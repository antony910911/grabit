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

  /** 資料夾路徑 → ID（含根目錄；結果會快取） */
  async folderId(path: string): Promise<string> {
    const full = joinPath(this.row.root_folder, path);
    const cached = await this.cache.get(full);
    // 只檢查根目錄是否還在，避免使用者手動刪掉後一直失敗
    if (cached && (full.includes('/') || (await this.alive(cached)))) return cached;
    let parent = 'root';
    let current = '';
    for (const seg of full.split('/')) {
      current = current ? `${current}/${seg}` : seg;
      const hit = current === full ? null : await this.cache.get(current);
      if (hit) {
        parent = hit;
        continue;
      }
      const id = (await this.findChild(parent, seg, true)) ?? (await this.createFolder(parent, seg));
      await this.cache.set(current, id);
      parent = id;
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
    return { ref: data.id, name: finalName, hash: md5 ? `md5:${md5}` : null, size: data.size ? Number(data.size) : length, link: gdriveLink(data.id) };
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
    return { ref, name: finalName, link: gdriveLink(ref) };
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
    await this.cache.renamePrefix(joinPath(this.row.root_folder, oldPath), joinPath(this.row.root_folder, newPath));
  }

  async download(ref: string): Promise<Response> {
    const token = await accessToken(this.ctx.env, this.row);
    const res = await fetch(`${DRIVE}/files/${ref}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw await httpError('Drive 下載失敗', res);
    return res;
  }
}
