/**
 * 钉钉开放平台 AI 表格 (notable) API 模块
 *
 * 字段映射:
 *   公司(文本) | 岗位(文本) | 城市(多选)
 *   投递DDL(日期) | 投递数量限制(数字)
 *   内推码(文本) | 状态(单选) | 待办(文本) | 预计耗时(数字)
 *   备注(文本) | 来源链接(网页链接) | 梯队(单选) | 信息来源渠道(文本)
 *   原始输入文本(文本) | 原始输入图片(文本) | 最后更新时间(自动)
 */

import type { DingTalkRecord, ParsedJob, PreUploadedAttachment } from './types';
import { ESTIMATED_MINUTES_BY_STATUS, isWaitingTypeTodo, isPassiveStatus } from './types';

const APP_KEY = process.env.DEMO_DINGTALK_APP_KEY ?? '';
const APP_SECRET = process.env.DEMO_DINGTALK_APP_SECRET ?? '';
const DEFAULT_BASE_ID = process.env.DEMO_DINGTALK_BASE_ID ?? '';
const DEFAULT_SHEET_ID = process.env.DEMO_DINGTALK_TABLE_ID ?? '';
const OPERATOR_ID = process.env.DEMO_DINGTALK_OPERATOR_ID ?? '';

function validateDemoEnv(): string[] {
  const missing: string[] = [];
  if (!APP_KEY) missing.push('DEMO_DINGTALK_APP_KEY');
  if (!APP_SECRET) missing.push('DEMO_DINGTALK_APP_SECRET');
  if (!DEFAULT_BASE_ID) missing.push('DEMO_DINGTALK_BASE_ID');
  if (!DEFAULT_SHEET_ID) missing.push('DEMO_DINGTALK_TABLE_ID');
  return missing;
}

const API_BASE = 'https://api.dingtalk.com';

// ============== 请求超时与重试 ==============
// 背景: Vercel Hobby 函数硬上限 10s, 而钉钉请求此前没有超时, 连接挂起时会
// 一直等到 Vercel 强杀 (返回 504 空响应), 前端表现为"请求超时"。
// 这里给所有钉钉请求加主动超时, 确保在函数预算内"快速失败"而非"挂到强杀"。
const DT_TIMEOUT_TOKEN = 5000;   // gettoken / users/me / sheets 列表
const DT_TIMEOUT_READ = 6000;    // 记录查询
const DT_TIMEOUT_WRITE = 6000;   // 新增/更新记录
const DT_TIMEOUT_UPLOAD = 6000;  // 图片上传

/** 带超时的 fetch, 超时时主动 abort 并抛出明确错误 */
async function dtFetch(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`钉钉请求超时 (${timeoutMs}ms): ${url.slice(0, 80)}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 记录写入 (POST/PUT) 的快速重试包装:
 * 仅对 503/500 和网络/超时错误重试 1 次 (0.6s 间隔), 业务错误 (4xx/200含code) 不重试。
 * 返回最终 Response 由调用方继续处理状态码与响应体。
 */
async function dtWriteWithRetry(
  method: 'POST' | 'PUT',
  url: string,
  token: string,
  body: unknown,
  label: string
): Promise<Response> {
  const options: RequestInit = {
    method,
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await dtFetch(url, options, DT_TIMEOUT_WRITE);
      // 业务错误 / 成功都直接返回给调用方; 仅 5xx 重试
      if (res.ok || (res.status !== 500 && res.status !== 503)) {
        return res;
      }
      const errText = await res.text();
      lastError = new Error(`钉钉${label}失败: HTTP ${res.status} - ${errText.slice(0, 300)}`);
      console.warn(`[钉钉] ${label} 5xx (尝试 ${attempt}/2): HTTP ${res.status}, ${errText.slice(0, 200)}`);
    } catch (err) {
      // 网络错误 / 超时也重试
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[钉钉] ${label} 网络/超时错误 (尝试 ${attempt}/2): ${lastError.message}`);
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastError ?? new Error(`钉钉${label}失败: 超过重试次数`);
}

/**
 * 工作空间配置: 每个钉钉表格对应一个配置
 * - demoMode: 演示模式, 使用服务端环境变量
 * - baseId: 钉钉 AI 表格 (notable) 的 base ID (非演示模式必填)
 * - sheetId: 表格内的 sheet ID (可选, 留空时自动检测)
 * - appKey/appSecret: 开发者凭据 (非演示模式必填)
 * - operatorId: 操作人 unionId (非演示模式必填)
 */
export interface WorkspaceConfig {
  demoMode?: boolean;
  baseId?: string;
  sheetId?: string;
  appKey?: string;
  appSecret?: string;
  operatorId?: string;
}

/**
 * 解析工作空间配置
 * 演示模式: 使用环境变量
 * 正常模式: 要求 config 提供 baseId
 */
function resolveIds(config?: WorkspaceConfig): { baseId: string; sheetId: string | undefined } {
  if (config?.demoMode) {
    const missing = validateDemoEnv();
    if (missing.length > 0) {
      throw new Error(`演示模式缺少环境变量: ${missing.join(', ')}。请在 Vercel 部署设置中配置这些变量。`);
    }
    return { baseId: DEFAULT_BASE_ID, sheetId: DEFAULT_SHEET_ID || undefined };
  }
  const baseId = config?.baseId?.trim();
  if (!baseId) {
    throw new Error('缺少 baseId: 请在设置页面配置工作空间');
  }
  const sheetId = config?.sheetId?.trim() || undefined;
  return { baseId, sheetId };
}

// ============== Sheet ID 自动检测 ==============

// 缓存: baseId → sheetId, 避免重复 API 调用
const sheetIdCache = new Map<string, string>();

/**
 * 通过 API 列出 base 下的所有 sheets, 返回第一个 sheet 的 ID
 * 用于新工作空间未指定 sheetId 时自动检测
 */
async function fetchFirstSheetId(token: string, baseId: string, operatorId: string): Promise<string> {
  const url = `${API_BASE}/v1.0/notable/bases/${baseId}/sheets?operatorId=${encodeURIComponent(operatorId)}`;
  console.log(`[钉钉] 自动检测 sheetId: ${url}`);

  const res = await dtFetch(url, {
    method: 'GET',
    headers: { 'x-acs-dingtalk-access-token': token },
  }, DT_TIMEOUT_TOKEN);

  if (!res.ok) {
    const errText = await res.text();
    console.error('[钉钉] 获取表格列表失败:', res.status, errText);
    throw new Error(`获取表格列表失败: HTTP ${res.status} - ${errText}`);
  }

  const data = (await res.json()) as {
    value?: Array<{ id?: string; name?: string }>;
  };

  const sheets = data.value ?? [];
  if (sheets.length === 0) {
    throw new Error(`表格 ${baseId} 中没有找到任何数据表, 请确认 baseId 是否正确`);
  }

  const firstSheetId = sheets[0].id;
  if (!firstSheetId) {
    throw new Error(`表格 ${baseId} 中无法获取数据表 ID`);
  }

  console.log(`[钉钉] 自动检测 sheetId 成功: ${firstSheetId} (表格名: ${sheets[0].name ?? '未知'})`);
  return firstSheetId;
}

