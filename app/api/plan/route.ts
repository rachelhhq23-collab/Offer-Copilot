/**
 * 投递计划生成接口: /api/plan
 *
 * 1. 从钉钉表格获取所有有效记录 (排除 Offer/已拒绝/已挂 等结束状态)
 * 2. 调用 DeepSeek 根据用户空闲时间生成优先级建议
 */

import { NextResponse } from 'next/server';
import { fetchAllRecords, type WorkspaceConfig } from '@/lib/dingtalk';
import { ESTIMATED_MINUTES_BY_STATUS } from '@/lib/types';

const EXCLUDED_STATUSES = ['Offer', '已拒绝', '简历挂', '测评挂', '笔试挂', '面试挂', '已挂'];

interface PlanTask {
  company: string;
  position: string;
  deadline: string;
  estimated_minutes: number | null;
  status: string;
  city: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      free_time?: string;
      workspace?: { baseId?: string; sheetId?: string; appKey?: string; appSecret?: string; operatorId?: string; demoMode?: boolean };
      deepseekKey?: string;
      demoMode?: boolean;
    };
    const freeTime = body.free_time?.trim();
    const wsRaw = body.workspace;
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

    if (!freeTime) {
      return NextResponse.json({ success: false, error: '请描述你的空闲时间' }, { status: 400 });
    }

    // 演示模式优先使用环境变量; 否则使用调用方传入的 deepseekKey; 两者都没有则报错
    const resolvedDeepseekKey = isDemo ? process.env.DEMO_DEEPSEEK_API_KEY : body.deepseekKey;
    if (!resolvedDeepseekKey) {
      return NextResponse.json({ success: false, error: '缺少 DeepSeek API Key' }, { status: 500 });
    }

    // 1. 获取所有记录并解析
    const rawRecords = await fetchAllRecords(workspace);
    const allTasks: PlanTask[] = rawRecords.map(parseRecordForPlan);

    // 2. 过滤出需要采取行动的记录
    const activeTasks = allTasks.filter(
      (t) => t.company && t.position && !EXCLUDED_STATUSES.includes(t.status)
    );

    if (activeTasks.length === 0) {
      return NextResponse.json({
        success: true,
        plan: [],
        summary: '暂时没有需要安排的任务',
      });
    }

    // 3. 构建 prompt
    const taskList = activeTasks.map((t) => {
      const minutes = t.estimated_minutes ?? '未设置';
      return `- ${t.company} | ${t.position} | DDL: ${t.deadline || '未设置'} | 预计耗时: ${minutes}分钟 | 状态: ${t.status} | 城市: ${t.city || '未设置'}`;
    }).join('\n');

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const systemPrompt = `你是一位秋招规划助手。请根据用户的空闲时间,从任务列表中合理安排优先做的任务。

紧急判定规则 (用于 reason 中说明"紧急"或"暂缓"):
- 状态为面试环节(AI面/群面/一面/二面/三面/HR面): 紧急, 因为流程正在进行中
- DDL在7天以内: 紧急
- 状态为测评/笔试且有明确待办: 紧急
- 状态为已投递且有DDL: 一般
- 状态为已投递且无DDL: 一般
- 状态为待投递: 一般
- 时间预算不够、DDL还早、流程不急: 暂缓

其他规则:
1. DDL越近的优先级越高
2. 在时间预算内,尽量安排能做完的任务组合
3. 明确写出建议做哪些、大概按什么顺序、预计各花多少时间
4. 对于时间不够、DDL还早的任务,建议"可以暂缓"
5. 今天的日期是 ${todayStr}
6. 如果某个任务的预计耗时为"未设置"(null), 请按统一对照表估算: 待投递=20, 测评=60, 笔试=60, AI面/群面/一面/二面/三面/HR面=120。已有具体数值的不要改动
7. 建议动作要具体,比如:网申、填写测评、准备笔试、准备面试等
8. 必须为任务列表中的每个任务都生成一条计划项,不能省略任何任务
9. 时间预算内做不完的任务,放在计划末尾,reason写"可以暂缓"
10. 相同状态的任务,紧急程度必须一致 (例如两个都是"已投递"状态,不能一个写紧急一个写暂缓,除非DDL差异很大)`;

    const userPrompt = `这是用户当前的秋招任务列表:
${taskList}

用户现在有 ${freeTime} 空闲时间。

请给出一个任务优先级建议,严格按下面的JSON格式输出,不要有多余的文字:
{
  "plan": [
    { "company": "公司", "position": "岗位", "action": "建议做的动作(比如网申/测评/准备面试)", "estimated_minutes": 数字, "reason": "为什么优先/暂缓的一句话理由" }
  ],
  "summary": "一句话总结本次的安排"
}

注意:plan数组里的顺序就是建议的执行顺序。reason里如果建议暂缓,请明确写"可以暂缓"。必须包含任务列表中的每一个任务,不能遗漏。`;

    // 4. 调用 DeepSeek
    const aiRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resolvedDeepseekKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('[plan] DeepSeek API error:', aiRes.status, errText);
      return NextResponse.json({ success: false, error: 'AI 规划失败,请稍后重试' }, { status: 500 });
    }

    const aiData = await aiRes.json();
    const rawContent = aiData.choices?.[0]?.message?.content ?? '';

    // 5. 解析 JSON
    const parsed = parseAiResponse(rawContent);
    if (!parsed) {
      console.error('[plan] AI 返回无法解析:', rawContent.slice(0, 500));
      return NextResponse.json({
        success: false,
        error: 'AI 返回格式异常,请重新生成',
      }, { status: 500 });
    }

    // 6. 用表格中的真实预计耗时覆盖 AI 返回值, 确保前后端一致 (AI 可能把暂缓项估成 0)
    //    匹配规则: 公司+岗位 完全一致; 找不到时回退到公司名匹配
    const normalize = (s: string) => s.trim().toLowerCase();
    const planWithStatus = parsed.plan.map((item: Record<string, unknown>) => {
      const itemCompany = normalize(String(item.company ?? ''));
      const itemPosition = normalize(String(item.position ?? ''));
      const task =
        activeTasks.find(
          (t) => normalize(t.company) === itemCompany && normalize(t.position) === itemPosition
        ) ?? activeTasks.find((t) => normalize(t.company) === itemCompany);

      const status = task?.status ?? '';
      const tableMin = task?.estimated_minutes;
      // 表格有有效数值时用表格值; 否则按状态对照表兜底 (避免显示 0)
      const minutes =
        tableMin && tableMin > 0
          ? tableMin
          : (ESTIMATED_MINUTES_BY_STATUS[status] ?? null);

      return { ...item, status, estimated_minutes: minutes };
    });

    return NextResponse.json({
      success: true,
      plan: planWithStatus,
      summary: parsed.summary,
    });
  } catch (error) {
    console.error('[plan] 生成计划异常:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '生成计划失败' },
      { status: 500 }
    );
  }
}

