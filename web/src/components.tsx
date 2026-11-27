import { useEffect, type ReactNode } from 'react';
import type { FileItem } from './api';
import { fileKind } from './lib';

const paths: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  files: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  rules: <path d="M4 6h10M4 12h16M4 18h7M17 4v4M14 18h6M17 16v4" />,
  groups: <path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8" />,
  settings: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />,
  logs: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  search: <path d="m21 21-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  up: <path d="m18 15-6-6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
  refresh: <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />,
  ai: <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.9 2.1 2.1.9-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18" />,
  tag: <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01" />,
  cloud: <path d="M17.5 19a4.5 4.5 0 1 0-1.3-8.8A6 6 0 1 0 6 16.9M6 19h11.5" />,
  users: <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />,
  history: <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2" />,
  upload: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />,
  more: <path d="M4 6h16M4 12h16M4 18h16" />,
  check: <path d="M20 6 9 17l-5-5" />,
  filter: <path d="M22 3H2l8 9.5V19l4 2v-8.5z" />,
  undo: <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />,
  layers: <path d="m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5" />,
  download: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  send: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />,
  line: <path d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.3 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.5s5.9-3.5 8-6c1.4-1.6 2-3.2 2-4.8C22 6.6 17.5 3 12 3z" />,
  eye: <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />,
  mail: <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6" />,
};

export function Icon({ name }: { name: keyof typeof paths | string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function Sheet({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="關閉">
            <Icon name="x" />
          </button>
        </div>
        {children}
        {actions && <div className="sheet-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function FileIcon({ ext, type }: { ext: string; type?: string }) {
  const k = fileKind(ext, type);
  return <div className={`file-icon ${k.cls}`}>{k.label}</div>;
}

export function StatusBadge({ file }: { file: Pick<FileItem, 'status' | 'unsorted'> & { classified_by?: string | null } }) {
  switch (file.status) {
    case 'done':
      if (file.unsorted) return <span className="badge warn">待分類</span>;
      return file.classified_by === 'ai' ? <span className="badge info">AI 歸檔</span> : <span className="badge ok">已歸檔</span>;
    case 'skipped':
      return <span className="badge muted">略過</span>;
    case 'pending':
    case 'processing':
      return <span className="badge info">處理中</span>;
    case 'failed':
      return <span className="badge danger">失敗</span>;
    case 'duplicate':
      return <span className="badge muted">重複</span>;
    default:
      return <span className="badge muted">已刪除</span>;
  }
}

export function Loading() {
  return (
    <div className="loading">
      <div className="spinner" />
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice danger">
      <div className="grow">{message}</div>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          重試
        </button>
      )}
    </div>
  );
}

/** 資料夾輸入框：可以直接輸入新路徑，也可以從既有資料夾挑選 */
export function FolderInput({ value, onChange, folders, autoFocus }: { value: string; onChange: (v: string) => void; folders: string[]; autoFocus?: boolean }) {
  return (
    <>
      <input className="input" list="folder-options" value={value} onChange={(e) => onChange(e.target.value)} placeholder="例：Farnesene/分析數據/2026" autoFocus={autoFocus} />
      <datalist id="folder-options">
        {folders.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </>
  );
}

export function TagChip({ tag, onRemove }: { tag: { name: string; color?: string; source?: string }; onRemove?: () => void }) {
  return (
    <span className="tag" title={tag.source === 'ai' ? 'AI 標籤' : tag.source === 'rule' ? '規則標籤' : undefined}>
      {tag.source === 'ai' && <span className="tag-ai">AI</span>}
      {tag.name}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`移除 ${tag.name}`}>
          ×
        </button>
      )}
    </span>
  );
}

export function ProjectBadge({ name, color }: { name: string; color?: string | null }) {
  return (
    <span className="project">
      <i style={{ background: color ?? 'var(--accent)' }} />
      {name}
    </span>
  );
}

export function SourceIcon({ type }: { type: string }) {
  return <span className="source-icon">{type === 'email' ? <Icon name="mail" /> : type === 'upload' ? <Icon name="upload" /> : <Icon name="line" />}</span>;
}

export function Brand() {
  return (
    <span className="brand-text">
      grabit<b>.</b>
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
