/**
 * 健康检查: 验证环境变量是否就绪
 */

import { NextResponse } from 'next/server';

export async function GET() {
  const required = [
    'DEEPSEEK_API_KEY',
    'DINGTALK_APP_KEY',
    'DINGTALK_APP_SECRET',
    'DINGTALK_BASE_ID',
  ];

  const missing = required.filter((k) => !process.env[k]);

  // 千问是可选的 (仅图片场景需要)
  const qwenOk = !!process.env.QWEN_API_KEY;

  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        status: 'missing_env',
        missing,
        qwen_ready: qwenOk,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    status: 'ready',
    qwen_ready: qwenOk,
  });
}
