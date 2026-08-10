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
import { ESTIMATED_MINUTES_BY_STATUS, isWaitingTypeTodo } from './types';

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
- "一面结束"/"二面结束"/"面试结束了" → 状态不变(保留原状态), 待办: "XX结束, 等待下一步通知"(例如"一面结束, 等待下一步通知")
- "测评完成"/"笔试完成"/"已完成测评" → 状态不变, 待办: "测评完成, 等待结果" 或 "笔试完成, 等待结果"

【优先级判断规则 - 必须严格遵守, 覆盖DDL距离判断】
- 高优先级: 状态为"待投递""测评""笔试""AI面""群面""一面""二面""三面""HR面" (即需要用户采取行动的状态, 这类DDL通常在一周内)
- 中优先级: 收到明确通知且DDL在7-30天
- 低优先级: 状态为"已投递""Offer""已拒绝" 或 DDL在30天以上 (即已完成当前步骤, 等待结果的状态)
- 暂缓: 所有场次都已过期, 或状态为"简历挂""测评挂""笔试挂""面试挂""已挂"

=== 格式 A: single (单一岗位) ===
{
  "message_type": "single",
  "company": "公司名称, 识别不到就填 null",
  "position": "岗位名称, 识别不到就填 null",
  "job_code": "岗位编号, 必须是消息正文中明确标注的岗位编号(如 J100665, A1024B), 没有就填 null。严禁从URL参数中提取id/pid等数字作为岗位编号",
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
  "source_url": "与当前状态最相关的链接。面试通知→填面试链接, 测评通知→填测评链接, 招聘信息→填网申/报名链接。不要填飞书下载等通用工具链接。没有就填 null, 不要加markdown反引号",
  "priority": "优先级, 只能是预设选项之一。按状态优先判断(覆盖DDL距离):
              - 高: 状态为待投递/测评/笔试/AI面/群面/一面/二面/三面/HR面 (需要用户采取行动的状态)
              - 中: 状态为待投递但DDL在30天以上, 或DDL在7-30天
              - 低: 状态为已投递/Offer/已拒绝, 或DDL在30天以上且无紧迫任务
              - 暂缓: 所有场次都已过期, 或状态为简历挂/测评挂/笔试挂/面试挂/已挂",
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
      "job_code": "该岗位单独的编号, 必须是正文明确标注的, 严禁从URL参数提取, 没有就填 null",
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

    const status = parsed.status_hint ?? '待投递';
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
    const isNoActionTodo = isWaitingTypeTodo(todo);

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

    // 优先级强制修正: 按状态驱动, 覆盖 AI 返回值
    const highPriorityStatuses = [
      '待投递', '测评', '笔试', 'AI面', '群面', '一面', '二面', '三面', 'HR面'
    ];
    const suspendedStatuses = ['简历挂', '测评挂', '笔试挂', '面试挂', '已挂'];
    const lowPriorityStatuses = ['已投递', 'Offer', '已拒绝'];
    let priority = parsed.priority ?? '中';
    if (highPriorityStatuses.includes(status)) {
      // 但如果是等待结果场景 (如"一面结束了等待结果", 状态还是"一面", 但实际已完成), 降为低
      if (isNoActionTodo) {
        priority = '低';
      } else {
        priority = '高';
      }
    } else if (suspendedStatuses.includes(status)) {
      priority = '暂缓';
    } else if (lowPriorityStatuses.includes(status)) {
      priority = '低';
    }
    console.log(`[AI解析] 状态="${status}", todo="${todo ?? 'null'}" → 优先级修正为 "${priority}" (原始="${parsed.priority ?? '中'}")`);

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
      source_url: resolveSourceUrl(parsed.source_url, status, rawText ?? ''),
      priority,
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

    // 没有截止日期时, 优先级降为低
    if (!sf.deadline && batchData.candidates.length > 0) {
      // priority 在 batch 中不存在, 无需处理
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

    // 没有截止日期时, 优先级降为低
    if (!jobData.deadline && jobData.priority !== '高') {
      jobData.priority = '低';
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
- requirements: 只有图片明确写了学历/专业/面向对象等要求时才提取, 没有填 null
- status_hint: 状态, 默认"待投递"
- priority: 只有图片明确提到优先级(如急招/紧急)时才设为高, 没有截止日期时默认"低"

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
  "requirements": "要求或null",
  "description": null,
  "status_hint": "待投递",
  "priority": "低",
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
    "city": ["城市或未知"],
    "requirements": "共享要求或null"
  },
  "candidates": [
    {"position": "岗位族1或具体岗位1", "description": null, "requirements": null},
    {"position": "岗位族2或具体岗位2", "description": null, "requirements": null}
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
