/**
 * 历史记录 API: /api/history
 *
 * GET: 获取全部记录
 * DELETE: 删除指定记录
 */

import { NextResponse } from 'next/server';
import { fetchAllRecords, deleteRecord, updateRecordFields, type WorkspaceConfig } from '@/lib/dingtalk';
import { ESTIMATED_MINUTES_BY_STATUS } from '@/lib/types';
import type { HistoryRecord, DingTalkRecord } from '@/lib/types';

export const runtime = 'nodejs';

function extractWorkspace(req: Request): WorkspaceConfig | undefined {
  const header = req.headers.get('x-workspace');
  if (!header) return undefined;
  try {
    const parsed = JSON.parse(header) as { baseId?: string; sheetId?: string; appKey?: string; appSecret?: string; operatorId?: string; demoMode?: boolean };
    if (parsed.demoMode) return { demoMode: true };
    if (!parsed.baseId && !parsed.appKey) return undefined;
    const config: WorkspaceConfig = { baseId: parsed.baseId ?? '', sheetId: parsed.sheetId };
    if (parsed.appKey) config.appKey = parsed.appKey;
    if (parsed.appSecret) config.appSecret = parsed.appSecret;
    if (parsed.operatorId) config.operatorId = parsed.operatorId;
    return config.baseId || config.appKey ? config : undefined;
  } catch {
    return undefined;
  }
}

export async function GET(request: Request) {
  try {
    const workspace = extractWorkspace(request);
    const records = await fetchAllRecords(workspace);
    const history = records.map(parseDingTalkRecord);

    // 按最后更新时间倒序
    history.sort((a, b) => (b.last_updated_time ?? 0) - (a.last_updated_time ?? 0));

    return NextResponse.json({ success: true, records: history });
  } catch (error) {
    console.error('[history] 获取记录失败:', error);
    const msg = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json(
      { success: false, error: msg, records: [] },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { recordId } = (await request.json()) as { recordId: string };
    const workspace = extractWorkspace(request);

    if (!recordId) {
      return NextResponse.json(
        { success: false, error: '缺少 recordId' },
        { status: 400 }
      );
    }

    await deleteRecord(recordId, workspace);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[history] 删除记录失败:', error);
    const msg = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const { recordId, status } = (await request.json()) as { recordId: string; status: string };
    const workspace = extractWorkspace(request);

    if (!recordId) {
      return NextResponse.json(
        { success: false, error: '缺少 recordId' },
        { status: 400 }
      );
    }

    if (!status) {
      return NextResponse.json(
        { success: false, error: '缺少 status' },
        { status: 400 }
      );
    }

    // 按状态对照表同步预计耗时, 确保钉钉表格与状态一致
    const fieldsToUpdate: Record<string, unknown> = { '状态': status };
    if (status in ESTIMATED_MINUTES_BY_STATUS) {
      const defaultMin = ESTIMATED_MINUTES_BY_STATUS[status];
      // 进行中状态: 按默认值设置 (有待办时会在 submit 流程中再同步)
      fieldsToUpdate['预计耗时'] = defaultMin ?? null;
    }

    await updateRecordFields(recordId, fieldsToUpdate, workspace);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[history] 更新状态失败:', error);
    const msg = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}

/**
 * 从钉钉字段值中提取实际文本
 * 钉钉 Notable API 可能返回:
 *   - 纯字符串: "待投递"
 *   - 单选项对象: { label: "待投递", value: "待投递" }
 *   - 多选项数组: [{ label: "北京" }, { label: "上海" }]
 *   - 其他类型
 */
function extractText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return value.map((v) => extractText(v)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // 钉钉 Notable API 字段值格式:
    //   单选项: { name: "待投递", id: "xxx" }
    //   多选项: [{ name: "北京", id: "xxx" }]
    //   链接: { link: "url", text: "显示文本" }
    //   富文本: { text: "内容" }
    // 优先取 name, 再取 label, value, text
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.label === 'string') return obj.label;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.text === 'string') return obj.text;
    // 链接类型: 返回 link
    if (typeof obj.link === 'string') return obj.link;
    // 最后 fallback
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * 从钉钉字段值中提取字符串数组 (用于多选字段)
 */
function extractStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) {
    return value.map((v) => extractText(v)).filter(Boolean);
  }
  if (typeof value === 'object') {
    const text = extractText(value);
    return text ? [text] : [];
  }
  return [];
}

/**
 * 将钉钉原始记录解析为 HistoryRecord
 */
function parseDingTalkRecord(record: DingTalkRecord): HistoryRecord {
  const f = record.fields as Record<string, unknown>;

  // 城市: 多选字段, 可能是对象数组
  const cities = extractStringArray(f['城市']);

  // 最后更新时间: 钉钉自动字段
  let lastUpdated: number | null = null;
  const rawTime = f['最后更新时间'];
  if (typeof rawTime === 'number') {
    lastUpdated = rawTime;
  } else if (typeof rawTime === 'string' && rawTime) {
    const t = new Date(rawTime).getTime();
    if (!isNaN(t)) lastUpdated = t;
  }

  // 投递DDL: 可能是时间戳数字
  let deadline: string | null = null;
  const rawDdl = f['投递DDL'];
  if (typeof rawDdl === 'number') {
    const d = new Date(rawDdl);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      deadline = `${y}-${m}-${day}`;
    }
  } else if (typeof rawDdl === 'string' && rawDdl) {
    deadline = rawDdl;
  }

  // 链接 (超链接字段, 格式为 {link: "url", text: "显示文本"})
  let sourceUrl: string | null = null;
  const rawUrl = f['链接'] ?? f['来源链接'];
  if (rawUrl) {
    if (typeof rawUrl === 'object' && rawUrl !== null) {
      const obj = rawUrl as Record<string, unknown>;
      if (typeof obj.link === 'string') {
        sourceUrl = obj.link;
      } else if (typeof obj.text === 'string') {
        sourceUrl = obj.text;
      }
    } else {
      sourceUrl = extractText(rawUrl);
    }
  }

  return {
    recordId: record.recordId,
    company: extractText(f['公司']),
    position: extractText(f['岗位']),
    job_code: f['岗位编号'] ? extractText(f['岗位编号']) : null,
    city: cities,
    deadline,
    status: extractText(f['状态']) || '待投递',
    priority: f['优先级标记'] ? extractText(f['优先级标记']) : null,
    last_updated_time: lastUpdated,
    raw_text: f['原始输入文本'] ? extractText(f['原始输入文本']) : null,
    raw_image: f['原始输入图片'] ? extractText(f['原始输入图片']) : null,
    source_channel: f['信息来源渠道'] ? extractText(f['信息来源渠道']) : null,
    todo: f['待办'] ? extractText(f['待办']) : null,
    referral_code: f['内推码'] ? extractText(f['内推码']) : null,
    source_url: sourceUrl,
    _raw_fields: f,
  };
}
