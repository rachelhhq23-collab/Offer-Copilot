/**
 * 批量确认提交接口: /api/batch-submit
 *
 * 用户勾选岗位后调用:
 *   1. 对每个被选中的 candidate, 合并 shared_fields
 *   2. 动态生成待办 (包含内推码、投递入口等信息)
 *   3. 复用校验和匹配逻辑, 支持岗位编号精确匹配
 */

import { NextResponse } from 'next/server';
import { validateParsedJob } from '@/lib/validator';
import {
  fetchAllRecords,
  matchRecord,
  createRecord,
  updateRecord,
  type WorkspaceConfig,
} from '@/lib/dingtalk';
import type {
  BatchSubmitRequest,
  BatchSubmitResponse,
  ParsedJob,
  BatchCandidate,
  BatchSharedFields,
} from '@/lib/types';

export const runtime = 'nodejs';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as BatchSubmitRequest & { content?: string; demoMode?: boolean };
    const { selected_indices, batch_result } = body;
    const rawContent = body.content ?? '';
    const rawImage = body.image ?? '';
    const wsRaw = body.workspace as { baseId?: string; sheetId?: string; appKey?: string; appSecret?: string; operatorId?: string; demoMode?: boolean } | undefined;
    const isDemo = body.demoMode === true || wsRaw?.demoMode === true;
    const workspace: WorkspaceConfig | undefined = isDemo
      ? { demoMode: true }
      : wsRaw && (wsRaw.baseId || wsRaw.appKey)
        ? {
            baseId: wsRaw.baseId ?? '',
            sheetId: wsRaw.sheetId,
            ...(wsRaw.appKey ? { appKey: wsRaw.appKey } : {}),
            ...(wsRaw.appSecret ? { appSecret: wsRaw.appSecret } : {}),
            ...(wsRaw.operatorId ? { operatorId: wsRaw.operatorId } : {}),
          }
        : undefined;

    if (!selected_indices || selected_indices.length === 0) {
      return NextResponse.json(
        { success: false, results: [], error: '请至少选择一个岗位' } satisfies BatchSubmitResponse,
        { status: 400 }
      );
    }

    const existingRecords = await fetchAllRecords(workspace);
    const results: BatchSubmitResponse['results'] = [];

    for (const index of selected_indices) {
      const candidate: BatchCandidate | undefined = batch_result.candidates[index];
      if (!candidate) continue;

      const sf: BatchSharedFields = batch_result.shared_fields;

      // ---- 构建待办文本 (动态生成, 包含关键信息) ----
      const todo = buildTodo(candidate, sf);

      // ---- 构建 ParsedJob ----
      // 直接清理 candidate 中的占位文本, 避免 AI 返回 "暂无岗位要求描述" 等无效内容
      const cleanPlaceholder = (v: string | null | undefined): string | null => {
        if (!v) return null;
        const t = v.trim();
        if (!t) return null;
        if (/^(暂无|无|未知|没有|未提及|不[详用])/.test(t)) return null;
        if (/^暂无.*(描述|要求|信息|岗位)/.test(t)) return null;
        return t;
      };

      const parsed: ParsedJob = {
        message_type: 'single',
        company: batch_result.source_company,
        position: candidate.position,
        job_code: candidate.job_code,
        city: sf.city,
        deadline: sf.deadline,
        description: cleanPlaceholder(candidate.description),
        requirements: cleanPlaceholder(candidate.requirements) ?? cleanPlaceholder(sf.requirements),
        application_limit: sf.application_limit,
        referral_code: sf.referral_code,
        status_hint: '待投递',
        todo,
        estimated_minutes: todo ? 20 : null,
        match_key: `${batch_result.source_company}-${candidate.position}`,
        source_url: sf.source_link,
        priority: '中',
        source_channel: body.source_channel ?? null,
        raw_text: rawContent.trim() || (rawImage ? `[图片提交] AI 已识别: 公司=${batch_result.source_company}, 岗位=${candidate.position}` : null),
        raw_image: rawImage || null,
      };

      // ---- 校验 ----
      const validation = validateParsedJob(parsed);
      if (!validation.valid) {
        results.push({
          candidate,
          action: 'created',
          recordId: '',
          message: `⚠️ ${candidate.position}: ${validation.errors[0]}`,
        });
        continue;
      }

      const cleaned = validation.cleaned;

      // ---- 匹配 + 新增/更新 ----
      try {
        const matched = await matchRecord(cleaned, existingRecords);
        let action: 'created' | 'updated';
        let recordId: string;

        if (matched) {
          const rec = await updateRecord(matched.recordId, cleaned, matched, workspace);
          action = 'updated';
          recordId = rec.recordId;
        } else {
          const rec = await createRecord(cleaned, workspace);
          action = 'created';
          recordId = rec.recordId;
          // 加入 existingRecords 供后续匹配
          existingRecords.push(rec);
        }

        results.push({
          candidate,
          action,
          recordId,
          message:
            action === 'created'
              ? `✅ 新增: ${cleaned.position}`
              : `🔄 更新: ${cleaned.position}`,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : '未知错误';
        results.push({
          candidate,
          action: 'created',
          recordId: '',
          message: `⚠️ ${candidate.position}: ${errMsg}`,
        });
      }
    }

    // 汇总
    const created = results.filter((r) => r.action === 'created').length;
    const updated = results.filter((r) => r.action === 'updated').length;
    const failed = results.filter((r) => !r.recordId).length;

    return NextResponse.json({
      success: true,
      results,
      message: `共处理 ${results.length} 个岗位: 新增 ${created}, 更新 ${updated}${failed > 0 ? `, 失败 ${failed}` : ''}`,
    } satisfies BatchSubmitResponse);
  } catch (error) {
    console.error('[batch-submit] 处理异常:', error);
    const msg = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json(
      { success: false, results: [], error: msg, message: '批量提交失败' } satisfies BatchSubmitResponse,
      { status: 500 }
    );
  }
}

/**
 * 构建动态待办文本: 把 shared_fields 的关键信息拼进去
 * 格式: "登录[source_link]投递[position]岗位, 使用内推码[referral_code]"
 */
function buildTodo(
  candidate: BatchCandidate,
  sf: BatchSharedFields
): string | null {
  const parts: string[] = [];

  // 投递入口
  if (sf.source_link) {
    parts.push(`登录 ${sf.source_link}`);
  }

  // 投递动作
  parts.push(`投递 ${candidate.position} 岗位`);

  // 内推码
  if (sf.referral_code) {
    parts.push(`使用内推码 ${sf.referral_code}`);
  }

  // 投递限制
  if (sf.application_limit && sf.application_limit > 0) {
    parts.push(`每人限投 ${sf.application_limit} 个岗位`);
  }

  // 截止日期
  if (sf.deadline) {
    parts.push(`截止日期 ${sf.deadline}`);
  }

  return parts.join('，');
}