/**
 * 解析最终的 sheetId:
 * 1. 如果 config 中明确提供了 sheetId, 直接使用
 * 2. 如果没有提供 sheetId, 且 baseId 是默认的, 使用环境变量中的 DEFAULT_SHEET_ID
 * 3. 如果没有提供 sheetId, 且 baseId 是新的, 通过 API 自动检测
 */
async function resolveSheetId(
  token: string,
  baseId: string,
  sheetId: string | undefined,
  operatorId: string
): Promise<string> {
  // Case 1: 明确提供了 sheetId
  if (sheetId) {
    return sheetId;
  }

  // Case 2: 默认 base, 使用默认 sheetId (来自环境变量 DEMO_DINGTALK_TABLE_ID)
  if (baseId === DEFAULT_BASE_ID && DEFAULT_SHEET_ID) {
    return DEFAULT_SHEET_ID;
  }

  // Case 3: 自动检测
  if (baseId === DEFAULT_BASE_ID && !DEFAULT_SHEET_ID) {
    console.log('[钉钉] DEMO_DINGTALK_TABLE_ID 未设置, 将通过 API 自动检测 sheetId');
  }

  const cached = sheetIdCache.get(baseId);
  if (cached) {
    return cached;
  }

  const detected = await fetchFirstSheetId(token, baseId, operatorId);
  sheetIdCache.set(baseId, detected);
  return detected;
}

// ============== Access Token 缓存 ==============

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
// 正常模式按 appKey 分别缓存 (多工作空间共用凭据, 同一 appKey 只取一次 token)
const tokenCacheByAppKey = new Map<string, TokenCache>();
let operatorIdCache: string | null = null;
const TOKEN_BUFFER = 300;

/**
 * 获取钉钉 access_token
 * 演示模式: 使用环境变量
 * 正常模式: 使用 config 传入的 appKey/appSecret
 * 两种模式均缓存 7000 秒 (钉钉 token 有效期 7200 秒), 避免一次提交内重复 gettoken
 */
