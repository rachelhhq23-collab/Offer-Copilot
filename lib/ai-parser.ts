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
import { ESTIMATED_MINUTES_BY_STATUS } from './types';

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

const TEXT_TIMEOUT = 15000;
const IMAGE_TIMEOUT = 60000;

// ============== System Prompt ==============

function buildSystemPrompt(): string {
  const today = new Date();
  const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const year = today.getFullYear();

  return `你是一个招聘信息解析器。用户会提交一段招聘通知内容, 可能是文字、图片或混合内容。
当前日期是 ${todayStr}, 请基于当前日期判断年份和优先级。

你需要处理两种输入场景:
1. **完整招聘通知**: 包含公司、岗位、JD 等完整信息
2. **简短进展更新**: 比如"大疆收到群面通知"、"百度DDL改为2026-09-30"、"美团内推码ABC123" 这类只有几个字段的更新

对于"简短进展更新", 你需要:
- 尽力提取公司名(必须)、岗位名(如有)、状态变化、待办、截止日期等明确信息
- 其他未提及的字段一律填 null (不要编造)
- match_key 必须包含公司名, 如果能识别岗位也要包含, 格式: "公司-岗位" 或 "公司"
- 如果输入只是更新某个字段(如 DDL), 只提取那个字段即可

钉钉 AI 表格有以下 16 个字段, 你提取的信息必须和这些字段对齐:
  公司(文本) | 岗位(文本) | 岗位编号(文本) | 城市(多选)
  投递DDL(日期) | 岗位描述(文本) | 岗位要求(文本) | 投递数量限制(数字)
  内推码(文本) | 状态(单选) | 待办(文本) | 预计耗时(数字)
  备注(文本) | 来源链接(网页链接) | 优先级标记(单选) | 最后更新时间(自动)

首先, 判断消息类型 (message_type):
- 如果内容里能提取出 2 个或以上不同的岗位 (不同的岗位名称或不同的岗位编号), 判定为 "batch"
- 如果只有 1 个明确的岗位, 判定为 "single"

城市字段是多选, 只能从以下选项中选择: 北京 / 上海 / 深圳 / 广州 / 杭州 / 成都 / 海外 / 其他 / 未知
没提到就填 ["未知"], 提到多个就全部列出来。

状态字段只能从以下选项中选择:
  待投递 / 已投递 / 测评 / 笔试 / AI面 / 群面 / 一面 / 二面 / 三面 / HR面 / Offer / 已拒绝 / 简历挂 / 测评挂 / 笔试挂 / 面试挂 / 已挂

优先级标记只能从以下选项中选择: 高 / 中 / 低 / 暂缓

进展更新的状态语义映射 (当用户没明确说状态时, 从文字推断):
- "收到群面"/"进入群面" → 状态: 群面, 待办: 待群面
- "收到一面"/"进入一面" → 状态: 一面, 待办: 待一面
- "收到测评"/"进入测评" → 状态: 测评, 待办: 待测评
- "收到笔试"/"进入笔试" → 状态: 笔试, 待办: 待笔试
- "已投递"/"已网申" → 状态: 已投递, 待办: 等待筛选结果
- "收到Offer" → 状态: Offer, 待办: 确认Offer
- "简历挂"/"测评挂"/"笔试挂"/"面试挂" → 对应挂状态, 待办: null
- "DDL改为XXX"/"截止日期XXX" → 只更新 deadline 字段, 其他不变

=== 格式 A: single (单一岗位) ===
{
  "message_type": "single",
  "company": "公司名称, 识别不到就填 null",
  "position": "岗位名称, 识别不到就填 null",
  "job_code": "岗位编号, 比如 J100665, 没有就填 null",
  "city": ["城市数组, 只能从预设选项中选, 没提到就填 ['未知']"],
  "deadline": "格式 YYYY-MM-DD, 招满即止/不设截止就填 null",
  "description": "岗位描述, 没有明确描述就填 null",
  "requirements": "岗位要求摘要, 没有就填 null",
  "application_limit": 投递数量限制的数字, 比如 '每人限投1个' 就填 1, 没提到就填 null,
  "referral_code": "内推码, 没有就填 null",
  "status_hint": "状态, 只能是预设选项之一, 默认 '待投递'",
  "todo": "具体可执行的下一步动作, 必须包含关键信息(比如投递入口、内推码)。
           如果消息本身没有要求用户做任何动作(纯资讯/祝贺类), 这里必须填 null, 不能编造",
  "estimated_minutes": "数字。按 status_hint 对照表填写, 与状态严格对齐:
                        待投递=20 (网申/投递简历),
                        测评=60,
                        笔试=60 (但如果消息原文明确写了具体时长, 比如"90分钟笔试""笔试时长2小时", 优先用消息里的真实值, 不用60),
                        AI面/群面/一面/二面/三面/HR面=120,
                        已投递/Offer/已拒绝/简历挂/测评挂/笔试挂/面试挂/已挂=null (流程已结束或无需用户行动)。
                        如果 todo 为 null, 这里必须也是 null",
  "source_url": "报名链接或原文中的URL, 没有就填 null, 不要加markdown反引号",
  "priority": "优先级, 只能是预设选项之一。判断逻辑(基于当前日期):
              - 高: 最近一个未过期场次在7天内, 或内容有'急招'/'紧急'/'尽快'等关键词
              - 中: 最近一个未过期场次在7-30天内
              - 低: 最近一个未过期场次在30天以上, 或没有截止日期但有明确投递要求
              - 暂缓: 所有场次都已过期, 或没有截止日期且优先级不明确",
  "remark": "备注信息, 没有就填 null",
  "match_key": "公司+岗位组合, 用于模糊匹配兜底"
}

=== 格式 B: batch (批量岗位列表) ===
{
  "message_type": "batch",
  "source_company": "发消息的公司名称",
  "shared_fields": {
    "deadline": "整条消息共享的截止日期 YYYY-MM-DD, 没有就填 null",
    "application_limit": 数字, 比如 '每人限投1个' 就填 1, 没有就填 null,
    "referral_code": "整条消息共享的内推码, 没有就填 null",
    "source_link": "网申入口链接, 没有就填 null",
    "city": ["整条消息共享的城市数组, 没提到就填 ['未知']"],
    "requirements": "整条消息共享的岗位要求(如学历、专业、面向对象等), 没有就填 null"
  },
  "candidates": [
    {
      "position": "具体岗位/职位名称",
      "job_code": "该岗位单独的编号, 没有就填 null",
      "description": "该岗位单独的描述, 没有就填 null",
      "requirements": "该岗位的要求。如果消息有共享的学历/专业/面向对象等要求, 必须填入此处, 不能填 null"
    }
  ]
}

要求:
1. 只返回 JSON, 不要有任何解释文字或 markdown 包裹
2. 日期格式必须是 YYYY-MM-DD, 如 ${year}-08-15
3. 日期年份: 如果消息中明确提到2027年, 则用2027; 否则默认用2026年
4. estimated_minutes 和 application_limit 必须是数字或 null, 不能是字符串
5. 如果某个字段无法从内容中提取, 使用 null
6. match_key 中的公司名使用常用简称, 比如"腾讯科技"→"腾讯", "阿里巴巴"→"阿里"
7. status_hint 和 priority 只能从指定选项中选择一个
8. city 字段始终是数组, 即使只有一个城市也要用 ["北京"] 格式
9. todo 字段: 如果消息没有要求用户做任何动作(比如祝贺、资讯类), 必须填 null
10. batch 格式的 candidates 按消息里出现的顺序排列
11. source_url / source_link 不要加 markdown 反引号
12. batch 格式: 每个候选岗位的 requirements 必须填写。如果消息有共享的学历/专业/面向对象等要求, 每个岗位都要填入这些共享要求`;
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
  textContent: string
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
      requirements: rawShared.requirements ?? parsed.requirements ?? null,
    };

    const data: BatchParsedResult = {
      message_type: 'batch',
      source_company: parsed.source_company ?? parsed.company ?? '未知公司',
      shared_fields: shared,
      candidates: Array.isArray(parsed.candidates)
        ? parsed.candidates.map((c: any) => ({
            position: c.position ?? '',
            job_code: c.job_code ?? null,
            description: c.description ?? null,
            requirements: c.requirements ?? null,
          }))
        : [],
    };
    return { message_type: 'batch', data };
  } else {
    // single 格式
    const city = normalizeCityArray(parsed.city ?? ['未知']);

    // 强制修正: 根据状态对照表重新计算 estimated_minutes, 确保与状态严格对齐
    const status = parsed.status_hint ?? '待投递';
    const todo = parsed.todo ?? null;
    let estimatedMinutes: number | null = null;

    if (todo) {
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
      job_code: parsed.job_code ?? null,
      city,
      deadline: parsed.deadline ?? null,
      description: parsed.description ?? null,
      requirements: parsed.requirements ?? null,
      application_limit: parsed.application_limit ?? null,
      referral_code: parsed.referral_code ?? null,
      status_hint: parsed.status_hint ?? '待投递',
      todo,
      estimated_minutes: estimatedMinutes,
      match_key: matchKey,
      source_url: parsed.source_url ?? null,
      priority: parsed.priority ?? '中',
      remark: parsed.remark ?? null,
      locations: Array.isArray(parsed.locations) ? parsed.locations : [],
    };
    return { message_type: 'single', data };
  }
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

  return parseJsonFromAi(textContent);
}

