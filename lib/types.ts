/**
 * 共享类型定义 —— 对齐钉钉 AI 表格字段
 *
 * 钉钉表格字段:
 *   公司(文本) | 岗位(文本) | 城市(多选)
 *   投递DDL(日期) | 投递数量限制(数字)
 *   内推码(文本) | 状态(单选) | 待办(文本) | 预计耗时(数字)
 *   备注(文本) | 来源链接(链接) | 梯队(单选) | 信息来源渠道(文本)
 *   原始输入文本(文本) | 原始输入图片(文本) | 最后更新时间(自动)
 */

/** 有效信息来源渠道 */
export const VALID_SOURCE_CHANNELS = [
  '微信群消息',
  '钉钉群消息',
  'QQ群消息',
  '邮箱',
  '公众号',
  '官网',
  'boss直聘',
  '其他',
] as const;

export type ValidSourceChannel = (typeof VALID_SOURCE_CHANNELS)[number];

/** 消息类型: single=单一岗位, batch=批量岗位列表 */
export type MessageType = 'single' | 'batch';

/** AI 解析后的岗位信息 (single 模式) */
export interface ParsedJob {
  message_type: 'single';
  company: string | null;
  position: string | null;
  /** 城市数组, 多选字段, 从预设选项中选 */
  city: string[];
  deadline: string | null;
  application_limit: number | null;
  referral_code: string | null;
  status_hint: string;
  todo: string | null;
  /** 只有 todo 不为 null 时才有值, 否则必须为 null */
  estimated_minutes: number | null;
  match_key: string;
  /** 来源链接 (报名链接等) */
  source_url?: string | null;
  /** 梯队: A/B/C/S/SS (前端用户选填, 不选则保留已有值) */
  echelon?: string | null;
  /** 宣讲会行程 (时间+教学楼+教室, 如"9月15日14:00 教3-201"; 无则 null) */
  info_session?: string | null;
  /** 备注 (可选) */
  remark?: string | null;
  /** 信息来源渠道 */
  source_channel?: string | null;
  /** 原始输入文本 (用户提交的原文) */
  raw_text?: string | null;
  /** 原始输入图片 (base64 或 URL) */
  raw_image?: string | null;
  /** 预上传的图片附件 (已上传到钉钉, 跳过 createRecord/updateRecord 内的上传步骤) */
  preUploadedAttachment?: PreUploadedAttachment | null;
  /** 多个场次信息 (可选, 用于内部计算) */
  locations?: JobLocation[];
}

/** 预上传的图片附件 (与 dingtalk.ts 的 AttachmentItem 结构一致) */
export interface PreUploadedAttachment {
  filename: string;
  size: number;
  type: string;
  url: string;
  resourceId: string;
}

/** 单个场次信息 (内部使用, 不直接写入) */
export interface JobLocation {
  city: string;
  date: string | null;
}

/** 批量岗位候选项 */
export interface BatchCandidate {
  position: string;
}

/** 批量共享字段 (batch 模式) */
export interface BatchSharedFields {
  deadline: string | null;
  application_limit: number | null;
  referral_code: string | null;
  source_link: string | null;
  /** 城市数组, 整条消息共享的城市 */
  city: string[];
}

/** AI 解析后的批量结果 (batch 模式) */
export interface BatchParsedResult {
  message_type: 'batch';
  source_company: string;
  shared_fields: BatchSharedFields;
  candidates: BatchCandidate[];
}

/** 钉钉 AI 表格中的一条记录 */
export interface DingTalkRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

/** 历史记录视图中的记录 (带解析后的字段) */
export interface HistoryRecord {
  recordId: string;
  company: string;
  position: string;
  city: string[];
  deadline: string | null;
  status: string;
  last_updated_time: number | null;
  raw_text: string | null;
  raw_image: string | null;
  source_channel: string | null;
  todo: string | null;
  referral_code: string | null;
  source_url: string | null;
  info_session: string | null;
  // 原始 fields 供删除时使用
  _raw_fields?: Record<string, unknown>;
}

/** 历史记录筛选类型 */
export type HistoryFilter = 'all' | 'active' | 'ended';

/** 支持的输入类型 */
export type InputType = 'text' | 'image';