async function getAccessToken(config?: WorkspaceConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // 演示模式: 使用环境变量, 启用缓存
  if (config?.demoMode) {
    if (tokenCache && tokenCache.expiresAt - TOKEN_BUFFER > now) {
      return tokenCache.token;
    }
    if (!APP_KEY || !APP_SECRET) {
      throw new Error('演示模式缺少 DEMO_DINGTALK_APP_KEY / DEMO_DINGTALK_APP_SECRET 环境变量');
    }
    const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(APP_KEY)}&appsecret=${encodeURIComponent(APP_SECRET)}`;
    const res = await dtFetch(url, { method: 'GET' }, DT_TIMEOUT_TOKEN);
    if (!res.ok) throw new Error(`获取钉钉 access_token 失败: HTTP ${res.status}`);
    const data = (await res.json()) as { errcode: number; errmsg: string; access_token?: string; expires_in?: number };
    if (data.errcode !== 0 || !data.access_token) {
      throw new Error(`获取钉钉 access_token 失败: ${data.errcode} ${data.errmsg}`);
    }
    const expiresIn = Math.min(data.expires_in ?? 7200, 7000);
    tokenCache = { token: data.access_token, expiresAt: now + expiresIn };
    return data.access_token;
  }

  // 正常模式: 使用用户传入的凭据
  const appKey = config?.appKey?.trim();
  const appSecret = config?.appSecret?.trim();
  if (!appKey || !appSecret) {
    throw new Error('缺少钉钉凭据: 请在设置页面填写 AppKey/AppSecret');
  }

  // 按 appKey 缓存, 命中则直接返回 (一次提交内 getAccessToken 会被调用多次)
  const cached = tokenCacheByAppKey.get(appKey);
  if (cached && cached.expiresAt - TOKEN_BUFFER > now) {
    return cached.token;
  }

  const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const res = await dtFetch(url, { method: 'GET' }, DT_TIMEOUT_TOKEN);
  if (!res.ok) throw new Error(`获取钉钉 access_token 失败: HTTP ${res.status}`);
  const data = (await res.json()) as { errcode: number; errmsg: string; access_token?: string; expires_in?: number };
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`获取钉钉 access_token 失败: ${data.errcode} ${data.errmsg}`);
  }
  const expiresIn = Math.min(data.expires_in ?? 7200, 7000);
  tokenCacheByAppKey.set(appKey, { token: data.access_token, expiresAt: now + expiresIn });
  return data.access_token;
}

// ============== Operator ID ==============

async function getOperatorId(token: string, config?: WorkspaceConfig): Promise<string> {
  // 演示模式: 使用环境变量, 启用缓存
  if (config?.demoMode) {
    if (operatorIdCache) {
      console.log('[钉钉] 使用缓存的 operatorId');
      return operatorIdCache;
    }
    if (OPERATOR_ID) {
      console.log('[钉钉] 使用环境变量中的 operatorId');
      operatorIdCache = OPERATOR_ID;
      return OPERATOR_ID;
    }
    // 演示模式也尝试自动获取
    console.log('[钉钉] 环境变量 DEMO_DINGTALK_OPERATOR_ID 未设置, 尝试通过 API 自动获取...');
    const id = await autoFetchOperatorId(token);
    operatorIdCache = id;
    return id;
  }

  // 正常模式: 使用用户传入的 operatorId
  const opId = config?.operatorId?.trim();
  if (!opId) {
    throw new Error('缺少操作人 ID: 请在设置页面填写 UnionId');
  }
  // 钉钉 unionId 长度校验: 通常 20+ 字符 (如 2qItsB4JPrEG8tWQDK4mdQiEiE)
  // 注意: unionId 不一定以 "U" 开头, 新版格式可能是任意字母数字串
  // 这里只做最低限度的长度校验, 防止误填 AppKey(短) 或 userId(数字)
  if (opId.length < 16) {
    console.warn(`[钉钉] operatorId 疑似无效: 长度=${opId.length}, 值=${opId.slice(0, 6)}...`);
    throw new Error(`操作人 ID 疑似无效 (长度 ${opId.length}, 正常 unionId 应 20+ 字符)。请确认填写的是 unionId 而非 userId/AppKey`);
  }
  return opId;
}

async function autoFetchOperatorId(token: string): Promise<string> {
  try {
    const url = `${API_BASE}/v1.0/contact/users/me`;
    const res = await dtFetch(url, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }, DT_TIMEOUT_TOKEN);
    if (res.ok) {
      const data = (await res.json()) as { unionId?: string };
      if (data.unionId) {
        console.log(`[钉钉] 自动获取 operatorId 成功: ${data.unionId}`);
        return data.unionId;
      }
      console.error('[钉钉] 自动获取 operatorId: API 返回数据中无 unionId 字段');
    } else {
      const errText = await res.text();
      console.error(`[钉钉] 自动获取 operatorId 失败: HTTP ${res.status} - ${errText}`);
    }
  } catch (err) {
    console.error('[钉钉] 自动获取 operatorId 异常:', err instanceof Error ? err.message : err);
  }
  throw new Error('自动获取 operatorId 失败。请在 Vercel 环境变量中设置 DEMO_DINGTALK_OPERATOR_ID');
}

// ============== 通用请求 ==============

function buildUrl(
  pathSuffix: string,
  baseId: string,
  sheetId: string,
  operatorId: string
): string {
  return `${API_BASE}/v1.0/notable/bases/${baseId}/sheets/${sheetId}/${pathSuffix}?operatorId=${encodeURIComponent(operatorId)}`;
}

// ============== 查询全部记录 ==============

export async function fetchAllRecords(config?: WorkspaceConfig): Promise<DingTalkRecord[]> {
  const token = await getAccessToken(config);
  const operatorId = await getOperatorId(token, config);
  const { baseId, sheetId } = resolveIds(config);
  const finalSheetId = await resolveSheetId(token, baseId, sheetId, operatorId);

  const allRecords: DingTalkRecord[] = [];
  let nextToken: string | undefined;

  do {
    const url = buildUrl('records/list', baseId, finalSheetId, operatorId);
    console.log(`[钉钉] 查询记录: ${url}`);

    const body: Record<string, unknown> = { maxResults: 100 };
    if (nextToken) body.nextToken = nextToken;

    const res = await dtFetch(url, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, DT_TIMEOUT_READ);

    if (!res.ok) {
      const errText = await res.text();
      console.error('钉钉查询失败:', res.status, errText);
      throw new Error(`查询钉钉记录失败: HTTP ${res.status} - ${errText}`);
    }

    const data = (await res.json()) as {
      records?: Array<{ id: string; fields: Record<string, unknown> }>;
      nextToken?: string;
      hasMore?: boolean;
    };

    for (const r of data.records ?? []) {
      allRecords.push({ recordId: r.id, fields: r.fields });
    }

    nextToken = data.hasMore ? data.nextToken : undefined;
  } while (nextToken);

  console.log(`[钉钉] 共查询到 ${allRecords.length} 条记录`);
  return allRecords;
}

// ============== 图片附件上传 ==============

interface AttachmentItem {
  filename: string;
  size: number;
  type: string;
  url: string;
  resourceId: string;
}

/**
 * 安全解析 JSON: 先读取 text, 再 parse, 避免空响应体导致 "Unexpected end of JSON input"
 */
async function safeJsonParse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text || !text.trim()) {
    throw new Error('响应体为空');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error('[钉钉] JSON 解析失败, 响应前 500 字符:', text.slice(0, 500));
    throw new Error(`响应不是有效的 JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * 将 base64 图片上传到钉钉, 返回附件对象 (用于写入附件字段)
 * 流程: 1.获取上传信息 → 2.PUT上传文件 → 返回附件元数据
 * 失败时静默重试 1 次, 仍失败返回 null (不影响主流程)
 */
async function uploadImageAttachment(
  token: string,
  baseId: string,
  operatorId: string,
  base64Image: string
): Promise<AttachmentItem | null> {
  // 单次上传尝试
  const attempt = async (): Promise<AttachmentItem | null> => {
    try {
    // 1. 解析 base64
    const dataUrlMatch = base64Image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    let mimeType: string;
    let base64Data: string;

    if (dataUrlMatch) {
      mimeType = dataUrlMatch[1];
      base64Data = dataUrlMatch[2];
    } else {
      // 纯 base64, 默认 png
      mimeType = 'image/png';
      base64Data = base64Image;
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const size = buffer.length;
    const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'png');
    const resourceName = `招聘截图_${Date.now()}.${ext}`;

    console.log(`[钉钉] 上传图片附件: ${mimeType}, ${size} bytes, ${resourceName}`);

    // 2. 获取资源上传信息
    const uploadInfoUrl = `${API_BASE}/v1.0/doc/docs/resources/${baseId}/uploadInfos/query?operatorId=${encodeURIComponent(operatorId)}`;
    const infoRes = await dtFetch(uploadInfoUrl, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        size,
        mediaType: mimeType,
        resourceName,
      }),
    }, DT_TIMEOUT_UPLOAD);

    if (!infoRes.ok) {
      const errText = await infoRes.text();
      console.error('[钉钉] 获取上传信息失败:', infoRes.status, errText);
      return null;
    }

    const infoDataRaw = await safeJsonParse<{
      uploadUrl?: string;
      resourceId?: string;
      resourceUrl?: string;
      result?: {
        uploadUrl?: string;
        resourceId?: string;
        resourceUrl?: string;
      };
    }>(infoRes);

    // 兼容两种响应格式: 顶层字段或嵌套在 result 中
    const infoData = infoDataRaw.result ?? infoDataRaw;

    console.log('[钉钉] 上传信息响应:', JSON.stringify(infoDataRaw));

    if (!infoData.uploadUrl || !infoData.resourceId || !infoData.resourceUrl) {
      console.error('[钉钉] 上传信息缺失字段:', JSON.stringify(infoDataRaw));
      return null;
    }

    // 3. PUT 上传文件到 uploadUrl
    const putRes = await dtFetch(infoData.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
      },
      body: buffer,
    }, DT_TIMEOUT_UPLOAD);

    if (!putRes.ok) {
      const errText = await putRes.text();
      console.error('[钉钉] PUT上传图片失败:', putRes.status, errText);
      return null;
    }

    console.log('[钉钉] 图片上传成功, resourceId:', infoData.resourceId);

    return {
      filename: resourceName,
      size,
      type: mimeType,
      url: infoData.resourceUrl,
      resourceId: infoData.resourceId,
    };
    } catch (err) {
      console.error('[钉钉] 上传图片附件异常:', err);
      return null;
    }
  };

  // 首次尝试
  const result = await attempt();
  if (result) return result;

  // 静默重试 1 次
  console.warn('[钉钉] 图片上传首次失败, 静默重试 1 次');
  return await attempt();
}

/**
 * 预上传图片附件 (与 AI 解析并行执行, 避免串行等待)
 * 返回附件对象, 后续通过 ParsedJob.preUploadedAttachment 传入 createRecord/updateRecord
 */
