import type { Env } from './env';
import type { Rule } from './rules';

export interface FileRow {
  id: number;
  line_message_id: string;
  group_id: string;
  sender_id: string | null;
  sender_name: string | null;
  message_type: string;
  original_name: string;
  stored_name: string | null;
  ext: string;
  mime_type: string | null;
  size: number | null;
  content_md5: string | null; // 「演算法:值」
  folder_path: string | null;
  drive_file_id: string | null; // 雲端上的識別碼（ID 或路徑）
  drive_link: string | null;
  matched_rule_id: number | null;
  unsorted: number;
  manual: number;
  status: 'pending' | 'processing' | 'done' | 'duplicate' | 'failed' | 'deleted' | 'skipped';
  duplicate_of: number | null;
  error: string | null;
  attempts: number;
  image_set_id: string | null;
  received_at: string;
  created_at: string;
  updated_at: string;
  storage_id: number | null;
  project_id: number | null;
  source: 'line' | 'email' | 'upload';
  classified_by: string | null;
  version_key: string | null;
  version_label: string | null;
  version_rank: number;
  ai_summary: string | null;
  ai_suggestion: string | null;
  content_text: string | null;
  reply_token: string | null;
  target_folder: string | null;
  root_ref?: string | null;
  ai_status: AiStatus | null;
  ai_error: string | null;
  ai_at: string | null;
  ai_attempts: number;
}

/** AI 判讀工作的狀態（和收檔狀態分開） */
export type AiStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'deferred';

export interface GroupRow {
  id: string;
  source_type: string;
  name: string;
  alias: string | null;
  enabled: number;
  joined: number;
  created_at: string;
  updated_at: string;
  storage_id: number | null;
  base_folder: string | null;
  rename_template: string | null;
  file_types: string | null;
  backup_images: number;
  backup_videos: number;
  notify: number;
  ai_enabled: number;
  ai_external: number;
  project_id: number | null;
  configured: number;
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

export async function listRules(env: Env): Promise<Rule[]> {
  const r = await env.DB.prepare('SELECT * FROM rules ORDER BY priority, id').all<Rule>();
  return r.results;
}

export async function getGroup(env: Env, id: string): Promise<GroupRow | null> {
  return env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(id).first<GroupRow>();
}

export function groupDisplayName(g: Pick<GroupRow, 'alias' | 'name'> | null, fallbackId: string): string {
  return g?.alias || g?.name || fallbackId.slice(0, 10);
}

export async function getFile(env: Env, id: number): Promise<FileRow | null> {
  return env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
}

export async function log(env: Env, level: 'info' | 'warn' | 'error', action: string, message: string, fileId?: number | null): Promise<void> {
  await env.DB.prepare('INSERT INTO logs (level, action, file_id, message) VALUES (?, ?, ?, ?)')
    .bind(level, action, fileId ?? null, message.slice(0, 2000))
    .run();
}

/** 依名稱取得或建立標籤，回傳 ID */
export async function ensureTag(env: Env, name: string): Promise<number> {
  const clean = name.trim().slice(0, 40);
  await env.DB.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').bind(clean).run();
  const r = await env.DB.prepare('SELECT id FROM tags WHERE name = ?').bind(clean).first<{ id: number }>();
  return r!.id;
}

export async function addTags(env: Env, fileId: number, names: string[], source: 'rule' | 'ai' | 'manual'): Promise<void> {
  for (const n of [...new Set(names.map((x) => x.trim()).filter(Boolean))]) {
    const id = await ensureTag(env, n);
    await env.DB.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id, source) VALUES (?, ?, ?)').bind(fileId, id, source).run();
  }
}

export async function projectIdByName(env: Env, name: string | null | undefined): Promise<number | null> {
  if (!name) return null;
  const r = await env.DB.prepare('SELECT id FROM projects WHERE name = ?').bind(name.trim()).first<{ id: number }>();
  return r?.id ?? null;
}

/** 檔案類別（群組可以設定只收哪些類別） */
export function fileCategory(ext: string, messageType: string): string {
  const e = ext.toLowerCase();
  if (messageType === 'image' || ['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp', 'bmp', 'tif', 'tiff'].includes(e)) return 'image';
  if (messageType === 'video' || ['mp4', 'mov', 'm4v', 'avi', 'mkv'].includes(e)) return 'video';
  if (messageType === 'audio' || ['m4a', 'mp3', 'wav', 'aac'].includes(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'].includes(e)) return 'document';
  if (['xls', 'xlsx', 'csv', 'ods', 'numbers', 'tsv'].includes(e)) return 'spreadsheet';
  if (['ppt', 'pptx', 'odp', 'key'].includes(e)) return 'presentation';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'archive';
  return 'other';
}

/** 群組設定是否接收這種檔案 */
export function groupAccepts(g: GroupRow | null, ext: string, messageType: string): boolean {
  if (!g) return true;
  const cat = fileCategory(ext, messageType);
  if (cat === 'image') return !!g.backup_images;
  if (cat === 'video' || cat === 'audio') return !!g.backup_videos;
  if (!g.file_types) return true;
  try {
    const allowed = JSON.parse(g.file_types) as string[];
    return allowed.length === 0 || allowed.includes(cat);
  } catch {
    return true;
  }
}
