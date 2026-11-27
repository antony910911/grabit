import { describe, expect, it } from 'vitest';
import { canOpenInCloud } from '../src/worker/api/files';

const user = (email: string) => ({ email, name: null, role: 'viewer' as const, allGroups: false, groups: [] });
const drive = (account: string | null, cfg: Record<string, unknown>) => ({ id: 1, type: 'gdrive' as const, name: 'g', root_folder: 'GrabIt', config: JSON.stringify(cfg), secret: '{}', account, is_default: 1 });

describe('誰可以直接在雲端開啟檔案', () => {
  it('雲端帳號本人一定可以（不分大小寫）', () => expect(canOpenInCloud(user('Owner@Gmail.com'), drive('owner@gmail.com', { share: 'private', root_id: 'R' }), 'R')).toBe(true));
  it('不分享時，其他成員不行', () => expect(canOpenInCloud(user('a@x.com'), drive('owner@gmail.com', { share: 'private', root_id: 'R' }), 'R')).toBe(false));
  it('分享給成員或知道連結的人：專屬資料夾裡的檔案可以', () => {
    expect(canOpenInCloud(user('a@x.com'), drive('owner@gmail.com', { share: 'members', root_id: 'R' }), 'R')).toBe(true);
    expect(canOpenInCloud(user('a@x.com'), drive('owner@gmail.com', { share: 'anyone', root_id: 'R' }), 'R')).toBe(true);
  });
  it('還沒搬進專屬資料夾的舊檔案不行', () => expect(canOpenInCloud(user('a@x.com'), drive('owner@gmail.com', { share: 'members', root_id: 'R' }), null)).toBe(false));
  it('分享設定失敗時不行', () => expect(canOpenInCloud(user('a@x.com'), drive('owner@gmail.com', { share: 'members', root_id: 'R', share_error: 'x' }), 'R')).toBe(false));
  it('OneDrive、Dropbox 的連結只有帳號本人打得開', () => {
    const od = { ...drive('owner@outlook.com', {}), type: 'onedrive' as const };
    expect(canOpenInCloud(user('a@x.com'), od, null)).toBe(false);
    expect(canOpenInCloud(user('owner@outlook.com'), od, null)).toBe(true);
  });
  it('沒有雲端空間就不行', () => expect(canOpenInCloud(user('a@x.com'), null, 'R')).toBe(false));
});