export async function preUploadImage(
  base64Image: string,
  config?: WorkspaceConfig
): Promise<PreUploadedAttachment | null> {
  try {
    const token = await getAccessToken(config);
    const operatorId = await getOperatorId(token, config);
    const { baseId } = resolveIds(config);
    const attachment = await uploadImageAttachment(token, baseId, operatorId, base64Image);
    return attachment as PreUploadedAttachment | null;
  } catch (err) {
    console.warn('[钉钉] 预上传图片失败, 将在写入记录时重试:', err);
    return null;
  }
}

// ============== 字段构建 ==============

/**
 * 根据状态返回链接显示文案
 */
function getLinkLabel(status: string | null | undefined): string {
  if (!status) return '报名链接';
  if (status === '测评') return '测评链接';
  if (status === '笔试') return '笔试链接';
  if (['AI面', '群面', '一面', '二面', '三面', 'HR面'].includes(status)) return '面试链接';
  return '报名链接';
}

/**
 * 根据 ParsedJob 构建钉钉表格字段
 * null 值字段不写入
 */
function buildFields(parsed: ParsedJob): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  // ---- 核心字段 ----
  if (parsed.company) fields['公司'] = parsed.company;
  if (parsed.position) fields['岗位'] = parsed.position;

  // ---- 城市 (多选数组) ----
  const cities = normalizeCityArray(parsed.city);
  if (cities.length > 0) {
    fields['城市'] = cities;
  }

  // ---- 投递DDL (日期时间戳, 表格格式化显示为 YYYY-MM-DD) ----
  const deadline = resolveDeadline(parsed);
  if (deadline) {
    const ts = dateStringToTimestamp(deadline);
    if (ts) fields['投递DDL'] = ts;
  }

  // ---- 备注 (过滤占位文本) ----
  if (parsed.remark && !isPlaceholderValue(parsed.remark)) {
    fields['备注'] = parsed.remark;
  }

  // ---- 投递数量限制 (数字) ----
  if (parsed.application_limit != null) {
    fields['投递数量限制'] = Number(parsed.application_limit);
  }

  // ---- 内推码 ----
  if (parsed.referral_code) fields['内推码'] = parsed.referral_code;

  // ---- 状态 ----
  if (parsed.status_hint) fields['状态'] = parsed.status_hint;

  // ---- 待办 ----
  // 被动/结束类状态 (已投递/Offer/已拒绝/各种挂): 显式写 null 清空旧待办,
  // 否则状态变成"面试挂"后, 待办还残留着"准备群面", 计划页会把它当成可执行任务
  if (isPassiveStatus(parsed.status_hint)) {
    fields['待办'] = null;
  } else if (parsed.todo) {
    fields['待办'] = parsed.todo;
  }

  // ---- 预计耗时 (数字) ----
  // 规则: 预计耗时与待办严格绑定
  // 1. 待办为空 → 预计耗时 = null (无需用户行动)
  // 2. 待办为"等待结果"类 (如"一面结束, 等待下一步通知") → 预计耗时 = null (虽有待办但无需行动)
  // 3. 待办为正常行动类 → 按状态对照表填写, 笔试优先用 AI 返回的真实时长
  if (parsed.status_hint && parsed.status_hint in ESTIMATED_MINUTES_BY_STATUS) {
    if (parsed.todo && !isWaitingTypeTodo(parsed.todo, parsed.status_hint)) {
      const min = parsed.estimated_minutes ?? ESTIMATED_MINUTES_BY_STATUS[parsed.status_hint];
      fields['预计耗时'] = min != null ? Number(min) : null;
    } else {
      // 无待办 或 等待型待办 → 清空旧值
      fields['预计耗时'] = null;
    }
  }

  // ---- 链接 (超链接字段, 需要 {link, text} 对象格式) ----
  if (parsed.source_url) {
    const cleanedUrl = cleanedUrlString(parsed.source_url);
    if (cleanedUrl) {
      fields['链接'] = {
        text: getLinkLabel(parsed.status_hint),
        link: cleanedUrl,
      };
    }
  }

  // ---- 梯队 (A/B/C/S/SS, 用户选填, 未选则不写保留已有值) ----
  if (parsed.echelon) {
    fields['梯队'] = parsed.echelon;
  }

  // ---- 宣讲会行程 (时间+地点, 含教学楼教室) ----
  if (parsed.info_session && !isPlaceholderValue(parsed.info_session)) {
    fields['宣讲会行程'] = parsed.info_session;
  }

  // ---- 信息来源渠道 ----
  if (parsed.source_channel && parsed.source_channel.trim() !== '') {
    fields['信息来源渠道'] = parsed.source_channel.trim();
  }

  // ---- 原始输入文本 ----
  // 首次创建时加时间戳, 确保与追加逻辑格式一致 (updateRecord 的追加逻辑会覆盖此值)
  if (parsed.raw_text && parsed.raw_text.trim() !== '') {
    fields['原始输入文本'] = formatRawTextEntry(parsed.raw_text.trim());
  }

  // ---- 原始输入图片 ----
  // 不在 buildFields 中处理, 改为在 createRecord/updateRecord 中异步上传后写入
  // (附件字段需要先上传文件再写入, buildFields 是同步函数无法处理)

  return fields;
}

/**
 * 确定最终使用的 deadline:
 * - 优先使用 parsed.deadline
 * - 如果有 locations, 使用最近一个未过期的日期作为补充
 */
function resolveDeadline(parsed: ParsedJob): string | null {
  if (parsed.deadline) return parsed.deadline;

  if (!parsed.locations || parsed.locations.length === 0) return null;

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const upcoming = parsed.locations
    .filter((loc) => loc.date)
    .map((loc) => ({
      date: loc.date!,
      ts: new Date(loc.date! + 'T00:00:00+08:00').getTime(),
    }))
    .filter((loc) => loc.ts >= now.getTime())
    .sort((a, b) => a.ts - b.ts);

  if (upcoming.length > 0) return upcoming[0].date;

  // 全过期的情况也返回最近的过期日期
  const allSorted = parsed.locations
    .filter((loc) => loc.date)
    .map((loc) => loc.date!)
    .sort((a, b) => b.localeCompare(a));

  return allSorted[0] ?? null;
}

/**
 * 判断钉钉表格字段是否发生了实际变化
 * - null vs undefined vs '': 视为相同 (空值)
 * - 数组: 比较排序后 JSON 序列化
 * - 字符串/数字: 严格相等
 * - AI 默认值 (城市=["未知"], 优先级="中") 不覆盖已有有效值
 * - null 不覆盖已有有效值 (预计耗时除外, 因为状态变更时需要清空)
 * - 公司名: 新值是旧值的子串时跳过 (防止 AI 简称覆盖全称, 如 "大疆" 覆盖 "DJI 大疆")
 * - 岗位名: 使用 normalizePosition 归一化后再比较 (防止 "产品运营" 覆盖 "产品运营岗")
 */
