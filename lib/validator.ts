/**
 * 规则校验模块 —— 纯代码逻辑, 不依赖 AI
 *
 * 兜底检查 AI 解析结果的合理性, 防止脏数据进入钉钉表格
 */

import {
  VALID_STATUSES,
  VALID_PRIORITIES,
  VALID_CITIES,
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

  // ---- 规则 3: status_hint 兜底 ----
  if (!cleaned.status_hint || !VALID_STATUSES.includes(cleaned.status_hint as any)) {
    if (cleaned.status_hint) {
      console.warn(`[校验] status_hint 无效, 兜底为"待投递": ${cleaned.status_hint}`);
    }
    cleaned.status_hint = '待投递';
  }

  // ---- 规则 4: estimated_minutes 校验 ----
  // 如果 todo 为 null, estimated_minutes 必须强制为 null
  if (!cleaned.todo || cleaned.todo.trim() === '') {
    cleaned.todo = null;
    cleaned.estimated_minutes = null;
  } else {
    const minutes = Number(cleaned.estimated_minutes);
    if (isNaN(minutes) || minutes < 5 || minutes > 480) {
      console.warn(`[校验] estimated_minutes 超出范围, 兜底为 30: ${cleaned.estimated_minutes}`);
      cleaned.estimated_minutes = 30;
    } else {
      cleaned.estimated_minutes = minutes;
    }
  }

  // ---- 规则 5: requirements / description 清理 ----
  // AI 可能返回 "暂无"、"暂无岗位要求描述"、"无" 等占位文本, 统一置为 null
  if (isPlaceholderText(cleaned.requirements)) {
    cleaned.requirements = null;
  }
  if (isPlaceholderText(cleaned.description)) {
    cleaned.description = null;
  }

  // ---- 规则 6: match_key 兜底生成 ----
  if (!cleaned.match_key || cleaned.match_key.trim() === '') {
    const parts: string[] = [];
    if (cleaned.company) parts.push(cleaned.company);
    if (cleaned.position) parts.push(cleaned.position);
    cleaned.match_key = parts.join('-') || '未知岗位';
  }

  // ---- 规则 7: priority 校验 ----
  if (cleaned.priority && !VALID_PRIORITIES.includes(cleaned.priority as any)) {
    console.warn(`[校验] priority 无效, 兜底为"中": ${cleaned.priority}`);
    cleaned.priority = '中';
  }

  // ---- 规则 8: source_url 格式校验 ----
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

  // ---- 规则 9: city 数组校验 (多选字段) ----
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

  // ---- 规则 10: locations 中日期格式校验 ----
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

  // ---- 规则 11: 基于实际日期重算优先级 ----
  const recalculatedPriority = recalculatePriority(cleaned);
  if (recalculatedPriority && recalculatedPriority !== cleaned.priority) {
    cleaned.priority = recalculatedPriority;
  }

  // ---- 规则 12: job_code 清理 ----
  if (cleaned.job_code !== undefined && cleaned.job_code !== null) {
    const code = cleaned.job_code.toString().trim();
    cleaned.job_code = code === '' ? null : code;
  }

  // ---- 规则 13: application_limit 转为整数 ----
  if (cleaned.application_limit !== undefined && cleaned.application_limit !== null) {
    const n = Number(cleaned.application_limit);
    if (isNaN(n)) {
      cleaned.application_limit = null;
    } else {
      cleaned.application_limit = Math.floor(n);
    }
  }

  // ---- 规则 14: referral_code 清理 ----
  if (cleaned.referral_code !== undefined && cleaned.referral_code !== null) {
    const code = cleaned.referral_code.toString().trim();
    cleaned.referral_code = code === '' ? null : code;
  }

  // ---- 规则 15: remark 清理 ----
  if (isPlaceholderText(cleaned.remark)) {
    cleaned.remark = null;
  }

  return { valid: true, errors, cleaned };
}

function recalculatePriority(data: ParsedJob): string | null {
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const allDates: string[] = [];
  if (data.locations) {
    for (const loc of data.locations) {
      if (loc.date && isValidDate(loc.date)) {
        allDates.push(loc.date);
      }
    }
  }
  if (data.deadline && isValidDate(data.deadline)) {
    allDates.push(data.deadline);
  }

  if (allDates.length === 0) {
    return data.company || data.position ? '低' : '暂缓';
  }

  const upcomingDates = allDates
    .map((d) => new Date(d + 'T00:00:00+08:00'))
    .filter((d) => d.getTime() >= now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());

  if (upcomingDates.length === 0) return '暂缓';

  const nearestDate = upcomingDates[0];
  const diffDays = Math.ceil(
    (nearestDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (diffDays <= 7) return '高';
  if (diffDays <= 30) return '中';
  return '低';
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
 * 检测 AI 返回的占位文本 (如 "暂无", "暂无岗位要求描述", "无" 等)
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
