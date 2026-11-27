// Google Drive（REST API；用 ID 定位，搬移後 ID 不變）
import { withCounter } from '../rules';
import { accessToken } from './oauth';
import { httpError, joinPath, sizedBody, StorageError, type Body, type MoveResult, type ProviderContext, type StorageProvider, type UploadResult } from './types';
import { FolderCache } from './cache';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
export const gdriveLink = (id: string) => `https://drive.google.com/file/d/${id}/view`;
export const gdriveFolderLink = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/** 專屬資料夾的分享方式 */
export type ShareMode = 'private' | 'members' | 'anyone';

export interface DriveConfig {
  root_id?: string; // 專屬根資料夾的 ID（所有檔案都放在這裡面）
  root_name?: string;
  share?: ShareMode;
  share_error?: string | null;
}

export function driveConfig(row: { config: string }): DriveConfig {
  try {
    return JSON.parse(row.config || '{}') as DriveConfig;
  } catch {
    return {};
  }
}

interface Permission {
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: string;
  emailAddress?: string;
}

export class GoogleDrive implements StorageProvider {
  private cache: FolderCache;
  constructor(private ctx: ProviderContext) {
    this.cache = new FolderCache(ctx.env, ctx.row.id);
  }
  get row() {
    return this.ctx.row;
  }

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await accessToken(this.ctx.env, this.ctx.row);
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    if (!res.ok) throw await httpError('Google Drive', res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async findChild(parentId: string, name: string, folder: boolean): Promise<string | null> {
    const query = [`name='${q(name)}'`, `'${parentId}' in parents`, 'trashed=false', folder ? `mimeType='${FOLDER_MIME}'` : `mimeType!='${FOLDER_MIME}'`].join(' and ');
    const r = await this.api<{ files: { id: string }[] }>(`${DRIVE}/files?${new URLSearchParams({ q: query, fields: 'files(id)', pageSize: '1' })}`);
    return r.files[0]?.id ?? null;
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const r = await this.api<{ id: string }>(`${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return r.id;
  }

  private async alive(id: string): Promise<boolean> {
    try {
      return !(await this.api<{ trashed: boolean }>(`${DRIVE}/files/${id}?fields=trashed`)).trashed;
    } catch {
      return false;
    }
  }

  private rootChecked: string | null = null;

  private async saveConfig(patch: Partial<DriveConfig>): Promise<DriveConfig> {
    const cfg = { ...driveConfig(this.row), ...patch };
    this.row.config = JSON.stringify(cfg);
    await this.ctx.env.DB.prepare('UPDATE storages SET config = ? WHERE id = ?').bind(this.row.config, this.row.id).run();
    return cfg;
  }

  /**
   * 專屬根資料夾：連結時在「我的雲端硬碟」建立一個全新的資料夾，用 ID 記住。
   * 之後所有檔案都放在這個資料夾裡；被刪除或移到垃圾桶時會自動重建一個新的。
   */
  async rootId(): Promise<string> {
    const cfg = driveConfig(this.row);
    if (cfg.root_id && (this.rootChecked === cfg.root_id || (await this.alive(cfg.root_id)))) {
      this.rootChecked = cfg.root_id;
      return cfg.root_id;
    }
    // 名稱重複時加上編號，確保是一個全新的資料夾
    const base = this.row.root_folder || 'GrabIt';
    let name = base;
    for (let n = 2; n < 50 && (await this.findChild('root', name, true)); n++) name = `${base} (${n})`;
    const created = await this.createFolder('root', name);
    // 同時有多個檔案在處理時可能都想建立資料夾：用條件式更新，只有一個會成功
    const r = await this.ctx.env.DB.prepare(
      "UPDATE storages SET config = json_set(json_set(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.root_id', ?), '$.root_name', ?) WHERE id = ? AND json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.root_id') IS ?",
    )
      .bind(created, name, this.row.id, cfg.root_id ?? null)
      .run();
    const latest = await this.ctx.env.DB.prepare('SELECT config FROM storages WHERE id = ?').bind(this.row.id).first<{ config: string }>();
    this.row.config = latest?.config ?? this.row.config;
    const winner = driveConfig(this.row).root_id ?? created;
    if (!r.meta.changes || winner !== created) {
      // 別的處理程序先建好了：刪掉自己多建的空資料夾
      await this.trash(created).catch(() => {});
      this.rootChecked = winner;
      return winner;
    }
    await this.cache.clear();
    this.rootChecked = created;
    await this.applySharing().catch(() => {});
    return created;
  }

  /** 專屬資料夾改名（只改名稱，ID 不變，檔案不用搬） */
  async renameRoot(name: string): Promise<void> {
    const root = await this.rootId();
    await this.api(`${DRIVE}/files/${root}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    await this.saveConfig({ root_name: name });
  }

  /** 依設定把專屬資料夾分享給 GrabIt 成員、知道連結的任何人，或不分享 */
  async applySharing(): Promise<{ added: number; removed: number; errors: string[] }> {
    const cfg = driveConfig(this.row);
    const mode: ShareMode = cfg.share ?? 'private';
    const root = cfg.root_id ?? (await this.rootId());
    const members =
      mode === 'members'
        ? (await this.ctx.env.DB.prepare('SELECT email FROM users').all<{ email: string }>()).results.map((u) => u.email.toLowerCase())
        : [];
    const own = (this.row.account ?? '').toLowerCase();
    const perms = (await this.api<{ permissions: Permission[] }>(`${DRIVE}/files/${root}/permissions?fields=permissions(id,type,role,emailAddress)`)).permissions;
    let added = 0;
    let removed = 0;
    const errors: string[] = [];
    const create = async (body: Record<string, unknown>, notify = false) => {
      const qs = body.type === 'user' ? `?sendNotificationEmail=${notify}&fields=id` : '?fields=id';
      await this.api(`${DRIVE}/files/${root}/permissions${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      added++;
    };
    // 移除不該有的權限（擁有者不動）
    for (const p of perms) {
      if (p.role === 'owner') continue;
      const keep =
        (p.type === 'anyone' && mode === 'anyone') ||
        (p.type === 'user' && mode === 'members' && !!p.emailAddress && members.includes(p.emailAddress.toLowerCase()));
      if (!keep && (p.type === 'anyone' || p.type === 'user')) {
        await this.api(`${DRIVE}/files/${root}/permissions/${p.id}`, { method: 'DELETE' }).catch((e: Error) => errors.push(e.message));
        removed++;
      }
    }
    if (mode === 'anyone' && !perms.some((p) => p.type === 'anyone')) {
      await create({ type: 'anyone', role: 'reader', allowFileDiscovery: false }).catch((e: Error) => errors.push(`公開連結：${e.message}`));
    }
    if (mode === 'members') {
      for (const email of members) {
        if (email === own || perms.some((p) => p.emailAddress?.toLowerCase() === email)) continue;
        await create({ type: 'user', role: 'reader', emailAddress: email }).catch((e: Error) => errors.push(`${email}：${e.message}`));
      }
    }
    await this.saveConfig({ share_error: errors.length ? errors.slice(0, 3).join('；') : null });
    return { added, removed, errors };
  }

  /** 資料夾路徑（相對於專屬根資料夾）→ ID；結果會快取 */
  async folderId(path: string): Promise<string> {
    const root = await this.rootId();
    const rel = joinPath(path);
    if (!rel) return root;
    const key = (p: string) => `${root}:${p}`;
    const cached = await this.cache.get(key(rel));
    if (cached) return cached;
    let parent = root;
    let current = '';
    for (const seg of rel.split('/')) {
      current = current ? `${current}/${seg}` : seg;
      const hit = await this.cache.get(key(current));
      if (hit) {
        parent = hit;
        continue;
      }
      const found = await this.findChild(parent, seg, true);
      const id = found ?? (await this.createFolder(parent, seg));
      const kept = await this.cache.claim(key(current), id);
      // 同時建立了兩個同名資料夾：保留先登記的那個，刪掉自己多建的
      if (kept !== id && !found) await this.trash(id).catch(() => {});
      parent = kept;
    }
    return parent;
  }

  private async uniqueName(parentId: string, name: string, selfId?: string): Promise<string> {
    let candidate = name;
    for (let n = 1; n < 200; n++) {
      const hit = await this.findChild(parentId, candidate, false);
      if (!hit || hit === selfId) return candidate;
      candidate = withCounter(name, n);
    }
    return withCounter(name, Date.now());
  }

  async upload(folderPath: string, name: string, mime: string, body: Body, length: number | null): Promise<UploadResult> {
    const parentId = await this.folderId(folderPath);
    const finalName = await this.uniqueName(parentId, name);
    const token = await accessToken(this.ctx.env, this.row);
    const init = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,md5Checksum,size`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        ...(length != null ? { 'X-Upload-Content-Length': String(length) } : {}),
      },
      body: JSON.stringify({ name: finalName, parents: [parentId] }),
    });
    if (!init.ok) throw await httpError('Drive 上傳初始化失敗', init);
    const location = init.headers.get('Location');
    if (!location) throw new StorageError('Drive 沒有回傳上傳網址');
    const res = await fetch(location, { method: 'PUT', headers: { 'Content-Type': mime }, body: await sizedBody(body, length) });
    if (!res.ok) throw await httpError('Drive 上傳失敗', res);
    const data = (await res.json()) as { id: string; md5Checksum?: string; size?: string };
    let md5 = data.md5Checksum;
    if (!md5) md5 = (await this.api<{ md5Checksum?: string }>(`${DRIVE}/files/${data.id}?fields=md5Checksum`)).md5Checksum;
    return { ref: data.id, name: finalName, hash: md5 ? `md5:${md5}` : null, size: data.size ? Number(data.size) : length, link: gdriveLink(data.id), root: this.rootChecked };
  }

  async move(ref: string, folderPath: string, name: string): Promise<MoveResult> {
    const parentId = await this.folderId(folderPath);
    const finalName = await this.uniqueName(parentId, name, ref);
    const meta = await this.api<{ parents?: string[] }>(`${DRIVE}/files/${ref}?fields=parents`);
    const p = new URLSearchParams({ fields: 'id' });
    const old = (meta.parents ?? []).filter((x) => x !== parentId);
    if (!(meta.parents ?? []).includes(parentId)) p.set('addParents', parentId);
    if (old.length) p.set('removeParents', old.join(','));
    await this.api(`${DRIVE}/files/${ref}?${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: finalName }) });
    return { ref, name: finalName, link: gdriveLink(ref), root: this.rootChecked };
  }

  async trash(ref: string): Promise<void> {
    await this.api(`${DRIVE}/files/${ref}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  }

  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const id = await this.folderId(oldPath);
    const newParentPath = newPath.split('/').slice(0, -1).join('/');
    const newName = newPath.split('/').pop()!;
    const parentId = await this.folderId(newParentPath);
    const meta = await this.api<{ parents?: string[] }>(`${DRIVE}/files/${id}?fields=parents`);
    const p = new URLSearchParams({ fields: 'id' });
    if (!(meta.parents ?? []).includes(parentId)) {
      p.set('addParents', parentId);
      if (meta.parents?.length) p.set('removeParents', meta.parents.join(','));
    }
    await this.api(`${DRIVE}/files/${id}?${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName }) });
    const root = await this.rootId();
    await this.cache.renamePrefix(`${root}:${joinPath(oldPath)}`, `${root}:${joinPath(newPath)}`);
  }

  async download(ref: string): Promise<Response> {
    const token = await accessToken(this.ctx.env, this.row);
    const res = await fetch(`${DRIVE}/files/${ref}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw await httpError('Drive 下載失敗', res);
    return res;
  }
}
