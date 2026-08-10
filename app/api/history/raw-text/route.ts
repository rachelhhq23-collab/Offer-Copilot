/**
 * 删除单条原始输入文本记录: /api/history/raw-text
 *
 * DELETE: 从"原始输入文本"字段中删除指定的一条历史记录
 * - 局部更新, 只影响"原始输入文本"字段, 不触碰其他字段
 */

import { NextResponse } from 'next/server';
import { fetchAllRecords, updateRecordFields, type WorkspaceConfig } from '@/lib/dingtalk';

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

/**
 * 解析原始输入文本, 按时间戳分段 (正序: 最旧在上)
 * 格式: [YYYY-MM-DD HH:mm]\n内容\n────...\n[YYYY-MM-DD HH:mm]\n内容
 */
function parseRawTextSegments(rawText: string): Array<{ timestamp: string; content: string }> {
  const tsRegex = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/g;
  const matches: Array<{ index: number; ts: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tsRegex.exec(rawText)) !== null) {
    matches.push({ index: m.index, ts: m[1] });
  }

  if (matches.length === 0) {
    return [{ timestamp: '', content: rawText.trim() }];
  }

  const segments: Array<{ timestamp: string; content: string }> = [];
  // 第一个时间戳之前的文本 (如首次创建记录时无时间戳的原始文本)
  if (matches[0].index > 0) {
    const beforeText = rawText.slice(0, matches[0].index).replace(/─{10,}/g, '').trim();
    if (beforeText) {
      segments.push({ timestamp: '', content: beforeText });
    }
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : rawText.length;
    let segment = rawText.slice(start, end).trim();
    segment = segment.replace(/─{10,}/g, '').trim();
    const ts = matches[i].ts;
    const content = segment.replace(`[${ts}]`, '').trim();
    segments.push({ timestamp: ts, content });
  }

  return segments;
}

/**
 * 重建原始输入文本: 用分隔符拼接段落
 */
function rebuildRawText(segments: Array<{ timestamp: string; content: string }>): string {
  return segments
    .map((s) => (s.timestamp ? `[${s.timestamp}]\n${s.content}` : s.content))
    .join(`\n${'─'.repeat(20)}\n`);
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as {
      recordId: string;
      timestamp: string;
      content: string;
    };
    const workspace = extractWorkspace(request);

    if (!body.recordId) {
      return NextResponse.json({ success: false, error: '缺少 recordId' }, { status: 400 });
    }

    // 1. 读取当前记录, 获取原始输入文本
    const records = await fetchAllRecords(workspace);
    const record = records.find((r) => r.recordId === body.recordId);
    if (!record) {
      return NextResponse.json({ success: false, error: '未找到记录' }, { status: 404 });
    }

    const rawText = String(record.fields['原始输入文本'] ?? '');
    if (!rawText.trim()) {
      return NextResponse.json({ success: false, error: '该记录无原始输入文本' }, { status: 400 });
    }

    // 2. 解析分段
    const segments = parseRawTextSegments(rawText);

    // 3. 过滤掉匹配的条目 (只删第一条匹配, 避免 timestamp+content 相同时全删)
    let deleted = false;
    const remaining = segments.filter((s) => {
      if (deleted) return true;
      const tsMatch = s.timestamp === body.timestamp;
      // content 精确匹配 (前端传的是清理后的 content)
      const contentMatch = body.content ? s.content === body.content : true;
      if (tsMatch && contentMatch) {
        deleted = true;
        return false;
      }
      return true;
    });

    if (!deleted) {
      return NextResponse.json({ success: false, error: '未找到匹配的历史记录' }, { status: 404 });
    }

    // 4. 重建文本并局部更新 (只更新"原始输入文本"字段)
    const newText = rebuildRawText(remaining);
    const fieldsToUpdate: Record<string, unknown> = {
      '原始输入文本': newText || null,
    };

    await updateRecordFields(body.recordId, fieldsToUpdate, workspace);

    console.log(`[raw-text] 删除成功, recordId=${body.recordId}, 剩余 ${remaining.length} 条`);

    return NextResponse.json({
      success: true,
      remainingCount: remaining.length,
      rawText: newText,
    });
  } catch (error) {
    console.error('[raw-text] 删除历史记录失败:', error);
    const msg = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
