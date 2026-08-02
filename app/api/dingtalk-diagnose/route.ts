/**
 * 钉钉连接诊断端点
 * 用于: 测试 token 获取、自动获取 operatorId
 * 访问: GET /api/dingtalk-diagnose
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  const results: Record<string, unknown> = {
    env: {
      hasAppKey: !!process.env.DINGTALK_APP_KEY,
      hasAppSecret: !!process.env.DINGTALK_APP_SECRET,
      hasBaseId: !!process.env.DINGTALK_BASE_ID,
      hasTableId: !!process.env.DINGTALK_TABLE_ID,
      hasOperatorId: !!process.env.DINGTALK_OPERATOR_ID,
    },
  };

  // Step 1: 获取 token
  try {
    const appKey = process.env.DINGTALK_APP_KEY ?? '';
    const appSecret = process.env.DINGTALK_APP_SECRET ?? '';
    const tokenUrl = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;

    const tokenRes = await fetch(tokenUrl);
    const tokenData = (await tokenRes.json()) as {
      errcode: number;
      errmsg: string;
      access_token?: string;
      expires_in?: number;
    };

    if (tokenData.errcode !== 0) {
      return NextResponse.json({
        step: 'getToken',
        success: false,
        error: `获取 token 失败: ${tokenData.errcode} ${tokenData.errmsg}`,
      });
    }

    results.tokenOk = true;
    results.tokenExpiresIn = tokenData.expires_in;
    const token = tokenData.access_token!;

    // Step 2: 尝试自动获取 operatorId
    try {
      const opUrl = 'https://api.dingtalk.com/v1.0/contact/users/me';
      const opRes = await fetch(opUrl, {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      const opData = (await opRes.json()) as Record<string, unknown>;
      results.operatorIdResponse = opData;

      if (opRes.ok && opData.unionId) {
        results.operatorId = opData.unionId;
        results.operatorIdFound = true;
      } else {
        results.operatorIdFound = false;
        results.operatorIdError = opData;
      }
    } catch (e) {
      results.operatorIdFound = false;
      results.operatorIdError = String(e);
    }

    // Step 3: 尝试列出数据表 (验证权限和路径)
    const baseId = process.env.DINGTALK_BASE_ID ?? '';
    const tableId = process.env.DINGTALK_TABLE_ID || baseId || '';
    const operatorId = (results.operatorId as string) || process.env.DINGTALK_OPERATOR_ID || '';

    if (operatorId && baseId && tableId) {
      try {
        // 尝试获取所有数据表 (验证 baseId 是否正确)
        const sheetsUrl = `https://api.dingtalk.com/v1.0/notable/bases/${baseId}/sheets?operatorId=${encodeURIComponent(operatorId)}`;
        const sheetsRes = await fetch(sheetsUrl, {
          method: 'GET',
          headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
          },
        });

        if (sheetsRes.ok) {
          const sheetsData = (await sheetsRes.json()) as {
            sheets?: Array<{ id: string; name: string }>;
          };
          results.sheets = sheetsData.sheets ?? [];
          results.sheetCheckOk = true;
        } else {
          const errText = await sheetsRes.text();
          results.sheetCheckOk = false;
          results.sheetCheckError = `HTTP ${sheetsRes.status}: ${errText}`;
        }

        // 尝试列出字段 (获取表结构)
        try {
          const fieldsUrl = `https://api.dingtalk.com/v1.0/notable/bases/${baseId}/sheets/${tableId}/fields?operatorId=${encodeURIComponent(operatorId)}`;
          const fieldsRes = await fetch(fieldsUrl, {
            method: 'GET',
            headers: {
              'x-acs-dingtalk-access-token': token,
              'Content-Type': 'application/json',
            },
          });

          if (fieldsRes.ok) {
            const fieldsData = (await fieldsRes.json()) as {
              fields?: Array<{ id: string; name: string; type: number }>;
            };
            results.tableFields = fieldsData.fields ?? [];
          } else {
            const errText = await fieldsRes.text();
            results.tableFieldsError = `HTTP ${fieldsRes.status}: ${errText}`;
          }
        } catch (e) {
          results.tableFieldsError = String(e);
        }

        // 尝试列出记录
        const listUrl = `https://api.dingtalk.com/v1.0/notable/bases/${baseId}/sheets/${tableId}/records/list?operatorId=${encodeURIComponent(operatorId)}`;
        const listRes = await fetch(listUrl, {
          method: 'POST',
          headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ maxResults: 3 }),
        });

        if (listRes.ok) {
          const listData = (await listRes.json()) as {
            records?: Array<{ id: string; fields: Record<string, unknown> }>;
          };
          results.recordCheckOk = true;
          results.recordCount = listData.records?.length ?? 0;
          // 列出第一条记录的字段名
          if (listData.records && listData.records.length > 0) {
            results.sampleRecordFields = Object.keys(listData.records[0].fields ?? {});
          }
        } else {
          const errText = await listRes.text();
          results.recordCheckOk = false;
          results.recordCheckError = `HTTP ${listRes.status}: ${errText}`;
        }
      } catch (e) {
        results.sheetCheckOk = false;
        results.sheetCheckError = String(e);
      }
    }

    return NextResponse.json(results);
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: String(e),
      hint: '请检查 DINGTALK_APP_KEY 和 DINGTALK_APP_SECRET 是否正确',
    });
  }
}
