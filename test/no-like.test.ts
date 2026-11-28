// D1 的 LIKE／GLOB 樣式最多 50 bytes（中文約 16 個字）：用參數組出的 LIKE 遇到長的資料夾名稱或關鍵字就會出錯
// （D1_ERROR: LIKE or GLOB pattern too complex）。路徑請用 substr(..., 1, length(?)) = ?，包含請用 instr()。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('不使用參數化的 LIKE', () => {
  it('src/worker 裡沒有 LIKE ? 或 GLOB ?', () => {
    const hits = files('src/worker').flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter(({ line }) => /\b(LIKE|GLOB)\s+\?/i.test(line)),
    );
    expect(hits.map((h) => `${h.f}:${h.i}: ${h.line.trim()}`)).toEqual([]);
  });
});
