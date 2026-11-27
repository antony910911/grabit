// 各雲端的 OAuth 設定與 token 更新
import type { Env } from '../env';
import { StorageError, type StorageRow, type StorageType } from './types';

interface OAuthConfig {
  label: string;
  authUrl: string;
  tokenUrl: string;
  scope: string;
  extra: Record<string, string>;
  clientId: (env: Env) => string | undefined;
  clientSecret: (env: Env) => string | undefined;
  envNames: [string, string];
}

export const OAUTH: Partial<Record<StorageType, OAuthConfig>> = {
  gdrive: {
    label: 'Google Drive',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // drive.file：只能存取本系統建立的檔案
    scope: 'https://www.googleapis.com/auth/drive.file openid email',
    extra: { access_type: 'offline', prompt: 'consent' },
    clientId: (e) => e.GOOGLE_CLIENT_ID,
    clientSecret: (e) => e.GOOGLE_CLIENT_SECRET,
    envNames: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  },
  onedrive: {
    label: 'OneDrive / SharePoint',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access Files.ReadWrite User.Read',
    extra: { prompt: 'select_account' },
    clientId: (e) => e.MS_CLIENT_ID,
    clientSecret: (e) => e.MS_CLIENT_SECRET,
    envNames: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET'],
  },
  dropbox: {
    label: 'Dropbox',
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scope: '',
    extra: { token_access_type: 'offline' },
    clientId: (e) => e.DROPBOX_APP_KEY,
    clientSecret: (e) => e.DROPBOX_APP_SECRET,
    envNames: ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET'],
  },
};

export function oauthConfigured(env: Env, type: StorageType): boolean {
  const c = OAUTH[type];
  return !!c && !!c.clientId(env) && !!c.clientSecret(env);
}

export function buildAuthUrl(env: Env, type: StorageType, redirectUri: string, state: string): string {
  const c = OAUTH[type];
  if (!c) throw new Error('這種空間不使用 OAuth');
  const p = new URLSearchParams({ client_id: c.clientId(env) ?? '', redirect_uri: redirectUri, response_type: 'code', state, ...c.extra });
  if (c.scope) p.set('scope', c.scope);
  return `${c.authUrl}?${p}`;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(c: OAuthConfig, env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId(env) ?? '', client_secret: c.clientSecret(env) ?? '', ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) throw new Error(`${c.label} 授權失敗：${data.error_description ?? data.error ?? res.status}`);
  return data;
}

export interface Secret {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
  password?: string;
}

/** 用授權碼換 token，回傳要存進 storages.secret 的內容與帳號 */
export async function exchangeCode(env: Env, type: StorageType, code: string, redirectUri: string): Promise<{ secret: Secret; account: string | null }> {
  const c = OAUTH[type]!;
  const t = await tokenRequest(c, env, { code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!t.refresh_token) throw new Error(`${c.label} 沒有回傳 refresh token，請到帳號設定移除授權後重新連接`);
  const secret: Secret = {
    refresh_token: t.refresh_token,
    access_token: t.access_token,
    expires_at: Date.now() + ((t.expires_in ?? 3600) - 60) * 1000,
  };
  return { secret, account: await lookupAccount(type, t) };
}

async function lookupAccount(type: StorageType, t: TokenResponse): Promise<string | null> {
  try {
    if (type === 'gdrive' && t.id_token) {
      let p = t.id_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
      p += '='.repeat((4 - (p.length % 4)) % 4);
      const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p), (ch) => ch.charCodeAt(0)))) as { email?: string };
      return json.email ?? null;
    }
    if (type === 'onedrive') {
      const r = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${t.access_token}` } });
      const j = (await r.json()) as { mail?: string; userPrincipalName?: string };
      return j.mail ?? j.userPrincipalName ?? null;
    }
    if (type === 'dropbox') {
      const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST', headers: { Authorization: `Bearer ${t.access_token}` } });
      const j = (await r.json()) as { email?: string };
      return j.email ?? null;
    }
  } catch {
    // 拿不到帳號名稱不影響使用
  }
  return null;
}

export function parseSecret(row: StorageRow): Secret {
  try {
    return JSON.parse(row.secret || '{}') as Secret;
  } catch {
    return {};
  }
}

/** 取得有效的 access token，過期就用 refresh token 換新的並寫回資料庫 */
export async function accessToken(env: Env, row: StorageRow): Promise<string> {
  const c = OAUTH[row.type];
  if (!c) throw new StorageError('這種空間不使用 OAuth', true);
  const s = parseSecret(row);
  if (s.access_token && s.expires_at && Date.now() < s.expires_at) return s.access_token;
  if (!s.refresh_token) throw new StorageError(`「${row.name}」尚未授權，請到「雲端設定」連接`, true);
  let t: TokenResponse;
  try {
    t = await tokenRequest(c, env, { refresh_token: s.refresh_token, grant_type: 'refresh_token' });
  } catch (e) {
    throw new StorageError(`「${row.name}」授權失效，請到「雲端設定」重新連接（${(e as Error).message}）`, true);
  }
  const next: Secret = {
    ...s,
    access_token: t.access_token,
    expires_at: Date.now() + ((t.expires_in ?? 3600) - 60) * 1000,
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
  };
  row.secret = JSON.stringify(next);
  await env.DB.prepare('UPDATE storages SET secret = ? WHERE id = ?').bind(row.secret, row.id).run();
  return t.access_token;
}
