/**
 * 规则校验模块 —— 纯代码逻辑, 不依赖 AI
 *
 * 兜底检查 AI 解析结果的合理性, 防止脏数据进入钉钉表格
 */

import {
  VALID_CITIES,
  ESTIMATED_MINUTES_BY_STATUS,
  isWaitingTypeTodo,
  normalizeStatus,
  type ParsedJob,
} from './types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  cleaned: ParsedJob;
}

export function validateParsedJob(raw: ParsedJob): ValidationResult {
  const errors: string[] = [];
  const cleaned: ParsedJob = { ...raw };

  // ---- 规则 1: company 和 position 不能同时为空 ----
  const companyEmpty = !cleaned.company || cleaned.company.trim() === '';
  const positionEmpty = !cleaned.position || cleaned.position.trim() === '';

  if (companyEmpty && positionEmpty) {
    errors.push('未能识别出有效的岗位信息, 请重新提交');
    return { valid: false, errors, cleaned };
  }

  if (companyEmpty) cleaned.company = null;
  if (positionEmpty) cleaned.position = null;

  // ---- 规则 2: deadline 格式校验 ----
  if (cleaned.deadline !== null) {
    if (!isValidDate(cleaned.deadline)) {
      console.warn(`[校验] deadline 格式无效, 置为 null: ${cleaned.deadline}`);
      cleaned.deadline = null;
    }
  }

  // ---- 规则 3: status_hint 归一化 + 兜底 ----
  // 先归一化变体 (如"待测评""在线测评"→"测评"), 无法识别才兜底为"待投递",
  // 否则进展更新消息的状态会被错误重置, 导致状态无法流转
  const normalizedStatus = normalizeStatus(cleaned.status_hint);
  if (!normalizedStatus) {
    if (cleaned.status_hint) {
      console.warn(`[校验] status_hint 无法识别, 兜底为"待投递": ${cleaned.status_hint}`);
    }
    cleaned.status_hint = '待投递';
  } else if (cleaned.status_hint !== normalizedStatus) {
    console.log(`[校验] status_hint 归一化: "${cleaned.status_hint}" → "${normalizedStatus}"`);
    cleaned.status_hint = normalizedStatus;
  }

  // ---- 规则 4: estimated_minutes 校验 ----
  // 与状态、待办严格对齐:
  //   1. todo 为空 → 强制 null
  //   2. 等待型待办 (无需行动) → 强制 null
  //   3. 行动型待办 → 优先按状态对照表, AI 返回值仅用于笔试特殊时长(90分钟等)
  const statusForMin = cleaned.status_hint;
  const isWaitTodo = isWaitingTypeTodo(cleaned.todo, statusForMin);
  if (!cleaned.todo || cleaned.todo.trim() === '') {
    cleaned.todo = null;
    cleaned.estimated_minutes = null;
  } else if (isWaitTodo) {
    // 等待型 todo 虽然非空, 但用户无需行动 → 预计耗时 null (与 ai-parser/dingtalk 保持一致)
    cleaned.estimated_minutes = null;
  } else {
    const defaultMin = statusForMin ? (ESTIMATED_MINUTES_BY_STATUS[statusForMin] ?? null) : null;
    const aiMinutes = cleaned.estimated_minutes;
    if (statusForMin === '笔试' && aiMinutes !== null && aiMinutes !== undefined) {
      const n = Number(aiMinutes);
      if (!isNaN(n) && n >= 5 && n <= 480) {
        // 笔试且 AI 返回了非默认时长 (如 90 分钟), 保留真实值
        cleaned.estimated_minutes = n;
      } else {
        cleaned.estimated_minutes = defaultMin;
      }
    } else {
      // 其他状态一律使用对照表, 忽略 AI 返回的异常值 (不再固定兜底 30)
      cleaned.estimated_minutes = defaultMin;
    }
  }

  // ---- 规则 5: match_key 兜底生成 ----
  if (!cleaned.match_key || cleaned.match_key.trim() === '') {
    const parts: string[] = [];
    if (cleaned.company) parts.push(cleaned.company);
    if (cleaned.position) parts.push(cleaned.position);
    cleaned.match_key = parts.join('-') || '未知岗位';
  }

  // ---- 规则 6: source_url 格式校验 ----
  if (cleaned.source_url && cleaned.source_url.trim() !== '') {
    let url = cleaned.source_url
      .replace(/`/g, '')
      .replace(/^["']+|["']+$/g, '')
      .trim();

    // 自动补 https:// 前缀 (如 careers.dji.com → https://careers.dji.com)
    url = ensureProtocol(url);

    if (isValidUrl(url)) {
      cleaned.source_url = url;
    } else {
      console.warn(`[校验] source_url 格式无效, 置为 null: ${cleaned.source_url}`);
      cleaned.source_url = null;
    }
  } else {
    cleaned.source_url = null;
  }

  // ---- 规则 8: city 数组校验 (多选字段) ----
  if (!cleaned.city || cleaned.city.length === 0) {
    cleaned.city = ['未知'];
  } else {
    cleaned.city = cleaned.city.filter((c) => {
      const trimmed = c.trim();
      if (!trimmed) return false;
      // 检查是否在预设列表中
      return VALID_CITIES.some((vc) => vc === trimmed || trimmed.includes(vc));
    });
    if (cleaned.city.length === 0) cleaned.city = ['未知'];
  }

  // ---- 规则 9: locations 中日期格式校验 ----
  if (cleaned.locations && Array.isArray(cleaned.locations)) {
    cleaned.locations = cleaned.locations
      .filter((loc) => loc.city && loc.city.trim() !== '')
      .map((loc) => ({
        city: loc.city.trim(),
        date: loc.date && isValidDate(loc.date) ? loc.date : null,
      }));
    cleaned.locations.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });
  } else {
    cleaned.locations = [];
  }

  // ---- 规则 11: application_limit 转为整数 ----
  if (cleaned.application_limit !== undefined && cleaned.application_limit !== null) {
    const n = Number(cleaned.application_limit);
    if (isNaN(n)) {
      cleaned.application_limit = null;
    } else {
      cleaned.application_limit = Math.floor(n);
    }
  }

  // ---- 规则 12: referral_code 清理 ----
  if (cleaned.referral_code !== undefined && cleaned.referral_code !== null) {
    const code = cleaned.referral_code.toString().trim();
    cleaned.referral_code = code === '' ? null : code;
  }

  // ---- 规则 13: remark 清理 ----
  if (isPlaceholderText(cleaned.remark)) {
    cleaned.remark = null;
  }

  return { valid: true, errors, cleaned };
}

function isValidDate(str: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const [year, month, day] = str.split('-').map(Number);
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() + 1 === month &&
    d.getUTCDate() === day
  );
}

function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 检测 AI 返回的占位文本 (如 "暂无", "无", "未知" 等)
 * 这些不是真正的业务数据, 应该置为 null
 */
function isPlaceholderText(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === '') return true;

  const placeholderPatterns = [
    /^暂无/,
    /^无$/,
    /^暂无.*描述/,
    /^暂无.*要求/,
    /^暂无.*信息/,
    /^暂无.*岗位/,
    /^没有/,
    /^未提及/,
    /^未知$/,
    /^null$/i,
    /^n\/a$/i,
    /^none$/i,
    /^unknown$/i,
    /^不[详用]$/,
  ];

  return placeholderPatterns.some((pattern) => pattern.test(trimmed));
}

/**
 * 自动为没有协议的 URL 补 https:// 前缀
 * 例如: careers.dji.com → https://careers.dji.com
 */
function ensureProtocol(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;

  // 已有协议
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // 以 www. 开头
  if (/^www\./i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  // 看起来像域名 (含点号, 不含空格和中文)
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}/.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return trimmed;
}
