import type { Env } from '../env';
import { GoogleDrive } from './gdrive';
import { OneDrive } from './onedrive';
import { Dropbox } from './dropbox';
import { WebDav } from './webdav';
import { MemoryStorage } from './memory';
import { StorageError, type StorageProvider, type StorageRow, type StorageType } from './types';

export * from './types';

export const STORAGE_LABEL: Record<StorageType, string> = {
  gdrive: 'Google Drive',
  onedrive: 'OneDrive / SharePoint',
  dropbox: 'Dropbox',
  webdav: 'NAS / WebDAV',
  demo: '展示用空間',
};

export function providerFor(env: Env, row: StorageRow): StorageProvider {
  const ctx = { env, row };
  switch (row.type) {
    case 'gdrive':
      return new GoogleDrive(ctx);
    case 'onedrive':
      return new OneDrive(ctx);
    case 'dropbox':
      return new Dropbox(ctx);
    case 'webdav':
      return new WebDav(ctx);
    case 'demo':
      return new MemoryStorage(ctx);
    default:
      throw new StorageError(`不支援的空間類型：${row.type}`, true);
  }
}

export async function getStorage(env: Env, id: number | null | undefined): Promise<StorageRow | null> {
  if (id) {
    const row = await env.DB.prepare('SELECT * FROM storages WHERE id = ?').bind(id).first<StorageRow>();
    if (row) return row;
  }
  return env.DB.prepare('SELECT * FROM storages ORDER BY is_default DESC, id LIMIT 1').first<StorageRow>();
}

export async function openStorage(env: Env, id: number | null | undefined): Promise<StorageProvider> {
  const row = await getStorage(env, id);
  if (!row) throw new StorageError('還沒有設定雲端空間，請到「雲端設定」新增', true);
  return providerFor(env, row);
}

/** 檢查空間是否已完成授權（不連網） */
export function storageReady(row: StorageRow): boolean {
  if (row.type === 'demo') return true;
  try {
    const s = JSON.parse(row.secret || '{}') as { refresh_token?: string; password?: string };
    return row.type === 'webdav' ? !!JSON.parse(row.config || '{}').url : !!s.refresh_token;
  } catch {
    return false;
  }
}
