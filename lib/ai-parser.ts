/**
 * AI 解析模块 —— 双模型架构
 *
 * 文本输入 → Deepseek (deepseek-chat)
 * 图片输入 → 阿里云百炼千问 (qwen-vl-flash)
 *
 * 两者均使用 OpenAI 兼容接口格式
 */

import type {
  ParsedJob,
  BatchParsedResult,
  MessageType,
  BatchSharedFields,
} from './types';
import { ESTIMATED_MINUTES_BY_STATUS, isWaitingTypeTodo, normalizeStatus } from './types';

// ============== 环境变量 (仅演示模式使用) ==============

const ENV_DEEPSEEK_API_KEY = process.env.DEMO_DEEPSEEK_API_KEY ?? '';
const ENV_DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
const ENV_DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';

const ENV_QWEN_API_KEY = process.env.DEMO_QWEN_API_KEY ?? '';
const ENV_QWEN_MODEL = process.env.QWEN_MODEL ?? 'qwen-vl-plus';
const ENV_QWEN_BASE_URL =
  process.env.QWEN_BASE_URL ??
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** AI 配置: 由调用方传入 */
export interface AIConfig {
  deepseekKey?: string;
  qwenKey?: string;
  demoMode?: boolean;
}

// Vercel Hobby 函数硬上限 10s: AI 解析之后还要串行执行钉钉写入 (token 已缓存,
// 典型 1-2s), 因此 AI 超时设 5.5s (图片 6s), 超时后仍有 ~4.5s 用于返回/写入,
// 避免"AI 占满 7s + 写入 3s"超过 10s 被 Vercel 强杀成 504 空响应
const TEXT_TIMEOUT = 5500;
const IMAGE_TIMEOUT = 6000;

// ============== System Prompt ==============

function buildSystemPrompt(): string {
  const today = new Date();
  const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const year = today.getFullYear();

  return `招聘信息解析器。当前日期: ${todayStr}。处理完整招聘通知和简短进展更新(如"收到群面""DDL改为XXX")。进展更新只提取明确信息,其他填null,不编造。

message_type: 2个以上不同岗位名称或编号→batch; 岗位方向/类别(如"技术类""产品类")不算独立岗位,按single处理。

城市(多选): 北京/上海/深圳/广州/杭州/成都/海外/其他/未知。没提到填["未知"]。
状态(单选): 待投递/已投递/测评/笔试/AI面/群面/一面/二面/三面/HR面/Offer/已拒绝/简历挂/测评挂/笔试挂/面试挂/已挂。
状态映射: "收到群面邀请/群面通知"→群面, "收到测评邀请/测评通知/邀您参加在线测评"→测评, "收到笔试邀请/笔试通知"→笔试, "已投递/网申成功"→已投递, "收到Offer"→Offer, "XX结束"→状态不变/待办填"XX结束,等待下一步通知", "XX完成"→状态不变/待办填"XX完成,等待结果"。status_hint 必须且只能从上一行枚举中选一个值原样填写, 严禁返回"待测评""在线测评""测评中"等任何变体。

宣讲会行程(info_session)提取规则(重要):
- 如果内容提到学校宣讲会/双选会/招聘会, 必须提取完整的时间+地点到 info_session 字段
- 地点必须包含具体的教学楼和教室, 不能只写校区 (如"教3-201""学生活动中心301", 不能只写"下沙校区")
- 格式: "日期+时间+教学楼+教室", 如"9月15日14:00 教3-201""9月20日19:00 学生活动中心301"
- 没有宣讲会信息时填 null

备注(remark)提取规则:
- 只记录宣讲会以外的补充信息 (宣讲会信息已放入 info_session, 不要重复放入 remark)
- 没有补充信息填 null

=== single ===
{"message_type":"single","company":"公司名,null","position":"岗位名,null","city":["城市数组"],"deadline":"YYYY-MM-DD,null","application_limit":数字或null,"referral_code":"内推码,null","status_hint":"状态,默认待投递","todo":"下一步动作,纯资讯填null","estimated_minutes":"待投递=20,测评=60,笔试=60(原文有具体时长用真实值),面试类=120,结束状态/null=null","source_url":"与状态最相关的链接,不加反引号,null","priority":null,"info_session":"宣讲会行程或null","remark":"备注,null","match_key":"公司-岗位"}

=== batch ===
{"message_type":"batch","source_company":"公司名","shared_fields":{"deadline":"YYYY-MM-DD,null","application_limit":数字或null,"referral_code":"内推码,null","source_link":"网申链接,null","city":["城市数组"]},"candidates":[{"position":"岗位名"}]}

要求: 只返回JSON不加解释 | 日期YYYY-MM-DD | 年份:提到2027用2027否则用${year} | 数字或null不用字符串 | 无法提取填null | 公司名用简称 | city始终数组 | 纯资讯todo填null | source_url不加反引号

公司名识别规则(重要):
- 纯链接输入时,公司名必须从网页标题/页面正文/域名中准确提取,严禁凭域名发音臆测
- "公司名用简称"指使用企业官方简称(如"阿里巴巴""腾讯"),而非把陌生公司替换成发音相近的知名品牌
- 域名发音相似不等于同一公司:aukeys=傲基科技(非奥克斯Aux),aux=奥克斯,bytedance=字节跳动,tencent=腾讯
- 若仅凭链接无法确定公司全称,可保留域名中可识别的拼音部分作为公司名(如aukeys→傲基科技),但严禁替换成其他近似品牌
- 当链接中含品牌拼音且与已知中文品牌发音相近时,优先采用域名拼音对应的真实公司,而非更知名的同音品牌`;
}

