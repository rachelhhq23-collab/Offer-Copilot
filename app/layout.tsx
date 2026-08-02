import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Offer Copilot — 求职工作台',
  description: '把散落各处的招聘信息，变成一个持续更新的求职工作台',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
