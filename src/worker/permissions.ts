// 多使用者權限：admin 管理全部；editor 可以整理檔案與規則；viewer 只能看。
// 非 admin 只能看到被授權的群組（或 all_groups = 1）。
import type { Env } from './env';

export type Role = 'admin' | 'editor' | 'viewer';

export interface CurrentUser {
  email: string;
  name: string | null;
  role: Role;
  allGroups: boolean;
  groups: string[];
}

export interface Scope {
  sql: string; // 套在 files f 上的條件
  binds: unknown[];
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function atLeast(user: CurrentUser, role: Role): boolean {
  return RANK[user.role] >= RANK[role];
}

export function fileScope(user: CurrentUser, alias = 'f'): Scope {
  if (user.role === 'admin' || user.allGroups) return { sql: '1 = 1', binds: [] };
  return { sql: `${alias}.group_id IN (SELECT group_id FROM user_groups WHERE email = ?)`, binds: [user.email] };
}

export function canSeeGroup(user: CurrentUser, groupId: string): boolean {
  return user.role === 'admin' || user.allGroups || user.groups.includes(groupId);
}

/** 管理員名單（環境變數 ADMIN_EMAILS，逗號分隔） */
export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 依 email 載入使用者。只有兩種人可以登入：
 * 1. ADMIN_EMAILS 名單上的人（第一次登入時自動建立為管理員，並且一定是管理員，避免被鎖在外面）
 * 2. 管理員在「成員與權限」加入的成員
 * 不在名單上的人回傳 null。
 */
export async function loadUser(env: Env, email: string): Promise<CurrentUser | null> {
  const lower = email.trim().toLowerCase();
  if (!lower) return null;
  let row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(lower).first<{ email: string; name: string | null; role: Role; all_groups: number }>();
  if (adminEmails(env).includes(lower)) {
    if (!row) {
      await env.DB.prepare("INSERT INTO users (email, role, all_groups) VALUES (?, 'admin', 1)").bind(lower).run();
      row = { email: lower, name: null, role: 'admin', all_groups: 1 };
    } else if (row.role !== 'admin') {
      await env.DB.prepare("UPDATE users SET role = 'admin' WHERE email = ?").bind(lower).run();
      row.role = 'admin';
    }
  }
  if (!row) return null;
  await env.DB.prepare("UPDATE users SET last_seen = datetime('now') WHERE email = ? AND (last_seen IS NULL OR last_seen < datetime('now', '-5 minutes'))").bind(lower).run();
  const groups = (await env.DB.prepare('SELECT group_id FROM user_groups WHERE email = ?').bind(lower).all<{ group_id: string }>()).results.map((g) => g.group_id);
  return { email: lower, name: row.name, role: row.role, allGroups: !!row.all_groups, groups };
}