function isFieldDifferent(key: string, newValue: unknown, oldValue: unknown): boolean {
  const isEmpty = (v: unknown) =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

  // 规则 1: null 不覆盖已有有效值 (预计耗时、待办、原始输入文本/图片除外)
  // - 预计耗时/待办: 状态变更为结束类 (挂/Offer/已投递) 时需要显式清空旧值,
  //   否则会残留"准备群面"等失效待办, 被计划页当成可执行任务
  // - 原始输入文本/图片: 由追加逻辑单独处理, 过滤阶段不参与
  if (isEmpty(newValue) && !isEmpty(oldValue) && key !== '预计耗时' && key !== '待办' && key !== '原始输入文本' && key !== '原始输入图片') {
    console.log(`    [保护] 字段 "${key}" 新值为空但旧值有内容, 跳过 (保留旧值)`);
    return false;
  }

  // 规则 2: AI 默认值不覆盖已有有效值
  // 城市=["未知"] 是 AI 默认值, 不应覆盖用户已选城市
  if (key === '城市' && Array.isArray(newValue) && newValue.length === 1 && newValue[0] === '未知') {
    if (!isEmpty(oldValue) && !(Array.isArray(oldValue) && oldValue.length === 1 && oldValue[0] === '未知')) {
      console.log(`    [保护] 字段 "城市" 新值为默认["未知"], 旧值为 ${JSON.stringify(oldValue)}, 跳过`);
      return false;
    }
  }
  // 状态保护: 新值"待投递"是 AI 默认兜底值, 不应覆盖已有进展状态
  // 场景: 宣讲会消息无明确进展, AI 默认返回"待投递", 不应把"一面""群面"等覆盖退步
  if (key === '状态' && newValue === '待投递' && !isEmpty(oldValue) && oldValue !== '待投递') {
    console.log(`    [保护] 字段 "状态" 新值为默认"待投递", 旧值为 "${oldValue}", 跳过`);
    return false;
  }

  // 规则 3: 公司名子串保护: AI 识别的简称不应覆盖原表全称
  // 例如: 新值="大疆", 旧值="DJI 大疆" → 新值是旧值的子串, 跳过
  if (key === '公司' && !isEmpty(newValue) && !isEmpty(oldValue)) {
    const newStr = String(newValue).toLowerCase().trim();
    const oldStr = String(oldValue).toLowerCase().trim();
    if (newStr !== oldStr && (oldStr.includes(newStr) || newStr.length < oldStr.length)) {
      console.log(`    [保护] 字段 "公司" 新值 "${newStr}" 是旧值 "${oldStr}" 的子串/简称, 跳过`);
      return false;
    }
  }

  // 规则 4: 岗位名归一化比较: 标准化后相同则跳过
  // 例如: 新值="产品运营", 旧值="产品运营岗" → normalizePosition 后都为 "产品运营"
  if (key === '岗位' && !isEmpty(newValue) && !isEmpty(oldValue)) {
    const normNew = normalizePosition(String(newValue));
    const normOld = normalizePosition(String(oldValue));
    if (normNew === normOld) {
      console.log(`    [保护] 字段 "岗位" 归一化后相同: "${normNew}" (新="${newValue}", 旧="${oldValue}"), 跳过`);
      return false;
    }
  }

  // 规则 5: 空值对比
  if (isEmpty(newValue) && isEmpty(oldValue)) return false;

  // 规则 6: 数组对比
  if (Array.isArray(newValue) && Array.isArray(oldValue)) {
    return JSON.stringify([...newValue].sort()) !== JSON.stringify([...oldValue].sort());
  }

  return newValue !== oldValue;
}

/**
 * 从钉钉字段值中提取时间戳 (毫秒)
 * "最后更新时间"字段可能是数字时间戳或字符串
 */
function extractTimestamp(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return isNaN(n) ? null : n;
  }
  return null;
}

/**
 * 规范化城市数组
 */
