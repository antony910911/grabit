// 驗證 0008 migration 的歷史資料回填：LINE 檔案依 User ID 歸到上傳者，缺 ID 的不依名稱合併
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const initSqlJs = require('sql.js/dist/sql-asm.js') as (opts?: unknown) => Promise<{ Database: new () => { run(sql: string, params?: unknown[]): void; exec(sql: string): { columns: string[]; values: unknown[][] }[] } }>;

const migrations = readdirSync('migrations')
  .filter((f) => f.endsWith('.sql') && !f.includes('_fts'))
  .sort();

describe('0008 上傳者 migration 回填', () => {
  it('依 sender_id 建立上傳者；同名不同 ID 分開；缺 ID 的歸入未知', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    for (const f of migrations.filter((m) => m < '0008')) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
    const ins = (id: string, sender: string | null, name: string | null, source = 'line', at = '2026-11-01T00:00:00Z') =>
      db.run(`INSERT INTO files (line_message_id, group_id, sender_id, sender_name, message_type, original_name, ext, received_at, source, status) VALUES (?, 'G1', ?, ?, 'file', ?, 'pdf', ?, ?, 'done')`, [id, sender, name, `${id}.pdf`, at, source]);
    ins('m1', 'Uaaa', '陳工程師');
    ins('m2', 'Uaaa', '陳工程師（新名字）', 'line', '2026-11-20T00:00:00Z');
    ins('m3', 'Ubbb', '陳工程師');
    ins('m4', null, '陳工程師');
    ins('m5', null, '供應商', 'email');
    for (const f of migrations.filter((m) => m >= '0008')) db.exec(readFileSync(`migrations/${f}`, 'utf8'));

    const rows = db.exec('SELECT line_message_id, uploader_key FROM files ORDER BY line_message_id')[0]!.values;
    expect(rows).toEqual([
      ['m1', 'line:Uaaa'],
      ['m2', 'line:Uaaa'],
      ['m3', 'line:Ubbb'],
      ['m4', null],
      ['m5', null],
    ]);
    const ups = db.exec('SELECT key, source, display_name, alias FROM uploaders ORDER BY key')[0]!.values;
    // 顯示名稱取最近一次的名字；兩個同名的人分開
    expect(ups).toEqual([
      ['line:Uaaa', 'line', '陳工程師（新名字）', null],
      ['line:Ubbb', 'line', '陳工程師', null],
    ]);
    const idx = db.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_uploader'")[0]!.values;
    expect(idx.length).toBe(1);
  });
});
