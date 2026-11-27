import { describe, expect, it } from 'vitest';
import { generatedFileName, signBody, verifySignature } from '../src/worker/line';

describe('LINE 簽章', () => {
  it('正確簽章通過、竄改內容失敗', async () => {
    const body = '{"events":[]}';
    const sig = await signBody('secret', body);
    expect(await verifySignature('secret', body, sig)).toBe(true);
    expect(await verifySignature('secret', body + ' ', sig)).toBe(false);
    expect(await verifySignature('other', body, sig)).toBe(false);
    expect(await verifySignature('secret', body, null)).toBe(false);
  });
});

describe('圖片／影片檔名', () => {
  it('用台北時間與訊息 ID 命名', () => {
    expect(generatedFileName('image', '123', new Date('2026-11-27T06:30:05Z'))).toBe('IMG_20261127_143005_123.jpg');
    expect(generatedFileName('video', '9', new Date('2026-11-27T06:30:05Z'))).toBe('VID_20261127_143005_9.mp4');
  });
});
