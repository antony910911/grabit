// Dropbox（路徑式，但檔案也可以用 "id:xxx" 定位，搬移後 ID 不變）
import { accessToken } from './oauth';
import { httpError, joinPath, sizedBody, StorageError, type Body, type MoveResult, type ProviderContext, type StorageProvider, type UploadResult } from './types';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const MAX_SIMPLE_UPLOAD = 150 * 1024 * 1024;

interface Metadata {
  id: string;
  name: string;
  path_display: string;
  size?: number;
  content_hash?: string;
}

/** Dropbox-API-Arg 標頭只能是 ASCII，中文要轉成 \uXXXX */
export function headerJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const webLink = (path: string) => `https://www.dropbox.com/home${path.split('/').map(encodeURIComponent).join('/')}`;

export class Dropbox implements StorageProvider {
  constructor(private ctx: ProviderContext) {}
  get row() {
    return this.ctx.row;
  }

  private full(path: string): string {
    return '/' + joinPath(this.row.root_folder, path);
  }

  private async rpc<T>(endpoint: string, args: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
    const token = await accessToken(this.ctx.env, this.row);
    const res = await fetch(`${API}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (res.ok) return { ok: true, data: (await res.json()) as T };
    if (res.status === 409) {
      const j = (await res.json().catch(() => ({}))) as { error_summary?: string };
      return { ok: false, error: j.error_summary ?? 'conflict', status: 409 };
    }
    throw await httpError('Dropbox', res);
  }

  private async ensureFolder(path: string): Promise<void> {
    const r = await this.rpc('/files/create_folder_v2', { path: this.full(path), autorename: false });
    // 已經存在不算錯誤
    if (!r.ok && !r.error.startsWith('path/conflict/folder')) throw new StorageError(`Dropbox 建立資料夾失敗：${r.error}`);
  }

  async upload(folderPath: string, name: string, _mime: string, body: Body, length: number | null): Promise<UploadResult> {
    if (length != null && length > MAX_SIMPLE_UPLOAD) throw new StorageError('Dropbox 單檔上傳上限 150MB', true);
    await this.ensureFolder(folderPath);
    const token = await accessToken(this.ctx.env, this.row);
    const res = await fetch(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': headerJson({ path: `${this.full(folderPath)}/${name}`, mode: 'add', autorename: true, mute: true }),
      },
      body: await sizedBody(body, length),
    });
    if (!res.ok) throw await httpError('Dropbox 上傳失敗', res);
    const m = (await res.json()) as Metadata;
    return { ref: m.id, name: m.name, hash: m.content_hash ? `dropbox:${m.content_hash}` : null, size: m.size ?? length, link: webLink(m.path_display) };
  }

  async move(ref: string, folderPath: string, name: string): Promise<MoveResult> {
    await this.ensureFolder(folderPath);
    const r = await this.rpc<{ metadata: Metadata }>('/files/move_v2', { from_path: ref, to_path: `${this.full(folderPath)}/${name}`, autorename: true });
    if (!r.ok) {
      // 搬到原本的位置（同名）時 Dropbox 會回 conflict，視為沒有變動
      if (r.error.startsWith('to/conflict') || r.error.includes('duplicated_or_nested_paths')) return { ref, name, link: null };
      throw new StorageError(`Dropbox 搬移失敗：${r.error}`);
    }
    return { ref: r.data.metadata.id, name: r.data.metadata.name, link: webLink(r.data.metadata.path_display) };
  }

  async trash(ref: string): Promise<void> {
    // Dropbox 刪除後 30 天內可以從「已刪除的檔案」救回
    const r = await this.rpc('/files/delete_v2', { path: ref });
    if (!r.ok && !r.error.startsWith('path_lookup/not_found')) throw new StorageError(`Dropbox 刪除失敗：${r.error}`);
  }

  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    await this.ensureFolder(newPath.split('/').slice(0, -1).join('/'));
    const r = await this.rpc('/files/move_v2', { from_path: this.full(oldPath), to_path: this.full(newPath), autorename: false });
    if (!r.ok) throw new StorageError(`Dropbox 資料夾改名失敗：${r.error}`);
  }

  async download(ref: string): Promise<Response> {
    const token = await accessToken(this.ctx.env, this.row);
    const res = await fetch(`${CONTENT}/files/download`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': headerJson({ path: ref }) } });
    if (!res.ok) throw await httpError('Dropbox 下載失敗', res);
    return res;
  }
}
