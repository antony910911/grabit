// 登入：用 Cloudflare Access 保護整個網站（/webhook 除外），這裡再驗一次 Access 簽發的 JWT，
// 並依 email 載入成員與權限。
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './api/util';
import { loadUser } from './permissions';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksDomain = '';

async function verifiedEmail(env: AppEnv['Bindings'], token: string | undefined): Promise<string | { error: string; status: 401 | 503 }> {
  if (env.DEV_NO_AUTH === 'true') return 'dev@localhost';
  const domain = (env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!domain || !env.ACCESS_AUD) {
    return { error: '管理介面尚未設定登入保護（Cloudflare Access），請參考 README 設定 ACCESS_TEAM_DOMAIN 與 ACCESS_AUD', status: 503 };
  }
  if (!token) return { error: '未登入', status: 401 };
  try {
    if (!jwks || jwksDomain !== domain) {
      jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
      jwksDomain = domain;
    }
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}`, audience: env.ACCESS_AUD });
    const email = String(payload.email ?? '');
    return email || { error: '登入資訊缺少 email', status: 401 };
  } catch {
    return { error: '登入驗證失敗', status: 401 };
  }
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const r = await verifiedEmail(c.env, c.req.header('Cf-Access-Jwt-Assertion'));
  if (typeof r !== 'string') return c.json({ error: r.error }, r.status);
  const user = await loadUser(c.env, r);
  if (!user) return c.json({ error: `${r} 還不是 GrabIt 的成員，請管理員到「成員與權限」加入你的 email` }, 403);
  c.set('user', user);
  return next();
};
