// 用 sql.js（瀏覽器版 SQLite）模擬 Cloudflare D1 的介面，讓正式的後端程式碼可以直接在瀏覽器執行
import initSqlJs from 'sql.js/dist/sql-asm.js';

type SqlValue = string | number | null | Uint8Array;
type Db = { prepare(sql: string): SqlStmt; exec(sql: string): { values: unknown[][] }[]; run(sql: string, p?: SqlValue[]): void; getRowsModified(): number };
type SqlStmt = { bind(p: SqlValue[]): void; step(): boolean; getAsObject(): Record<string, unknown>; free(): void };

function norm(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || v instanceof Uint8Array) return v;
  return String(v);
}

class Stmt {
  constructor(
    private db: Db,
    private sql: string,
    private params: SqlValue[] = [],
  ) {}
  bind(...p: unknown[]) {
    return new Stmt(this.db, this.sql, p.map(norm));
  }
  private rows(): Record<string, unknown>[] {
    const s = this.db.prepare(this.sql);
    try {
      s.bind(this.params);
      const out: Record<string, unknown>[] = [];
      while (s.step()) out.push(s.getAsObject());
      return out;
    } finally {
      s.free();
    }
  }
  async first<T>(col?: string): Promise<T | null> {
    const r = this.rows()[0];
    if (!r) return null;
    return (col ? r[col] : r) as T;
  }
  async all<T>() {
    return { results: this.rows() as T[], success: true, meta: {} };
  }
  async run() {
    this.rows();
    const changes = this.db.getRowsModified();
    const last = this.db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] as number;
    return { success: true, results: [], meta: { changes, last_row_id: last } };
  }
  runSync() {
    return this.run();
  }
}

export class FakeD1 {
  constructor(private db: Db) {}
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }
}

export async function createDb(migrations: string[]): Promise<FakeD1> {
  const SQL = await initSqlJs();
  const db = new SQL.Database() as unknown as Db;
  for (const m of migrations) db.exec(m);
  return new FakeD1(db);
}
