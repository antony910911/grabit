// 檔案搬移（含復原紀錄）與資料夾改名
import type { Env } from './env';
import { getFile, log, type FileRow } from './db';
import { getStorage, providerFor } from './storage';
import { indexFile } from './search';
import { emitWebhook } from './notify';
import { joinPath } from './storage/types';

export interface MoveOptions {
  batchId: string;
  description: string;
  userEmail: string;
  /** true = 使用者手動調整（之後重新套用規則時會略過） */
  manual: boolean;
  record?: boolean;
}

export async function moveFile(env: Env, file: FileRow, folderPath: string, name: string, opts: MoveOptions): Promise<{ folderPath: string; storedName: string }> {
  if (!file.drive_file_id) throw new Error('這個檔案還沒有上傳到雲端');
  const storage = await getStorage(env, file.storage_id);
  if (!storage) throw new Error('找不到檔案所在的雲端空間');
  if (folderPath === file.folder_path && name === file.stored_name) return { folderPath, storedName: name };
  const provider = providerFor(env, storage);
  const moved = await provider.move(file.drive_file_id, folderPath, name);
  await env.DB.prepare(
    `UPDATE files SET folder_path = ?, stored_name = ?, drive_file_id = ?, drive_link = COALESCE(?, drive_link), root_ref = COALESCE(?, root_ref), unsorted = CASE WHEN ? THEN 0 ELSE unsorted END,
     manual = CASE WHEN ? THEN 1 ELSE manual END, classified_by = CASE WHEN ? THEN 'manual' ELSE classified_by END, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(folderPath, moved.name, moved.ref, moved.link, moved.root ?? null, opts.manual ? 1 : 0, opts.manual ? 1 : 0, opts.manual ? 1 : 0, file.id)
    .run();
  if (opts.record !== false) {
    await env.DB.prepare(
      'INSERT INTO operations (batch_id, file_id, action, from_folder, from_name, to_folder, to_name, description, user_email, prev_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        opts.batchId,
        file.id,
        'move',
        file.folder_path,
        file.stored_name,
        folderPath,
        moved.name,
        opts.description,
        opts.userEmail,
        JSON.stringify({ unsorted: file.unsorted, manual: file.manual, classified_by: file.classified_by, matched_rule_id: file.matched_rule_id }),
      )
      .run();
  }
  await indexFile(env, file.id);
  await emitWebhook(env, { event: 'file.moved', file: { id: file.id, name: moved.name, folder: folderPath, from: file.folder_path, link: moved.link ?? file.drive_link } });
  return { folderPath, storedName: moved.name };
}

export async function renameFolder(env: Env, storageId: number, from: string, to: string, opts: Omit<MoveOptions, 'manual'>): Promise<number> {
  const storage = await getStorage(env, storageId);
  if (!storage) throw new Error('找不到雲端空間');
  await providerFor(env, storage).renameFolder(from, to);
  // 不用 LIKE：D1 的 LIKE 樣式最多 50 bytes（中文約 16 個字），長的資料夾路徑會出錯；
  // 名稱裡的 % 和 _ 也不會被當成萬用字元。長度用 SQLite 的 length() 算，中文、emoji 都正確。
  const r = await env.DB.prepare(
    `UPDATE files SET folder_path = ? || substr(folder_path, length(?) + 1), updated_at = datetime('now')
     WHERE storage_id = ? AND (folder_path = ? OR substr(folder_path, 1, length(?)) = ?)`,
  )
    .bind(to, from, storageId, from, `${from}/`, `${from}/`)
    .run();
  // WebDAV 以路徑當識別碼，路徑變了要一起更新
  if (storage.type === 'webdav') {
    const oldPrefix = joinPath(storage.root_folder, from) + '/';
    const newPrefix = joinPath(storage.root_folder, to) + '/';
    await env.DB.prepare('UPDATE files SET drive_file_id = ? || substr(drive_file_id, length(?) + 1) WHERE storage_id = ? AND substr(drive_file_id, 1, length(?)) = ?')
      .bind(newPrefix, oldPrefix, storageId, oldPrefix, oldPrefix)
      .run();
  }
  await env.DB.prepare('UPDATE rules SET target_path = ? || substr(target_path, length(?) + 1) WHERE target_path = ? OR substr(target_path, 1, length(?)) = ?')
    .bind(to, from, from, `${from}/`, `${from}/`)
    .run();
  if (opts.record !== false) {
    await env.DB.prepare(
      "INSERT INTO operations (batch_id, file_id, action, from_folder, to_folder, description, user_email, to_name) VALUES (?, 0, 'rename_folder', ?, ?, ?, ?, ?)",
    )
      .bind(opts.batchId, from, to, opts.description, opts.userEmail, String(storageId))
      .run();
  }
  const ids = await env.DB.prepare('SELECT id FROM files WHERE storage_id = ? AND (folder_path = ? OR substr(folder_path, 1, length(?)) = ?)')
    .bind(storageId, to, `${to}/`, `${to}/`)
    .all<{ id: number }>();
  for (const { id } of ids.results) await indexFile(env, id);
  return r.meta.changes ?? 0;
}

/** 復原一批操作（反向依序執行） */
export async function undoBatch(env: Env, batchId: string, userEmail: string): Promise<{ undone: number; errors: string[] }> {
  const ops = await env.DB.prepare('SELECT * FROM operations WHERE batch_id = ? AND undone = 0 ORDER BY id DESC').bind(batchId).all<{
    id: number;
    file_id: number;
    action: string;
    from_folder: string;
    from_name: string;
    to_folder: string;
    to_name: string;
    prev_state: string | null;
  }>();
  let undone = 0;
  const errors: string[] = [];
  for (const op of ops.results) {
    try {
      if (op.action === 'rename_folder') {
        await renameFolder(env, Number(op.to_name), op.to_folder, op.from_folder, { batchId, description: '復原', userEmail, record: false });
      } else {
        const file = await getFile(env, op.file_id);
        if (!file || file.status !== 'done') throw new Error('檔案已不存在');
        await moveFile(env, file, op.from_folder, op.from_name, { batchId, description: '復原', userEmail, manual: false, record: false });
        if (op.prev_state) {
          const p = JSON.parse(op.prev_state) as { unsorted: number; manual: number; classified_by: string | null; matched_rule_id: number | null };
          await env.DB.prepare('UPDATE files SET unsorted = ?, manual = ?, classified_by = ?, matched_rule_id = ? WHERE id = ?')
            .bind(p.unsorted, p.manual, p.classified_by, p.matched_rule_id, file.id)
            .run();
        }
      }
      await env.DB.prepare('UPDATE operations SET undone = 1 WHERE id = ?').bind(op.id).run();
      undone++;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  await log(env, errors.length ? 'warn' : 'info', 'undo', `${userEmail} 復原了 ${undone} 個操作${errors.length ? `，${errors.length} 個失敗` : ''}`);
  return { undone, errors };
}
