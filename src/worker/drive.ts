// Google Drive（OAuth 2.0 + REST API，不依賴 googleapis 套件，可在 Workers 執行）
import type { Env } from './env';
import { PermanentError } from './env';
import { getSetting, setSetting, deleteSetting } from './db';
import { withCounter } from './rules';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// drive.file：只能存取本系統建立的檔案，不會讀到你雲端硬碟的其他內容
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DEFAULT_ROOT = 'LINE FileHub';

export function authUrl(env: Env, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `${DRIVE_SCOPE} openid email`,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok) throw new Error(`Google OAuth 失敗：${data.error_description ?? data.error ?? res.status}`);
  return data;
}

function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    let payload = idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<void> {
  const t = await tokenRequest({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (!t.refresh_token) throw new Error('Google 沒有回傳 refresh token，請到 Google 帳號移除授權後重新連接');
  await setSetting(env, 'google_refresh_token', t.refresh_token);
  await setSetting(env, 'google_access_token', t.access_token);
  await setSetting(env, 'google_access_expires', String(Date.now() + (t.expires_in - 60) * 1000));
  const email = emailFromIdToken(t.id_token);
  if (email) await setSetting(env, 'google_email', email);
  // 換帳號後舊的資料夾 ID 都不能用了
  await env.DB.prepare('DELETE FROM drive_folders').run();
}

export async function disconnect(env: Env): Promise<void> {
  for (const k of ['google_refresh_token', 'google_access_token', 'google_access_expires', 'google_email']) {
    await deleteSetting(env, k);
  }
  await env.DB.prepare('DELETE FROM drive_folders').run();
}

export async function getAccessToken(env: Env): Promise<string> {
  const cached = await getSetting(env, 'google_access_token');
  const expires = Number((await getSetting(env, 'google_access_expires')) ?? 0);
  if (cached && Date.now() < expires) return cached;
  const refresh = await getSetting(env, 'google_refresh_token');
  if (!refresh) throw new PermanentError('尚未連接 Google Drive，請到「設定」頁面連接');
  let t: TokenResponse;
  try {
    t = await tokenRequest({
      refresh_token: refresh,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    });
  } catch (e) {
    throw new PermanentError(`Google Drive 授權失效，請到「設定」重新連接（${(e as Error).message}）`);
  }
  await setSetting(env, 'google_access_token', t.access_token);
  await setSetting(env, 'google_access_expires', String(Date.now() + (t.expires_in - 60) * 1000));
  return t.access_token;
}

export class Drive {
  constructor(
    private env: Env,
    private token: string,
  ) {}

  static async connect(env: Env): Promise<Drive> {
    return new Drive(env, await getAccessToken(env));
  }

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const text = await res.text();
      const err = `Google Drive API ${res.status}：${text.slice(0, 300)}`;
      if (res.status === 401 || res.status === 403) throw new PermanentError(err);
      throw new Error(err);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private static q(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  private async findChild(parentId: string, name: string, folder: boolean): Promise<string | null> {
    const q = [
      `name='${Drive.q(name)}'`,
      `'${parentId}' in parents`,
      'trashed=false',
      folder ? `mimeType='${FOLDER_MIME}'` : `mimeType!='${FOLDER_MIME}'`,
    ].join(' and ');
    const r = await this.api<{ files: { id: string }[] }>(
      `${DRIVE}/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`,
    );
    return r.files[0]?.id ?? null;
  }

  private async createFolder(parentId: string | null, name: string): Promise<string> {
    const r = await this.api<{ id: string }>(`${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
    });
    return r.id;
  }

  private async folderStillExists(id: string): Promise<boolean> {
    try {
      const r = await this.api<{ trashed: boolean }>(`${DRIVE}/files/${id}?fields=trashed`);
      return !r.trashed;
    } catch {
      return false;
    }
  }

  /** 根目錄（在「我的雲端硬碟」下建立，名稱可在設定修改） */
  async rootFolderId(): Promise<string> {
    const name = (await getSetting(this.env, 'root_folder')) || DEFAULT_ROOT;
    const key = `__root__:${name}`;
    const cached = await this.env.DB.prepare('SELECT folder_id FROM drive_folders WHERE path = ?')
      .bind(key)
      .first<{ folder_id: string }>();
    if (cached && (await this.folderStillExists(cached.folder_id))) return cached.folder_id;
    const existing = await this.findChild('root', name, true);
    const id = existing ?? (await this.createFolder(null, name));
    await this.env.DB.prepare('INSERT OR REPLACE INTO drive_folders (path, folder_id) VALUES (?, ?)')
      .bind(key, id)
      .run();
    return id;
  }

  /** 確保「根目錄/a/b/c」存在，回傳最後一層的資料夾 ID */
  async ensureFolder(path: string): Promise<string> {
    let parent = await this.rootFolderId();
    const segments = path.split('/').filter(Boolean);
    let current = '';
    for (const seg of segments) {
      current = current ? `${current}/${seg}` : seg;
      const cached = await this.env.DB.prepare('SELECT folder_id FROM drive_folders WHERE path = ?')
        .bind(current)
        .first<{ folder_id: string }>();
      if (cached) {
        parent = cached.folder_id;
        continue;
      }
      const id = (await this.findChild(parent, seg, true)) ?? (await this.createFolder(parent, seg));
      await this.env.DB.prepare('INSERT OR REPLACE INTO drive_folders (path, folder_id) VALUES (?, ?)')
        .bind(current, id)
        .run();
      parent = id;
    }
    return parent;
  }

  /** 若資料夾內已有同名檔案，改用「名稱 (1).ext」 */
  async uniqueName(parentId: string, name: string): Promise<string> {
    let candidate = name;
    for (let n = 1; n < 100; n++) {
      if (!(await this.findChild(parentId, candidate, false))) return candidate;
      candidate = withCounter(name, n);
    }
    return withCounter(name, Date.now());
  }

  /**
   * 串流上傳：資料直接從 LINE 流向 Google Drive，不會整個讀進記憶體。
   * Drive 會回傳 md5Checksum，用來偵測重複檔案。
   */
  async upload(
    parentId: string,
    name: string,
    mimeType: string,
    body: ReadableStream<Uint8Array>,
    length: number | null,
  ): Promise<{ id: string; md5: string | null; size: number | null }> {
    const init = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,md5Checksum,size`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        ...(length != null ? { 'X-Upload-Content-Length': String(length) } : {}),
      },
      body: JSON.stringify({ name, parents: [parentId] }),
    });
    if (!init.ok) throw new Error(`Drive 上傳初始化失敗 ${init.status}：${(await init.text()).slice(0, 300)}`);
    const location = init.headers.get('Location');
    if (!location) throw new Error('Drive 沒有回傳上傳網址');

    let payload: BodyInit;
    if (length != null) {
      const fixed = new FixedLengthStream(length);
      void body.pipeTo(fixed.writable).catch(() => {});
      payload = fixed.readable;
    } else {
      // 不知道長度時只能先讀進記憶體（LINE 通常會提供長度）
      payload = await new Response(body).arrayBuffer();
    }
    const res = await fetch(location, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: payload,
    });
    if (!res.ok) throw new Error(`Drive 上傳失敗 ${res.status}：${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { id: string; md5Checksum?: string; size?: string };
    let md5 = data.md5Checksum ?? null;
    if (!md5) {
      const meta = await this.api<{ md5Checksum?: string }>(`${DRIVE}/files/${data.id}?fields=md5Checksum`);
      md5 = meta.md5Checksum ?? null;
    }
    return { id: data.id, md5, size: data.size ? Number(data.size) : length };
  }

  async move(fileId: string, newParentId: string): Promise<void> {
    const meta = await this.api<{ parents?: string[] }>(`${DRIVE}/files/${fileId}?fields=parents`);
    const remove = (meta.parents ?? []).join(',');
    const p = new URLSearchParams({ addParents: newParentId, fields: 'id' });
    if (remove) p.set('removeParents', remove);
    await this.api(`${DRIVE}/files/${fileId}?${p}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }

  async rename(fileId: string, name: string): Promise<void> {
    await this.api(`${DRIVE}/files/${fileId}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  /** 移到垃圾桶（30 天內可以從 Google Drive 救回） */
  async trash(fileId: string): Promise<void> {
    await this.api(`${DRIVE}/files/${fileId}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }
}

export function driveLink(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}
