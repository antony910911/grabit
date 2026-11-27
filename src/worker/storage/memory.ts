// 展示版用的記憶體雲端空間（不會連到任何外部服務）
import { withCounter } from '../rules';
import { joinPath, sha256Hex, type Body, type MoveResult, type ProviderContext, type StorageProvider, type UploadResult } from './types';

interface MemFile {
  id: string;
  folder: string;
  name: string;
  mime: string;
  data: ArrayBuffer;
  trashed: boolean;
}

const stores = new Map<number, Map<string, MemFile>>();
let seq = 0;

export function memoryFiles(storageId: number): MemFile[] {
  return [...(stores.get(storageId)?.values() ?? [])];
}

export class MemoryStorage implements StorageProvider {
  private files: Map<string, MemFile>;
  constructor(private ctx: ProviderContext) {
    if (!stores.has(ctx.row.id)) stores.set(ctx.row.id, new Map());
    this.files = stores.get(ctx.row.id)!;
  }
  get row() {
    return this.ctx.row;
  }

  private unique(folder: string, name: string, self?: string): string {
    let candidate = name;
    for (let n = 1; ; n++) {
      const clash = [...this.files.values()].some((f) => !f.trashed && f.folder === folder && f.name === candidate && f.id !== self);
      if (!clash) return candidate;
      candidate = withCounter(name, n);
    }
  }

  async upload(folderPath: string, name: string, mime: string, body: Body, length: number | null): Promise<UploadResult> {
    const data = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    const folder = joinPath(this.row.root_folder, folderPath);
    const finalName = this.unique(folder, name);
    const id = `mem${++seq}`;
    this.files.set(id, { id, folder, name: finalName, mime, data, trashed: false });
    return { ref: id, name: finalName, hash: `sha256:${await sha256Hex(data)}`, size: length ?? data.byteLength, link: null };
  }

  async move(ref: string, folderPath: string, name: string): Promise<MoveResult> {
    const f = this.files.get(ref);
    if (!f) throw new Error('找不到檔案');
    f.folder = joinPath(this.row.root_folder, folderPath);
    f.name = this.unique(f.folder, name, ref);
    return { ref, name: f.name, link: null };
  }

  async trash(ref: string): Promise<void> {
    const f = this.files.get(ref);
    if (f) f.trashed = true;
  }

  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const from = joinPath(this.row.root_folder, oldPath);
    const to = joinPath(this.row.root_folder, newPath);
    for (const f of this.files.values()) {
      if (f.folder === from || f.folder.startsWith(`${from}/`)) f.folder = to + f.folder.slice(from.length);
    }
  }

  async download(ref: string): Promise<Response> {
    const f = this.files.get(ref);
    if (!f) return new Response('not found', { status: 404 });
    return new Response(f.data, { headers: { 'Content-Type': f.mime } });
  }
}
