'use client';

import { useEffect, useState, useCallback } from 'react';

export interface Workspace {
  id: string;
  name: string;
  baseId: string;
  sheetId?: string;
}

const STORAGE_KEY = 'offer-copilot-workspaces';
const ACTIVE_KEY = 'offer-copilot-active-workspace';
const CREDS_KEY = 'offer-copilot-dev-credentials';
const AI_KEYS_KEY = 'offer-copilot-ai-keys';
const DEMO_KEY = 'offer-copilot-demo-mode';

/** 钉钉应用凭据 */
export interface DevCredentials {
  appKey: string;
  appSecret: string;
  operatorId: string;
}

/** AI 模型密钥 */
export interface AIKeys {
  deepseekKey: string;
  qwenKey?: string;
}

/** 完整的用户配置 */
export interface UserConfig {
  credentials: DevCredentials | null;
  aiKeys: AIKeys | null;
  workspaces: Workspace[];
}

/**
 * 检查配置是否完整（所有必填项都已填写）
 */
export function isConfigComplete(
  credentials: DevCredentials | null,
  aiKeys: AIKeys | null,
  workspaces: Workspace[]
): boolean {
  if (!credentials?.appKey?.trim()) return false;
  if (!credentials?.appSecret?.trim()) return false;
  if (!credentials?.operatorId?.trim()) return false;
  if (!aiKeys?.deepseekKey?.trim()) return false;
  if (workspaces.length === 0) return false;
  if (!workspaces[0]?.baseId?.trim()) return false;
  return true;
}

// ============== 演示模式 ==============

export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  // URL 参数 ?mode=demo
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'demo') {
    sessionStorage.setItem(DEMO_KEY, '1');
    return true;
  }
  return sessionStorage.getItem(DEMO_KEY) === '1';
}

export function exitDemoMode() {
  sessionStorage.removeItem(DEMO_KEY);
  // 清除 URL 参数
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.delete('mode');
    window.history.replaceState({}, '', url.toString());
  }
}

// ============== localStorage 读写 ==============

function loadCredentials(): DevCredentials | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DevCredentials>;
      if (parsed.appKey && parsed.appSecret && parsed.operatorId) {
        return {
          appKey: parsed.appKey,
          appSecret: parsed.appSecret,
          operatorId: parsed.operatorId,
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function saveCredentials(creds: DevCredentials | null) {
  if (typeof window === 'undefined') return;
  if (creds) {
    localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
  } else {
    localStorage.removeItem(CREDS_KEY);
  }
}

function loadAIKeys(): AIKeys | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AI_KEYS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AIKeys>;
      if (parsed.deepseekKey) {
        return { deepseekKey: parsed.deepseekKey, ...(parsed.qwenKey ? { qwenKey: parsed.qwenKey } : {}) };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function saveAIKeys(keys: AIKeys | null) {
  if (typeof window === 'undefined') return;
  if (keys) {
    localStorage.setItem(AI_KEYS_KEY, JSON.stringify(keys));
  } else {
    localStorage.removeItem(AI_KEYS_KEY);
  }
}

function loadWorkspaces(): Workspace[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as Workspace[];
    }
  } catch {
    // ignore
  }
  return [];
}

function saveWorkspaces(list: Workspace[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

// ============== React Hook ==============

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [credentials, setCredentials] = useState<DevCredentials | null>(null);
  const [aiKeys, setAIKeys] = useState<AIKeys | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [ready, setReady] = useState(false);

  // 初始化
  useEffect(() => {
    const stored = loadWorkspaces();
    if (stored.length > 0) {
      setWorkspaces(stored);
      const active = localStorage.getItem(ACTIVE_KEY);
      if (active && stored.some((w) => w.id === active)) {
        setActiveId(active);
      } else {
        setActiveId(stored[0].id);
        localStorage.setItem(ACTIVE_KEY, stored[0].id);
      }
    }
    setCredentials(loadCredentials());
    setAIKeys(loadAIKeys());
    setDemoMode(isDemoMode());
    setReady(true);
  }, []);

  // 持久化工作空间
  useEffect(() => {
    if (ready && workspaces.length > 0) {
      saveWorkspaces(workspaces);
    }
  }, [workspaces, ready]);

  const setActive = useCallback((id: string) => {
    setActiveId(id);
    if (typeof window !== 'undefined') {
      localStorage.setItem(ACTIVE_KEY, id);
    }
  }, []);

  const addWorkspace = useCallback((ws: Omit<Workspace, 'id'>) => {
    const newWs: Workspace = { ...ws, id: `ws-${Date.now()}` };
    setWorkspaces((prev) => [...prev, newWs]);
    return newWs;
  }, []);

  const updateWorkspace = useCallback((id: string, patch: Partial<Workspace>) => {
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }, []);

  const removeWorkspace = useCallback((id: string) => {
    setWorkspaces((prev) => {
      const next = prev.filter((w) => w.id !== id);
      if (activeId === id) {
        if (next.length > 0) {
          setActiveId(next[0].id);
          if (typeof window !== 'undefined') {
            localStorage.setItem(ACTIVE_KEY, next[0].id);
          }
        } else {
          setActiveId('');
          if (typeof window !== 'undefined') {
            localStorage.removeItem(ACTIVE_KEY);
          }
        }
      }
      // 即使列表为空也要保存，这样删除最后一个工作空间后状态正确
      saveWorkspaces(next);
      return next;
    });
  }, [activeId]);

  const activeWorkspace = workspaces.find((w) => w.id === activeId) ?? null;

  // 构建 API 请求时携带的配置
  const currentConfig = demoMode
    ? { demoMode: true }
    : activeWorkspace?.baseId?.trim() && credentials
      ? {
          baseId: activeWorkspace.baseId.trim(),
          sheetId: activeWorkspace.sheetId?.trim() || undefined,
          appKey: credentials.appKey,
          appSecret: credentials.appSecret,
          operatorId: credentials.operatorId,
        }
      : undefined;

  // 保存/清除开发者凭据
  const setDevCredentials = useCallback((creds: DevCredentials | null) => {
    setCredentials(creds);
    saveCredentials(creds);
  }, []);

  // 保存/清除 AI 密钥
  const setAIKeysCallback = useCallback((keys: AIKeys | null) => {
    setAIKeys(keys);
    saveAIKeys(keys);
  }, []);

  // 退出演示模式
  const handleExitDemo = useCallback(() => {
    exitDemoMode();
    setDemoMode(false);
  }, []);

  const configComplete = isConfigComplete(credentials, aiKeys, workspaces);

  return {
    workspaces,
    activeId,
    activeWorkspace,
    currentConfig,
    credentials,
    aiKeys,
    demoMode,
    ready,
    configComplete,
    setActive,
    addWorkspace,
    updateWorkspace,
    removeWorkspace,
    setDevCredentials,
    setAIKeys: setAIKeysCallback,
    exitDemoMode: handleExitDemo,
  };
}