function normalizeCityArray(cities: string[] | null | undefined): string[] {
  if (!cities || cities.length === 0) return ['未知'];

  const validOptions = ['北京', '上海', '深圳', '广州', '杭州', '成都', '海外', '其他', '未知'];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const raw of cities) {
    const normalized = normalizeCity(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result.length > 0 ? result : ['未知'];
}

// ============== 新增/更新记录 ==============

export async function createRecord(parsed: ParsedJob, config?: WorkspaceConfig): Promise<DingTalkRecord> {
  const token = await getAccessToken(config);
  const operatorId = await getOperatorId(token, config);
  const { baseId, sheetId } = resolveIds(config);
  const finalSheetId = await resolveSheetId(token, baseId, sheetId, operatorId);

  const fields = buildFields(parsed);

  // 写入原始输入图片 (附件字段: 优先使用预上传结果, 否则现场上传, 失败时跳过)
  if (parsed.raw_image && parsed.raw_image.trim()) {
    const attachment = parsed.preUploadedAttachment ?? await uploadImageAttachment(token, baseId, operatorId, parsed.raw_image);
    if (attachment) {
      fields['原始输入图片'] = [attachment];
      console.log('[钉钉] 图片附件已添加到字段');
    } else {
      console.warn('[钉钉] 图片附件上传失败, 跳过写入图片字段 (不影响其他字段)');
    }
  }

  console.log(`[钉钉] 准备写入的字段:`, JSON.stringify(fields, null, 2));

  const url = buildUrl('records', baseId, finalSheetId, operatorId);

  const res = await dtWriteWithRetry('POST', url, token, { records: [{ fields }] }, '新增记录');

  if (!res.ok) {
    const errText = await res.text();
    console.error('钉钉新增失败:', res.status, errText);
    throw new Error(`新增钉钉记录失败: HTTP ${res.status} - ${errText}`);
  }

  const data = await safeJsonParse<{
    value?: Array<{ id: string }>;
    code?: string;
    message?: string;
    requestid?: string;
  }>(res);

  // 钉钉 API 有时返回 200 但响应体含错误
  if (data.code && data.message) {
    console.error('钉钉新增失败(200但含错误):', data.code, data.message);
    throw new Error(`新增钉钉记录失败: ${data.code} - ${data.message}`);
  }

  const id = data.value?.[0]?.id ?? '';
  if (!id) {
    console.error('钉钉新增异常: 响应未包含记录ID, 完整响应:', JSON.stringify(data));
    throw new Error('钉钉新增记录失败: API 未返回记录 ID');
  }

  console.log(`[钉钉] 新增成功: recordId=${id}`);
  return { recordId: id, fields };
}

export async function updateRecord(
  recordId: string,
  parsed: ParsedJob,
  existingRecord?: DingTalkRecord | null,
  config?: WorkspaceConfig
): Promise<DingTalkRecord> {
  const token = await getAccessToken(config);
  const operatorId = await getOperatorId(token, config);
  const { baseId, sheetId } = resolveIds(config);
  const finalSheetId = await resolveSheetId(token, baseId, sheetId, operatorId);

  const url = buildUrl('records', baseId, finalSheetId, operatorId);
  console.log(`[钉钉] 更新记录: ${url}, recordId=${recordId}`);

  let fields = buildFields(parsed);

  // 智能更新: 与已有记录对比, 只保留真正变化的字段, 避免用 AI 默认值覆盖已有数据
  // 例如: 进展更新"大疆收到群面通知"不应把城市从"深圳"覆盖为"未知"
  if (existingRecord) {
    const existing = existingRecord.fields as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (isFieldDifferent(key, value, existing[key])) {
        filtered[key] = value;
      } else {
        console.log(`  [跳过] 字段 "${key}" 未变化 (${JSON.stringify(value)}), 不写入`);
      }
    }
    fields = filtered;
  }

  // 状态冲突处理: 当状态发生变化时, 在备注中保留历史状态记录
  if (existingRecord && parsed.status_hint) {
    const oldStatus = existingRecord.fields?.['状态'];
    const newStatus = parsed.status_hint;
    if (oldStatus && oldStatus !== newStatus) {
      const timestamp = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const statusHistory = `[${timestamp} 状态变更: ${oldStatus} → ${newStatus}]`;
      const existingRemark = String(existingRecord.fields?.['备注'] ?? '');
      // 合并: AI 返回的新备注 + 历史状态记录
      const newRemark = parsed.remark
        ? `${parsed.remark}\n${statusHistory}`
        : existingRemark
          ? `${existingRemark}\n${statusHistory}`
          : statusHistory;
      fields['备注'] = newRemark;
      console.log(`[状态变更] ${oldStatus} → ${newStatus}, 已记录到备注`);
    }
  }

  // 追加原始输入文本 (保留历史, 不覆盖)
  if (existingRecord && parsed.raw_text) {
    const existingRaw = String(existingRecord.fields['原始输入文本'] ?? '');
    const newEntry = formatRawTextEntry(parsed.raw_text);
    console.log(`[追加] 原始输入文本: 已有 ${existingRaw.length} 字符, 新增 ${newEntry.length} 字符`);
    if (existingRaw) {
      fields['原始输入文本'] = `${existingRaw}\n${'─'.repeat(20)}\n${newEntry}`;
    } else {
      fields['原始输入文本'] = newEntry;
    }
  }

  // 写入原始输入图片 (附件字段: 优先使用预上传结果, 否则现场上传, 失败时跳过)
  if (parsed.raw_image && parsed.raw_image.trim()) {
    const attachment = parsed.preUploadedAttachment ?? await uploadImageAttachment(token, baseId, operatorId, parsed.raw_image);
    if (attachment) {
      // 已有图片附件时, 追加新附件到数组; 相同图片不重复追加
      const existingAttachments = existingRecord?.fields?.['原始输入图片'];
      const existingList: Array<{ url?: string }> = Array.isArray(existingAttachments)
        ? existingAttachments.filter((a): a is { url?: string } => !!a && typeof a === 'object')
        : [];
      const url = typeof attachment.url === 'string' ? attachment.url : '';
      if (existingList.some((a) => a.url === url)) {
        console.log('[钉钉] 相同图片附件已存在, 跳过追加');
      } else {
        fields['原始输入图片'] = [...existingList, attachment];
        console.log('[钉钉] 图片附件已添加到更新字段');
      }
    } else {
      console.warn('[钉钉] 图片附件上传失败, 跳过写入图片字段 (不影响其他字段)');
    }
  }

  // 如果没有任何字段需要更新, 跳过 API 调用
  if (Object.keys(fields).length === 0) {
    console.log('[钉钉] 无实际变化的字段, 跳过更新');
    return { recordId, fields: existingRecord?.fields ?? {} } as unknown as DingTalkRecord;
  }

  console.log(`[钉钉] 准备更新的字段:`, JSON.stringify(fields, null, 2));

  const res = await dtWriteWithRetry(
    'PUT',
    url,
    token,
    { records: [{ id: recordId, fields }] },
    '更新记录'
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error('钉钉更新失败:', res.status, errText);
    throw new Error(`更新钉钉记录失败: HTTP ${res.status} - ${errText}`);
  }

  console.log(`[钉钉] 更新成功: recordId=${recordId}`);
  return { recordId, fields };
}

// ============== 匹配逻辑 ==============

export async function matchRecord(
  parsed: ParsedJob,
  existingRecords: DingTalkRecord[]
): Promise<DingTalkRecord | null> {
  // 公司+岗位模糊匹配
  const matched = await aiMatchRecord(parsed.match_key, existingRecords, parsed.status_hint);
  if (matched) return matched;

  // 最终回退: 原始文本完全一致匹配 (防止 AI 返回不同岗位名导致重复创建)
  if (parsed.raw_text) {
    const rawTextLower = parsed.raw_text.trim().toLowerCase();
    for (const record of existingRecords) {
      const existingRaw = String(record.fields?.['原始输入文本'] ?? '').toLowerCase();
      if (existingRaw.includes(rawTextLower) || rawTextLower.includes(existingRaw)) {
        console.log(`[匹配成功] 原始文本匹配: recordId=${record.recordId}`);
        return record;
      }
    }
  }

  return null;
}

/**
 * 宣讲会场景: 匹配某公司下所有记录 (宣讲会是公司维度信息, 应同步到所有岗位记录)
 * 使用精确公司名匹配 (双向 includes), 不依赖 match_key
 * 返回所有匹配的记录, 供调用方逐条更新
 */
export function matchAllCompanyRecords(
  company: string,
  existingRecords: DingTalkRecord[]
): DingTalkRecord[] {
  const companyLower = company.toLowerCase().trim();
  const candidates = existingRecords.filter((r) => {
    const c = String(r.fields?.['公司'] ?? '').toLowerCase().trim();
    if (!c) return false;
    // 精确匹配或双向包含 (如 "DJI 大疆" 包含 "大疆")
    return c === companyLower || c.includes(companyLower) || companyLower.includes(c);
  });
  console.log(`[匹配] matchAllCompanyRecords: 公司 "${company}" 匹配到 ${candidates.length} 条记录`);
  return candidates;
}

export async function aiMatchRecord(
  newMatchKey: string,
  existingRecords: DingTalkRecord[],
  statusHint?: string | null
): Promise<DingTalkRecord | null> {
  if (existingRecords.length === 0) return null;

  // 统一使用精确匹配, 避免 AI 将同一公司不同岗位误判为相同
  return simpleFuzzyMatch(newMatchKey, existingRecords, statusHint);
}

