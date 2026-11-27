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
  content_md5: string | null;
  folder_path: string | null;
  drive_file_id: string | null;
  drive_link: string | null;
  matched_rule_id: number | null;
  unsorted: number;
  manual: number;
  status: 'pending' | 'processing' | 'done' | 'duplicate' | 'failed' | 'deleted';
  duplicate_of: number | null;
  error: string | null;
  attempts: number;
  image_set_id: string | null;
  received_at: string;
  created_at: string;
  updated_at: string;
}

export interface GroupRow {
  id: string;
  source_type: string;
  name: string;
  alias: string | null;
  enabled: number;
  joined: number;
  created_at: string;
  updated_at: string;
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

export function groupDisplayName(g: GroupRow | null, fallbackId: string): string {
  return g?.alias || g?.name || fallbackId.slice(0, 10);
}

export async function getFile(env: Env, id: number): Promise<FileRow | null> {
  return env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRow>();
}

export async function log(
  env: Env,
  level: 'info' | 'warn' | 'error',
  action: string,
  message: string,
  fileId?: number | null,
): Promise<void> {
  await env.DB.prepare('INSERT INTO logs (level, action, file_id, message) VALUES (?, ?, ?, ?)')
    .bind(level, action, fileId ?? null, message.slice(0, 2000))
    .run();
}
