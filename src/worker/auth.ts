// 管理介面驗證：Google 登入建立的 Session（Cookie）＋ 成員名單與角色權限。
// LINE /webhook 不經過這裡，改用 LINE 簽章驗證。
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './api/util';
import { loadUser } from './permissions';
import { clearSessionCookie, readSession, revokeSession, sameOrigin } from './auth/session';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** DEV_NO_AUTH 只在本機（localhost）或展示版有效，就算誤設在正式環境也不會生效 */
export function devBypass(env: AppEnv['Bindings'], url: string): boolean {
  if (env.DEV_NO_AUTH !== 'true') return false;
  return !!env.DEMO_AI || LOCAL_HOSTS.has(new URL(url).hostname);
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!sameOrigin(c.req.raw)) return c.json({ error: '請求來源不正確（CSRF 防護）' }, 403);

  if (devBypass(c.env, c.req.url)) {
    const email = 'dev@localhost';
    await c.env.DB.prepare("INSERT OR IGNORE INTO users (email, name, role, all_groups) VALUES (?, '本機開發', 'admin', 1)").bind(email).run();
    const user = await loadUser(c.env, email);
    c.set('user', user!);
    c.set('sessionId', null);
    return next();
  }

  const session = await readSession(c);
  if (!session) {
    clearSessionCookie(c);
    return c.json({ error: '請先登入', login: true }, 401);
  }
  const user = await loadUser(c.env, session.email);
  if (!user) {
    // 成員已被移除：撤銷這個 Session
    await revokeSession(c.env, session.id);
    clearSessionCookie(c);
    return c.json({ error: `${session.email} 已不是 GrabIt 成員，請聯絡管理員`, login: true }, 401);
  }
  c.set('user', user);
  c.set('sessionId', session.id);
  return next();
};