/** 有效状态列表 (与钉钉表格中的单选字段选项一致) */
export const VALID_STATUSES = [
  '待投递',
  '已投递',
  '测评',
  '笔试',
  'AI面',
  '群面',
  '一面',
  '二面',
  '三面',
  'HR面',
  'Offer',
  '已拒绝',
  '简历挂',
  '测评挂',
  '笔试挂',
  '面试挂',
  '已挂',
] as const;

export type ValidStatus = (typeof VALID_STATUSES)[number];

/**
 * 状态 → 预计耗时(分钟) 对照表
 * - 待投递=20, 测评=60, 笔试=60(默认; 消息原文有具体时长时以原文为准), 各面试=120
 * - 已投递及已结束状态=null (无需用户行动)
 * AI 解析、计划生成、前端展示均以此为准
 */
export const ESTIMATED_MINUTES_BY_STATUS: Record<string, number | null> = {
  待投递: 20,
  测评: 60,
  笔试: 60,
  AI面: 120,
  群面: 120,
  一面: 120,
  二面: 120,
  三面: 120,
  HR面: 120,
  已投递: null,
  Offer: null,
  已拒绝: null,
  简历挂: null,
  测评挂: null,
  笔试挂: null,
  面试挂: null,
  已挂: null,
};

/**
 * 将 AI 返回的状态文本归一化为 VALID_STATUSES 中的标准值。
 *
 * 背景: Prompt 虽要求 status_hint 必须取自枚举, 但大模型仍会返回
 * "待测评""在线测评""群面通知"等变体; 旧逻辑对非枚举值一律兜底为"待投递",
 * 导致进展更新(如测评通知)时状态无法流转、匹配后更新被"未变化"过滤跳过。
 *
 * 归一化策略: ① 精确命中枚举直接返回; ② 关键词包含匹配
 * (顺序敏感: 挂状态/Offer 等含阶段词的长词在前, 避免"测评挂"被"测评"抢先)。
 * 返回 null 表示无法识别, 由调用方决定兜底值。
 */
export function normalizeStatus(raw: string | null | undefined): ValidStatus | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // 1. 精确命中标准枚举
  if ((VALID_STATUSES as readonly string[]).includes(s)) {
    return s as ValidStatus;
  }

  // 2. 复合"失败/拒绝"表达检测: 必须在关键词规则之前处理,
  //    否则"群面挂""群面已挂"这类会被"群面"规则抢先误判为进行中状态
  const lower = s.toLowerCase();
  const isRejected = ['拒绝', '拒信', '感谢信', '被拒'].some((w) => lower.includes(w));
  const isFailed = ['挂', '没过', '未通过', '淘汰', '不通过', '被刷', '凉了'].some((w) => lower.includes(w));
  if (isRejected) return '已拒绝';
  if (isFailed) {
    // 按具体阶段映射到对应的挂状态 (面试阶段词优先, 因为"群面"属于面试)
    if (/面试|群面|ai\s?面|hr\s?面|人力面|一面|二面|三面|初面|终面|专业面|业务面|主管面|总监面/.test(lower)) {
      return '面试挂';
    }
    if (lower.includes('笔试')) return '笔试挂';
    if (/测评|评测|ot/.test(lower)) return '测评挂';
    if (/简历|初筛|筛选/.test(lower)) return '简历挂';
    return '已挂';
  }
  if (/流程结束|招聘结束|流程终止|校招流程将结束/.test(lower)) return '已挂';

  // 3. 关键词包含匹配 (顺序敏感, 更具体的规则放前面)
  const rules: Array<[string, ValidStatus]> = [
    // ---- 挂/拒绝类 (必须排在阶段词前面, 因为"测评挂"包含"测评") ----
    ['简历挂', '简历挂'], ['简历未通过', '简历挂'], ['简历没过', '简历挂'], ['简历淘汰', '简历挂'], ['筛选未通过', '简历挂'], ['简历筛选不通过', '简历挂'],
    ['测评挂', '测评挂'], ['测评未通过', '测评挂'], ['测评没过', '测评挂'], ['测评淘汰', '测评挂'], ['测评不通过', '测评挂'],
    ['笔试挂', '笔试挂'], ['笔试未通过', '笔试挂'], ['笔试没过', '笔试挂'], ['笔试淘汰', '笔试挂'], ['笔试不通过', '笔试挂'],
    ['面试挂', '面试挂'], ['面试未通过', '面试挂'], ['面试没过', '面试挂'], ['面试淘汰', '面试挂'], ['面试不通过', '面试挂'], ['终面挂', '面试挂'],
    ['已拒绝', '已拒绝'], ['被拒绝', '已拒绝'], ['拒信', '已拒绝'], ['感谢信', '已拒绝'], ['未录用', '已拒绝'],
    ['已挂', '已挂'], ['流程结束', '已挂'], ['招聘流程结束', '已挂'],
    // ---- Offer ----
    ['offer', 'Offer'], ['录用', 'Offer'], ['拟录取', 'Offer'], ['拟录用', 'Offer'], ['签约', 'Offer'], ['录取', 'Offer'],
    // ---- 面试类 (群面/AI面/HR面 与 一/二/三面 互不包含, 顺序无冲突) ----
    ['群面', '群面'],
    ['ai面', 'AI面'], ['ai 面', 'AI面'], ['ai面试', 'AI面'], ['ai 面试', 'AI面'],
    ['hr面', 'HR面'], ['hr 面', 'HR面'], ['hr面试', 'HR面'], ['hr 面试', 'HR面'], ['人力面', 'HR面'],
    ['一面', '一面'], ['初面', '一面'], ['1面', '一面'],
    ['二面', '二面'], ['复面', '二面'], ['2面', '二面'],
    ['三面', '三面'], ['终面', '三面'], ['3面', '三面'],
    // ---- 测评 / 笔试 ----
    ['测评', '测评'], ['评测', '测评'], ['ot测评', '测评'], ['在线测评', '测评'], ['素质测评', '测评'], ['综合测评', '测评'],
    ['笔试', '笔试'], ['在线笔试', '笔试'], ['上机考试', '笔试'],
    // ---- 已投递 / 待投递 ----
    ['已投递', '已投递'], ['已网申', '已投递'], ['网申成功', '已投递'], ['待筛选', '已投递'], ['筛选中', '已投递'], ['等待筛选', '已投递'], ['已申请', '已投递'],
    ['待投递', '待投递'], ['未投递', '待投递'], ['待网申', '待投递'], ['待申请', '待投递'], ['可投递', '待投递'],
  ];

  for (const [keyword, target] of rules) {
    if (lower.includes(keyword.toLowerCase())) {
      return target;
    }
  }

  return null;
}

