/**
 * 共享类型定义 —— 对齐钉钉 AI 表格 19 个字段
 *
 * 钉钉表格字段:
 *   公司(文本) | 岗位(文本) | 岗位编号(文本) | 城市(多选)
 *   投递DDL(日期) | 岗位描述(文本) | 岗位要求(文本) | 投递数量限制(数字)
 *   内推码(文本) | 状态(单选) | 待办(文本) | 预计耗时(数字)
 *   备注(文本) | 来源链接(链接) | 优先级标记(单选) | 信息来源渠道(文本)
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
  job_code: string | null;
  /** 城市数组, 多选字段, 从预设选项中选 */
  city: string[];
  deadline: string | null;
  description: string | null;
  requirements: string | null;
  application_limit: number | null;
  referral_code: string | null;
  status_hint: string;
  todo: string | null;
  /** 只有 todo 不为 null 时才有值, 否则必须为 null */
  estimated_minutes: number | null;
  match_key: string;
  /** 来源链接 (报名链接等) */
  source_url?: string | null;
  /** 优先级: 高/中/低/暂缓 */
  priority?: string;
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
  job_code: string | null;
  description: string | null;
  requirements: string | null;
}

/** 批量共享字段 (batch 模式) */
export interface BatchSharedFields {
  deadline: string | null;
  application_limit: number | null;
  referral_code: string | null;
  source_link: string | null;
  /** 城市数组, 整条消息共享的城市 */
  city: string[];
  /** 整条消息共享的岗位要求 (如专业、学历要求等) */
  requirements: string | null;
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
  job_code: string | null;
  city: string[];
  deadline: string | null;
  status: string;
  priority: string | null;
  last_updated_time: number | null;
  raw_text: string | null;
  raw_image: string | null;
  source_channel: string | null;
  todo: string | null;
  referral_code: string | null;
  source_url: string | null;
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
 * 判断待办是否为"等待结果"类（无需用户行动）。
 * 这类待办虽然非空, 但用户无需做任何事, 因此预计耗时应为 null。
 * 场景: "一面结束, 等待下一步通知""测评完成, 等待结果""等待筛选结果"等
 */
export function isWaitingTypeTodo(todo: string | null | undefined): boolean {
  if (!todo) return false;
  const waitingKeywords = [
    '等待', '等结果', '等通知',
    '结束了', '已结束', '完成了', '已完成', '完成测评', '完成笔试',
  ];
  return waitingKeywords.some((kw) => todo.includes(kw));
}

/** 有效优先级列表 (与钉钉表格中的单选字段选项一致) */
export const VALID_PRIORITIES = ['高', '中', '低', '暂缓'] as const;

export type ValidPriority = (typeof VALID_PRIORITIES)[number];

/** 钉钉表格城市选项 */
export const VALID_CITIES = ['北京', '上海', '深圳', '广州', '杭州', '成都', '海外', '其他', '未知'] as const;

/** 提交请求 */
export interface SubmitRequest {
  content?: string;
  image?: string;
  inputType?: InputType;
  /** 信息来源渠道 */
  source_channel?: string;
  /** 工作空间配置 (可选, 不传则使用环境变量默认值) */
  workspace?: { baseId: string; sheetId?: string };
}

/** 提交响应 (single 模式) */
export interface SubmitResponse {
  success: boolean;
  action?: 'created' | 'updated';
  parsed?: ParsedJob;
  recordId?: string;
  message?: string;
  error?: string;
  message_type?: MessageType;
  batch_result?: BatchParsedResult;
}

/** 批量提交请求 (用户勾选后的确认) */
export interface BatchSubmitRequest {
  selected_indices: number[];
  batch_result: BatchParsedResult;
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
