/**
 * 主 API 路由: /api/submit
 *
 * 完整流程:
 *   1. 接收用户提交内容 (文本 / 图片)
 *   2. AI 解析 + 钉钉记录查询 + 图片上传 (三者并行)
 *   3. single: 规则校验 → 匹配 → 新增/更新
 *   4. batch: 返回候选项, 但如果只有1个candidate则自动按single处理
 */

import { NextResponse } from 'next/server';
import { parseJob } from '@/lib/ai-parser';
import { validateParsedJob } from '@/lib/validator';
import {
  fetchAllRecords,
  matchRecord,
  matchAllCompanyRecords,
  createRecord,
  updateRecord,
  preUploadImage,
  type WorkspaceConfig,
} from '@/lib/dingtalk';
import type {
  SubmitRequest,
  SubmitResponse,
  ParsedJob,
  BatchParsedResult,
  DingTalkRecord,
  PreUploadedAttachment,
} from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SubmitRequest & {
      deepseekKey?: string;
      qwenKey?: string;
      demoMode?: boolean;
    };
    const { deepseekKey, qwenKey, demoMode } = body;
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

    if (!body.content && !body.image) {
      return NextResponse.json(
        { success: false, error: '提交内容不能为空, 请提供文字内容或图片' } satisfies SubmitResponse,
        { status: 400 }
      );
    }

    // ========== 并行执行: AI解析 + 查询已有记录 + 图片预上传 ==========
    // 三者无依赖关系, 并行执行可节省 0.5-2.5s
    const [parseResult, existingRecords, preUploadedAttachment] = await Promise.all([
      parseJob({
        content: body.content,
        image: body.image,
        forceType: body.inputType,
        deepseekKey,
        qwenKey,
        demoMode,
      }),
      // 预查询记录: 失败时返回 null, processSingleJob 中会重试
      fetchAllRecords(workspace).catch((err) => {
        console.warn('[submit] 预查询记录失败, 将在 single 流程中重试:', err);
        return null;
      }),
      // 预上传图片: 仅图片输入时执行, 失败时返回 null (后续 createRecord/updateRecord 会重试)
      body.image ? preUploadImage(body.image, workspace) : Promise.resolve(null),
    ]);

    const { message_type, data } = parseResult;
    console.log(`[submit] AI 解析完成, 消息类型: ${message_type}, 预查询记录: ${existingRecords?.length ?? '失败'} 条, 图片预上传: ${preUploadedAttachment ? '成功' : '未执行/失败'}`);

    // ========== batch 单候选自动转 single ==========
    if (message_type === 'batch') {
      const batchData = data as BatchParsedResult;

      if (batchData.candidates.length === 1) {
        console.log(`[submit] batch 只有 1 个候选, 自动转为 single 处理`);

        const candidate = batchData.candidates[0];
        const sf = batchData.shared_fields;

        const autoJob: ParsedJob = {
          message_type: 'single',
          company: batchData.source_company,
          position: candidate.position,
          city: sf.city,
          deadline: sf.deadline,
          application_limit: sf.application_limit,
          referral_code: sf.referral_code,
          status_hint: '待投递',
          todo: null,
          estimated_minutes: null,
          match_key: `${batchData.source_company}-${candidate.position}`,
          source_url: sf.source_link,
          source_channel: body.source_channel ?? null,
          raw_text: body.content ?? null,
          raw_image: null,
        };

        return processSingleJob(autoJob, workspace, existingRecords, null);
      }

      console.log(`[submit] 批量模式, 共 ${batchData.candidates.length} 个候选项`);

      return NextResponse.json({
        success: true,
        message_type: 'batch',
        batch_result: batchData,
        message: `检测到 ${batchData.candidates.length} 个岗位, 请选择你感兴趣的岗位`,
      } satisfies SubmitResponse);
    }

    // ========== single 流程 ==========
    const parsed = data as ParsedJob;
    parsed.source_channel = body.source_channel ?? null;
    // 梯队选填, 用户未选则为 null (由 isFieldDifferent 保护不覆盖已有值)
    parsed.echelon = body.echelon ?? null;
    // 原始输入文本: 纯文本提交用原文, 图片提交生成 AI 识别摘要
    if (body.content && body.content.trim()) {
      parsed.raw_text = body.content.trim();
    } else if (body.image) {
      const now = new Date();
      const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      parsed.raw_text = `[图片提交 ${ts}] AI 已识别: 公司=${parsed.company ?? '未知'}, 岗位=${parsed.position ?? '未知'}`;
    } else {
      parsed.raw_text = null;
    }
    parsed.raw_image = body.image ?? null; // base64 图片, 将在 createRecord/updateRecord 中上传到钉钉
    parsed.preUploadedAttachment = preUploadedAttachment;
    return processSingleJob(parsed, workspace, existingRecords, preUploadedAttachment);
  } catch (error) {
    console.error('[submit] 处理异常:', error);
    const msg = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json(
      { success: false, error: msg, message: '处理失败, 请检查日志后重试' } satisfies SubmitResponse,
      { status: 500 }
    );
  }
}

