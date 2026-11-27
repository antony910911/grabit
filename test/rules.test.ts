import { describe, expect, it } from 'vitest';
import { classify, renderFileName, renderPath, ruleMatches, sanitizeSegment, splitExt, withCounter, type Rule } from '../src/worker/rules';

const base: Omit<Rule, 'id' | 'name' | 'match_type' | 'pattern' | 'target_path'> = {
  priority: 100,
  group_id: null,
  rename_template: null,
  enabled: 1,
};
const rule = (id: number, p: Partial<Rule> & Pick<Rule, 'match_type' | 'pattern' | 'target_path'>): Rule => ({
  ...base,
  id,
  name: `r${id}`,
  ...p,
});

// 2026-11-27 06:30 UTC = 台北 14:30
const at = new Date('2026-11-27T06:30:00Z');
const ctx = (fileName: string, groupId = 'G1') => ({ fileName, groupId, groupName: '酵母研發群組', senderName: '小明', receivedAt: at });

describe('ruleMatches', () => {
  it('keywords：任一關鍵字、不分大小寫，支援中文逗號與頓號', () => {
    const r = rule(1, { match_type: 'keywords', pattern: 'GC，HPLC、farnesene', target_path: 'x' });
    expect(ruleMatches(r, ctx('20261127_Farnesene_結果.xlsx'))).toBe(true);
    expect(ruleMatches(r, ctx('hplc.pdf'))).toBe(true);
    expect(ruleMatches(r, ctx('會議紀錄.docx'))).toBe(false);
  });
  it('extension：忽略點與大小寫', () => {
    const r = rule(1, { match_type: 'extension', pattern: '.DWG, dxf', target_path: 'x' });
    expect(ruleMatches(r, ctx('圖面A.dwg'))).toBe(true);
    expect(ruleMatches(r, ctx('dwg說明.pdf'))).toBe(false);
  });
  it('regex：格式錯誤時視為不符合，不會丟出例外', () => {
    expect(ruleMatches(rule(1, { match_type: 'regex', pattern: '^INV-\\d+', target_path: 'x' }), ctx('inv-0012.pdf'))).toBe(true);
    expect(ruleMatches(rule(1, { match_type: 'regex', pattern: '([', target_path: 'x' }), ctx('a.pdf'))).toBe(false);
  });
  it('群組條件與停用', () => {
    const r = rule(1, { match_type: 'any', pattern: '', target_path: 'x', group_id: 'G2' });
    expect(ruleMatches(r, ctx('a.pdf', 'G1'))).toBe(false);
    expect(ruleMatches(r, ctx('a.pdf', 'G2'))).toBe(true);
    expect(ruleMatches({ ...r, enabled: 0 }, ctx('a.pdf', 'G2'))).toBe(false);
  });
});

describe('classify', () => {
  const rules = [
    rule(1, { priority: 20, match_type: 'keywords', pattern: 'Farnesene', target_path: 'Farnesene' }),
    rule(2, { priority: 10, match_type: 'keywords', pattern: 'GC', target_path: 'Farnesene/分析數據/{yyyy}', group_id: 'G1' }),
  ];
  it('依優先序取第一條符合的規則，並代入日期變數（台北時區）', () => {
    const r = classify(rules, ctx('20261127_Farnesene_GC分析結果.xlsx'));
    expect(r.rule?.id).toBe(2);
    expect(r.folderPath).toBe('Farnesene/分析數據/2026');
    expect(r.storedName).toBe('20261127_Farnesene_GC分析結果.xlsx');
    expect(r.unsorted).toBe(false);
  });
  it('群組不符時往下比對', () => {
    expect(classify(rules, ctx('Farnesene_GC.xlsx', 'G9')).rule?.id).toBe(1);
  });
  it('沒有規則符合 → 待分類/{group}', () => {
    const r = classify(rules, ctx('附件01.pdf'));
    expect(r.rule).toBeNull();
    expect(r.unsorted).toBe(true);
    expect(r.folderPath).toBe('待分類/酵母研發群組');
  });
  it('改名範本會自動補上副檔名', () => {
    const r = classify(
      [rule(1, { match_type: 'any', pattern: '', target_path: '{group}/{yyyy}-{MM}', rename_template: '{yyyyMMdd}_{sender}_{name}' })],
      ctx('報價單.PDF'),
    );
    expect(r.folderPath).toBe('酵母研發群組/2026-11');
    expect(r.storedName).toBe('20261127_小明_報價單.pdf');
  });
});

describe('路徑與檔名工具', () => {
  it('變數值中的 / 不會產生額外的資料夾層級', () => {
    expect(renderPath('專案/{group}', { group: 'A/B' })).toBe('專案/A_B');
  });
  it('去除空白層級與不合法字元', () => {
    expect(renderPath('/a//b:c/', {})).toBe('a/b_c');
    expect(sanitizeSegment('  報告?.pdf ')).toBe('報告_.pdf');
  });
  it('splitExt / withCounter', () => {
    expect(splitExt('a.tar.GZ')).toEqual({ name: 'a.tar', ext: 'gz' });
    expect(splitExt('.env')).toEqual({ name: '.env', ext: '' });
    expect(withCounter('報告.pdf', 2)).toBe('報告 (2).pdf');
  });
  it('沒有改名範本時保留原檔名', () => {
    expect(renderFileName(null, 'a.pdf', { ext: 'pdf' })).toBe('a.pdf');
  });
});
