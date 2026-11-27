// 登入 Session：隨機 token 放在 HttpOnly Cookie，資料庫只存雜湊；可設定有效期限、可撤銷
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';

/** __Host- 前綴：瀏覽器強制要求 Secure、Path=/、不能指定 Domain，避免子網域覆寫 */
export const SESSION_COOKIE = '__Host-grabit_session';
export const STATE_COOKIE = '__Host-grabit_login_state';

/** Session 絕對有效期限（天）與閒置逾時（天），可用環境變數調整 */
export function sessionDays(env: Env): { absolute: number; idle: number } {
  const absolute = Math.min(Math.max(Number(env.SESSION_TTL_DAYS) || 30, 1), 90);
  const idle = Math.min(Math.max(Number(env.SESSION_IDLE_DAYS) || 7, 1), absolute);
  return { absolute, idle };
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cookieBase = { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const };

export interface SessionRow {
  id: string;
  email: string;
  created_at: string;
  last_seen: string;
  expires_at: string;
  user_agent: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createSession(c: Context<any>, email: string): Promise<void> {
  const env = c.env as Env;
  const { absolute } = sessionDays(env);
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO sessions (id, email, expires_at, user_agent, ip) VALUES (?, ?, datetime('now', ?), ?, ?)`,
  )
    .bind(await sha256Hex(token), email, `+${absolute} days`, (c.req.header('User-Agent') ?? '').slice(0, 300), c.req.header('CF-Connecting-IP') ?? null)
    .run();
  // 順便清掉過期很久的 Session 與登入暫存，避免資料表無限長大
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now', '-30 days')").run();
  await env.DB.prepare("DELETE FROM auth_states WHERE expires_at < datetime('now')").run();
  setCookie(c, SESSION_COOKIE, token, { ...cookieBase, maxAge: absolute * 86400 });
}

/** 依 Cookie 找出有效的 Session（未撤銷、未過期、未閒置逾時） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readSession(c: Context<any>): Promise<SessionRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 200) return null;
  const env = c.env as Env;
  const { idle } = sessionDays(env);
  const row = await env.DB.prepare(
    `SELECT id, email, created_at, last_seen, expires_at, user_agent FROM sessions
     WHERE id = ? AND revoked_at IS NULL AND expires_at > datetime('now') AND last_seen > datetime('now', ?)`,
  )
    .bind(await sha256Hex(token), `-${idle} days`)
    .first<SessionRow>();
  if (!row) return null;
  // 每 5 分鐘最多更新一次最後使用時間（閒置逾時用）
  await env.DB.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE id = ? AND last_seen < datetime('now', '-5 minutes')").bind(row.id).run();
  return row;
}

export async function revokeSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").bind(id).run();
}

export async function revokeAllSessions(env: Env, email: string): Promise<number> {
  const r = await env.DB.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE email = ? AND revoked_at IS NULL").bind(email.toLowerCase()).run();
  return r.meta.changes ?? 0;
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

/** 只允許站內的相對路徑，避免登入後被導到外部網站（open redirect） */
export function safeRedirect(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || /[\r\n]/.test(next)) return '/';
  if (next.startsWith('/auth/') || next.startsWith('/login')) return '/';
  return next.slice(0, 500);
}

/**
 * CSRF 防護：會改變資料的請求必須來自同一個網站。
 * 瀏覽器一定會帶 Origin 或 Sec-Fetch-Site；兩者都沒有的是非瀏覽器用戶端（不受 CSRF 影響）。
 */
export function sameOrigin(req: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const origin = req.headers.get('Origin');
  if (origin) return origin === new URL(req.url).origin;
  const site = req.headers.get('Sec-Fetch-Site');
  if (site) return site === 'same-origin' || site === 'none';
  return true;
}