// ============== 图片解析 (千问) ==============

const VISION_PROMPT = `请识别这张图片中的所有文字内容, 然后提取招聘相关信息, 严格按以下 JSON 格式输出。

当前日期: ${new Date().getFullYear()}年${new Date().getMonth() + 1}月${new Date().getDate()}日

提取规则:
- company: 公司名称 (必填, 从图片中找)
- position: 岗位名称 (必填, 从图片中找所有岗位)
- city: 城市数组, 只能选: 北京/上海/深圳/广州/杭州/成都/海外/其他/未知
- deadline: 截止日期, 格式 YYYY-MM-DD, 没有填 null
- referral_code: 内推码, 没有填 null
- source_url: 报名链接, 没有填 null
- requirements: 学历/专业/面向对象等要求, 没有填 null
- status_hint: 状态, 默认"待投递"
- priority: 优先级 高/中/低/暂缓

判断 single vs batch:
- 图片中有 2 个或以上不同岗位 → message_type = "batch", 每个岗位放在 candidates 数组
- 只有 1 个岗位 → message_type = "single"

=== single 格式 ===
{
  "message_type": "single",
  "company": "公司名",
  "position": "岗位名",
  "city": ["城市"],
  "deadline": "2026-08-15",
  "referral_code": "内推码或null",
  "source_url": "链接或null",
  "requirements": "要求或null",
  "description": null,
  "status_hint": "待投递",
  "priority": "中",
  "match_key": "公司-岗位"
}

=== batch 格式 ===
{
  "message_type": "batch",
  "source_company": "公司名",
  "shared_fields": {
    "deadline": "2026-08-15",
    "referral_code": "内推码或null",
    "source_link": "链接或null",
    "city": ["城市"],
    "requirements": "共享要求或null"
  },
  "candidates": [
    {"position": "岗位1", "description": null, "requirements": null},
    {"position": "岗位2", "description": null, "requirements": null}
  ]
}

只输出 JSON, 不要任何解释文字。`;

function normalizeImageData(image: string): string {
  if (image.startsWith('data:')) {
    return image;
  }
  return `data:image/png;base64,${image}`;
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
  const imageData = normalizeImageData(imageBase64);

  const runOnce = async (strict: boolean) => {
    const systemPrompt = strict
      ? '你是一个严谨的招聘信息提取器。识别图片中的文字, 严格按照用户要求的 JSON 格式输出。只输出 JSON 对象, 不要任何多余内容。'
      : VISION_PROMPT;

    const userText = strict
      ? '识别这张图片, 提取所有招聘信息, 输出 JSON'
      : '识别这张图片中的招聘信息';

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

    return parseJsonFromAi(textContent);
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