/**
 * 被动/结束类状态: 用户无需任何行动 (已投递等结果 / Offer / 已拒绝 / 各种挂)
 * 这些状态下待办和预计耗时都必须清空, 优先级为低或暂缓
 */
export function isPassiveStatus(statusHint?: string | null): boolean {
  const passiveStatuses = ['已投递', 'Offer', '已拒绝', '简历挂', '测评挂', '笔试挂', '面试挂', '已挂'];
  return !!statusHint && passiveStatuses.includes(statusHint);
}

/**
 * 判断待办是否为"等待结果"类（无需用户行动）。
 * 这类待办虽然非空, 但用户无需做任何事, 因此预计耗时应为 null, 优先级为低。
 *
 * 【被动等待（无需行动）—— 返回 true】:
 *   明确表示当前阶段已完成, 只需等结果/通知:
 *   - "一面结束, 等待下一步通知" "测评完成, 等待结果"
 *   - "已投递, 等待筛选结果" "简历已提交, 等待回复"
 *   - "完成了" "已结束" "笔试结束等待通知"
 *
 * 【主动等待（需要准备）—— 返回 false】:
 *   收到了下一阶段的邀请/资格, 只是时间/细节未定, 用户仍需准备:
 *   - "收到群面邀请, 时间待定" "等待群面通知" → 需要准备群面
 *   - "等待笔试安排" "收到测评邀请等待链接" → 需要准备笔试/测评
 *   - "一面已约, 等待面试" "面试时间待定" → 需要准备面试
 *   判断逻辑: 同时满足以下两个条件才算"被动等待":
 *   1) 包含等待/结束/完成类关键词
 *   2) 要么明确提到"结束/完成/已投递/已提交"等完成态, 要么当前状态本身是非行动型(已投递/Offer/各种挂状态)
 */
