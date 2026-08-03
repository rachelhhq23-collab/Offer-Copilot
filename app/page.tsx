'use client';

import React, { useState, useRef, useEffect, ChangeEvent, DragEvent } from 'react';
import { Inbox, BriefcaseBusiness, CalendarCheck, X, ChevronDown, ChevronUp, Clock, MapPin, ExternalLink, Trash2, Plus, Minus, Eye, EyeOff, MoreHorizontal, Filter, RefreshCw, FileText, Users, Target, AlertTriangle, AlertCircle, CheckCircle, Search, Check, Upload, Settings2, FolderOpen, Code, Info, HelpCircle, ArrowLeft, ArrowRight, Cpu } from 'lucide-react';
import './page.css';
import { useWorkspaces, type Workspace, type DevCredentials, type AIKeys } from '@/lib/workspace';

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateStr;
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  return `${month}月${day}日`;
}

function deadlineStatus(ddl: string | null | undefined, status: string): 'ok' | 'soon' | 'overdue' | 'none' {
  if (!ddl) return 'none';
  const ddlDate = new Date(ddl + 'T00:00:00+08:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((ddlDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    if (['Offer', '已拒绝', '简历挂', '测评挂', '笔试挂', '面试挂', '已挂'].includes(status)) {
      return 'ok';
    }
    return 'overdue';
  }
  if (diffDays <= 3) return 'soon';
  return 'ok';
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    '待投递': 'gray',
    '已投递': 'blue',
    '测评': 'blue',
    '笔试': 'blue',
    '一面': 'purple',
    '二面': 'purple',
    '三面': 'purple',
    'AI面': 'purple',
    '群面': 'purple',
    'HR面': 'purple',
    'Offer': 'green',
    '已拒绝': 'dark',
    '简历挂': 'dark',
    '测评挂': 'dark',
    '笔试挂': 'dark',
    '面试挂': 'dark',
    '已挂': 'dark',
  };
  return map[status] ?? 'gray';
}

function statusClass(status: string): string {
  const c = statusColor(status);
  const map: Record<string, string> = {
    'gray': 'status-gray',
    'blue': 'status-blue',
    'purple': 'status-blue',
    'green': 'status-green',
    'dark': 'status-danger',
  };
  return map[c] ?? 'status-gray';
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays}天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ===== 类型定义 =====

interface Candidate {
  position: string;
  job_code: string | null;
  description: string | null;
  requirements: string | null;
}

interface SharedFields {
  deadline: string | null;
  application_limit: number | null;
  referral_code: string | null;
  source_link: string | null;
  city: string[];
}

interface BatchResult {
  message_type: 'batch';
  source_company: string;
  shared_fields: SharedFields;
  candidates: Candidate[];
}

interface ParseResult {
  success: boolean;
  message_type?: 'single' | 'batch';
  action?: 'created' | 'updated';
  parsed?: {
    company: string | null;
    position: string | null;
    job_code?: string | null;
    city: string[];
    deadline: string | null;
    description?: string | null;
    requirements: string | null;
    application_limit?: number | null;
    referral_code?: string | null;
    status_hint: string;
    todo?: string | null;
    estimated_minutes?: number | null;
    remark?: string | null;
    source_channel?: string | null;
    match_key: string;
    locations?: Array<{ city: string; date: string | null }>;
    source_url?: string | null;
    priority?: string;
  };
  recordId?: string;
  message?: string;
  error?: string;
  batch_result?: BatchResult;
}

interface BatchSubmitResultItem {
  candidate: Candidate;
  action: 'created' | 'updated';
  recordId: string;
  message: string;
}

interface BatchSubmitResponse {
  success: boolean;
  results: BatchSubmitResultItem[];
  message?: string;
  error?: string;
}

interface HistoryRecordItem {
  recordId: string;
  company: string;
  position: string;
  job_code: string | null;
  city: string[];
  deadline: string | null;
  status: string;
  priority: string | null;
  last_updated_time: number | null;
  raw_text: string | null;
  raw_image: string | null;
  source_channel: string | null;
  todo: string | null;
  referral_code: string | null;
  source_url: string | null;
}

interface PlanItem {
  company: string;
  position: string;
  action: string;
  estimated_minutes: number | null;
  status?: string;
  reason: string;
}

interface PlanResult {
  plan: PlanItem[];
  summary: string;
}

