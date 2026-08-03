/**
 * 钉钉开放平台 AI 表格 (notable) API 模块
 *
 * 字段映射 (16 个字段):
 *   公司(文本) | 岗位(文本) | 岗位编号(文本) | 城市(多选)
 *   投递DDL(日期) | 岗位描述(文本) | 岗位要求(文本) | 投递数量限制(数字)
 *   内推码(文本) | 状态(单选) | 待办(文本) | 预计耗时(数字)
 *   备注(文本) | 来源链接(网页链接) | 优先级标记(单选) | 最后更新时间(自动)
 */

import type { DingTalkRecord, ParsedJob } from './types';
import { ESTIMATED_MINUTES_BY_STATUS } from './types';

const APP_KEY = process.env.DEMO_DINGTALK_APP_KEY ?? '';
const APP_SECRET = process.env.DEMO_DINGTALK_APP_SECRET ?? '';
const DEFAULT_BASE_ID = process.env.DEMO_DINGTALK_BASE_ID ?? '';
const DEFAULT_SHEET_ID = process.env.DEMO_DINGTALK_TABLE_ID || DEFAULT_BASE_ID || '';
const OPERATOR_ID = process.env.DEMO_DINGTALK_OPERATOR_ID ?? '';

const API_BASE = 'https://api.dingtalk.com';

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
    const baseId = DEFAULT_BASE_ID;
    if (!baseId) throw new Error('演示模式缺少 DEMO_DINGTALK_BASE_ID 环境变量');
    return { baseId, sheetId: DEFAULT_SHEET_ID || undefined };
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

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'x-acs-dingtalk-access-token': token },
  });

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

  // Case 3: 新 base, 自动检测
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
let operatorIdCache: string | null = null;
const TOKEN_BUFFER = 300;

/**
 * 获取钉钉 access_token
 * 演示模式: 使用环境变量
 * 正常模式: 使用 config 传入的 appKey/appSecret
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
    const res = await fetch(url, { method: 'GET' });
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

  const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`获取钉钉 access_token 失败: HTTP ${res.status}`);
  const data = (await res.json()) as { errcode: number; errmsg: string; access_token?: string; expires_in?: number };
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`获取钉钉 access_token 失败: ${data.errcode} ${data.errmsg}`);
  }
  return data.access_token;
}

// ============== Operator ID ==============

async function getOperatorId(token: string, config?: WorkspaceConfig): Promise<string> {
  // 演示模式: 使用环境变量, 启用缓存
  if (config?.demoMode) {
    if (operatorIdCache) return operatorIdCache;
    if (OPERATOR_ID) {
      operatorIdCache = OPERATOR_ID;
      return OPERATOR_ID;
    }
    // 演示模式也尝试自动获取
    const id = await autoFetchOperatorId(token);
    operatorIdCache = id;
    return id;
  }

  // 正常模式: 使用用户传入的 operatorId
  const opId = config?.operatorId?.trim();
  if (!opId) {
    throw new Error('缺少操作人 ID: 请在设置页面填写 UnionId');
  }
  return opId;
}

async function autoFetchOperatorId(token: string): Promise<string> {
  try {
    const url = `${API_BASE}/v1.0/contact/users/me`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = (await res.json()) as { unionId?: string };
      if (data.unionId) {
        console.log(`[钉钉] 自动获取 operatorId 成功: ${data.unionId}`);
        return data.unionId;
      }
    }
  } catch {
    // ignore
  }
  throw new Error('自动获取 operatorId 失败, 请手动填写 UnionId');
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

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

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

// ============== 字段构建 ==============

/**
 * 钉钉表格附件字段只接受图片 URL (http/https), 不接受 base64 或其他文本
 */
function isStorableImageUrl(value: string): boolean {
  const v = value.trim();
  return /^https?:\/\//i.test(v);
}

/**
 * 根据 ParsedJob 构建钉钉表格字段
 * 严格对齐 16 个字段, null 值字段不写入
 */