export function isWaitingTypeTodo(
  todo: string | null | undefined,
  statusHint?: string | null
): boolean {
  if (!todo) return false;

  // 状态为非行动型的, 无论 todo 写什么, 都视为等待型
  // 已投递/Offer/已拒绝/各种挂状态: 用户都不需要做任何事
  if (isPassiveStatus(statusHint)) {
    return true;
  }

  // 明确的完成/结束态关键词: 出现这些说明该阶段已做完, 只需等结果
  const doneKeywords = [
    '结束了', '已结束', '完成了', '已完成', '完成测评', '完成笔试',
    '面试结束', '测评结束', '笔试结束', '群面结束', '一面结束', '二面结束', '三面结束', 'HR面结束', 'AI面结束',
    '已投递', '已提交', '简历已投', '简历已提交', '已网申', '网申已提交',
  ];
  const hasDoneKeyword = doneKeywords.some((kw) => todo.includes(kw));

  // 仅等待/等结果/等通知 + 完成态关键词同时出现, 才是被动等待
  const waitingKeywords = ['等待', '等结果', '等通知', '等候'];
  const hasWaitingKeyword = waitingKeywords.some((kw) => todo.includes(kw));

  if (hasDoneKeyword) {
    // 明确说了结束/完成, 无论有没有"等待"二字, 都是无需行动
    return true;
  }

  // 只有等待关键词, 但没有完成态关键词 → 可能是"等待安排但需要准备"
  // 需要进一步区分:
  //   "等待群面通知" "等待面试安排" "等待笔试时间" → 状态是面试/笔试类, 需要准备, 返回 false
  //   "等待筛选结果" "等待简历审核" → 没有明确下一阶段行动, 是被动等待, 返回 true
  if (hasWaitingKeyword) {
    // 如果有"结果""审核""筛选""回复"等词, 说明是在等别人处理, 无需用户行动
    const passiveWaitKeywords = ['结果', '审核', '筛选', '回复', '回信', '反馈', '审批'];
    if (passiveWaitKeywords.some((kw) => todo.includes(kw))) {
      return true;
    }

    // 如果提到了具体的下一阶段 (面试/测评/笔试/群面/一面等), 但只说等通知/安排
    // 说明用户收到了邀请需要准备, 只是时间未定 → 不是被动等待
    const nextStageKeywords = ['面试', '群面', '一面', '二面', '三面', 'HR面', 'AI面', '测评', '笔试'];
    if (nextStageKeywords.some((kw) => todo.includes(kw))) {
      return false;
    }

    // 如果当前状态是行动型状态 (待投递/测评/笔试/面试类), 说明还没做完
    const actionStatuses = ['待投递', '测评', '笔试', 'AI面', '群面', '一面', '二面', '三面', 'HR面'];
    if (statusHint && actionStatuses.includes(statusHint)) {
      return false;
    }
  }

  return false;
}

/** 钉钉表格城市选项 */
export const VALID_CITIES = ['北京', '上海', '深圳', '广州', '杭州', '成都', '海外', '其他', '未知'] as const;

/** 提交请求 */
export interface SubmitRequest {
  content?: string;
  image?: string;
  inputType?: InputType;
  /** 信息来源渠道 */
  source_channel?: string;
  /** 梯队 (A/B/C/S/SS, 选填, 不选则保留已有值) */
  echelon?: string;
  /** 工作空间配置 (可选, 不传则使用环境变量默认值) */
  workspace?: { baseId: string; sheetId?: string };
}

/** 提交响应 (single 模式) */
export interface SubmitResponse {
  success: boolean;
  action?: 'created' | 'updated';
  parsed?: ParsedJob;
  recordId?: string;
  recordIds?: string[];
  message?: string;
  error?: string;
  message_type?: MessageType;
  batch_result?: BatchParsedResult;
}

/** 批量提交请求 (用户勾选后的确认) */
export interface BatchSubmitRequest {
  selected_indices: number[];
  batch_result: BatchParsedResult;
  /** 梯队 (A/B/C/S/SS, 选填, 不选则保留已有值) */
  echelon?: string;
  /** 信息来源渠道 */
  source_channel?: string;
  /** 原始输入图片 (base64, 可选) */
  image?: string;
  /** 工作空间配置 */
  workspace?: { baseId: string; sheetId?: string };
}

/** 批量提交响应 */
export interface BatchSubmitResponse {
  success: boolean;
  results: Array<{
    candidate: BatchCandidate;
    action: 'created' | 'updated';
    recordId: string;
    message: string;
  }>;
  message?: string;
  error?: string;
}
