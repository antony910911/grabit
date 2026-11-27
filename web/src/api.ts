export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    ...rest,
    credentials: 'same-origin',
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`伺服器回應格式錯誤（HTTP ${res.status}）`, res.status || 500);
  }
  if (!res.ok) {
    const err = new ApiError((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`, res.status);
    // 登入過期或被登出：通知 App 顯示登入頁
    if (res.status === 401 && path !== '/me') window.dispatchEvent(new CustomEvent('grabit-login-required', { detail: err.message }));
    throw err;
  }
  return data as T;
}

export async function logout(all = false): Promise<void> {
  try {
    if (all) await api('/me/logout-all', { method: 'POST', json: {} });
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    location.href = '/login';
  }
}

export type Role = 'admin' | 'editor' | 'viewer';

export interface Me {
  prefs?: import('./theme').ThemePrefs;
  email: string;
  name: string | null;
  role: Role;
  aiAvailable: boolean;
  fullText: boolean;
  semantic: boolean;
  demo: boolean;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
  source?: 'rule' | 'ai' | 'manual';
  count?: number;
}

export interface FileItem {
  id: number;
  group_id: string;
  group_name: string;
  sender_name: string | null;
  message_type: string;
  original_name: string;
  stored_name: string | null;
  ext: string;
  size: number | null;
  folder_path: string | null;
  drive_link: string | null;
  unsorted: number;
  manual: number;
  status: 'pending' | 'processing' | 'done' | 'duplicate' | 'failed' | 'deleted' | 'skipped';
  duplicate_of: number | null;
  error: string | null;
  attempts: number;
  rule_name: string | null;
  received_at: string;
  storage_id: number | null;
  storage_name: string | null;
  project_id: number | null;
  project_name: string | null;
  project_color: string | null;
  source: 'line' | 'email' | 'upload';
  classified_by: 'rule' | 'ai' | 'group' | 'manual' | 'none' | null;
  version_key: string | null;
  version_label: string | null;
  version_count: number;
  ai_summary: string | null;
  target_folder: string | null;
  ai_status: AiStatus | null;
  ai_error: string | null;
  ai_at: string | null;
  uploader_key: string | null;
  uploader_name: string | null;
  tags: Tag[];
}

/** 上傳者（虛擬檢視）：用唯一 ID 關聯，名稱可以自訂別名 */
export interface Uploader {
  key: string;
  name: string;
  display_name: string | null;
  alias: string | null;
  source: string;
  count: number;
  groups: number;
  projects: number;
  last_at: string;
  pinned: boolean;
}

export type AiStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'deferred';

/** AI 判讀的結果（建議值；信心分數未校準） */
export interface AiSuggestion {
  folder: string | null;
  folderKnown?: boolean;
  project: string | null;
  tags: string[];
  suggestedName?: string | null;
  confidence: number;
  reason: string;
  keyInfo?: string[];
  warnings?: string[];
  provider?: string;
  model?: string;
  at?: string;
  read?: 'full' | 'partial' | 'filename';
  applied?: { folder?: boolean; name?: boolean; project?: boolean };
  dismissed?: boolean;
}

export interface FileDetail extends FileItem {
  content_excerpt: string | null;
  ai_suggestion: AiSuggestion | null;
  versions: { id: number; name: string; version_label: string | null; received_at: string; folder_path: string; sender_name: string | null; group_name: string }[];
  duplicates: { id: number; name: string; status: string; folder_path: string }[];
}

export interface Rule {
  id: number;
  name: string;
  priority: number;
  match_type: 'keywords' | 'regex' | 'extension' | 'any';
  pattern: string;
  group_id: string | null;
  target_path: string;
  rename_template: string | null;
  enabled: number;
  project_id: number | null;
  tags: string | null;
}

export interface Group {
  id: string;
  source_type: 'group' | 'room' | 'user' | 'email' | 'upload';
  name: string;
  alias: string | null;
  enabled: number;
  joined: number;
  configured: number;
  storage_id: number | null;
  storage_name: string | null;
  base_folder: string | null;
  rename_template: string | null;
  file_types: string[] | null;
  backup_images: number;
  backup_videos: number;
  notify: number;
  ai_enabled: number;
  ai_external: number;
  project_id: number | null;
  project_name: string | null;
  file_count: number;
  outside_project: number;
  bytes: number;
  last_file_at: string | null;
  members: string[];
}

export interface Project {
  id: number;
  name: string;
  color: string;
  description: string | null;
  count: number;
}

export interface Storage {
  id: number;
  type: 'gdrive' | 'onedrive' | 'dropbox' | 'webdav' | 'demo';
  typeLabel: string;
  name: string;
  root_folder: string;
  account: string | null;
  is_default: number;
  ready: boolean;
  files: number;
  bytes: number;
  config: { url?: string; username?: string };
  folderLink: string | null;
  share: 'private' | 'members' | 'anyone' | null;
  shareError: string | null;
  filesOutside: number;
  rootMissing: boolean;
  extraFolders: number;
}

export interface Stats {
  archived: number;
  unsorted: number;
  byAi: number;
  aiReview: number;
  failed: number;
  pending: number;
  duplicates: number;
  bytes: number;
  groups: number;
  unconfiguredGroups: number;
  autoRate: number | null;
  storagesReady: boolean;
  hasStorage: boolean;
  suggestions: number;
  recent: Pick<FileItem, 'id' | 'original_name' | 'stored_name' | 'ext' | 'message_type' | 'folder_path' | 'status' | 'unsorted' | 'received_at' | 'group_name' | 'classified_by'>[];
}

export interface Sources {
  groups: { id: string; source_type: string; name: string; configured: number; enabled: number; joined: number; count: number }[];
  projects: { id: number; name: string; color: string; count: number }[];
  tags: Tag[];
  years: { year: string; count: number }[];
}

export interface Suggestion {
  id: number;
  pattern: string;
  target_path: string;
  support: number;
  conflicts: number;
  examples: string[];
}

export interface User {
  email: string;
  name: string | null;
  role: Role;
  all_groups: number;
  groups: string[];
  last_seen: string | null;
  active_sessions: number;
}
