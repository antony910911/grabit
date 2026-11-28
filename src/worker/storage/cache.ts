import type { Env } from '../env';

/** 資料夾路徑 → 雲端 ID 的快取，避免每次都查雲端 */
export class FolderCache {
  constructor(
    private env: Env,
    private storageId: number,
  ) {}

  async get(path: string): Promise<string | null> {
    const r = await this.env.DB.prepare('SELECT folder_id FROM storage_folders WHERE storage_id = ? AND path = ?')
      .bind(this.storageId, path)
      .first<{ folder_id: string }>();
    return r?.folder_id ?? null;
  }

  async set(path: string, id: string): Promise<void> {
    await this.env.DB.prepare('INSERT OR REPLACE INTO storage_folders (storage_id, path, folder_id) VALUES (?, ?, ?)')
      .bind(this.storageId, path, id)
      .run();
  }

  /** 同時有多個處理程序建立同一個資料夾時，只保留第一個寫入的 ID，回傳最後採用的 ID */
  async claim(path: string, id: string): Promise<string> {
    await this.env.DB.prepare('INSERT OR IGNORE INTO storage_folders (storage_id, path, folder_id) VALUES (?, ?, ?)').bind(this.storageId, path, id).run();
    return (await this.get(path)) ?? id;
  }

  async renamePrefix(oldPath: string, newPath: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE OR REPLACE storage_folders SET path = ? || substr(path, length(?) + 1) WHERE storage_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?)`,
    )
      .bind(newPath, oldPath, this.storageId, oldPath, `${oldPath}/`, `${oldPath}/`)
      .run();
  }

  async clear(): Promise<void> {
    await this.env.DB.prepare('DELETE FROM storage_folders WHERE storage_id = ?').bind(this.storageId).run();
  }
}
