// Google 帳號登入（OAuth 2.0 Authorization Code + PKCE + OpenID Connect）
// 只用來確認「你是誰」；存取 Google Drive 的授權在「雲端設定」另外進行（/oauth/gdrive/callback）。
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../env';
import { log } from '../db';
import { loadUser } from '../permissions';
import { createSession, randomToken, safeRedirect, sha256Base64Url, sha256Hex, STATE_COOKIE } from './session';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const LOGIN_CALLBACK_PATH = '/auth/google/callback';
const STATE_TTL_MINUTES = 10;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type C = Context<any>;

export type LoginError = 'config' | 'state' | 'denied' | 'token' | 'verify' | 'unverified' | 'not_member';

function fail(c: C, code: LoginError) {
  return c.redirect(`/login?error=${code}`);
}

export function loginConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** 第一步：產生 state、nonce、PKCE，導向 Google 登入頁 */
export async function startLogin(c: C) {
  const env = c.env as Env;
  if (!loginConfigured(env)) return fail(c, 'config');
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  await env.DB.prepare(
    `INSERT INTO auth_states (state_hash, nonce, code_verifier, redirect_to, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))`,
  )
    .bind(await sha256Hex(state), nonce, verifier, safeRedirect(c.req.query('next')), `+${STATE_TTL_MINUTES} minutes`)
    .run();
  // state 同時放在 Cookie：回來時兩者必須一致，避免攻擊者把他的登入結果塞給你（login CSRF）
  setCookie(c, STATE_COOKIE, state, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: STATE_TTL_MINUTES * 60 });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: new URL(LOGIN_CALLBACK_PATH, c.req.url).toString(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return c.redirect(`${AUTHORIZE_URL}?${params}`);
}

interface IdClaims {
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  nonce?: string;
  azp?: string;
}

/** 第二步：Google 帶著 code 回來，驗證後建立 Session */
export async function finishLogin(c: C) {
  const env = c.env as Env;
  const { code, state, error } = c.req.query();
  const cookieState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true });
  if (error) return fail(c, 'denied');
  if (!loginConfigured(env)) return fail(c, 'config');
  if (!code || !state || !cookieState || state !== cookieState) return fail(c, 'state');

  // state 只能用一次：先刪除再判斷，重放的請求會找不到
  const stateHash = await sha256Hex(state);
  const saved = await env.DB.prepare("SELECT nonce, code_verifier, redirect_to, expires_at > datetime('now') AS valid FROM auth_states WHERE state_hash = ?")
    .bind(stateHash)
    .first<{ nonce: string; code_verifier: string; redirect_to: string; valid: number }>();
  await env.DB.prepare('DELETE FROM auth_states WHERE state_hash = ?').bind(stateHash).run();
  if (!saved || !saved.valid) return fail(c, 'state');

  // 用授權碼＋PKCE verifier 換 ID Token（伺服器對伺服器，帶 client secret）
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: new URL(LOGIN_CALLBACK_PATH, c.req.url).toString(),
      grant_type: 'authorization_code',
      code_verifier: saved.code_verifier,
    }),
  });
  const tokens = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!res.ok || !tokens.id_token) return fail(c, 'token');

  // 驗證 ID Token：簽章（Google 公鑰）、issuer、audience、有效期限、nonce、email_verified
  let claims: IdClaims;
  try {
    jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: ISSUERS,
      audience: env.GOOGLE_CLIENT_ID!,
      algorithms: ['RS256'],
      clockTolerance: 30,
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    claims = payload as IdClaims;
  } catch {
    return fail(c, 'verify');
  }
  if (claims.nonce !== saved.nonce) return fail(c, 'verify');
  if (claims.azp && claims.azp !== env.GOOGLE_CLIENT_ID) return fail(c, 'verify');
  if (claims.email_verified !== true && claims.email_verified !== 'true') return fail(c, 'unverified');

  const email = claims.email!.trim().toLowerCase();
  const user = await loadUser(env, email);
  if (!user) {
    await log(env, 'warn', 'login', `拒絕登入：${email} 不是 GrabIt 成員`);
    return fail(c, 'not_member');
  }
  if (!user.name && claims.name) await env.DB.prepare('UPDATE users SET name = ? WHERE email = ? AND name IS NULL').bind(claims.name.slice(0, 80), email).run();
  await createSession(c, email);
  await log(env, 'info', 'login', `${email} 登入`);
  return c.redirect(saved.redirect_to || '/');
}