/**
 * 标准化岗位名称: 去除常见后缀和标点, 用于匹配比较
 * 例如: "综合类岗位" → "综合", "制造。" → "制造", "产品经理岗位" → "产品经理", "产品运营岗" → "产品运营"
 */
function normalizePosition(position: string): string {
  let s = position.trim().toLowerCase();
  // 去除尾部标点
  s = s.replace(/[。，.,！!？?；;]+$/, '');
  // 去除常见后缀 (顺序重要: 先去长的, 再去短的)
  s = s.replace(/类岗位$/, '');   // "综合类岗位" → "综合"
  s = s.replace(/岗位$/, '');     // "产品经理岗位" → "产品经理"
  s = s.replace(/类$/, '');       // "综合类" → "综合"
  s = s.replace(/岗$/, '');       // "产品运营岗" → "产品运营"
  return s.trim();
}

/**
 * 岗位名双字组 (bigram) Dice 相似度
 * 用于进展更新场景: 用户口语化的岗位名与表格中的正式名可能只有尾部差异
 * 例: "智能服务产品运营" vs "智能服务产品实习生" → 0.67
 *     "产品运营" vs "产品经理" → 0.33 (低于阈值, 不误匹配)
 */
function bigramDice(a: string, b: string): number {
  if (!a || !b) return 0;
  const grams = (s: string): Set<string> => {
    const g = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  ga.forEach((x) => {
    if (gb.has(x)) inter++;
  });
  return (2 * inter) / (ga.size + gb.size);
}

function simpleFuzzyMatch(
  matchKey: string,
  records: DingTalkRecord[],
  statusHint?: string | null
): DingTalkRecord | null {
  const keyLower = matchKey.toLowerCase().replace(/\s+/g, '');
  const keyParts = keyLower.split(/[-_]/);
  const keyCompany = keyParts[0] ?? '';
  const keyPosition = normalizePosition(keyParts.slice(1).join('-'));
  // 进展更新类消息 (非"待投递"): 用户在说一个已跟踪机会的新状态, 岗位名允许口语化
  const isUpdate = !!statusHint && statusHint !== '待投递';

  console.log(`[匹配] simpleFuzzyMatch: matchKey="${matchKey}", keyCompany="${keyCompany}", keyPosition="${keyPosition}", status="${statusHint ?? ''}", isUpdate=${isUpdate}, 共${records.length}条记录`);

  // 第一优先: 公司+岗位精确匹配
  if (keyCompany && keyPosition) {
    for (const record of records) {
      const fields = record.fields as Record<string, unknown>;
      const company = String(fields['公司'] ?? '').toLowerCase();
      const position = normalizePosition(String(fields['岗位'] ?? ''));

      const companyMatch =
        company === keyCompany || company.includes(keyCompany) || keyCompany.includes(company);
      const positionMatch = position === keyPosition;

      console.log(
        `  [优先级1] 记录${record.recordId}: company="${company}" vs "${keyCompany}" → ${companyMatch}, position="${position}" vs "${keyPosition}" → ${positionMatch}`
      );

      if (companyMatch && positionMatch) {
        console.log(`  [匹配成功] 优先级1 (公司+岗位精确): recordId=${record.recordId}`);
        return record;
      }
      // 岗位名包含匹配 (如 "X-STAR" vs "X-STAR顶尖AI人才计划")
      if (companyMatch && keyPosition && position) {
        const containsMatch = position.includes(keyPosition) || keyPosition.includes(position);
        if (containsMatch && keyPosition.length >= 3) {
          console.log(`  [匹配成功] 优先级1.5 (公司+岗位包含): recordId=${record.recordId}, "${position}" vs "${keyPosition}"`);
          return record;
        }
      }
    }
  } else {
    console.log(`  [跳过] 优先级1: keyCompany="${keyCompany}", keyPosition="${keyPosition}" (需两者都非空)`);
  }

  // 优先级 1.7: 进展更新 + 岗位名高相似度 (仅更新类消息启用, 新机会不参与, 避免误合并)
  // 例: 用户输入"抖音集团-智能服务产品运营群面已挂", 表格中岗位名为"智能服务产品实习生"
  if (isUpdate && keyCompany && keyPosition) {
    let best: { record: DingTalkRecord; score: number } | null = null;
    for (const record of records) {
      const fields = record.fields as Record<string, unknown>;
      const company = String(fields['公司'] ?? '').toLowerCase();
      const position = normalizePosition(String(fields['岗位'] ?? ''));
      const companyMatch =
        company === keyCompany || company.includes(keyCompany) || keyCompany.includes(company);
      if (!companyMatch || !position) continue;
      const score = bigramDice(keyPosition, position);
      console.log(`  [优先级1.7] 记录${record.recordId}: "${position}" vs "${keyPosition}" 相似度=${score.toFixed(2)}`);
      if (!best || score > best.score) best = { record, score };
    }
    if (best && best.score >= 0.62) {
      console.log(`  [匹配成功] 优先级1.7 (进展更新+岗位相似度 ${best.score.toFixed(2)}): recordId=${best.record.recordId}`);
      return best.record;
    }
  }

  // 第二优先: 仅公司名匹配 (进展更新场景, 如"大疆收到群面通知")
  // 只有当该公司在表格中只有一条记录时才自动匹配, 避免同公司多岗位歧义
  // 新增类消息 (待投递) 要求 match_key 不带岗位名才走此回退, 防止批量提交误匹配;
  // 进展更新类消息 (测评/面试/挂等) 即使带了岗位名, 只要公司下仅 1 条记录即无歧义, 允许匹配
  if (keyCompany && (!keyPosition || isUpdate)) {
    const candidates: DingTalkRecord[] = [];
    for (const record of records) {
      const fields = record.fields as Record<string, unknown>;
      const company = String(fields['公司'] ?? '').toLowerCase();
      if (company === keyCompany || company.includes(keyCompany) || keyCompany.includes(company)) {
        candidates.push(record);
      }
    }
    console.log(`  [优先级2] 公司名 "${keyCompany}" 匹配到 ${candidates.length} 条记录`);
    if (candidates.length === 1) {
      console.log(`  [匹配成功] 优先级2 (仅公司名): ${keyCompany} → ${candidates[0].recordId} (该公司仅一条记录, 无歧义)`);
      return candidates[0];
    }
    if (candidates.length > 1) {
      console.log(`  [匹配失败] 优先级2: ${candidates.length} 条记录, 存在歧义, 返回 null`);
    }
  }

  console.log(`  [匹配失败] 未找到匹配记录`);
  return null;
}

function preFilter(
  matchKey: string,
  records: DingTalkRecord[]
): DingTalkRecord[] {
  const keyLower = matchKey.toLowerCase();
  const candidates: DingTalkRecord[] = [];

  for (const record of records) {
    const fields = record.fields as Record<string, unknown>;
    const company = String(fields['公司'] ?? '').toLowerCase();
    if (company && keyLower.includes(company.slice(0, 2))) {
      candidates.push(record);
    }
  }

  return candidates;
}

// ============== 字段值规范化 ==============

function normalizeCity(city: string): string {
  const cityLower = city.toLowerCase().trim();
  const options = ['北京', '上海', '深圳', '广州', '杭州', '成都', '海外', '其他', '未知'];

  for (const opt of options) {
    if (cityLower.includes(opt.toLowerCase())) {
      return opt;
    }
  }

  const aliasMap: Record<string, string> = {
    beijing: '北京', bj: '北京',
    shanghai: '上海', sh: '上海',
    shenzhen: '深圳', sz: '深圳',
    guangzhou: '广州', gz: '广州',
    hangzhou: '杭州', hz: '杭州',
    chengdu: '成都', cd: '成都',
  };

  for (const [alias, target] of Object.entries(aliasMap)) {
    if (cityLower.includes(alias)) {
      return target;
    }
  }

  if (city.includes('海外')) return '海外';
  if (city.includes('其他')) return '其他';
  if (city.includes('未知')) return '未知';

  return '其他';
}

function dateStringToTimestamp(dateStr: string): number | null {
  const cleaned = dateStr.trim();
  const match = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    console.warn(`[日期] 格式不支持, 无法转换: ${dateStr}`);
    return null;
  }

  const [, year, month, day] = match;
  const d = new Date(`${year}-${month}-${day}T00:00:00+08:00`);

  if (isNaN(d.getTime())) {
    console.warn(`[日期] 无效日期: ${dateStr}`);
    return null;
  }

  return d.getTime();
}

