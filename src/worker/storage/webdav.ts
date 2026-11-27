// NAS / 私有雲（WebDAV：Synology、QNAP、Nextcloud 都支援）
import { withCounter } from '../rules';
import { parseSecret } from './oauth';
import { httpError, joinPath, parentAndName, sha256Hex, sizedBody, StorageError, type Body, type MoveResult, type ProviderContext, type StorageProvider, type UploadResult } from './types';

interface WebdavConfig {
  url: string; // 例：https://nas.example.com:5006/home
  username: string;
}

export const TRASH_FOLDER = '.grabit-trash';

export class WebDav implements StorageProvider {
  private base: string;
  private auth: string;
  constructor(private ctx: ProviderContext) {
    const cfg = JSON.parse(ctx.row.config || '{}') as WebdavConfig;
    if (!cfg.url) throw new StorageError('WebDAV 尚未設定網址', true);
    this.base = cfg.url.replace(/\/+$/, '');
    const pwd = parseSecret(ctx.row).password ?? '';
    this.auth = 'Basic ' + btoa(unescape(encodeURIComponent(`${cfg.username}:${pwd}`)));
  }
  get row() {
    return this.ctx.row;
  }

  private url(relPath: string): string {
    return `${this.base}/${relPath.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  }

  private req(method: string, relPath: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.url(relPath), { ...init, method, headers: { Authorization: this.auth, ...(init.headers ?? {}) } });
  }

  private async exists(relPath: string): Promise<boolean> {
    const res = await this.req('PROPFIND', relPath, { headers: { Depth: '0' } });
    if (res.status === 404) return false;
    if (res.status === 401 || res.status === 403) throw await httpError('WebDAV', res);
    return res.ok || res.status === 207;
  }

  private async ensureDir(relPath: string): Promise<void> {
    let current = '';
    for (const seg of relPath.split('/').filter(Boolean)) {
      current = current ? `${current}/${seg}` : seg;
      const res = await this.req('MKCOL', current);
      // 201 建立成功、405 已存在
      if (!(res.ok || res.status === 405 || res.status === 301)) throw await httpError('WebDAV 建立資料夾失敗', res);
    }
  }

  private async uniquePath(dir: string, name: string, self?: string): Promise<{ path: string; name: string }> {
    let candidate = name;
    for (let n = 1; n < 200; n++) {
      const p = joinPath(dir, candidate);
      if (p === self || !(await this.exists(p))) return { path: p, name: candidate };
      candidate = withCounter(name, n);
    }
    throw new StorageError('同名檔案太多');
  }

  async upload(folderPath: string, name: string, mime: string, body: Body, length: number | null): Promise<UploadResult> {
    const dir = joinPath(this.row.root_folder, folderPath);
    await this.ensureDir(dir);
    const target = await this.uniquePath(dir, name);
    let hash: string | null = null;
    let payload: BodyInit;
    if (body instanceof ArrayBuffer) {
      hash = `sha256:${await sha256Hex(body)}`;
      payload = body;
    } else {
      const Digest = (crypto as unknown as { DigestStream?: new (alg: string) => WritableStream & { digest: Promise<ArrayBuffer> } }).DigestStream;
      if (Digest) {
        const [a, b] = body.tee();
        const ds = new Digest('SHA-256');
        void b.pipeTo(ds).catch(() => {});
        payload = await sizedBody(a, length);
        ds.digest.then((d) => (hash = `sha256:${[...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')}`)).catch(() => {});
        const res = await this.req('PUT', target.path, { headers: { 'Content-Type': mime }, body: payload });
        if (!res.ok) throw await httpError('WebDAV 上傳失敗', res);
        await ds.digest.catch(() => null);
        return { ref: target.path, name: target.name, hash, size: length, link: this.url(target.path) };
      }
      payload = await sizedBody(body, length);
    }
    const res = await this.req('PUT', target.path, { headers: { 'Content-Type': mime }, body: payload });
    if (!res.ok) throw await httpError('WebDAV 上傳失敗', res);
    return { ref: target.path, name: target.name, hash, size: length, link: this.url(target.path) };
  }

  private async moveTo(from: string, to: string): Promise<void> {
    const res = await this.req('MOVE', from, { headers: { Destination: this.url(to), Overwrite: 'F' } });
    if (!res.ok) throw await httpError('WebDAV 搬移失敗', res);
  }

  async move(ref: string, folderPath: string, name: string): Promise<MoveResult> {
    const dir = joinPath(this.row.root_folder, folderPath);
    await this.ensureDir(dir);
    const target = await this.uniquePath(dir, name, ref);
    if (target.path !== ref) await this.moveTo(ref, target.path);
    return { ref: target.path, name: target.name, link: this.url(target.path) };
  }

  async trash(ref: string): Promise<void> {
    // WebDAV 沒有垃圾桶：搬到根目錄下的 .grabit-trash，需要時可以手動救回
    const trashDir = joinPath(this.row.root_folder, TRASH_FOLDER);
    await this.ensureDir(trashDir);
    const { name } = parentAndName(ref);
    const target = await this.uniquePath(trashDir, name);
    await this.moveTo(ref, target.path);
  }

  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const to = joinPath(this.row.root_folder, newPath);
    await this.ensureDir(parentAndName(to).parent);
    await this.moveTo(joinPath(this.row.root_folder, oldPath), to);
  }

  async download(ref: string): Promise<Response> {
    const res = await this.req('GET', ref);
    if (!res.ok) throw await httpError('WebDAV 下載失敗', res);
    return res;
  }
}