// ============== 工具 ==============

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`AI 请求超时 (${timeoutMs}ms), 请稍后重试`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 AI 返回的 JSON 字符串, 自动识别 single / batch
 */
function parseJsonFromAi(
  textContent: string,
  rawText?: string
): { message_type: MessageType; data: ParsedJob | BatchParsedResult } {
  let jsonStr = textContent.trim();

  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const extracted = extractJsonObject(textContent);
    if (!extracted) {
      console.error('[AI] 无法从返回内容中提取 JSON:', textContent.slice(0, 2000));
      throw new Error('AI 返回内容格式异常, 无法解析');
    }
    parsed = JSON.parse(extracted);
  }

  const messageType: MessageType = parsed.message_type ?? 'single';

  if (messageType === 'batch') {
    // batch 格式
    const rawShared = parsed.shared_fields ?? {};
    const shared: BatchSharedFields = {
      deadline: rawShared.deadline ?? parsed.deadline ?? null,
      application_limit:
        rawShared.application_limit ?? parsed.application_limit ?? null,
      referral_code:
        rawShared.referral_code ?? parsed.referral_code ?? null,
      source_link: rawShared.source_link ?? parsed.source_link ?? null,
      city: normalizeCityArray(rawShared.city ?? parsed.city ?? ['未知']),
    };

    const data: BatchParsedResult = {
      message_type: 'batch',
      source_company: parsed.source_company ?? parsed.company ?? '未知公司',
      shared_fields: shared,
      candidates: Array.isArray(parsed.candidates)
        ? parsed.candidates.map((c: any) => ({
            position: c.position ?? '',
          }))
        : [],
    };
    return { message_type: 'batch', data };
  } else {
    // single 格式
    const city = normalizeCityArray(parsed.city ?? ['未知']);

    // 状态归一化: AI 可能返回"待测评""在线测评"等变体, 统一映射到标准枚举
    // 不归一化会导致后续优先级/预计耗时/todo 补全全部按错误状态计算, validator 还会兜底为"待投递"
    const status = normalizeStatus(parsed.status_hint) ?? '待投递';
    if (parsed.status_hint && parsed.status_hint !== status) {
      console.log(`[AI解析] 状态归一化: "${parsed.status_hint}" → "${status}"`);
    }
    let todo = parsed.todo ?? null;

    // 行动型状态 AI 漏填 todo 时, 自动补充默认待办 (防止 AI 只写了状态没写 todo 导致优先级/预计耗时出错)
    const actionStatusDefaults: Record<string, string> = {
      '待投递': '投递简历',
      '测评': '完成测评',
      '笔试': '参加笔试',
      'AI面': '准备AI面试',
      '群面': '准备群面',
      '一面': '准备一面',
      '二面': '准备二面',
      '三面': '准备三面',
      'HR面': '准备HR面试',
    };
    if (!todo && actionStatusDefaults[status]) {
      todo = actionStatusDefaults[status];
      console.log(`[AI解析] 行动型状态 ${status} 缺少 todo, 自动补全为 "${todo}"`);
    }

    // 如果todo是"等待结果"类文本, 视为无需用户行动 → 清空estimated_minutes
    const isNoActionTodo = isWaitingTypeTodo(todo, status);

    // 强制修正: 根据状态+待办类型重新计算 estimated_minutes, 确保与状态严格对齐
    let estimatedMinutes: number | null = null;
    if (todo && !isNoActionTodo) {
      // 笔试特殊处理: 如果 AI 返回的不是默认 60 (说明原文提到了具体时长, 如 90 分钟), 保留真实值
      const aiMinutes = parsed.estimated_minutes ?? null;
      if (status === '笔试' && aiMinutes !== null && aiMinutes !== 60) {
        estimatedMinutes = aiMinutes;
      } else {
        // 其他情况统一按状态对照表计算
        const defaultMin = ESTIMATED_MINUTES_BY_STATUS[status];
        estimatedMinutes = defaultMin ?? null;
      }
    }

    // 构造 match_key: 始终从 company+position 重建, 不信任 AI 返回值
    // AI 返回的 match_key 格式不稳定 (可能无分隔符、用了错误的公司名等), 容易导致匹配失败
    const company = parsed.company ?? '';
    const position = parsed.position ?? '';
    let matchKey: string;
    if (company && position) {
      matchKey = `${company}-${position}`;
    } else if (company) {
      matchKey = company;
    } else {
      matchKey = '未知';
    }
    console.log(`[AI解析] match_key: "${matchKey}" (company="${company}", position="${position}")`);

    const data: ParsedJob = {
      message_type: 'single',
      company: parsed.company ?? null,
      position: parsed.position ?? null,
      city,
      deadline: parsed.deadline ?? null,
      application_limit: parsed.application_limit ?? null,
      referral_code: parsed.referral_code ?? null,
      status_hint: status,
      todo,
      estimated_minutes: estimatedMinutes,
      match_key: matchKey,
      source_url: resolveSourceUrl(parsed.source_url, status, rawText ?? ''),
      info_session: parsed.info_session ?? null,
      remark: parsed.remark ?? null,
      locations: Array.isArray(parsed.locations) ? parsed.locations : [],
    };
    return { message_type: 'single', data };
  }
}

