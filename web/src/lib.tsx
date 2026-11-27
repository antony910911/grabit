import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

// ---------- 路由（不用額外套件） ----------
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
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
type ToastFn = (msg: string, kind?: 'ok' | 'error') => void;
const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'error'; id: number } | null>(null);
  const show = useCallback<ToastFn>((msg, kind = 'ok') => setToast({ msg, kind, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 5000 : 2600);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.kind === 'error' ? 'error' : ''}`} role="status">
          {toast.msg}
        </div>
      )}
    </ToastCtx.Provider>
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
