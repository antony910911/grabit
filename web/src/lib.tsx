import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

// ---------- 路由（不用額外套件） ----------
// 網址存在記憶體裡；能改瀏覽器網址就順便改（展示頁面在受限的 iframe 裡可能不允許）
let virtualUrl = location.pathname + location.search;

export function currentUrl(): URL {
  return new URL(virtualUrl, 'https://grabit.local');
}

function emit() {
  window.dispatchEvent(new Event('grabit-nav'));
}

export function usePath(): string {
  const [path, setPath] = useState(currentUrl().pathname);
  useEffect(() => {
    const onPop = () => {
      virtualUrl = location.pathname + location.search;
      setPath(currentUrl().pathname);
    };
    const onNav = () => setPath(currentUrl().pathname);
    window.addEventListener('popstate', onPop);
    window.addEventListener('grabit-nav', onNav);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('grabit-nav', onNav);
    };
  }, []);
  return path;
}

export function navigate(to: string) {
  if (to === virtualUrl) return;
  virtualUrl = to;
  try {
    history.pushState(null, '', to);
  } catch {
    // 忽略：只用記憶體裡的網址
  }
  emit();
  window.scrollTo(0, 0);
}

/** 更新網址但不新增瀏覽紀錄（例如篩選條件） */
export function replaceUrl(to: string) {
  virtualUrl = to;
  try {
    history.replaceState(null, '', to);
  } catch {
    // 忽略
  }
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ---------- 提示訊息 ----------
export interface ToastAction {
  label: string;
  onClick: () => void;
}
type ToastFn = (msg: string, kind?: 'ok' | 'error', action?: ToastAction) => void;
const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'error'; id: number; action?: ToastAction } | null>(null);
  const show = useCallback<ToastFn>((msg, kind = 'ok', action) => setToast({ msg, kind, id: Date.now(), action }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 5000 : toast.action ? 7000 : 2600);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.kind === 'error' ? 'error' : ''}`} role="status">
          <span>{toast.msg}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                toast.action!.onClick();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ---------- 確認對話框（瀏覽器內建的 confirm() 在部分環境會被擋掉） ----------
type ConfirmFn = (message: string, okLabel?: string) => Promise<boolean>;
let confirmImpl: ConfirmFn = async (m) => window.confirm(m);
export const ask = (message: string, okLabel?: string) => confirmImpl(message, okLabel);

export function ConfirmHost() {
  const [req, setReq] = useState<{ message: string; ok: string; resolve: (v: boolean) => void } | null>(null);
  useEffect(() => {
    confirmImpl = (message, okLabel = '確定') => new Promise<boolean>((resolve) => setReq({ message, ok: okLabel, resolve }));
  }, []);
  if (!req) return null;
  const done = (v: boolean) => {
    req.resolve(v);
    setReq(null);
  };
  return (
    <div className="overlay" style={{ zIndex: 70 }} onClick={() => done(false)}>
      <div className="sheet" role="alertdialog" aria-modal="true" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: '8px 0 4px', fontSize: 'calc(15px * var(--fs))', lineHeight: 1.6 }}>{req.message}</p>
        <div className="sheet-actions">
          <button className="btn" onClick={() => done(false)} autoFocus>
            取消
          </button>
          <button className="btn primary" onClick={() => done(true)}>
            {req.ok}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 資料載入 ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}

// ---------- 格式化 ----------
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  // D1 的 datetime('now') 沒有時區標記，視為 UTC
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) return `今天 ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('zh-TW', { year: sameYear ? undefined : 'numeric', month: 'numeric', day: 'numeric' }) + ` ${time}`;
}

export function useMe() {
  return useContext(MeCtx);
}
export const MeCtx = createContext<import('./api').Me | null>(null);

export function canEdit(me: import('./api').Me | null) {
  return !!me && me.role !== 'viewer';
}

/** 依行比對兩段文字（簡單 LCS），用於版本比對 */
export function lineDiff(a: string, b: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  const A = a.split('\n').slice(0, 400);
  const B = b.split('\n').slice(0, 400);
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: 'same', text: A[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ type: 'del', text: A[i++]! });
    else out.push({ type: 'add', text: B[j++]! });
  }
  while (i < n) out.push({ type: 'del', text: A[i++]! });
  while (j < m) out.push({ type: 'add', text: B[j++]! });
  return out;
}

export function fileKind(ext: string, type?: string): { cls: string; label: string } {
  const e = (ext || '').toLowerCase();
  if (e === 'pdf') return { cls: 'pdf', label: 'PDF' };
  if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(e)) return { cls: 'doc', label: e === 'txt' ? 'TXT' : 'DOC' };
  if (['xls', 'xlsx', 'csv', 'ods'].includes(e)) return { cls: 'xls', label: e === 'csv' ? 'CSV' : 'XLS' };
  if (['ppt', 'pptx', 'key', 'odp'].includes(e)) return { cls: 'ppt', label: 'PPT' };
  if (type === 'image' || ['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp'].includes(e)) return { cls: 'img', label: 'IMG' };
  if (type === 'video' || ['mp4', 'mov', 'm4v'].includes(e)) return { cls: 'img', label: 'VID' };
  if (type === 'audio' || ['m4a', 'mp3', 'wav'].includes(e)) return { cls: '', label: 'AUD' };
  return { cls: '', label: (e || 'file').slice(0, 4) };
}
