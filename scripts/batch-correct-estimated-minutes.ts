/**
 * 一次性脚本: 按统一"状态 → 预计耗时"对照表批量修正钉钉表格历史数据
 *
 * 对照表:
 *   待投递 → 20
 *   测评   → 60
 *   笔试   → 60 (但消息原文明确写了具体时长时, 保留原文真实值, 不用 60 覆盖)
 *   AI面/群面/一面/二面/三面/HR面 → 120
 *   已投递/Offer/已拒绝/简历挂/测评挂/笔试挂/面试挂/已挂 → null (清空)
 *
 * 用法:
 *   npx tsx scripts/batch-correct-estimated-minutes.ts            # 预览 (dry-run, 不写入)
 *   npx tsx scripts/batch-correct-estimated-minutes.ts --apply     # 实际写入
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ============== 加载 .env.local ==============
// 独立脚本需手动加载环境变量, 钉钉 SDK 依赖 process.env
function loadEnv() {
  const envPath = resolve(process.cwd(), '.env.local');
  try {
    const text = readFileSync(envPath, 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // 去掉首尾引号
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
    console.log('[env] 已加载 .env.local');
  } catch (err) {
    console.warn('[env] 未找到 .env.local, 将使用已有 process.env:', err instanceof Error ? err.message : err);
  }
}

loadEnv();

// ============== 对照表 ==============

const STANDARD_MINUTES: Record<string, number | null> = {
  待投递: 20,
  测评: 60,
  笔试: 60,
  AI面: 120,
  群面: 120,
  一面: 120,
  二面: 120,
  三面: 120,
  HR面: 120,
  // 无需用户行动 / 流程已结束
  已投递: null,
  Offer: null,
  已拒绝: null,
  简历挂: null,
  测评挂: null,
  笔试挂: null,
  面试挂: null,
  已挂: null,
};

const APPLY = process.argv.includes('--apply');

// ============== 辅助函数 ==============

function extractText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((v) => extractText(v)).filter(Boolean).join('');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.name === 'string') return obj.name;
  }
  return String(value);
}

function getCurrentMinutes(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * 从消息原文中提取明确的笔试时长 (分钟)
 * 命中 "笔试...90分钟" / "90分钟笔试" / "笔试时长2小时" 等模式
 * 只提取与"笔试"关联的时长, 避免误抓 DDL 等其他数字
 */
function extractExplicitExamMinutes(rawText: string): number | null {
  if (!rawText) return null;
  const text = rawText.replace(/\s+/g, '');

  const patterns: Array<{ re: RegExp; toMinutes: (m: RegExpMatchArray) => number | null }> = [
    // X分钟 (笔试附近)
    { re: /笔试[^\d]{0,12}(\d+(?:\.\d+)?)分钟/, toMinutes: (m) => toInt(m[1]) },
    { re: /(\d+(?:\.\d+)?)分钟[^\d]{0,12}笔试/, toMinutes: (m) => toInt(m[1]) },
    { re: /笔试时长[：:]?(\d+(?:\.\d+)?)分钟/, toMinutes: (m) => toInt(m[1]) },
    // X小时 (笔试附近)
    { re: /笔试[^\d]{0,12}(\d+(?:\.\d+)?)小时/, toMinutes: (m) => toInt(m[1], 60) },
    { re: /(\d+(?:\.\d+)?)小时[^\d]{0,12}笔试/, toMinutes: (m) => toInt(m[1], 60) },
    { re: /笔试时长[：:]?(\d+(?:\.\d+)?)小时/, toMinutes: (m) => toInt(m[1], 60) },
  ];

  for (const { re, toMinutes } of patterns) {
    const m = text.match(re);
    if (m) {
      const mins = toMinutes(m);
      if (mins !== null && mins >= 10 && mins <= 300) return mins;
    }
  }
  return null;
}

function toInt(raw: string, multiplier = 1): number | null {
  const num = Number(raw) * multiplier;
  return Number.isFinite(num) ? Math.round(num) : null;
}

// ============== 主流程 ==============

interface Correction {
  recordId: string;
  company: string;
  position: string;
  status: string;
  current: number | null;
  target: number | null;
  reason: string;
}

async function main() {
  console.log(`\n========== 预计耗时批量修正 ${APPLY ? '[APPLY 实际写入]' : '[DRY-RUN 预览]'} ==========\n`);

  // 动态导入: 确保 loadEnv() 先执行, 钉钉模块读取 process.env 时环境变量已就绪
  const { fetchAllRecords, updateRecordFields } = await import('../lib/dingtalk');

  const records = await fetchAllRecords();
  console.log(`共读取到 ${records.length} 条记录\n`);

  const corrections: Correction[] = [];

  for (const record of records) {
    const f = record.fields as Record<string, unknown>;
    const status = extractText(f['状态']).trim();
    const company = extractText(f['公司']);
    const position = extractText(f['岗位']);
    const rawText = extractText(f['原始输入文本']);
    const current = getCurrentMinutes(f['预计耗时']);

    if (!(status in STANDARD_MINUTES)) {
      console.log(`[跳过] 未知状态 "${status}" | ${company} ${position} (recordId=${record.recordId})`);
      continue;
    }

    let target = STANDARD_MINUTES[status];
    let reason = '按状态对照表';

    // 笔试特殊处理: 原文明确提到具体时长时, 保留真实值
    if (status === '笔试') {
      const explicit = extractExplicitExamMinutes(rawText);
      if (explicit !== null) {
        // 原文有明确时长
        if (current === null) {
          target = explicit;
          reason = `原文明确笔试时长 ${explicit} 分钟 (原为空, 补填)`;
        } else {
          // 已有值, 视为真实值, 保留不覆盖
          console.log(`[保留] 笔试 | ${company} ${position} | 当前=${current} (原文明确提到笔试时长, 保留原值不覆盖)`);
          continue;
        }
      }
    }

    const needUpdate =
      (target === null && current !== null) ||
      (target !== null && current !== target);

    if (!needUpdate) continue;

    corrections.push({
      recordId: record.recordId,
      company,
      position,
      status,
      current,
      target,
      reason,
    });
  }

  if (corrections.length === 0) {
    console.log('\n✓ 所有记录的预计耗时均已符合新标准, 无需修正。\n');
    return;
  }

  console.log(`发现 ${corrections.length} 条需要修正的记录:\n`);
  for (const c of corrections) {
    const currentStr = c.current === null ? '空' : String(c.current);
    const targetStr = c.target === null ? '空(清空)' : String(c.target);
    console.log(
      `  • [${c.status}] ${c.company} ${c.position}\n` +
      `    ${currentStr} → ${targetStr}  (${c.reason})`
    );
  }

  if (!APPLY) {
    console.log('\n[DRY-RUN] 以上为预览, 未实际写入。确认无误后加 --apply 参数执行写入。');
    return;
  }

  console.log('\n开始写入...');
  let ok = 0;
  let fail = 0;
  for (const c of corrections) {
    try {
      const fields: Record<string, unknown> = {
        预计耗时: c.target, // null 表示清空该字段
      };
      await updateRecordFields(c.recordId, fields);
      console.log(`  ✓ 已更新 ${c.company} ${c.position}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ 失败 ${c.company} ${c.position}:`, err instanceof Error ? err.message : err);
      fail++;
    }
  }

  console.log(`\n========== 完成: 成功 ${ok} / 失败 ${fail} ==========\n`);
}

main().catch((err) => {
  console.error('\n脚本执行异常:', err);
  process.exit(1);
});