/**
 * 处理单个岗位的完整流程
 * @param existingRecords 预查询的已有记录 (null 表示预查询失败, 需要重新查询)
 * @param preUploadedAttachment 预上传的图片附件 (null 表示无图片或预上传失败)
 */
async function processSingleJob(
  parsed: ParsedJob,
  workspace?: WorkspaceConfig,
  existingRecords?: DingTalkRecord[] | null,
  preUploadedAttachment?: PreUploadedAttachment | null,
) {
  console.log('[submit] single 模式, 开始校验和匹配');

  const validation = validateParsedJob(parsed);

  if (!validation.valid) {
    return NextResponse.json(
      { success: false, error: validation.errors[0], parsed: validation.cleaned } satisfies SubmitResponse,
      { status: 422 }
    );
  }

  const cleaned: ParsedJob = validation.cleaned;
  // 透传预上传的图片附件
  if (preUploadedAttachment) {
    cleaned.preUploadedAttachment = preUploadedAttachment;
  }
  console.log('[submit] 校验后数据:', cleaned);

  // 使用预查询结果, 或在预查询失败时重新查询
  const records = existingRecords ?? await fetchAllRecords(workspace);

  // 宣讲会场景: info_session 非空且无岗位名 → 更新该公司下所有记录
  // (宣讲会是公司维度信息, 不是岗位维度, 应同步到所有岗位记录)
  if (cleaned.info_session && !cleaned.position && cleaned.company) {
    const allMatched = matchAllCompanyRecords(cleaned.company, records);
    if (allMatched.length > 0) {
      console.log(`[submit] 宣讲会场景: 匹配到 ${allMatched.length} 条 "${cleaned.company}" 记录, 并行更新`);
      // 并行更新所有匹配记录, 避免串行 updateRecord 在记录数多时超出 Vercel 10s 限制
      const updateResults = await Promise.all(
        allMatched.map(async (rec) => {
          await updateRecord(rec.recordId, cleaned, rec, workspace);
          return rec.recordId;
        })
      );
      return NextResponse.json({
        success: true,
        message_type: 'single',
        action: 'updated' as const,
        parsed: cleaned,
        recordId: updateResults[0],
        recordIds: updateResults,
        message: `🔄 宣讲会行程已同步至 ${cleaned.company} 的 ${allMatched.length} 条记录`,
      } satisfies SubmitResponse);
    }
    // 公司下无记录, 走正常新增流程
    console.log(`[submit] 宣讲会场景: 未找到 "${cleaned.company}" 的已有记录, 执行新增`);
  }

  const matched = await matchRecord(cleaned, records);

  let action: 'created' | 'updated';
  let record: DingTalkRecord;

  if (matched) {
    console.log(`[submit] 匹配到已有记录, recordId=${matched.recordId}, 执行更新`);
    record = await updateRecord(matched.recordId, cleaned, matched, workspace);
    action = 'updated';
  } else {
    console.log('[submit] 未匹配到记录, 执行新增');
    record = await createRecord(cleaned, workspace);
    action = 'created';
  }

  return NextResponse.json({
    success: true,
    message_type: 'single',
    action,
    parsed: cleaned,
    recordId: record.recordId,
    message:
      action === 'created'
        ? `✅ 新增记录: ${cleaned.company ?? '未知公司'} - ${cleaned.position ?? '未知岗位'}`
        : `🔄 更新记录: ${cleaned.company} - ${cleaned.position} (→ ${cleaned.status_hint})`,
  } satisfies SubmitResponse);
}