// ===== 添加工作空间表单组件 =====
function AddWorkspaceForm({ onAdd }: { onAdd: (ws: { name: string; baseId: string; sheetId?: string }) => void }) {
  const [name, setName] = useState('');
  const [baseId, setBaseId] = useState('');
  const [sheetId, setSheetId] = useState('');
  const [expanded, setExpanded] = useState(false);

  const handleSubmit = () => {
    if (!name.trim() || !baseId.trim()) return;
    onAdd({
      name: name.trim(),
      baseId: baseId.trim(),
      sheetId: sheetId.trim() || undefined,
    });
    setName('');
    setBaseId('');
    setSheetId('');
    setExpanded(false);
  };

  if (!expanded) {
    return (
      <button className="btn btn-ghost add-workspace-btn" onClick={() => setExpanded(true)}>
        <Plus size={14} /> 添加工作空间
      </button>
    );
  }

  return (
    <div className="add-workspace-form">
      <input
        type="text"
        placeholder="工作空间名称（如：比赛演示）"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="text"
        placeholder="baseId（钉钉 AI 表格 ID）"
        value={baseId}
        onChange={(e) => setBaseId(e.target.value)}
      />
      <input
        type="text"
        placeholder="sheetId（可选，留空自动检测）"
        value={sheetId}
        onChange={(e) => setSheetId(e.target.value)}
      />
      <div className="add-workspace-actions">
        <button
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={!name.trim() || !baseId.trim()}
        >
          保存
        </button>
        <button className="btn btn-ghost" onClick={() => setExpanded(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

// ===== 开发者配置组件 =====
function DevConfigSection({
  credentials,
  onSave,
}: {
  credentials: DevCredentials | null;
  onSave: (creds: DevCredentials | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [appKey, setAppKey] = useState(credentials?.appKey ?? '');
  const [appSecret, setAppSecret] = useState(credentials?.appSecret ?? '');
  const [operatorId, setOperatorId] = useState(credentials?.operatorId ?? '');
  const [showSecret, setShowSecret] = useState(false);
  const [showOpTooltip, setShowOpTooltip] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setAppKey(credentials?.appKey ?? '');
    setAppSecret(credentials?.appSecret ?? '');
    setOperatorId(credentials?.operatorId ?? '');
  }, [credentials]);

  const hasSaved = !!credentials?.appKey;

  const handleSave = () => {
    const key = appKey.trim();
    const secret = appSecret.trim();
    const opId = operatorId.trim();
    if (!key && !secret && !opId) {
      onSave(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return;
    }
    if (!key || !secret || !opId) return;
    onSave({ appKey: key, appSecret: secret, operatorId: opId });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = () => {
    setAppKey('');
    setAppSecret('');
    setOperatorId('');
    onSave(null);
  };

  return (
    <div className={`dev-config ${expanded ? 'expanded' : ''}`}>
      {/* 折叠标题栏 */}
      <button
        className="dev-config-header-bar"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="dev-config-header-left">
          <Code size={14} />
          <span className="dev-config-header-title">开发者配置</span>
          {hasSaved && (
            <span className="dev-config-header-badge">
              <CheckCircle size={11} />
              已启用
            </span>
          )}
        </span>
        <ChevronDown size={14} className={`dev-config-chevron ${expanded ? 'open' : ''}`} />
      </button>

      {/* 展开内容 */}
      {expanded && (
        <div className="dev-config-body">
          {/* 低调提示 */}
          <div className="dev-config-notice">
            <Info size={13} />
            <span>仅本地开发使用，内容存储在当前浏览器，请勿在公共设备填写真实密钥。</span>
          </div>

          {/* 默认应用说明 */}
          <p className="dev-config-desc">
            用于读写你的钉钉 AI 表格。请填写你自己的企业内部应用凭据（AppKey / AppSecret / 操作人 UnionId），所有字段均为必填。
          </p>

          <div className="dev-config-fields">
            <div className="dev-config-field">
              <label className="dev-config-label">AppKey</label>
              <input
                type="text"
                className="dev-config-input"
                value={appKey}
                onChange={(e) => setAppKey(e.target.value)}
                placeholder="钉钉应用的 AppKey"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="dev-config-field">
              <label className="dev-config-label">
                AppSecret
                <button
                  type="button"
                  className="dev-config-toggle"
                  onClick={() => setShowSecret((v) => !v)}
                >
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                  {showSecret ? '隐藏' : '显示'}
                </button>
              </label>
              <input
                type={showSecret ? 'text' : 'password'}
                className="dev-config-input"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder="钉钉应用的 AppSecret"
                autoComplete="off"
                spellCheck={false}
              />
              <a
                className="dev-config-helper-link"
                href="https://open-dev.dingtalk.com/apiExplorer#/?devType=org&api=dingtalk.oapi.gettoken"
                target="_blank"
                rel="noopener noreferrer"
              >
                如何获取 AppKey / AppSecret?查看指南 →
              </a>
            </div>

            <div className="dev-config-field">
              <label className="dev-config-label">
                操作人 ID
                <span
                  className="dev-config-tooltip-trigger"
                  onMouseEnter={() => setShowOpTooltip(true)}
                  onMouseLeave={() => setShowOpTooltip(false)}
                >
                  <HelpCircle size={13} />
                  {showOpTooltip && (
                    <span className="dev-config-tooltip">
                      登录钉钉开放平台的{' '}
                      <a
                        href="https://open-dev.dingtalk.com/apiExplorer#/?devType=org&api=dingtalk.oapi.v2.user.get"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        API Explorer
                      </a>
                      ，打开 &ldquo;dingtalk.oapi.v2.user.get&rdquo; 接口，输入你的 userId 查询，返回结果中的 unionId 即为所需值。
                    </span>
                  )}
                </span>
              </label>
              <input
                type="text"
                className="dev-config-input"
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
                placeholder="你的钉钉 unionId"
                autoComplete="off"
                spellCheck={false}
              />
              <a
                className="dev-config-helper-link"
                href="https://open-dev.dingtalk.com/apiExplorer#/?devType=org&api=dingtalk.oapi.v2.user.get"
                target="_blank"
                rel="noopener noreferrer"
              >
                如何获取 UnionId?查看指南 →
              </a>
            </div>
          </div>

          <div className="dev-config-actions">
            {hasSaved && (
              <span className="dev-config-status">
                <CheckCircle size={14} />
                已启用本地凭据
              </span>
            )}
            <button className="btn btn-secondary" onClick={handleClear} disabled={!hasSaved && !appKey && !appSecret && !operatorId}>
              清除
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={!appKey.trim() && !appSecret.trim() && !operatorId.trim()}>
              {saved ? '已保存' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 工作空间切换器组件 =====
function WorkspaceSwitcher({
  workspaces,
  activeId,
  activeWorkspace,
  onSelect,
  onManage,
}: {
  workspaces: Workspace[];
  activeId: string;
  activeWorkspace: Workspace | null;
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  if (workspaces.length === 0) {
    return (
      <button className="ws-trigger ws-empty" onClick={onManage}>
        <Settings2 size={14} />
        <span>添加工作空间</span>
      </button>
    );
  }

  return (
    <div className="ws-dropdown" ref={ref}>
      <button
        className="ws-trigger"
        onClick={() => setOpen((v) => !v)}
        title="切换工作空间"
      >
        <FolderOpen size={14} />
        <span className="ws-trigger-name">{activeWorkspace?.name ?? '选择工作空间'}</span>
        <ChevronDown size={13} className={`ws-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && (
        <div className="ws-menu">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              className={`ws-menu-item ${ws.id === activeId ? 'active' : ''}`}
              onClick={() => {
                onSelect(ws.id);
                setOpen(false);
              }}
            >
              <span className="ws-menu-name">{ws.name}</span>
              <span className="ws-menu-id">{ws.baseId.slice(0, 6)}…</span>
              {ws.id === activeId && <Check size={14} className="ws-menu-check" />}
            </button>
          ))}
          <div className="ws-menu-divider" />
          <button
            className="ws-menu-manage"
            onClick={() => {
              onManage();
              setOpen(false);
            }}
          >
            <Settings2 size={13} />
            <span>管理工作空间</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ===== AI 模型配置组件（设置页用） =====
function AIConfigSection({
  aiKeys,
  onSave,
}: {
  aiKeys: AIKeys | null;
  onSave: (keys: AIKeys | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deepseekKey, setDeepseekKey] = useState(aiKeys?.deepseekKey ?? '');
  const [qwenKey, setQwenKey] = useState(aiKeys?.qwenKey ?? '');
  const [showDeepseek, setShowDeepseek] = useState(false);
  const [showQwen, setShowQwen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDeepseekKey(aiKeys?.deepseekKey ?? '');
    setQwenKey(aiKeys?.qwenKey ?? '');
  }, [aiKeys]);

  const hasSaved = !!(aiKeys?.deepseekKey || aiKeys?.qwenKey);

  const handleSave = () => {
    const dk = deepseekKey.trim();
    const qk = qwenKey.trim();
    if (!dk && !qk) {
      onSave(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return;
    }
    onSave({ deepseekKey: dk, qwenKey: qk });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = () => {
    setDeepseekKey('');
    setQwenKey('');
    onSave(null);
  };

  return (
    <div className={`dev-config ai-config ${expanded ? 'expanded' : ''}`}>
      <button
        className="dev-config-header-bar"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="dev-config-header-left">
          <Cpu size={14} />
          <span className="dev-config-header-title">AI 模型配置</span>
          {hasSaved && (
            <span className="dev-config-header-badge">
              <CheckCircle size={11} />
              已启用
            </span>
          )}
        </span>
        <ChevronDown size={14} className={`dev-config-chevron ${expanded ? 'open' : ''}`} />
      </button>

      {expanded && (
        <div className="dev-config-body">
          <div className="dev-config-notice">
            <Info size={13} />
            <span>文字信息用 DeepSeek 解析，海报/截图用图像模型（Qwen-VL）识别。密钥仅存储在当前浏览器。</span>
          </div>

          <div className="dev-config-fields">
            <div className="dev-config-field">
              <label className="dev-config-label">
                DeepSeek API Key
                <button
                  type="button"
                  className="dev-config-toggle"
                  onClick={() => setShowDeepseek((v) => !v)}
                >
                  {showDeepseek ? <EyeOff size={13} /> : <Eye size={13} />}
                  {showDeepseek ? '隐藏' : '显示'}
                </button>
              </label>
              <input
                type={showDeepseek ? 'text' : 'password'}
                className="dev-config-input"
                value={deepseekKey}
                onChange={(e) => setDeepseekKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
              <a
                className="dev-config-helper-link"
                href="https://platform.deepseek.com/api_keys"
                target="_blank"
                rel="noopener noreferrer"
              >
                前往 platform.deepseek.com 获取 →
              </a>
            </div>

            <div className="dev-config-field">
              <label className="dev-config-label">
                图像模型 API Key（Qwen-VL）
                <button
                  type="button"
                  className="dev-config-toggle"
                  onClick={() => setShowQwen((v) => !v)}
                >
                  {showQwen ? <EyeOff size={13} /> : <Eye size={13} />}
                  {showQwen ? '隐藏' : '显示'}
                </button>
              </label>
              <input
                type={showQwen ? 'text' : 'password'}
                className="dev-config-input"
                value={qwenKey}
                onChange={(e) => setQwenKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
              <a
                className="dev-config-helper-link"
                href="https://bailian.console.aliyun.com/?apiKey=1#/api-key"
                target="_blank"
                rel="noopener noreferrer"
              >
                前往阿里云百炼获取 →
              </a>
              <p className="dev-config-desc">
                用于识别招聘海报/截图。未填写时仅支持文字解析。
              </p>
            </div>
          </div>

          <div className="dev-config-actions">
            {hasSaved && (
              <span className="dev-config-status">
                <CheckCircle size={14} />
                已启用本地密钥
              </span>
            )}
            <button className="btn btn-secondary" onClick={handleClear} disabled={!hasSaved && !deepseekKey && !qwenKey}>
              清除
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={!deepseekKey.trim() && !qwenKey.trim()}>
              {saved ? '已保存' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 演示模式提示条 =====
function DemoBanner({ onExit }: { onExit: () => void }) {
  return (
    <div className="demo-banner">
      <div className="demo-banner-content">
        <Info size={14} />
        <span className="demo-banner-text">
          当前为演示模式，数据可能被其他访问者查看。正式使用请配置你自己的账号。
        </span>
        <button className="demo-banner-btn" onClick={onExit}>
          配置我自己的账号
        </button>
      </div>
    </div>
  );
}

// ===== 引导式配置向导 =====
function SetupWizard({
  aiKeys,
  credentials,
  workspaces,
  onSaveAIKeys,
  onSaveCredentials,
  onAddWorkspace,
  onFinish,
}: {
  aiKeys: AIKeys | null;
  credentials: DevCredentials | null;
  workspaces: Workspace[];
  onSaveAIKeys: (keys: AIKeys) => void;
  onSaveCredentials: (creds: DevCredentials) => void;
  onAddWorkspace: (ws: { name: string; baseId: string; sheetId?: string }) => void;
  onFinish: () => void;
}) {
  const [step, setStep] = useState(0);

  // 步骤 1: AI 模型
  const [deepseekKey, setDeepseekKey] = useState(aiKeys?.deepseekKey ?? '');
  const [qwenKey, setQwenKey] = useState(aiKeys?.qwenKey ?? '');
  const [showDeepseek, setShowDeepseek] = useState(false);
  const [showQwen, setShowQwen] = useState(false);

  // 步骤 2: 钉钉应用
  const [appKey, setAppKey] = useState(credentials?.appKey ?? '');
  const [appSecret, setAppSecret] = useState(credentials?.appSecret ?? '');
  const [operatorId, setOperatorId] = useState(credentials?.operatorId ?? '');
  const [showSecret, setShowSecret] = useState(false);

  // 步骤 3: 工作空间
  const [wsName, setWsName] = useState(workspaces[0]?.name ?? '');
  const [baseId, setBaseId] = useState(workspaces[0]?.baseId ?? '');

  const step1Valid = !!deepseekKey.trim() || !!qwenKey.trim();
  const step2Valid = !!appKey.trim() && !!appSecret.trim() && !!operatorId.trim();
  const step3Valid = !!wsName.trim() && !!baseId.trim();

  const handleNext = () => {
    if (step === 0) {
      if (!step1Valid) return;
      onSaveAIKeys({ deepseekKey: deepseekKey.trim(), qwenKey: qwenKey.trim() });
      setStep(1);
    } else if (step === 1) {
      if (!step2Valid) return;
      onSaveCredentials({
        appKey: appKey.trim(),
        appSecret: appSecret.trim(),
        operatorId: operatorId.trim(),
      });
      setStep(2);
    }
  };

  const handleBack = () => {
    if (step > 0) setStep(step - 1);
  };

  const handleFinish = () => {
    if (!step3Valid) return;
    // 如果工作空间列表里已有同 baseId 的，不重复添加
    const exists = workspaces.some((w) => w.baseId === baseId.trim());
    if (!exists) {
      onAddWorkspace({ name: wsName.trim(), baseId: baseId.trim() });
    }
    onFinish();
  };

  const stepLabels = ['AI 模型', '钉钉应用', '工作空间'];

  return (
    <main className="wizard-page">
      <div className="wizard-card">
        {/* Logo / 标题 */}
        <div className="wizard-brand">
          <h1 className="wizard-title">Offer Copilot</h1>
          <p className="wizard-subtitle">把散落各处的招聘信息,变成一个持续更新的 Offer 工作台</p>
        </div>

        {/* 进度指示 */}
        <div className="wizard-progress">
          <div className="wizard-dots">
            {stepLabels.map((label, idx) => (
              <div
                key={idx}
                className={`wizard-dot-item ${idx === step ? 'current' : ''} ${idx < step ? 'done' : ''}`}
              >
                <div className="wizard-dot">
                  {idx < step ? <Check size={12} /> : idx + 1}
                </div>
                <span className="wizard-dot-label">{label}</span>
              </div>
            ))}
          </div>
          <div className="wizard-step-counter">步骤 {step + 1} / 3</div>
        </div>

        {/* 步骤内容（带过渡动画） */}
        <div key={step} className="wizard-step-content">
          {step === 0 && (
            <div className="wizard-step-pane">
              <div className="wizard-step-header">
                <h2 className="wizard-step-title">配置 AI 模型</h2>
                <p className="wizard-step-desc">文字用 DeepSeek 解析，海报/截图用 Qwen-VL 图像模型识别，请填入对应的 API 密钥。</p>
              </div>

              <div className="wizard-fields">
                <div className="wizard-field">
                  <label className="wizard-label">DeepSeek API Key</label>
                  <div className="wizard-input-wrap">
                    <input
                      type={showDeepseek ? 'text' : 'password'}
                      className="wizard-input"
                      value={deepseekKey}
                      onChange={(e) => setDeepseekKey(e.target.value)}
                      placeholder="sk-..."
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="wizard-input-toggle"
                      onClick={() => setShowDeepseek((v) => !v)}
                    >
                      {showDeepseek ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <a
                    className="wizard-helper-link"
                    href="https://platform.deepseek.com/api_keys"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    前往 platform.deepseek.com 获取 →
                  </a>
                </div>

                <div className="wizard-field">
                  <label className="wizard-label">图像模型 API Key（Qwen-VL）</label>
                  <div className="wizard-input-wrap">
                    <input
                      type={showQwen ? 'text' : 'password'}
                      className="wizard-input"
                      value={qwenKey}
                      onChange={(e) => setQwenKey(e.target.value)}
                      placeholder="sk-..."
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="wizard-input-toggle"
                      onClick={() => setShowQwen((v) => !v)}
                    >
                      {showQwen ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <a
                    className="wizard-helper-link"
                    href="https://bailian.console.aliyun.com/?apiKey=1#/api-key"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    前往阿里云百炼获取 →
                  </a>
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="wizard-step-pane">
              <div className="wizard-step-header">
                <h2 className="wizard-step-title">配置钉钉应用</h2>
                <p className="wizard-step-desc">接下来配置你的钉钉应用身份,用于读写你的招聘信息表格。</p>
              </div>

              <div className="wizard-fields">
                <div className="wizard-field">
                  <label className="wizard-label">AppKey</label>
                  <input
                    type="text"
                    className="wizard-input"
                    value={appKey}
                    onChange={(e) => setAppKey(e.target.value)}
                    placeholder="钉钉应用的 AppKey"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="wizard-field">
                  <label className="wizard-label">AppSecret</label>
                  <div className="wizard-input-wrap">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      className="wizard-input"
                      value={appSecret}
                      onChange={(e) => setAppSecret(e.target.value)}
                      placeholder="钉钉应用的 AppSecret"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="wizard-input-toggle"
                      onClick={() => setShowSecret((v) => !v)}
                    >
                      {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <a
                    className="wizard-helper-link"
                    href="https://open-dev.dingtalk.com/apiExplorer#/?devType=org&api=dingtalk.oapi.gettoken"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    如何获取 AppKey / AppSecret?查看指南 →
                  </a>
                </div>

                <div className="wizard-field">
                  <label className="wizard-label">操作人 UnionId</label>
                  <input
                    type="text"
                    className="wizard-input"
                    value={operatorId}
                    onChange={(e) => setOperatorId(e.target.value)}
                    placeholder="你的钉钉 unionId"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <a
                    className="wizard-helper-link"
                    href="https://open-dev.dingtalk.com/apiExplorer#/?devType=org&api=dingtalk.oapi.v2.user.get"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    如何获取 UnionId?查看指南 →
                  </a>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="wizard-step-pane">
              <div className="wizard-step-header">
                <h2 className="wizard-step-title">绑定你的第一个工作空间</h2>
                <p className="wizard-step-desc">最后一步,告诉我们你的钉钉 AI 表格 ID（baseId）,我们会用它来保存你的求职记录。</p>
              </div>

              <div className="wizard-fields">
                <div className="wizard-field">
                  <label className="wizard-label">工作空间名称</label>
                  <input
                    type="text"
                    className="wizard-input"
                    value={wsName}
                    onChange={(e) => setWsName(e.target.value)}
                    placeholder="如：我的秋招、比赛演示"
                    autoComplete="off"
                  />
                </div>

                <div className="wizard-field">
                  <label className="wizard-label">钉钉 AI 表格 baseId</label>
                  <input
                    type="text"
                    className="wizard-input"
                    value={baseId}
                    onChange={(e) => setBaseId(e.target.value)}
                    placeholder="从钉钉 AI 表格的分享链接中获取"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="wizard-actions">
          {step > 0 && (
            <button className="btn btn-ghost wizard-btn-back" onClick={handleBack}>
              <ArrowLeft size={14} /> 上一步
            </button>
          )}
          {step < 2 ? (
            <button
              className="btn btn-primary wizard-btn-next"
              onClick={handleNext}
              disabled={step === 0 ? !step1Valid : !step2Valid}
            >
              下一步 <ArrowRight size={14} />
            </button>
          ) : (
            <button
              className="btn btn-primary wizard-btn-finish"
              onClick={handleFinish}
              disabled={!step3Valid}
            >
              <Check size={14} /> 完成配置
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

// ===== 主组件 =====

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<'submit' | 'history' | 'plan' | 'settings'>('submit');

  // 工作空间
  const {
    workspaces,
    activeId,
    activeWorkspace,
    currentConfig,
    setActive,
    addWorkspace,
    updateWorkspace,
    removeWorkspace,
    credentials,
    setDevCredentials,
    aiKeys,
    setAIKeys,
    demoMode,
    exitDemoMode,
    configComplete,
    ready,
  } = useWorkspaces();

  const wsConfig = currentConfig;

  // 提交相关状态
  const [content, setContent] = useState('');
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sourceChannel, setSourceChannel] = useState<string>('');
  const [sourceError, setSourceError] = useState('');
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchSubmitResponse | null>(null);
  const [toastMsg, setToastMsg] = useState<string>('');

  // 历史记录状态
  const [historyRecords, setHistoryRecords] = useState<HistoryRecordItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'active' | 'ended'>('all');
  const [historySearch, setHistorySearch] = useState('');

  // 投递计划状态
  const [planInput, setPlanInput] = useState('');
  const [planLoading, setPlanLoading] = useState(false);
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  const [planError, setPlanError] = useState('');

  const [showDeferred, setShowDeferred] = useState(false);

  // Toast 自动消失
  useEffect(() => {
    if (toastMsg) {
      const t = setTimeout(() => setToastMsg(''), 2500);
      return () => clearTimeout(t);
    }
  }, [toastMsg]);

  // 切换 Tab 或工作空间时加载历史
  useEffect(() => {
    if ((activeTab === 'history' || activeTab === 'plan') && historyRecords.length === 0) {
      loadHistory();
    }
  }, [activeTab, activeId]);

  // 工作空间切换时刷新历史
  useEffect(() => {
    if (activeWorkspace && historyRecords.length > 0) {
      loadHistory();
      if (planResult) {
        setPlanResult(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const showToast = (msg: string) => setToastMsg(msg);

  // ===== 提交相关函数 =====

  const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('图片读取失败, 请重试'));
      reader.readAsDataURL(file);
    });

  const handleImageFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('请选择图片文件');
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      showToast('图片不能超过 8MB');
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setImageBase64(dataUrl);
      setImagePreview(dataUrl);
      setImageName(file.name || '招聘截图');
      setResult(null);
      setBatchResult(null);
      setSelectedIndices([]);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '图片读取失败, 请重试');
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    void handleImageFile(file);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void handleImageFile(e.dataTransfer.files?.[0]);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        void handleImageFile(item.getAsFile());
        return;
      }
    }
  };

  const removeImage = () => {
    setImageBase64(null);
    setImagePreview(null);
    setImageName('');
  };

  const handleSubmit = async () => {
    if (!content.trim() && !imageBase64) {
      setError('请输入文字内容或上传图片');
      return;
    }

    setLoading(true);
    setError('');
    setSourceError('');
    setResult(null);
    setBatchResult(null);
    setSelectedIndices([]);

    try {
      const body: { content?: string; image?: string; inputType?: 'text' | 'image'; source_channel?: string; workspace?: { baseId?: string; sheetId?: string; appKey?: string; appSecret?: string; operatorId?: string; demoMode?: boolean }; deepseekKey?: string; qwenKey?: string; demoMode?: boolean } = {};
      if (content.trim()) body.content = content.trim();
      if (imageBase64) {
        body.image = imageBase64;
        body.inputType = 'image';
      }
      // 信息来源可选, 默认"其他"
      body.source_channel = sourceChannel || '其他';
      if (wsConfig) body.workspace = wsConfig;
      if (!demoMode && aiKeys?.deepseekKey) body.deepseekKey = aiKeys.deepseekKey;
      if (!demoMode && aiKeys?.qwenKey) body.qwenKey = aiKeys.qwenKey;
      if (demoMode) body.demoMode = true;

      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as ParseResult;
      setResult(data);

      if (!res.ok || !data.success) {
        setError(data.error ?? data.message ?? '提交失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败, 请检查网络');
    } finally {
      setLoading(false);
    }
  };

  const handleBatchConfirm = async () => {
    if (!result?.batch_result || selectedIndices.length === 0) {
      setError('请至少选择一个岗位');
      return;
    }

    setBatchSubmitting(true);
    setError('');

    try {
      const res = await fetch('/api/batch-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selected_indices: selectedIndices,
          batch_result: result.batch_result,
          source_channel: sourceChannel || '其他',
          content: content,
          ...(imageBase64 ? { image: imageBase64 } : {}),
          ...(wsConfig ? { workspace: wsConfig } : {}),
          ...(demoMode ? { demoMode: true } : {}),
        }),
      });

      const data = (await res.json()) as BatchSubmitResponse;
      setBatchResult(data);

      if (!res.ok || !data.success) {
        setError(data.error ?? data.message ?? '批量提交失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败');
    } finally {
      setBatchSubmitting(false);
    }
  };

  const toggleCandidate = (index: number) => {
    setSelectedIndices((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  };

  const selectAll = () => {
    if (!result?.batch_result) return;
    if (selectedIndices.length === result.batch_result.candidates.length) {
      setSelectedIndices([]);
    } else {
      setSelectedIndices(result.batch_result.candidates.map((_, i) => i));
    }
  };

  const handleClear = () => {
    setContent('');
    setImageBase64(null);
    setImagePreview(null);
    setImageName('');
    setResult(null);
    setError('');
    setSourceChannel('');
    setSourceError('');
    setSelectedIndices([]);
    setBatchResult(null);
  };

  // ===== 历史记录相关函数 =====

  const workspaceHeader: Record<string, string> = wsConfig ? { 'x-workspace': JSON.stringify(wsConfig) } : {};

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/history', {
        headers: workspaceHeader,
      });
      const data = await res.json();
      if (data.success) {
        setHistoryRecords(data.records);
      } else {
        setError(data.error ?? '加载失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    if (!confirm('确定要删除这条记录吗？此操作不可撤销')) return;

    try {
      const res = await fetch('/api/history', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...workspaceHeader },
        body: JSON.stringify({ recordId }),
      });
      if (res.ok) {
        setHistoryRecords((prev) => prev.filter((r) => r.recordId !== recordId));
        showToast('已删除');
      } else {
        const data = await res.json();
        setError(data.error ?? '删除失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  };

  const generatePlan = async () => {
    if (!planInput.trim()) {
      setPlanError('请先描述你的空闲时间');
      return;
    }
    setPlanError('');
    setPlanResult(null);
    setPlanLoading(true);
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          free_time: planInput.trim(),
          ...(wsConfig ? { workspace: wsConfig } : {}),
          ...(!demoMode && aiKeys?.deepseekKey ? { deepseekKey: aiKeys.deepseekKey } : {}),
          ...(demoMode ? { demoMode: true } : {}),
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setPlanResult({ plan: data.plan, summary: data.summary });
      } else {
        setPlanError(data.error ?? '生成计划失败');
      }
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : '生成计划失败');
    } finally {
      setPlanLoading(false);
    }
  };

  const handleUpdateStatus = async (recordId: string, newStatus: string) => {
    try {
      const res = await fetch('/api/history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...workspaceHeader },
        body: JSON.stringify({ recordId, status: newStatus }),
      });
      if (res.ok) {
        showToast(`已更新为「${newStatus}」`);
      } else {
        const data = await res.json();
        showToast(data.error ?? '更新失败');
      }
    } catch {
      showToast('更新失败');
    }
  };

  const filteredHistory = historyRecords.filter((r) => {
    if (historyFilter === 'active') {
      return !['已拒绝', '简历挂', '测评挂', '笔试挂', '面试挂', '已挂'].includes(r.status);
    }
    if (historyFilter === 'ended') {
      return ['已拒绝', '简历挂', '测评挂', '笔试挂', '面试挂', '已挂'].includes(r.status);
    }
    return true;
  }).filter((r) => {
    if (!historySearch) return true;
    const q = historySearch.toLowerCase();
    return r.company.toLowerCase().includes(q) || r.position.toLowerCase().includes(q);
  });

  const hasInput = !!content.trim() || !!imageBase64;
  const isBatch = result?.message_type === 'batch';
  const isSingle = result?.message_type === 'single' || (result?.success && !isBatch);

  const sourceOptions = ['微信群消息', '钉钉群消息', 'QQ群消息', '邮件', '公众号', '招聘官网', 'Boss直聘', '其他'];

  const hasActiveOpportunities = historyRecords.filter((r) =>
    !['Offer', '已拒绝', '简历挂', '测评挂', '笔试挂', '面试挂', '已挂'].includes(r.status)
  ).length > 0;

  // ===== 渲染 =====

  // 等待 hook 初始化完成
  if (!ready) {
    return <main className="page" />;
  }

  // 非演示模式且配置不全 → 展示引导式配置向导
  if (!demoMode && !configComplete) {
    return (
      <SetupWizard
        aiKeys={aiKeys}
        credentials={credentials}
        workspaces={workspaces}
        onSaveAIKeys={setAIKeys}
        onSaveCredentials={setDevCredentials}
        onAddWorkspace={(ws) => {
          const newWs = addWorkspace(ws);
          setActive(newWs.id);
        }}
        onFinish={() => setActiveTab('submit')}
      />
    );
  }

  return (
    <main className="page">
      {demoMode && <DemoBanner onExit={exitDemoMode} />}
      <div className="container">
        <header className="header">
          <div className="header-top">
            <div>
              <h1 className="title">Offer Copilot</h1>
              <p className="subtitle">把散落各处的招聘信息,变成一个持续更新的Offer工作台</p>
            </div>
            {/* 工作空间切换器 */}
            <WorkspaceSwitcher
              workspaces={workspaces}
              activeId={activeId}
              activeWorkspace={activeWorkspace}
              onSelect={setActive}
              onManage={() => setActiveTab('settings')}
            />
          </div>
        </header>

        {/* Tab 切换 */}
        <div className="tabs">
          <button
            className={`tab ${activeTab === 'submit' ? 'active' : ''}`}
            onClick={() => setActiveTab('submit')}
          >
            <Inbox size={16} />
            <span>新增</span>
          </button>
          <button
            className={`tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            <BriefcaseBusiness size={16} />
            <span>机会</span>
          </button>
          <button
            className={`tab ${activeTab === 'plan' ? 'active' : ''}`}
            onClick={() => setActiveTab('plan')}
          >
            <CalendarCheck size={16} />
            <span>计划</span>
          </button>
          <button
            className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings2 size={16} />
            <span>设置</span>
          </button>
        </div>

        {/* 收集视图 */}
        {activeTab === 'submit' && (
          <>
            <section className="card">
              <div className="drop-inbox">
                <div className="drop-inbox-header">
                  <h2 className="drop-inbox-title">添加一个求职机会</h2>
                  <p className="drop-inbox-desc">粘贴招聘消息、邮件、公众号文章或岗位链接,关键信息会被自动整理出来。同一家公司的新进展——比如笔试通知——也会被认出来,直接更新到对应的记录上,不会重复添加。</p>
                </div>

                <textarea
                  className="textarea"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  onPaste={handlePaste}
                  placeholder="粘贴微信群消息、邮件、公众号文章或招聘链接……"
                  disabled={loading}
                />

                <div
                  className={`upload-zone placeholder ${dragOver ? 'drag-over' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="upload-content">
                    <Upload className="upload-icon" size={24} />
                    <div className="upload-text">{imagePreview ? '点击重新选择截图' : '上传招聘截图'}</div>
                    <div className="upload-hint">支持PNG、JPG,截图中的岗位信息会被自动识别</div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>

                {imagePreview && (
                  <div className="image-preview-card">
                    <img src={imagePreview} alt="招聘截图预览" className="image-preview-img" />
                    <div className="image-preview-info">
                      <span className="image-preview-name">{imageName}</span>
                      <span className="image-preview-meta">将使用千问视觉模型识别</span>
                    </div>
                    <button
                      type="button"
                      className="image-preview-remove"
                      onClick={removeImage}
                    >
                      <X size={14} />
                      移除
                    </button>
                  </div>
                )}

                <div className="source-section">
                  <div className="source-label">
                    信息来源<span className="source-optional">（可选, 默认其他）</span>
                  </div>
                  <div className="source-desc">选择这条信息的来源渠道,便于后续分类和筛选</div>
                  <div className="source-chips">
                    {sourceOptions.map((ch) => (
                      <div
                        key={ch}
                        className={`source-chip ${sourceChannel === ch ? 'active' : ''}`}
                        onClick={() => {
                          setSourceChannel(ch);
                          setSourceError('');
                        }}
                      >
                        {sourceChannel === ch && <Check size={14} />}
                        {ch}
                      </div>
                    ))}
                  </div>
                  {sourceError && (
                    <div className="source-error">
                      <AlertCircle size={14} />
                      <span>{sourceError}</span>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="error-banner">
                    <AlertCircle size={16} />
                    <span>{error}</span>
                  </div>
                )}

                <div className="actions">
                  <button
                    className="btn btn-primary"
                    onClick={handleSubmit}
                    disabled={loading || !hasInput}
                  >
                    {loading ? <span className="spinner" /> : null}
                    <span>{loading ? '整理中…' : '开始整理'}</span>
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={handleClear}
                    disabled={loading}
                  >
                    清空
                  </button>
                </div>
              </div>
            </section>

            {isBatch && result?.batch_result && !batchResult && (
              <BatchSelectionCard
                batchResult={result.batch_result}
                selectedIndices={selectedIndices}
                onToggle={toggleCandidate}
                onSelectAll={selectAll}
                onConfirm={handleBatchConfirm}
                submitting={batchSubmitting}
              />
            )}

            {isBatch && batchResult && (
              <BatchResultCard
                batchResult={result!.batch_result!}
                submissionResult={batchResult}
                onReset={() => {
                  setBatchResult(null);
                  setSelectedIndices([]);
                }}
              />
            )}

            {isSingle && result?.parsed && (
              <ResultCard result={result} />
            )}

            {!result && !loading && (
              <div className="hint">
                <span>同公司 + 同岗位的记录会自动识别并更新, 不会重复添加</span>
              </div>
            )}
          </>
        )}

        {/* 机会视图 */}
        {activeTab === 'history' && (
          <section className="card history-card">
            <div className="history-toolbar">
              <div className="history-toolbar-left">
                <div className="history-filter-group">
                  {[
                    { value: 'all', label: '全部' },
                    { value: 'active', label: '进行中' },
                    { value: 'ended', label: '已结束' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      className={`filter-btn ${historyFilter === opt.value ? 'active' : ''}`}
                      onClick={() => setHistoryFilter(opt.value as any)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="history-toolbar-right">
                <div className="history-search">
                  <Search size={16} />
                  <input
                    type="text"
                    placeholder="搜索公司或岗位"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-secondary btn-refresh"
                  onClick={loadHistory}
                  disabled={historyLoading}
                >
                  {historyLoading ? <span className="spinner" /> : <RefreshCw size={14} />}
                  <span>刷新</span>
                </button>
              </div>
            </div>

            {historyLoading ? (
              <div className="history-loading">加载中...</div>
            ) : filteredHistory.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><Inbox size={40} /></div>
                <div className="empty-title">暂无机会</div>
                <div className="empty-desc">前往新增页添加第一条招聘信息</div>
                <button className="btn btn-primary" onClick={() => setActiveTab('submit')}>
                  去新增
                </button>
              </div>
            ) : (
              <div className="history-list">
                {filteredHistory.map((rec) => (
                  <HistoryCard
                    key={rec.recordId}
                    record={rec}
                    onDelete={() => handleDeleteRecord(rec.recordId)}
                    hideDelete={demoMode}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* 计划视图 */}
        {activeTab === 'plan' && (
          <section className="card plan-card">
            <div className="plan-header">
              <h2 className="plan-title">安排今天的求职任务</h2>
              <p className="plan-desc">告诉我你有多少空闲时间,剩下的交给我——结合截止日期、当前进度和所需精力,排出今晚最值得先做的事。</p>
              <div className="plan-input-row">
                <input
                  type="text"
                  className="plan-input"
                  value={planInput}
                  onChange={(e) => setPlanInput(e.target.value)}
                  placeholder="例如: 今晚2小时"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') generatePlan();
                  }}
                />
                <button
                  className="btn btn-primary btn-generate"
                  onClick={generatePlan}
                  disabled={planLoading}
                >
                  {planLoading ? <span className="spinner" /> : null}
                  <span>{planLoading ? '生成中…' : '生成计划'}</span>
                </button>
              </div>
              {planError && (
                <div className="plan-error">
                  <AlertCircle size={14} />
                  <span>{planError}</span>
                </div>
              )}
            </div>

            {planResult && (
              <div className="plan-result">
                <div className="plan-summary">
                  <span>{planResult.summary}</span>
                </div>
                <div className="plan-items">
                  {planResult.plan.map((item, idx) => {
                    const isDeferred = /暂缓|可以暂缓/.test(item.reason);
                    const isUrgent = /DDL|ddl|截止|紧迫|紧急|尽快/.test(item.reason);
                    if (isDeferred && !showDeferred) return null;
                    return (
                      <div
                        key={idx}
                        className={`plan-item ${isUrgent ? 'urgent' : ''} ${isDeferred ? 'deferred' : ''}`}
                      >
                        <div className="plan-item-index">{idx + 1}</div>
                        <div className="plan-item-body">
                          <div className="plan-item-header">
                            <span className="plan-item-company">{item.company}</span>
                            <span className="plan-item-position">{item.position}</span>
                          </div>
                          <div className={`plan-item-sub ${isUrgent ? 'urgent' : ''}`}>
                            <span className="plan-item-time">
                              <Clock size={12} />
                              {item.estimated_minutes != null ? `预计 ${item.estimated_minutes} 分钟` : '无需操作'}
                            </span>
                          </div>
                          <div className="plan-item-action">{item.action}</div>
                          <div className="plan-item-reason">
                            {item.reason.length > 80 ? item.reason.slice(0, 80) + '…' : item.reason}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {planResult.plan.some((item) => /暂缓|可以暂缓/.test(item.reason)) && (
                    <button
                      className="plan-toggle-deferred"
                      onClick={() => setShowDeferred(!showDeferred)}
                    >
                      {showDeferred ? <><ChevronUp size={14} /> 收起暂缓项</> : <><ChevronDown size={14} /> 查看更多（{planResult.plan.filter((item) => /暂缓|可以暂缓/.test(item.reason)).length} 个暂缓项）</>}
                    </button>
                  )}
                </div>
              </div>
            )}

            {!planResult && !planLoading && (
              <div className="empty-state">
                <div className="empty-icon"><CalendarCheck size={40} /></div>
                <div className="empty-title">{hasActiveOpportunities ? '排出今晚的投递节奏' : '暂无机会可安排'}</div>
                <div className="empty-desc">
                  {hasActiveOpportunities
                    ? '综合截止日期、当前阶段、所需材料、预计耗时和优先级,帮你找出今晚最值得先攻克的事。'
                    : '提交一些招聘信息后再来试试吧'}
                </div>
                {!hasActiveOpportunities && (
                  <button className="btn btn-primary" onClick={() => setActiveTab('submit')}>
                    去新增
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {/* 设置视图 */}
        {activeTab === 'settings' && (
          <section className="card settings-card">
            <div className="settings-header">
              <h2 className="settings-title">工作空间管理</h2>
              <p className="settings-desc">在不同的钉钉表格（baseId）之间切换，而无需重新部署。所有配置保存在浏览器本地。</p>
            </div>

            {/* 当前工作空间 */}
            {activeWorkspace && (
              <div className="settings-current">
                <span className="settings-current-label">当前</span>
                <span className="settings-current-name">{activeWorkspace.name}</span>
                <code className="settings-current-id">{activeWorkspace.baseId}</code>
              </div>
            )}

            {/* 工作空间列表 */}
            <div className="workspace-list">
              {workspaces.map((ws) => (
                <div
                  key={ws.id}
                  className={`workspace-item ${ws.id === activeId ? 'active' : ''}`}
                >
                  <div className="workspace-item-info">
                    <input
                      type="text"
                      className="workspace-item-name"
                      value={ws.name}
                      onChange={(e) => updateWorkspace(ws.id, { name: e.target.value })}
                      placeholder="工作空间名称"
                    />
                    <input
                      type="text"
                      className="workspace-item-baseid"
                      value={ws.baseId}
                      onChange={(e) => updateWorkspace(ws.id, { baseId: e.target.value })}
                      placeholder="baseId"
                    />
                  </div>
                  <div className="workspace-item-actions">
                    {ws.id !== activeId && (
                      <button
                        className="btn btn-ghost"
                        onClick={() => setActive(ws.id)}
                      >
                        切换
                      </button>
                    )}
                    {workspaces.length > 1 && (
                      <button
                        className="btn btn-ghost btn-danger"
                        onClick={() => {
                          if (confirm(`确定删除工作空间「${ws.name}」吗？`)) {
                            removeWorkspace(ws.id);
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* 添加新工作空间 */}
            <AddWorkspaceForm
              onAdd={(ws) => {
                const newWs = addWorkspace(ws);
                setActive(newWs.id);
              }}
            />

            {/* 提示 */}
            <div className="settings-tips">
              <p><strong>说明：</strong></p>
              <ul>
                <li>每个工作空间的 baseId 对应一个独立的钉钉 AI 表格。</li>
                <li>sheetId 留空时会自动检测（调用钉钉 API 获取第一个数据表）。</li>
                <li>切换工作空间后，历史记录和投递计划会自动刷新为对应表格的数据。</li>
              </ul>
            </div>

            {/* AI 模型配置 */}
            <AIConfigSection
              aiKeys={aiKeys}
              onSave={setAIKeys}
            />

            {/* 开发者配置 */}
            <DevConfigSection
              credentials={credentials}
              onSave={setDevCredentials}
            />
          </section>
        )}
      </div>

      {/* Toast 提示 */}
      {toastMsg && (
        <div className="toast">{toastMsg}</div>
      )}
    </main>
  );
}

// ===== 子组件 =====

function BatchSelectionCard({
  batchResult,
  selectedIndices,
  onToggle,
  onSelectAll,
  onConfirm,
  submitting,
}: {
  batchResult: BatchResult;
  selectedIndices: number[];
  onToggle: (index: number) => void;
  onSelectAll: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  const allSelected = selectedIndices.length === batchResult.candidates.length;
  const sf = batchResult.shared_fields;

  return (
    <section className="card batch-card">
      <div className="batch-header">
        <h2 className="batch-title"><FileText size={18} /> {batchResult.source_company} 发来了以下岗位机会:</h2>
        {sf.application_limit && sf.application_limit > 0 && (
          <div className="batch-limit">
            <AlertTriangle size={14} /> 本次机会最多可选 {sf.application_limit} 个岗位
          </div>
        )}
        <div className="batch-shared-info">
          {sf.deadline && (
            <span className="shared-tag">
              <CalendarCheck size={13} /> 截止: {formatDate(sf.deadline)}
            </span>
          )}
          {sf.referral_code && (
            <span className="shared-tag">
              <Users size={13} /> 内推码: {sf.referral_code}
            </span>
          )}
          {sf.source_link && (
            <span className="shared-tag">
              <ExternalLink size={13} />
              <a href={sf.source_link} target="_blank" rel="noopener noreferrer" className="link">网申入口</a>
            </span>
          )}
          {sf.city.length > 0 && (
            <span className="shared-tag">
              <MapPin size={13} /> {sf.city.join(', ')}
            </span>
          )}
        </div>
      </div>

      <div className="batch-actions">
        <button className="btn btn-link" onClick={onSelectAll}>
          {allSelected ? '取消全选' : '全选'}
        </button>
        <span className="selection-count">已选 {selectedIndices.length} / {batchResult.candidates.length} 个</span>
      </div>

      <div className="candidate-list">
        {batchResult.candidates.map((candidate, idx) => {
          const isSelected = selectedIndices.includes(idx);
          return (
            <label key={idx} className={`candidate-item ${isSelected ? 'selected' : ''}`}>
              <input type="checkbox" checked={isSelected} onChange={() => onToggle(idx)} className="candidate-checkbox" />
              <div className="candidate-info">
                <div className="candidate-main">
                  <span className="candidate-position">{candidate.position}</span>
                  {candidate.job_code && <span className="candidate-code">{candidate.job_code}</span>}
                </div>
                {candidate.description && <div className="candidate-requirements">{candidate.description}</div>}
              </div>
            </label>
          );
        })}
      </div>

      <div className="batch-confirm">
        <button className="btn btn-primary" onClick={onConfirm} disabled={submitting || selectedIndices.length === 0}>
          {submitting ? <span className="spinner" /> : null}
          <span>确认添加所选岗位 ({selectedIndices.length})</span>
        </button>
      </div>
    </section>
  );
}

function BatchResultCard({
  batchResult,
  submissionResult,
  onReset,
}: {
  batchResult: BatchResult;
  submissionResult: BatchSubmitResponse;
  onReset: () => void;
}) {
  return (
    <section className="card batch-result-card">
      <h2 className="result-title"><FileText size={18} /> {batchResult.source_company} - 批量提交结果</h2>
      <div className="batch-result-list">
        {submissionResult.results.map((item, idx) => (
          <div key={idx} className={`batch-result-item ${item.action === 'created' ? 'is-new' : 'is-update'}`}>
            <div className="batch-result-main">
              <span className="candidate-position">{item.candidate.position}</span>
              {item.candidate.job_code && <span className="candidate-code">{item.candidate.job_code}</span>}
            </div>
            <div className="batch-result-status">{item.message}</div>
          </div>
        ))}
      </div>
      {submissionResult.message && <div className="result-message">{submissionResult.message}</div>}
      <div className="batch-confirm">
        <button className="btn btn-secondary" onClick={onReset}>继续提交新的岗位</button>
      </div>
    </section>
  );
}

function ResultCard({ result }: { result: ParseResult }) {
  const p = result.parsed!;
  const isNew = result.action === 'created';
  const [showMatchKey, setShowMatchKey] = useState(false);

  const toggleMatchKey = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault();
      setShowMatchKey((v) => !v);
    }
  };

  const allLocations = p.locations ?? [];
  const displayLocations = allLocations.slice(0, 4);
  const hiddenCount = allLocations.length - displayLocations.length;
  const [showAllLocations, setShowAllLocations] = useState(false);
  const visibleLocations = showAllLocations ? allLocations : displayLocations;

  return (
    <section
      className="card result-card"
      onClick={toggleMatchKey}
    >
      <div className="result-header-bar">
        <div className="result-sync">
          <CheckCircle size={16} />
          <span>已同步至钉钉表格</span>
        </div>
        {result.recordId && <span className="record-id">ID: {result.recordId}</span>}
      </div>

      <div className="result-title-row">
        <h2>{p.company ?? '未知公司'} · {p.position ?? '未知岗位'}</h2>
        <span className={`result-badge ${isNew ? 'new' : 'update'}`}>
          {isNew ? '新增' : '更新'}
        </span>
      </div>

      <div className="info-grid">
        <InfoRow
          label="城市"
          value={
            p.city && p.city.length > 0 ? (
              <div className="location-list">
                {p.city.map((c, idx) => (<span key={idx} className="location-tag">{c}</span>))}
              </div>
            ) : '—'
          }
        />
        <InfoRow
          label="截止日期"
          value={p.deadline ? formatDate(p.deadline) : <span className="muted-text">未识别到截止日期</span>}
        />
        <InfoRow label="当前阶段" value={p.status_hint} />
        {p.priority && <InfoRow label="优先级" value={p.priority} />}
        {p.job_code && <InfoRow label="岗位编号" value={p.job_code} />}
        {p.application_limit != null && (
          <InfoRow label="投递数量限制" value={`限投 ${p.application_limit} 个`} />
        )}
        {p.referral_code && <InfoRow label="内推码" value={p.referral_code} />}
        {p.source_channel && <InfoRow label="信息来源渠道" value={p.source_channel} />}
        {p.estimated_minutes != null && <InfoRow label="预计耗时" value={`${p.estimated_minutes} 分钟`} />}
        {p.description && <InfoRow label="岗位描述" value={p.description} fullWidth />}
        {p.requirements && <InfoRow label="岗位要求" value={p.requirements} fullWidth />}

        {allLocations.length > 0 && (
          <div className="info-row full">
            <div className="info-label">所有场次</div>
            <div className="info-value">
              <div className="location-list">
                {visibleLocations.map((loc, idx) => (
                  <span key={idx} className="location-tag">
                    {loc.city}{loc.date && ` · ${formatDate(loc.date)}`}
                  </span>
                ))}
                {hiddenCount > 0 && !showAllLocations && (
                  <button className="location-tag more-tag" onClick={(e) => { e.stopPropagation(); setShowAllLocations(true); }}>
                    还有 {hiddenCount} 个
                  </button>
                )}
                {showAllLocations && hiddenCount > 0 && (
                  <button className="location-tag more-tag" onClick={(e) => { e.stopPropagation(); setShowAllLocations(false); }}>
                    收起
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {showMatchKey && p.match_key && <InfoRow label="match_key" value={p.match_key} />}
      </div>

      {p.todo && (
        <div className="next-action">
          <div className="next-action-label"><Target size={13} /> 下一步行动</div>
          <div className="next-action-content">{p.todo}</div>
        </div>
      )}

      {(p.remark || p.source_url) && (
        <>
          <div className="result-divider" />
          <div className="result-secondary">
            {p.remark && <div className="result-secondary-item"><span className="muted-text">备注:</span> {p.remark}</div>}
            {p.source_url && (
              <div className="result-secondary-item">
                <ExternalLink size={14} />
                <a href={p.source_url} target="_blank" rel="noopener noreferrer" className="link">打开链接</a>
              </div>
            )}
          </div>
        </>
      )}

      {result.message && <div className="result-message">{result.message}</div>}
    </section>
  );
}

function InfoRow({ label, value, fullWidth }: { label: string; value: React.ReactNode; fullWidth?: boolean }) {
  return (
    <div className={fullWidth ? 'info-row full' : 'info-row'}>
      <div className="info-label">{label}</div>
      <div className="info-value">{value}</div>
    </div>
  );
}

/**
 * 解析原始输入文本, 按时间戳分段
 * 格式: [YYYY-MM-DD HH:mm]\n内容\n────...\n[YYYY-MM-DD HH:mm]\n内容
 * 返回倒序 (最新在上)
 */
function parseRawTextSegments(rawText: string): Array<{ timestamp: string | null; content: string }> {
  const segments: Array<{ timestamp: string | null; content: string }> = [];

  const tsRegex = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/g;
  const matches: Array<{ index: number; ts: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = tsRegex.exec(rawText)) !== null) {
    matches.push({ index: m.index, ts: m[1] });
  }

  if (matches.length === 0) {
    segments.push({ timestamp: null, content: rawText });
  } else {
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = i + 1 < matches.length ? matches[i + 1].index : rawText.length;
      let content = rawText.slice(start, end).trim();

      content = content.replace(/─{10,}/g, '').trim();
      content = content.replace(`[${matches[i].ts}]`, '').trim();

      segments.push({ timestamp: matches[i].ts, content });
    }
  }

  return segments.reverse();
}

function HistoryCard({ record, onDelete, hideDelete }: { record: HistoryRecordItem; onDelete: () => void; hideDelete?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const ddlStatus = deadlineStatus(record.deadline, record.status);

  const rawTextSegments = record.raw_text ? parseRawTextSegments(record.raw_text) : [];

  return (
    <div className={`history-card-item ddl-${ddlStatus}`}>
      {!hideDelete && (
        <button className="delete-btn" onClick={onDelete} title="删除">
          <Trash2 size={14} />
        </button>
      )}

      <div className="history-title-row">
        <span className="history-company"><strong>{record.company}</strong></span>
        <span className="history-divider">·</span>
        <span className="history-position">{record.position}</span>
      </div>
      <span className="history-updated">{formatTimestamp(record.last_updated_time)}</span>

      <div className="history-meta-row">
        <span className={`status-tag ${statusClass(record.status)}`}>{record.status}</span>
        {record.city.length > 0 && (
          <span className="history-city">
            <MapPin size={12} /> {record.city.join(', ')}
          </span>
        )}
        {record.source_channel && (
          <span className="history-source">{record.source_channel}</span>
        )}
        {record.deadline && (
          <span className={`history-ddl ${ddlStatus === 'soon' ? 'soon' : ddlStatus === 'overdue' ? 'overdue' : ''}`}>
            <Clock size={12} /> {formatDate(record.deadline)}
          </span>
        )}
      </div>

      {(record.job_code || record.referral_code) && (
        <div className="history-extra-row">
          {record.job_code && <span className="candidate-code">{record.job_code}</span>}
          {record.referral_code && <span className="referral-tag">内推: {record.referral_code}</span>}
        </div>
      )}

      <div className="history-more">
        <button className="toggle-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? <><ChevronUp size={14} /> 收起原文</> : <><ChevronDown size={14} /> 查看原文</>}
        </button>
      </div>

      {expanded && (
        <div className="history-expand">
          {rawTextSegments.length > 0 && (
            <div className="raw-block">
              <div className="raw-label"><FileText size={13} /> 原始输入文本 ({rawTextSegments.length} 条记录)</div>
              <div className="raw-segments">
                {rawTextSegments.map((seg, idx) => (
                  <div key={idx} className="raw-segment">
                    {seg.timestamp && <div className="raw-segment-time">{seg.timestamp}</div>}
                    <pre className="raw-content">{seg.content}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}
          {record.raw_image && (
            <div className="raw-block">
              <div className="raw-label">原始输入图片</div>
              <img src={record.raw_image} alt="原始图片" className="raw-image" onClick={() => window.open(record.raw_image!, '_blank')} />
            </div>
          )}
          {record.source_url && (
            <div className="raw-block">
              <div className="raw-label"><ExternalLink size={13} /> 链接</div>
              <a href={record.source_url} target="_blank" rel="noopener noreferrer" className="link">{record.source_url}</a>
            </div>
          )}
          {record.todo && (
            <div className="raw-block">
              <div className="raw-label"><Target size={13} /> 待办</div>
              <div>{record.todo}</div>
            </div>
          )}
          {rawTextSegments.length === 0 && !record.raw_image && <div className="muted-text">暂无原始输入记录</div>}
        </div>
      )}
    </div>
  );
}
