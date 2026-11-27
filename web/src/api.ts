export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
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
    // Cloudflare Access 登入過期時會回傳 HTML 登入頁
    if (res.ok || res.status === 302) throw new ApiError('登入已過期，請重新整理頁面', 401);
  }
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
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
  status: 'pending' | 'processing' | 'done' | 'duplicate' | 'failed' | 'deleted';
  duplicate_of: number | null;
  error: string | null;
  attempts: number;
  rule_name: string | null;
  received_at: string;
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
}

export interface Group {
  id: string;
  source_type: 'group' | 'room' | 'user';
  name: string;
  alias: string | null;
  enabled: number;
  joined: number;
  file_count: number;
  last_file_at: string | null;
}

export interface Settings {
  driveConnected: boolean;
  googleEmail: string | null;
  rootFolder: string;
  lineConfigured: boolean;
  googleConfigured: boolean;
  queueEnabled: boolean;
  webhookUrl: string;
  oauthRedirectUri: string;
  timezone: string;
}

export interface Stats {
  archived: number;
  unsorted: number;
  failed: number;
  pending: number;
  duplicates: number;
  bytes: number;
  groups: number;
  autoRate: number | null;
  driveConnected: boolean;
  recent: Pick<FileItem, 'id' | 'original_name' | 'stored_name' | 'folder_path' | 'status' | 'unsorted' | 'received_at' | 'group_name'>[];
}
