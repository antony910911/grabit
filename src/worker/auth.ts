// 管理介面驗證：建議用 Cloudflare Access 保護整個網站（/webhook 除外），
// 這裡再驗一次 Access 簽發的 JWT，避免有人繞過 Access 直接打 API。
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { Env } from './env';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksDomain = '';

export type AuthVars = { userEmail: string };

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (c, next) => {
  const env = c.env;
  if (env.DEV_NO_AUTH === 'true') {
    c.set('userEmail', 'dev@localhost');
    return next();
  }
  const domain = (env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!domain || !env.ACCESS_AUD) {
    return c.json({ error: '管理介面尚未設定登入保護（Cloudflare Access），請參考 README 設定 ACCESS_TEAM_DOMAIN 與 ACCESS_AUD' }, 503);
  }
  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return c.json({ error: '未登入' }, 401);
  try {
    if (!jwks || jwksDomain !== domain) {
      jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
      jwksDomain = domain;
    }
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}`, audience: env.ACCESS_AUD });
    c.set('userEmail', String(payload.email ?? ''));
  } catch {
    return c.json({ error: '登入驗證失敗' }, 401);
  }
  return next();
};