// ============== 删除记录 ==============

export async function deleteRecord(recordId: string, config?: WorkspaceConfig): Promise<void> {
  const token = await getAccessToken(config);
  const operatorId = await getOperatorId(token, config);
  const { baseId, sheetId } = resolveIds(config);
  const finalSheetId = await resolveSheetId(token, baseId, sheetId, operatorId);

  const url = `${API_BASE}/v1.0/notable/bases/${baseId}/sheets/${finalSheetId}/records/delete?operatorId=${encodeURIComponent(operatorId)}`;
  console.log(`[钉钉] 删除记录: ${url}, recordId=${recordId}`);

  const res = await dtFetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recordIds: [recordId] }),
  }, DT_TIMEOUT_WRITE);

  if (!res.ok) {
    const errText = await res.text();
    console.error('钉钉删除失败:', res.status, errText);
    throw new Error(`删除钉钉记录失败: HTTP ${res.status} - ${errText}`);
  }

  console.log(`[钉钉] 删除成功: recordId=${recordId}`);
}

/**
 * 轻量更新: 只更新指定字段 (用于快速修改状态等场景)
 */
export async function updateRecordFields(
  recordId: string,
  fields: Record<string, unknown>,
  config?: WorkspaceConfig
): Promise<void> {
  const token = await getAccessToken(config);
  const operatorId = await getOperatorId(token, config);
  const { baseId, sheetId } = resolveIds(config);
  const finalSheetId = await resolveSheetId(token, baseId, sheetId, operatorId);

  const url = `${API_BASE}/v1.0/notable/bases/${baseId}/sheets/${finalSheetId}/records?operatorId=${encodeURIComponent(operatorId)}`;
  console.log(`[钉钉] 轻量更新记录: ${url}, recordId=${recordId}, fields=`, fields);

  const body = {
    records: [{ id: recordId, fields }],
  };

  // 带重试机制的请求 (处理 503/500/网络抖动/超时)
  // 注意: 单次请求 4s 超时 + 0.5s 退避, 总共 2 次尝试, 控制在 Vercel Hobby 10s 预算内
  const MAX_ATTEMPTS = 2;
  const ATTEMPT_TIMEOUT = 4000;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await dtFetch(url, {
        method: 'PUT',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }, ATTEMPT_TIMEOUT);

      if (res.ok) {
        console.log(`[钉钉] 轻量更新成功: recordId=${recordId}`);
        return;
      }

      // 仅对 503/500 重试, 其他错误直接抛出
      if (res.status === 503 || res.status === 500) {
        const errText = await res.text();
        console.warn(`[钉钉] 轻量更新失败 (尝试 ${attempt}/${MAX_ATTEMPTS}): HTTP ${res.status} - ${errText}`);
        lastError = new Error(`轻量更新钉钉记录失败: HTTP ${res.status} - ${errText}`);
      } else {
        const errText = await res.text();
        console.error('钉钉轻量更新失败:', res.status, errText);
        throw new Error(`轻量更新钉钉记录失败: HTTP ${res.status} - ${errText}`);
      }
    } catch (err) {
      // 网络错误 / 超时: 记录并按重试逻辑处理
      lastError = err instanceof Error ? err : new Error(String(err));
      // 业务错误 (上面构造的 Error 且非超时/网络) 直接抛出
      if (lastError.message.startsWith('轻量更新钉钉记录失败: HTTP') &&
          !lastError.message.includes('503') && !lastError.message.includes('500')) {
        throw lastError;
      }
      console.warn(`[钉钉] 轻量更新网络/超时错误 (尝试 ${attempt}/${MAX_ATTEMPTS}): ${lastError.message}`);
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = 500; // 0.5s 后重试 (控制总时长)
      console.log(`[钉钉] ${delay}ms 后重试...`);
      await new Promise<void>((resolve) => setTimeout(() => resolve(), delay));
    }
  }

  throw lastError ?? new Error('轻量更新钉钉记录失败: 超过最大重试次数');
}

// ============== 辅助函数 ==============

/**
 * 检测占位文本: AI 返回的无效内容 (如 "暂无", "无", "未知")
 * 这些不是真正的业务数据, 应该阻止写入钉钉
 */
function isPlaceholderValue(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;

  const patterns = [
    /^暂无/,
    /^无$/,
    /^暂无.*描述/,
    /^暂无.*要求/,
    /^暂无.*信息/,
    /^暂无.*岗位/,
    /^没有/,
    /^未提及/,
    /^未知$/,
    /^不[详用]$/,
  ];

  return patterns.some((p) => p.test(trimmed));
}

/**
 * 清理 URL 字符串: 去除反引号、引号、多余空格
 */
function cleanedUrlString(url: string): string {
  return url
    .replace(/`/g, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

/**
 * 格式化原始输入条目: 加时间戳前缀
 */
function formatRawTextEntry(raw: string): string {
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `[${ts}]\n${raw}`;
}