// ============== 本地解析辅助函数 ==============

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
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.label === 'string') return obj.label;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.link === 'string') return obj.link;
    return JSON.stringify(value);
  }
  return String(value);
}

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

function parseRecordForPlan(record: { recordId: string; fields: Record<string, unknown> }): PlanTask {
  const f = record.fields;
  const company = extractText(f['公司']);
  const position = extractText(f['岗位']);
  const status = extractText(f['状态']) || '待投递';

  // 城市
  const city = extractStringArray(f['城市']).join('/');

  // 投递DDL
  let deadline = '';
  const rawDdl = f['投递DDL'];
  if (typeof rawDdl === 'number') {
    const d = new Date(rawDdl);
    if (!isNaN(d.getTime())) {
      deadline = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  } else if (typeof rawDdl === 'string' && rawDdl) {
    deadline = rawDdl;
  }

  // 预计耗时
  let estimatedMinutes: number | null = null;
  const rawMin = f['预计耗时'];
  if (typeof rawMin === 'number') {
    estimatedMinutes = rawMin;
  } else if (typeof rawMin === 'string') {
    const n = parseInt(rawMin, 10);
    if (!isNaN(n)) estimatedMinutes = n;
  }

  return { company, position, deadline, estimated_minutes: estimatedMinutes, status, city };
}

/**
 * 解析 AI 返回的 JSON (容错处理)
 */
function parseAiResponse(content: string): { plan: any[]; summary: string } | null {
  if (!content) return null;

  // 尝试直接解析
  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.plan) && typeof parsed.summary === 'string') {
      return parsed;
    }
  } catch {
    // 继续尝试提取 JSON
  }

  // 尝试从 markdown code block 中提取
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && Array.isArray(parsed.plan)) {
        return parsed;
      }
    } catch {
      // 继续尝试
    }
  }

  // 尝试从文本中提取 { ... } 块
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && Array.isArray(parsed.plan)) {
        return parsed;
      }
    } catch {
      // 失败
    }
  }

  return null;
}