function buildFields(parsed: ParsedJob): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  // ---- 核心字段 ----
  if (parsed.company) fields['公司'] = parsed.company;
  if (parsed.position) fields['岗位'] = parsed.position;
  if (parsed.job_code) fields['岗位编号'] = parsed.job_code;

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

  // ---- 岗位描述 (过滤占位文本) ----
  if (parsed.description && !isPlaceholderValue(parsed.description)) {
    fields['岗位描述'] = parsed.description;
  }

  // ---- 岗位要求 (过滤占位文本) ----
  if (parsed.requirements && !isPlaceholderValue(parsed.requirements)) {
    fields['岗位要求'] = parsed.requirements;
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
  if (parsed.todo) fields['待办'] = parsed.todo;

  // ---- 预计耗时 (数字) ----
  // 按状态对照表强制同步: 有待办写对应值, 无待办写 null 清空旧值
  if (parsed.status_hint && parsed.status_hint in ESTIMATED_MINUTES_BY_STATUS) {
    if (parsed.todo) {
      const min = parsed.estimated_minutes ?? ESTIMATED_MINUTES_BY_STATUS[parsed.status_hint];
      fields['预计耗时'] = min != null ? Number(min) : null;
    } else {
      // 无待办 → 清空旧值 (已投递/Offer/已挂等状态)
      fields['预计耗时'] = null;
    }
  }

  // ---- 链接 (超链接字段, 需要 {link, text} 对象格式) ----
  if (parsed.source_url) {
    const cleanedUrl = cleanedUrlString(parsed.source_url);
    if (cleanedUrl) {
      fields['链接'] = {
        text: '报名链接',
        link: cleanedUrl,
      };
    }
  }

  // ---- 优先级标记 ----
  if (parsed.priority) {
    fields['优先级标记'] = normalizePriority(parsed.priority);
  }

  // ---- 信息来源渠道 ----
  if (parsed.source_channel && parsed.source_channel.trim() !== '') {
    fields['信息来源渠道'] = parsed.source_channel.trim();
  }

  // ---- 原始输入文本 ----
  if (parsed.raw_text && parsed.raw_text.trim() !== '') {
    fields['原始输入文本'] = parsed.raw_text.trim();
  }

  // ---- 原始输入图片 ----
  // 钉钉表格的图片字段是附件类型, 只接受图片 URL, 不接受 base64/文本
  if (parsed.raw_image && isStorableImageUrl(parsed.raw_image)) {
    fields['原始输入图片'] = parsed.raw_image.trim();
  }

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

  // 规则 1: null 不覆盖已有有效值 (预计耗时、原始输入文本除外)
  // - 预计耗时: 状态变更时需要清空
  // - 原始输入文本: 由追加逻辑单独处理, 过滤阶段不参与
  if (isEmpty(newValue) && !isEmpty(oldValue) && key !== '预计耗时' && key !== '原始输入文本' && key !== '原始输入图片') {
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
  // 优先级="中" 是 AI 默认值, 不应覆盖用户已设置的优先级
  if (key === '优先级标记' && newValue === '中') {
    if (!isEmpty(oldValue) && oldValue !== '中') {
      console.log(`    [保护] 字段 "优先级标记" 新值为默认"中", 旧值为 ${JSON.stringify(oldValue)}, 跳过`);
      return false;
    }
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
  console.log(`[钉钉] 准备写入的字段:`, JSON.stringify(fields, null, 2));

  const url = buildUrl('records', baseId, finalSheetId, operatorId);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records: [{ fields }] }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('钉钉新增失败:', res.status, errText);
    throw new Error(`新增钉钉记录失败: HTTP ${res.status} - ${errText}`);
  }

  const data = (await res.json()) as {
    value?: Array<{ id: string }>;
    code?: string;
    message?: string;
    requestid?: string;
  };

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

  // 追加原始输入图片 (同样只追加可存储的图片 URL)
  if (existingRecord && parsed.raw_image && isStorableImageUrl(parsed.raw_image)) {
    const existingRaw = String(existingRecord.fields['原始输入图片'] ?? '');
    const newEntry = formatRawTextEntry(parsed.raw_image);
    if (existingRaw) {
      fields['原始输入图片'] = `${existingRaw}\n${'─'.repeat(20)}\n${newEntry}`;
    } else {
      fields['原始输入图片'] = newEntry;
    }
  }

  // 如果没有任何字段需要更新, 跳过 API 调用
  if (Object.keys(fields).length === 0) {
    console.log('[钉钉] 无实际变化的字段, 跳过更新');
    return { recordId, fields: existingRecord?.fields ?? {} } as unknown as DingTalkRecord;
  }

  console.log(`[钉钉] 准备更新的字段:`, JSON.stringify(fields, null, 2));

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      records: [
        {
          id: recordId,
          fields,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('钉钉更新失败:', res.status, errText);
    throw new Error(`更新钉钉记录失败: HTTP ${res.status} - ${errText}`);
  }

  console.log(`[钉钉] 更新成功: recordId=${recordId}`);
  return { recordId, fields };
}

// ============== 匹配逻辑 ==============

export function findRecordByJobCode(
  jobCode: string | null | undefined,
  records: DingTalkRecord[]
): DingTalkRecord | null {
  if (!jobCode) return null;

  const code = jobCode.trim();
  if (!code) return null;

  for (const record of records) {
    const fields = record.fields as Record<string, unknown>;
    const recordCode = String(fields['岗位编号'] ?? '').trim();
    if (recordCode && recordCode === code) {
      console.log(`[匹配] 通过岗位编号匹配成功: ${code} → ${record.recordId}`);
      return record;
    }
  }

  console.log(`[匹配] 岗位编号未找到匹配: ${code}`);
  return null;
}

export async function matchRecord(
  parsed: ParsedJob,
  existingRecords: DingTalkRecord[]
): Promise<DingTalkRecord | null> {
  // 优先岗位编号精确匹配
  if (parsed.job_code) {
    const byCode = findRecordByJobCode(parsed.job_code, existingRecords);
    if (byCode) return byCode;
    // 有岗位编号但不匹配时, 不回退到模糊匹配, 避免不同岗位互相覆盖
    console.log(`[匹配] 岗位编号 ${parsed.job_code} 未匹配, 跳过模糊匹配, 将创建新记录`);
    return null;
  }

  // 无岗位编号时, 回退到模糊匹配
  return aiMatchRecord(parsed.match_key, existingRecords);
}

export async function aiMatchRecord(
  newMatchKey: string,
  existingRecords: DingTalkRecord[]
): Promise<DingTalkRecord | null> {
  if (existingRecords.length === 0) return null;

  // 统一使用精确匹配, 避免 AI 将同一公司不同岗位误判为相同
  return simpleFuzzyMatch(newMatchKey, existingRecords);
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

function simpleFuzzyMatch(
  matchKey: string,
  records: DingTalkRecord[]
): DingTalkRecord | null {
  const keyLower = matchKey.toLowerCase().replace(/\s+/g, '');
  const keyParts = keyLower.split(/[-_]/);
  const keyCompany = keyParts[0] ?? '';
  const keyPosition = normalizePosition(keyParts.slice(1).join('-'));

  console.log(`[匹配] simpleFuzzyMatch: matchKey="${matchKey}", keyCompany="${keyCompany}", keyPosition="${keyPosition}", 共${records.length}条记录`);

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
        console.log(`  [匹配成功] 优先级1 (公司+岗位): recordId=${record.recordId}`);
        return record;
      }
    }
  } else {
    console.log(`  [跳过] 优先级1: keyCompany="${keyCompany}", keyPosition="${keyPosition}" (需两者都非空)`);
  }

  // 第二优先: 仅公司名匹配 (进展更新场景, 如"大疆收到群面通知")
  // 只有当该公司在表格中只有一条记录时才自动匹配, 避免同公司多岗位歧义
  // 注意: 如果 match_key 中包含岗位信息 (keyPosition 非空), 跳过此回退,
  // 否则同公司不同岗位的批量提交会误匹配到刚创建的记录
  if (keyCompany && !keyPosition) {
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

function normalizePriority(priority: string): string {
  const validPriorities = ['高', '中', '低', '暂缓'];
  const normalized = priority.trim();

  if (validPriorities.includes(normalized)) {
    return normalized;
  }

  const map: Record<string, string> = {
    '紧急': '高', '急招': '高', '尽快': '高', '最高': '高',
    'high': '高', 'medium': '中', 'normal': '中',
    'low': '低', '暂缓': '暂缓', 'later': '暂缓',
  };

  const lower = normalized.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (lower.includes(key.toLowerCase()) || normalized.includes(key)) {
      return value;
    }
  }

  return '中';
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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recordIds: [recordId] }),
  });

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

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('钉钉轻量更新失败:', res.status, errText);
    throw new Error(`轻量更新钉钉记录失败: HTTP ${res.status} - ${errText}`);
  }

  console.log(`[钉钉] 轻量更新成功: recordId=${recordId}`);
}

// ============== 辅助函数 ==============

/**
 * 检测占位文本: AI 返回的无效内容 (如 "暂无岗位描述", "无", "未知")
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
