import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { versionInfo } from '../src/worker/versions';
import { candidateTokens, generalizePath, pickKeyword } from '../src/worker/learn';
import { extractContent } from '../src/worker/extract';
import { groupAccepts, fileCategory } from '../src/worker/db';
import { headerJson } from '../src/worker/storage/dropbox';

describe('版本辨識', () => {
  it('v1／v2／Final 同一組，Final 最新', () => {
    const a = versionInfo('期末報告_v1.docx');
    const b = versionInfo('期末報告_v2.docx');
    const c = versionInfo('期末報告_Final.docx');
    expect(a.key).toBe(b.key);
    expect(b.key).toBe(c.key);
    expect(a.label).toBe('v1');
    expect(c.label).toBe('Final');
    expect(c.rank).toBeGreaterThan(b.rank);
    expect(b.rank).toBeGreaterThan(a.rank);
  });
  it('忽略日期前綴、支援中文版本字樣與副本編號', () => {
    expect(versionInfo('20261127_FY115報告_v2.pdf').key).toBe(versionInfo('20261130_FY115報告_v3.pdf').key);
    expect(versionInfo('計畫書修正版2.docx').label).toBe('修正版2');
    expect(versionInfo('計畫書 (1).docx').key).toBe(versionInfo('計畫書.docx').key);
    expect(versionInfo('報告_v3_final.docx').label).toBe('v3 Final');
  });
  it('副檔名不同不算同一份', () => {
    expect(versionInfo('報告.pdf').key).not.toBe(versionInfo('報告.docx').key);
  });
});

describe('規則學習', () => {
  it('切出關鍵字（中英交界也切開，去掉日期與版本）', () => {
    expect(candidateTokens('20261127_Farnesene_GC分析_v2.xlsx')).toEqual(['Farnesene', 'GC', '分析']);
  });
  it('選出只出現在目標資料夾的關鍵字', () => {
    const files = [
      { id: 1, original_name: 'BMP實驗數據_A.xlsx', folder_path: '沼氣研發/操作數據', manual: 1 },
      { id: 2, original_name: 'BMP實驗數據_B.xlsx', folder_path: '沼氣研發/操作數據', manual: 1 },
      { id: 3, original_name: '實驗數據總表.xlsx', folder_path: '其他', manual: 0 },
    ];
    const pick = pickKeyword('BMP實驗數據_A.xlsx', '沼氣研發/操作數據', files);
    expect(pick?.pattern).toBe('BMP');
    expect(pick?.support).toBe(2);
  });
  it('路徑中的年份換成變數', () => {
    expect(generalizePath('Farnesene/分析數據/2026', new Date('2026-05-01'))).toBe('Farnesene/分析數據/{yyyy}');
    expect(generalizePath('會議紀錄/2026-05', new Date('2026-05-01'))).toBe('會議紀錄/{yyyy}-{MM}');
  });
});

describe('文字擷取', () => {
  it('docx', () => {
    const zip = zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>GC 分析 &amp; 結論</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>') });
    const r = extractContent('報告.docx', '', zip.buffer as ArrayBuffer);
    expect(r.kind).toBe('text');
    expect(r.text).toContain('GC 分析 & 結論');
    expect(r.text).toContain('第二段');
  });
  it('pdf 與圖片交給 AI 直接讀', () => {
    expect(extractContent('a.pdf', 'application/pdf', new ArrayBuffer(4)).kind).toBe('pdf');
    expect(extractContent('a.jpg', 'image/jpeg', new ArrayBuffer(4)).mediaType).toBe('image/jpeg');
  });
  it('壞掉的 Office 檔不會丟例外', () => {
    expect(extractContent('壞.docx', '', new ArrayBuffer(10)).kind).toBe('none');
  });
});

describe('群組檔案類型設定', () => {
  const g = { backup_images: 0, backup_videos: 1, file_types: JSON.stringify(['pdf', 'spreadsheet']) } as never;
  it('依類別過濾', () => {
    expect(fileCategory('xlsx', 'file')).toBe('spreadsheet');
    expect(groupAccepts(g, 'jpg', 'image')).toBe(false);
    expect(groupAccepts(g, 'pdf', 'file')).toBe(true);
    expect(groupAccepts(g, 'docx', 'file')).toBe(false);
    expect(groupAccepts(g, 'mp4', 'video')).toBe(true);
  });
});

describe('Dropbox 標頭', () => {
  it('中文轉成 ASCII 跳脫', () => {
    expect(headerJson({ path: '/報告.pdf' })).toBe('{"path":"/\\u5831\\u544a.pdf"}');
  });
});
