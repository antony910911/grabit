// Google Drive 專屬資料夾：分享同步與舊檔案整理
import type { Env } from '../env';
import { log } from '../db';
import { GoogleDrive, driveConfig } from './gdrive';
import { storageReady, type StorageRow } from './index';

/** 成員名單變動後，同步「分享給 GrabIt 成員」的資料夾權限 */
export async function syncDriveSharing(env: Env, onlyStorageId?: number): Promise<void> {
  const rows = (await env.DB.prepare("SELECT * FROM storages WHERE type = 'gdrive'").all<StorageRow>()).results;
  for (const row of rows) {
    if (onlyStorageId && row.id !== onlyStorageId) continue;
    const cfg = driveConfig(row);
    if (!storageReady(row) || (!onlyStorageId && cfg.share !== 'members')) continue;
    try {
      const r = await new GoogleDrive({ env, row }).applySharing();
      if (r.errors.length) await log(env, 'warn', 'storage', `「${row.name}」分享設定部分失敗：${r.errors.slice(0, 3).join('；')}`);
    } catch (e) {
      await log(env, 'warn', 'storage', `「${row.name}」分享設定失敗：${(e as Error).message}`);
    }
  }
}

/** 還不在專屬資料夾裡的檔案數 */
export async function filesOutsideRoot(env: Env, row: StorageRow): Promise<number> {
  const root = driveConfig(row).root_id;
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM files WHERE storage_id = ? AND status IN ('done', 'duplicate') AND drive_file_id IS NOT NULL AND (root_ref IS NULL OR (root_ref != ? AND root_ref != ?))",
  )
    .bind(row.id, root ?? '', `error:${root ?? ''}`)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** 把散落在舊位置的檔案搬進專屬資料夾（保留原本的子資料夾結構）；每次處理一批 */
export async function consolidate(env: Env, row: StorageRow, limit = 20): Promise<{ moved: number; remaining: number; errors: string[] }> {
  const drive = new GoogleDrive({ env, row });
  const root = await drive.rootId();
  const files = await env.DB.prepare(
    `SELECT id, drive_file_id, folder_path, stored_name, original_name FROM files
     WHERE storage_id = ? AND status IN ('done', 'duplicate') AND drive_file_id IS NOT NULL AND (root_ref IS NULL OR (root_ref != ? AND root_ref != ?)) LIMIT ?`,
  )
    .bind(row.id, root, `error:${root}`, limit)
    .all<{ id: number; drive_file_id: string; folder_path: string | null; stored_name: string | null; original_name: string }>();
  let moved = 0;
  const errors: string[] = [];
  for (const f of files.results) {
    try {
      const r = await drive.move(f.drive_file_id, f.folder_path ?? '待分類', f.stored_name ?? f.original_name);
      await env.DB.prepare('UPDATE files SET stored_name = ?, drive_link = ?, root_ref = ? WHERE id = ?').bind(r.name, r.link, root, f.id).run();
      moved++;
    } catch (e) {
      // 原檔已被刪除等情況：標記起來避免一直重試
      await env.DB.prepare('UPDATE files SET root_ref = ? WHERE id = ?').bind(`error:${root}`, f.id).run();
      errors.push(`${f.stored_name ?? f.original_name}：${(e as Error).message}`);
    }
  }
  if (moved || errors.length) await log(env, errors.length ? 'warn' : 'info', 'storage', `整理到專屬資料夾：搬移 ${moved} 個檔案${errors.length ? `，${errors.length} 個失敗` : ''}`);
  return { moved, remaining: await filesOutsideRoot(env, { ...row, config: JSON.stringify({ ...driveConfig(row), root_id: root }) }), errors };
}
