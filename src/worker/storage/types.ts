// 雲端儲存空間的共同介面：所有路徑都是「相對於根目錄」，以 / 分隔
import type { Env } from '../env';

export type StorageType = 'gdrive' | 'onedrive' | 'dropbox' | 'webdav' | 'demo';

export interface StorageRow {
  id: number;
  type: StorageType;
  name: string;
  root_folder: string;
  config: string;
  secret: string;
  account: string | null;
  is_default: number;
}

export interface UploadResult {
  ref: string; // 之後搬移/刪除用的識別碼（ID 或路徑）
  name: string; // 實際存檔名稱（可能因為重名自動加編號）
  hash: string | null; // 「演算法:值」，例如 md5:xxx、sha256:xxx
  size: number | null;
  link: string | null;
}

export interface MoveResult {
  ref: string;
  name: string;
  link: string | null;
}

export type Body = ReadableStream<Uint8Array> | ArrayBuffer;

export interface StorageProvider {
  readonly row: StorageRow;
  /** 上傳到資料夾（不存在會自動建立）；遇到同名檔案自動改成「名稱 (1).ext」 */
  upload(folderPath: string, name: string, mime: string, body: Body, length: number | null): Promise<UploadResult>;
  /** 搬移並（可選）改名；目標同名時自動加編號 */
  move(ref: string, folderPath: string, name: string): Promise<MoveResult>;
  /** 移到垃圾桶／資源回收筒（可救回） */
  trash(ref: string): Promise<void>;
  /** 整個資料夾改名或搬移 */
  renameFolder(oldPath: string, newPath: string): Promise<void>;
  download(ref: string): Promise<Response>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
  }
}

export interface ProviderContext {
  env: Env;
  row: StorageRow;
}

export function joinPath(...parts: (string | null | undefined)[]): string {
  return parts
    .flatMap((p) => (p ?? '').split('/'))
    .filter(Boolean)
    .join('/');
}

export function parentAndName(path: string): { parent: string; name: string } {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop() ?? '';
  return { parent: parts.join('/'), name };
}

/** 已知長度時用 FixedLengthStream 串流（Workers），否則讀進記憶體 */
export async function sizedBody(body: Body, length: number | null): Promise<BodyInit> {
  if (body instanceof ArrayBuffer) return body;
  const FLS = (globalThis as { FixedLengthStream?: typeof FixedLengthStream }).FixedLengthStream;
  if (length != null && FLS) {
    const fixed = new FLS(length);
    void body.pipeTo(fixed.writable).catch(() => {});
    return fixed.readable;
  }
  return new Response(body).arrayBuffer();
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function httpError(prefix: string, res: Response): Promise<StorageError> {
  const text = (await res.text().catch(() => '')).slice(0, 300);
  return new StorageError(`${prefix} ${res.status}：${text}`, res.status === 401 || res.status === 403);
}