/**
 * 根据状态从原始文本中智能选择最相关的URL
 * AI 偶尔会返回错误的URL (如面试通知返回网申链接), 这里做后处理校验
 */
function resolveSourceUrl(aiUrl: string | null | undefined, status: string, rawText: string): string | null {
  if (!aiUrl) return null;
  if (!rawText) return aiUrl; // 图片解析等无原始文本场景, 信任 AI 返回值

  // 从原始文本中提取所有 URL
  const urlPattern = /https?:\/\/[^\s`"'，。、）)\]】]+/g;
  const allUrls = rawText.match(urlPattern) ?? [];

  // 排除通用工具链接 (飞书下载等)
  const toolDomains = ['feishu.cn/download', 'feishu.cn/dl', 'larksuite.com/download'];
  const candidateUrls = allUrls.filter((u) => !toolDomains.some((d) => u.includes(d)));

  // 根据状态匹配最相关的 URL
  const statusUrlPatterns: Record<string, string[]> = {
    '测评': ['eztest', 'exam', 'test', 'assessment', 'ceping', 'eval'],
    '笔试': ['exam', 'test', 'nowcoder', 'code', 'niuke'],
    'AI面': ['meeting', 'interview', 'video', 'zijieimg', 'feishu.cn', 'lark', 'zoom', 'tencentmeeting'],
    '群面': ['meeting', 'interview', 'video', 'zijieimg', 'feishu.cn', 'lark', 'zoom', 'tencentmeeting'],
    '一面': ['meeting', 'interview', 'video', 'zijieimg', 'feishu.cn', 'lark', 'zoom', 'tencentmeeting'],
    '二面': ['meeting', 'interview', 'video', 'zijieimg', 'feishu.cn', 'lark', 'zoom', 'tencentmeeting'],
    '三面': ['meeting', 'interview', 'video', 'zijieimg', 'feishu.cn', 'lark', 'zoom', 'tencentmeeting'],
    'HR面': ['meeting', 'interview', 'video', 'zijieimg', 'feishu.cn', 'lark', 'zoom', 'tencentmeeting'],
  };

  const patterns = statusUrlPatterns[status];
  if (patterns && candidateUrls.length > 0) {
    // 找到匹配状态关键词的URL
    const matched = candidateUrls.find((u) =>
      patterns.some((p) => u.toLowerCase().includes(p))
    );
    if (matched) {
      const cleaned = matched.replace(/[`"'，。、）)\]】]+$/, '');
      if (cleaned !== aiUrl) {
        console.log(`[AI解析] source_url 智能修正: 状态=${status}, AI返回=${aiUrl}, 修正为=${cleaned}`);
      }
      return cleaned;
    }
  }

  return aiUrl;
}

