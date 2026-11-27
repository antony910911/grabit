// OneDrive / SharePoint（Microsoft Graph；用 item ID 定位）
import { withCounter } from '../rules';
import { accessToken } from './oauth';
import { FolderCache } from './cache';
import { httpError, joinPath, StorageError, type Body, type MoveResult, type ProviderContext, type StorageProvider, type UploadResult } from './types';

const GRAPH = 'https://graph.microsoft.com/v1.0';
// 上傳分段大小必須是 320 KiB 的倍數
const CHUNK = 320 * 1024 * 32; // 10 MiB

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  file?: { hashes?: { quickXorHash?: string; sha1Hash?: string; sha256Hash?: string } };
}

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');

function itemHash(item: DriveItem): string | null {
  const h = item.file?.hashes;
  if (h?.sha256Hash) return `sha256:${h.sha256Hash.toLowerCase()}`;
  if (h?.sha1Hash) return `sha1:${h.sha1Hash.toLowerCase()}`;
  if (h?.quickXorHash) return `qxor:${h.quickXorHash}`;
  return null;
}

/** 把串流切成固定大小的區塊 */
async function* chunks(body: Body, size: number): AsyncGenerator<Uint8Array> {
  if (body instanceof ArrayBuffer) {
    for (let i = 0; i < body.byteLength; i += size) yield new Uint8Array(body.slice(i, i + size));
    return;
  }
  const reader = body.getReader();
  let buf = new Uint8Array(size);
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let off = 0;
    while (off < value.length) {
      const n = Math.min(size - filled, value.length - off);
      buf.set(value.subarray(off, off + n), filled);
      filled += n;
      off += n;
      if (filled === size) {
        yield buf;
        buf = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled) yield buf.subarray(0, filled);
}

export class OneDrive implements StorageProvider {
  private cache: FolderCache;
  constructor(private ctx: ProviderContext) {
    this.cache = new FolderCache(ctx.env, ctx.row.id);
  }
  get row() {
    return this.ctx.row;
  }

  private async api<T>(path: string, init: RequestInit = {}, allow404 = false): Promise<T | null> {
    const token = await accessToken(this.ctx.env, this.row);
    const res = await fetch(`${GRAPH}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw await httpError('OneDrive', res);
    if (res.status === 204) return null;
    return (await res.json()) as T;
  }

  async folderId(path: string): Promise<string> {
    const full = joinPath(this.row.root_folder, path);
    const cached = await this.cache.get(full);
    if (cached) return cached;
    let parentId: string | null = null;
    let current = '';
    for (const seg of full.split('/')) {
      current = current ? `${current}/${seg}` : seg;
      const hit = await this.cache.get(current);
      if (hit) {
        parentId = hit;
        continue;
      }
      const existing = await this.api<DriveItem>(`/me/drive/root:/${enc(current)}`, {}, true);
      let id: string | undefined = existing?.id;
      if (!id) {
        const created: DriveItem | null = await this.api<DriveItem>(parentId ? `/me/drive/items/${parentId}/children` : '/me/drive/root/children', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }),
        });
        id = created!.id;
      }
      if (!id) throw new StorageError('OneDrive 建立資料夾失敗');
      await this.cache.set(current, id);
      parentId = id;
    }
    return parentId!;
  }

  private async uniqueName(parentId: string, name: string, selfId?: string): Promise<string> {
    let candidate = name;
    for (let n = 1; n < 200; n++) {
      const hit = await this.api<DriveItem>(`/me/drive/items/${parentId}:/${encodeURIComponent(candidate)}`, {}, true);
      if (!hit || hit.id === selfId) return candidate;
      candidate = withCounter(name, n);
    }
    return withCounter(name, Date.now());
  }

  async upload(folderPath: string, name: string, _mime: string, body: Body, length: number | null): Promise<UploadResult> {
    const parentId = await this.folderId(folderPath);
    const finalName = await this.uniqueName(parentId, name);
    const session = await this.api<{ uploadUrl: string }>(`/me/drive/items/${parentId}:/${encodeURIComponent(finalName)}:/createUploadSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
    });
    // 長度未知時先讀進記憶體以取得總長度
    if (length == null && !(body instanceof ArrayBuffer)) body = await new Response(body).arrayBuffer();
    const total = body instanceof ArrayBuffer ? body.byteLength : length!;
    if (total === 0) throw new StorageError('OneDrive 不接受空檔案', true);
    let offset = 0;
    let item: DriveItem | null = null;
    for await (const part of chunks(body, CHUNK)) {
      const res = await fetch(session!.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(part.byteLength), 'Content-Range': `bytes ${offset}-${offset + part.byteLength - 1}/${total}` },
        body: part,
      });
      if (!res.ok) throw await httpError('OneDrive 上傳失敗', res);
      offset += part.byteLength;
      if (res.status === 200 || res.status === 201) item = (await res.json()) as DriveItem;
    }
    if (!item) throw new StorageError('OneDrive 上傳沒有完成');
    return { ref: item.id, name: item.name, hash: itemHash(item), size: item.size ?? total, link: item.webUrl ?? null };
  }

  async move(ref: string, folderPath: string, name: string): Promise<MoveResult> {
    const parentId = await this.folderId(folderPath);
    const finalName = await this.uniqueName(parentId, name, ref);
    const item = await this.api<DriveItem>(`/me/drive/items/${ref}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentReference: { id: parentId }, name: finalName }),
    });
    return { ref, name: item!.name, link: item!.webUrl ?? null };
  }

  async trash(ref: string): Promise<void> {
    await this.api(`/me/drive/items/${ref}`, { method: 'DELETE' });
  }

  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const id = await this.folderId(oldPath);
    const parentId = await this.folderId(newPath.split('/').slice(0, -1).join('/'));
    await this.api(`/me/drive/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentReference: { id: parentId }, name: newPath.split('/').pop() }),
    });
    await this.cache.renamePrefix(joinPath(this.row.root_folder, oldPath), joinPath(this.row.root_folder, newPath));
  }

  async download(ref: string): Promise<Response> {
    const token = await accessToken(this.ctx.env, this.row);
    const res = await fetch(`${GRAPH}/me/drive/items/${ref}/content`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw await httpError('OneDrive 下載失敗', res);
    return res;
  }
}
