// 搜尋：全文（FTS5 trigram）＋語意（Workers AI 向量，可選）＋一般條件
import type { Env } from './env';
import type { SearchArgs, SearchHit } from './ai';
import type { Scope } from './permissions';

let ftsAvailable: boolean | null = null;

export async function hasFts(env: Env): Promise<boolean> {
  if (ftsAvailable !== null) return ftsAvailable;
  try {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files_fts'").first();
    ftsAvailable = !!r;
  } catch {
    ftsAvailable = false;
  }
  return ftsAvailable;
}

const EMBED_MODEL = '@cf/baai/bge-m3';

async function embed(env: Env, texts: string[]): Promise<number[][] | null> {
  if (!env.AI || !env.VECTORIZE) return null;
  try {
    const r = (await env.AI.run(EMBED_MODEL, { text: texts })) as { data?: number[][] };
    return r.data ?? null;
  } catch {
    return null;
  }
}

/** 更新一個檔案的搜尋索引（全文＋向量） */
export async function indexFile(env: Env, fileId: number): Promise<void> {
  const f = await env.DB.prepare(
    `SELECT f.id, f.status, COALESCE(f.stored_name, f.original_name) AS name, f.original_name, f.folder_path, f.ai_summary, f.content_text, f.group_id,
       (SELECT group_concat(t.name, ' ') FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id) AS tags
     FROM files f WHERE f.id = ?`,
  )
    .bind(fileId)
    .first<{ id: number; status: string; name: string; original_name: string; folder_path: string | null; ai_summary: string | null; content_text: string | null; group_id: string; tags: string | null }>();
  if (await hasFts(env)) {
    await env.DB.prepare('DELETE FROM files_fts WHERE rowid = ?').bind(fileId).run();
    if (f && f.status === 'done') {
      await env.DB.prepare('INSERT INTO files_fts (rowid, name, folder, summary, content, tags) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(fileId, `${f.name} ${f.original_name}`, f.folder_path ?? '', f.ai_summary ?? '', (f.content_text ?? '').slice(0, 50_000), f.tags ?? '')
        .run();
    }
  }
  if (env.VECTORIZE) {
    if (!f || f.status !== 'done') {
      await env.VECTORIZE.deleteByIds([String(fileId)]).catch(() => {});
      return;
    }
    const text = [f.name, f.folder_path, f.tags, f.ai_summary, (f.content_text ?? '').slice(0, 2000)].filter(Boolean).join('\n');
    const vec = await embed(env, [text]);
    if (vec?.[0]) await env.VECTORIZE.upsert([{ id: String(fileId), values: vec[0], metadata: { group_id: f.group_id } }]).catch(() => {});
  }
}

export async function semanticIds(env: Env, query: string, topK = 30): Promise<number[]> {
  const vec = await embed(env, [query]);
  if (!vec?.[0] || !env.VECTORIZE) return [];
  const r = await env.VECTORIZE.query(vec[0], { topK });
  return r.matches.filter((m) => m.score > 0.45).map((m) => Number(m.id));
}

export interface QueryParts {
  where: string[];
  binds: unknown[];
}

/** 把關鍵字轉成 SQL 條件：三個字以上用全文索引，較短的用 instr（D1 的 LIKE 樣式最多 50 bytes，長的中文關鍵字會出錯） */
export async function keywordCondition(env: Env, q: string, parts: QueryParts, semantic: number[] = []): Promise<void> {
  const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return;
  const fts = await hasFts(env);
  const conds: string[] = [];
  const long = fts ? terms.filter((t) => [...t].length >= 3) : [];
  if (long.length) {
    conds.push('f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)');
    parts.binds.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND '));
  }
  for (const t of terms.filter((x) => !long.includes(x))) {
    conds.push(
      `(${['f.original_name', 'f.stored_name', 'f.folder_path', 'f.sender_name', 'f.ai_summary', 'f.content_text'].map((col) => `instr(lower(${col}), lower(?)) > 0`).join(' OR ')}
        OR EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND instr(lower(t.name), lower(?)) > 0))`,
    );
    parts.binds.push(t, t, t, t, t, t, t);
  }
  const keyword = conds.join(' AND ');
  if (semantic.length) {
    parts.where.push(`((${keyword}) OR f.id IN (${semantic.map(() => '?').join(',')}))`);
    parts.binds.push(...semantic);
  } else {
    parts.where.push(`(${keyword})`);
  }
}

/** 給 AI 查詢工具用的搜尋 */
export async function searchForAi(env: Env, scope: Scope, args: SearchArgs): Promise<SearchHit[]> {
  const parts: QueryParts = { where: ["f.status = 'done'", scope.sql], binds: [...scope.binds] };
  if (args.query) await keywordCondition(env, args.query, parts, await semanticIds(env, args.query));
  if (args.group) {
    parts.where.push('(instr(lower(g.name), lower(?)) > 0 OR instr(lower(g.alias), lower(?)) > 0)');
    parts.binds.push(args.group, args.group);
  }
  if (args.project) {
    parts.where.push('instr(lower(p.name), lower(?)) > 0');
    parts.binds.push(args.project);
  }
  if (args.tag) {
    parts.where.push('EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND instr(lower(t.name), lower(?)) > 0)');
    parts.binds.push(args.tag);
  }
  if (args.from) {
    parts.where.push('f.received_at >= ?');
    parts.binds.push(args.from);
  }
  if (args.to) {
    parts.where.push('f.received_at < ?');
    parts.binds.push(`${args.to}T23:59:59.999Z`);
  }
  const rows = await env.DB.prepare(
    `SELECT f.id, COALESCE(f.stored_name, f.original_name) AS name, f.folder_path AS folder, COALESCE(g.alias, g.name, f.group_id) AS grp,
       p.name AS project, f.received_at, f.ai_summary AS summary,
       (SELECT group_concat(t.name, ',') FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id) AS tags
     FROM files f LEFT JOIN groups g ON g.id = f.group_id LEFT JOIN projects p ON p.id = f.project_id
     WHERE ${parts.where.join(' AND ')} ORDER BY f.received_at DESC LIMIT ?`,
  )
    .bind(...parts.binds, Math.min(args.limit ?? 20, 50))
    .all<{ id: number; name: string; folder: string | null; grp: string; project: string | null; received_at: string; summary: string | null; tags: string | null }>();
  return rows.results.map((r) => ({ id: r.id, name: r.name, folder: r.folder, group: r.grp, project: r.project, received_at: r.received_at, summary: r.summary, tags: r.tags ? r.tags.split(',') : [] }));
}