/**
 * 从模型输出中提取第一个可解析的 JSON 对象
 * 模型偶尔会在 JSON 前后附加解释文字, 这里按括号配对提取
 */
function extractJsonObject(text: string): string | null {
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            // 括号配对但内容非法, 继续找下一个对象
            break;
          }
        }
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return null;
}

/**
 * 规范化城市数组: 验证每个城市是否在预设列表中
 */
function normalizeCityArray(raw: unknown): string[] {
  const validCities = ['北京', '上海', '深圳', '广州', '杭州', '成都', '海外', '其他', '未知'];

  let arr: string[];
  if (Array.isArray(raw)) {
    arr = raw.map(String);
  } else if (typeof raw === 'string' && raw) {
    arr = [raw];
  } else {
    return ['未知'];
  }

  const normalized = arr
    .map((c) => c.trim())
    .filter((c) => {
      if (!c) return false;
      // 尝试模糊匹配
      for (const vc of validCities) {
        if (c === vc || c.includes(vc)) return true;
      }
      return false;
    });

  if (normalized.length === 0) return ['未知'];
  return normalized;
}

// ============== 文本解析 (Deepseek) ==============

async function parseTextWithDeepseek(
  content: string,
  aiConfig?: AIConfig
): Promise<ReturnType<typeof parseJsonFromAi>> {
  const apiKey = aiConfig?.demoMode
    ? ENV_DEEPSEEK_API_KEY
    : aiConfig?.deepseekKey?.trim();
  if (!apiKey) {
    throw new Error('缺少 DeepSeek API Key, 请在设置页面配置');
  }
  const baseUrl = ENV_DEEPSEEK_BASE_URL;
  const model = ENV_DEEPSEEK_MODEL;

  const url = `${baseUrl}/chat/completions`;

  const t0 = Date.now();
  console.log(`[Deepseek] 开始请求, 超时=${TEXT_TIMEOUT}ms, 内容长度=${content.length}`);

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: `请解析以下招聘通知内容:\n\n""${content}""`,
          },
        ],
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      }),
    },
    TEXT_TIMEOUT
  );

  console.log(`[Deepseek] 响应耗时: ${Date.now() - t0}ms, 状态: ${res.status}`);

  if (!res.ok) {
    const errText = await res.text();
    console.error('[Deepseek] API 错误:', res.status, errText);
    throw new Error(`Deepseek 解析失败: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const textContent = data.choices?.[0]?.message?.content ?? '';
  if (!textContent) {
    throw new Error('Deepseek 返回内容为空');
  }

  return parseJsonFromAi(textContent, content);
}

// ============== 图片解析后处理: 清除AI幻觉 ==============

/**
 * 检测AI是否编造了城市信息。
 * 图片中未明确提到城市时, AI容易编造热门城市(如北京/上海/深圳)。
 * 判断逻辑: 如果只有1个城市且是热门城市, 极可能是编造的
 */
function isLikelyFabricatedCity(cities: string[]): boolean {
  const hotCities = ['北京', '上海', '深圳', '广州', '杭州', '成都'];
  if (cities.length === 0) return false;
  if (cities.length > 2) return false;
  // 只有1-2个城市且全是热门城市, 极可能是编造
  return cities.every((c) => hotCities.includes(c));
}

/**
 * 检测AI是否编造了日期。
 * 图片中未明确提到日期时, AI容易编造"12月31日"或未来日期。
 */
function isLikelyFabricatedDeadline(deadline: string | null): boolean {
  if (!deadline) return false;
  // 常见编造日期: 12月31日, 6月30日等月末日期
  const fabricatedPatterns = [
    /-12-31$/,
    /-06-30$/,
    /-01-01$/,
    /-12-?\d{2}$/, // 12月的任何日期
  ];
  return fabricatedPatterns.some((p) => p.test(deadline));
}

function sanitizeImageResult(
  result: { message_type: MessageType; data: ParsedJob | BatchParsedResult }
): { message_type: MessageType; data: ParsedJob | BatchParsedResult } {
  const { message_type, data } = result;

  if (message_type === 'batch') {
    const batchData = data as BatchParsedResult;
    const sf = batchData.shared_fields;

    // 清除可能编造的城市
    if (sf.city && isLikelyFabricatedCity(sf.city)) {
      console.warn(`[图片后处理] 检测到可能编造的城市: ${sf.city}, 清除为["未知"]`);
      sf.city = ['未知'];
    }

    // 清除可能编造的日期
    if (isLikelyFabricatedDeadline(sf.deadline)) {
      console.warn(`[图片后处理] 检测到可能编造的日期: ${sf.deadline}, 清除为null`);
      sf.deadline = null;
    }

  } else {
    const jobData = data as ParsedJob;

    // 清除可能编造的城市
    if (jobData.city && isLikelyFabricatedCity(jobData.city)) {
      console.warn(`[图片后处理] 检测到可能编造的城市: ${jobData.city}, 清除为["未知"]`);
      jobData.city = ['未知'];
    }

    // 清除可能编造的日期
    if (isLikelyFabricatedDeadline(jobData.deadline)) {
      console.warn(`[图片后处理] 检测到可能编造的日期: ${jobData.deadline}, 清除为null`);
      jobData.deadline = null;
    }

  }

  return result;
}

// ============== 图片解析 (千问) ==============

const VISION_PROMPT = `请仔细识别这张图片中的所有文字内容, 然后提取招聘相关信息, 严格按以下 JSON 格式输出。

当前日期: ${new Date().getFullYear()}年${new Date().getMonth() + 1}月${new Date().getDate()}日

【核心原则 - 必须严格遵守】
- 只提取图片中【明确出现】的文字信息, 看不到的一律填 null
- 严禁脑补/推测/编造任何图片中没有的信息
- 宁可信息少, 不可编造信息

【字段提取规则】
- company: 公司名称 (必填, 从图片中找)
- position: 岗位名称 (必填, 从图片中找所有岗位)
- city: 只有图片明确提到城市时才提取, 没提就填 ["未知"]
- deadline: 只有图片明确写了截止日期/DDL/截止时间时才填写 YYYY-MM-DD, 没写就填 null, 严禁编造日期
- referral_code: 只有图片明确写了内推码时才提取, 没有填 null
- source_url: 只有图片明确有链接时才提取, 没有填 null
- status_hint: 状态, 默认"待投递"; 只能从枚举中选一个原样填写: 待投递/已投递/测评/笔试/AI面/群面/一面/二面/三面/HR面/Offer/已拒绝/简历挂/测评挂/笔试挂/面试挂/已挂; 收到测评/笔试/面试通知时分别填 测评/笔试/对应面试阶段, 严禁返回"待测评"等变体
- info_session: 宣讲会行程。如果图片中提到学校宣讲会/双选会/招聘会的时间或地点, 必须提取完整的时间+教学楼+教室(不能只写校区), 格式如"9月15日14:00 教3-201"; 无宣讲会信息填 null
- remark: 备注字段。只记录宣讲会以外的补充信息(宣讲会信息已放入info_session); 无补充填 null

【batch 判断规则】
- 图片中列出多个岗位(如校招岗位列表) → message_type = "batch"
- 只有 1 个岗位 → message_type = "single"
- 如果图片标题是"XX届校园招聘"但正文列出了多个具体岗位(如"算法工程师""前端工程师""产品经理"), 必须判为 batch

【batch candidates 提取规则 - 严格执行】
1. 如果图片中岗位总数 ≤ 15个: 把每个具体岗位名称都放进 candidates 数组
2. 如果图片中岗位总数 > 15个 (如按岗位族/类别分类, 每类下还有多个细分岗位):
   - 只提取一级分类(岗位族)作为 candidates, 不要展开细分岗位
   - 例如图片中有"算法类(含NLP/CV/推荐算法等)"→ candidates 中只放"算法类"
   - 例如图片中有"研发类(含前端/后端/移动端等)"→ candidates 中只放"研发类"
3. 如果图片只有公司名和招聘大类, 没有具体岗位: candidates 填空数组 [], position 填 "校招岗位"

=== single 格式 ===
{
  "message_type": "single",
  "company": "公司名",
  "position": "岗位名",
  "city": ["城市或未知"],
  "deadline": "2026-08-15 或 null",
  "referral_code": "内推码或null",
  "source_url": "链接或null",
  "status_hint": "待投递",
  "info_session": "宣讲会行程或null",
  "remark": "备注或null",
  "match_key": "公司-岗位"
}

=== batch 格式 ===
{
  "message_type": "batch",
  "source_company": "公司名",
  "shared_fields": {
    "deadline": "2026-08-15 或 null",
    "referral_code": "内推码或null",
    "source_link": "链接或null",
    "city": ["城市或未知"]
  },
  "candidates": [
    {"position": "岗位族1或具体岗位1"},
    {"position": "岗位族2或具体岗位2"}
  ]
}

只输出 JSON, 不要任何解释文字。`;

function normalizeImageData(image: string): {
  dataUri: string;
  mime: string;
  estimatedBytes: number;
  base64Len: number;
} {
  // 输入可能已经是 data:image/xxx;base64,xxxx 格式
  if (image.startsWith('data:')) {
    const headerMatch = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
    const mime = headerMatch?.[1] ?? 'image/jpeg';
    const base64Payload = headerMatch ? image.slice(headerMatch[0].length) : image;
    const base64Len = base64Payload.length;
    // base64 解码后体积 ≈ len * 3/4
    const estimatedBytes = Math.floor(base64Len * 0.75);
    return { dataUri: image, mime, estimatedBytes, base64Len };
  }
  // 裸 base64, 默认当 jpeg (前端 compressImage 统一输出 jpeg)
  const base64Len = image.length;
  const estimatedBytes = Math.floor(base64Len * 0.75);
  return {
    dataUri: `data:image/jpeg;base64,${image}`,
    mime: 'image/jpeg',
    estimatedBytes,
    base64Len,
  };
}

async function parseImageWithQwen(
  imageBase64: string,
  aiConfig?: AIConfig
): Promise<ReturnType<typeof parseJsonFromAi>> {
  const apiKey = aiConfig?.demoMode
    ? ENV_QWEN_API_KEY
    : aiConfig?.qwenKey?.trim();
  if (!apiKey) {
    throw new Error('缺少千问 API Key, 请在设置页面配置');
  }
  const baseUrl = ENV_QWEN_BASE_URL;
  const model = ENV_QWEN_MODEL;

  const url = `${baseUrl}/chat/completions`;
  const imageInfo = normalizeImageData(imageBase64);
  const imageData = imageInfo.dataUri;

  // 诊断日志: 帮助排查 401 / 超时 / 空返回等常见问题
  console.log(
    `[千问视觉] 准备调用: model=${model}, baseUrl=${baseUrl}, ` +
      `MIME=${imageInfo.mime}, base64长度=${imageInfo.base64Len.toLocaleString()} chars, ` +
      `解码后约 ${(imageInfo.estimatedBytes / 1024 / 1024).toFixed(2)} MB, ` +
      `key前缀=${apiKey.slice(0, 4)}...${apiKey.slice(-4)}, key长度=${apiKey.length}`
  );
  // DashScope hard limit: HTTP payload ≤ 6MB, base64 图像 payload ≤ 4.5MB
  if (imageInfo.base64Len > 4500 * 1024) {
    console.warn(
      `[千问视觉] ⚠️ base64 payload 超过 4.5MB, DashScope compatible-mode 可能因 HTTP body > 6MB 返回 413 或截断导致 400/500`
    );
  }

  const runOnce = async (strict: boolean) => {
    const systemPrompt = strict
      ? '你是一个严谨的招聘信息提取器。识别图片中的文字, 严格按照用户要求的 JSON 格式输出。只输出 JSON 对象, 不要任何多余内容。'
      : VISION_PROMPT;

    const userText = strict
      ? '识别这张图片, 提取所有招聘信息, 输出 JSON'
      : '识别这张图片中的招聘信息';

    const t0 = Date.now();
    console.log(`[千问视觉] 开始请求, 超时=${IMAGE_TIMEOUT}ms, strict=${strict}`);

    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: imageData },
                },
                {
                  type: 'text',
                  text: userText,
                },
              ],
            },
          ],
          temperature: 0.1,
          max_tokens: 4096,
        }),
      },
      IMAGE_TIMEOUT
    );

    console.log(`[千问视觉] 响应耗时: ${Date.now() - t0}ms, 状态: ${res.status}, strict=${strict}`);

    if (!res.ok) {
      const errText = await res.text();
      console.error('[千问] API 错误:', res.status, errText);
      throw new Error(`千问视觉解析失败: HTTP ${res.status} - ${errText}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const textContent = data.choices?.[0]?.message?.content ?? '';
    if (!textContent) {
      throw new Error('千问返回内容为空');
    }

    console.log('[千问] 原始返回:', textContent.slice(0, 500));

    const result = parseJsonFromAi(textContent);

    // 图片解析后处理: 清除AI可能编造的字段
    return sanitizeImageResult(result);
  };

  try {
    return await runOnce(false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('格式异常') && !message.includes('返回内容为空')) {
      throw err;
    }
    console.warn('[千问] 首次返回格式异常, 以 strict 模式重试:', message);
    return await runOnce(true);
  }
}

// ============== 对外主入口 ==============

export interface ParseOptions extends AIConfig {
  content?: string;
  image?: string;
  forceType?: 'text' | 'image';
}

export async function parseJob(
  options: ParseOptions
): Promise<{ message_type: MessageType; data: ParsedJob | BatchParsedResult }> {
  const { content, image, forceType, deepseekKey, qwenKey, demoMode } = options;
  const aiConfig: AIConfig = { deepseekKey, qwenKey, demoMode };

  const inputType: 'text' | 'image' =
    forceType ?? (image ? 'image' : 'text');

  console.log(`[AI] 开始解析, 输入类型: ${inputType}`);

  if (inputType === 'image') {
    if (!image || image.trim().length === 0) {
      throw new Error('图片数据为空');
    }
    return parseImageWithQwen(image, aiConfig);
  } else {
    if (!content || content.trim().length === 0) {
      throw new Error('文本内容为空');
    }
    return parseTextWithDeepseek(content, aiConfig);
  }
}
