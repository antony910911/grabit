// 管理介面 API
import { Hono } from 'hono';
import type { Env } from './env';
import type { AuthVars } from './auth';
import { getFile, getGroup, getSetting, groupDisplayName, listRules, log, setSetting, type FileRow } from './db';
import { classifyFile, enqueueFile } from './processor';
import { classify, renderPath, sanitizeSegment, type MatchType, type Rule } from './rules';
import { DEFAULT_ROOT, disconnect, Drive } from './drive';

type App = { Bindings: Env; Variables: AuthVars };
export const api = new Hono<App>();

const MATCH_TYPES: MatchType[] = ['keywords', 'regex', 'extension', 'any'];

class BadRequest extends Error {}

api.onError((err, c) => {
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: err.message || '伺服器錯誤' }, 500);
});

async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new BadRequest('JSON 格式錯誤');
  }
}

/** 使用者輸入的資料夾路徑：去掉不合法字元與空白層級 */
function cleanFolderPath(p: string): string {
  const out = p
    .split('/')
    .map((s) => sanitizeSegment(s))
    .filter((s) => s && s !== '_' && s !== '..')
    .join('/');
  if (!out) throw new BadRequest('資料夾路徑不能是空的');
  return out;
}

// ---------- 帳號 / 總覽 ----------

api.get('/me', (c) => c.json({ email: c.get('userEmail') }));

api.get('/stats', async (c) => {
  const db = c.env.DB;
  const counts = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS archived,
        SUM(CASE WHEN status = 'done' AND unsorted = 1 THEN 1 ELSE 0 END) AS unsorted,
        SUM(CASE WHEN status = 'done' AND unsorted = 0 THEN 1 ELSE 0 END) AS sorted,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END) AS duplicates,
        SUM(CASE WHEN status = 'done' THEN COALESCE(size, 0) ELSE 0 END) AS bytes
       FROM files`,
    )
    .first<Record<string, number | null>>();
  const groups = await db.prepare('SELECT COUNT(*) AS n FROM groups WHERE joined = 1 AND enabled = 1').first<{ n: number }>();
  const recent = await db
    .prepare(
      `SELECT f.id, f.original_name, f.stored_name, f.folder_path, f.status, f.unsorted, f.received_at,
              COALESCE(g.alias, g.name, f.group_id) AS group_name
       FROM files f LEFT JOIN groups g ON g.id = f.group_id
       WHERE f.status != 'deleted' ORDER BY f.received_at DESC LIMIT 6`,
    )
    .all();
  const archived = counts?.archived ?? 0;
  return c.json({
    archived,
    unsorted: counts?.unsorted ?? 0,
    failed: counts?.failed ?? 0,
    pending: counts?.pending ?? 0,
    duplicates: counts?.duplicates ?? 0,
    bytes: counts?.bytes ?? 0,
    groups: groups?.n ?? 0,
    autoRate: archived ? (counts?.sorted ?? 0) / archived : null,
    driveConnected: !!(await getSetting(c.env, 'google_refresh_token')),
    recent: recent.results,
  });
});

// ---------- 檔案 ----------

api.get('/files', async (c) => {
  const { status = 'all', q = '', group = '', folder = '' } = c.req.query();
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const where: string[] = [];
  const binds: unknown[] = [];
  switch (status) {
    case 'unsorted':
      where.push("f.status = 'done' AND f.unsorted = 1");
      break;
    case 'sorted':
      where.push("f.status = 'done' AND f.unsorted = 0");
      break;
    case 'failed':
      where.push("f.status = 'failed'");
      break;
    case 'pending':
      where.push("f.status IN ('pending', 'processing')");
      break;
    case 'duplicate':
      where.push("f.status = 'duplicate'");
      break;
    default:
      where.push("f.status != 'deleted'");
  }
  if (q.trim()) {
    where.push('(f.original_name LIKE ? OR f.stored_name LIKE ? OR f.folder_path LIKE ? OR f.sender_name LIKE ?)');
    const like = `%${q.trim()}%`;
    binds.push(like, like, like, like);
  }
  if (group) {
    where.push('f.group_id = ?');
    binds.push(group);
  }
  if (folder) {
    where.push('(f.folder_path = ? OR f.folder_path LIKE ?)');
    binds.push(folder, `${folder}/%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await c.env.DB.prepare(
    `SELECT f.*, COALESCE(g.alias, g.name, f.group_id) AS group_name, r.name AS rule_name
     FROM files f
     LEFT JOIN groups g ON g.id = f.group_id
     LEFT JOIN rules r ON r.id = f.matched_rule_id
     ${whereSql} ORDER BY f.received_at DESC, f.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit + 1, offset)
    .all();
  const items = rows.results.slice(0, limit);
  return c.json({ items, hasMore: rows.results.length > limit });
});

api.get('/files/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT f.*, COALESCE(g.alias, g.name, f.group_id) AS group_name, r.name AS rule_name
     FROM files f LEFT JOIN groups g ON g.id = f.group_id LEFT JOIN rules r ON r.id = f.matched_rule_id
     WHERE f.id = ?`,
  )
    .bind(Number(c.req.param('id')))
    .first();
  if (!row) return c.json({ error: '找不到檔案' }, 404);
  return c.json(row);
});

api.get('/folders', async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT folder_path AS path, COUNT(*) AS count FROM files WHERE status = 'done' AND folder_path IS NOT NULL GROUP BY folder_path ORDER BY folder_path",
  ).all<{ path: string; count: number }>();
  return c.json({ items: r.results });
});

async function moveAndRename(env: Env, file: FileRow, folderPath: string, storedName: string): Promise<{ folderPath: string; storedName: string }> {
  if (!file.drive_file_id) throw new BadRequest('這個檔案還沒有上傳到雲端');
  const drive = await Drive.connect(env);
  const folderChanged = folderPath !== file.folder_path;
  const nameChanged = storedName !== file.stored_name;
  let finalName = storedName;
  if (folderChanged || nameChanged) {
    const folderId = await drive.ensureFolder(folderPath);
    finalName = await drive.uniqueName(folderId, storedName);
    if (folderChanged) await drive.move(file.drive_file_id, folderId);
    if (finalName !== file.stored_name) await drive.rename(file.drive_file_id, finalName);
  }
  return { folderPath, storedName: finalName };
}

api.patch('/files/:id', async (c) => {
  const file = await getFile(c.env, Number(c.req.param('id')));
  if (!file || file.status !== 'done') return c.json({ error: '找不到檔案，或檔案尚未歸檔完成' }, 404);
  const body = await readJson<{ folderPath?: string; storedName?: string }>(c.req.raw);
  const folderPath = body.folderPath != null ? cleanFolderPath(body.folderPath) : file.folder_path!;
  const storedName = body.storedName != null ? sanitizeSegment(body.storedName) : file.stored_name!;
  if (!storedName) throw new BadRequest('檔名不能是空的');
  const r = await moveAndRename(c.env, file, folderPath, storedName);
  await c.env.DB.prepare(
    "UPDATE files SET folder_path = ?, stored_name = ?, unsorted = 0, manual = 1, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(r.folderPath, r.storedName, file.id)
    .run();
  await log(c.env, 'info', 'manual', `${c.get('userEmail')} 將「${file.stored_name}」移到 ${r.folderPath}/${r.storedName}`, file.id);
  return c.json({ ok: true, ...r });
});

api.delete('/files/:id', async (c) => {
  const file = await getFile(c.env, Number(c.req.param('id')));
  if (!file) return c.json({ error: '找不到檔案' }, 404);
  if (file.drive_file_id && file.status === 'done') {
    const drive = await Drive.connect(c.env);
    await drive.trash(file.drive_file_id);
  }
  await c.env.DB.prepare("UPDATE files SET status = 'deleted', updated_at = datetime('now') WHERE id = ?").bind(file.id).run();
  await log(c.env, 'info', 'delete', `${c.get('userEmail')} 刪除「${file.stored_name ?? file.original_name}」（已移到 Google Drive 垃圾桶）`, file.id);
  return c.json({ ok: true });
});

api.post('/files/:id/retry', async (c) => {
  const file = await getFile(c.env, Number(c.req.param('id')));
  if (!file) return c.json({ error: '找不到檔案' }, 404);
  if (file.status !== 'failed' && file.status !== 'pending') throw new BadRequest('只有失敗或等待中的檔案可以重試');
  await c.env.DB.prepare("UPDATE files SET status = 'pending', attempts = 0, error = NULL, updated_at = datetime('now') WHERE id = ?")
    .bind(file.id)
    .run();
  await enqueueFile(c.env, c.executionCtx, file.id);
  return c.json({ ok: true });
});

/** 重新套用規則：先 dryRun 預覽，確認後再實際搬移 */
api.post('/files/reapply', async (c) => {
  const body = await readJson<{ scope?: 'unsorted' | 'all'; dryRun?: boolean }>(c.req.raw);
  const scope = body.scope === 'all' ? 'all' : 'unsorted';
  const dryRun = body.dryRun !== false;
  const files = await c.env.DB.prepare(
    `SELECT * FROM files WHERE status = 'done' AND manual = 0 ${scope === 'unsorted' ? 'AND unsorted = 1' : ''}
     ORDER BY received_at DESC LIMIT 300`,
  ).all<FileRow>();
  const rules = await listRules(c.env);
  const groupCache = new Map<string, string>();
  const changes: { id: number; name: string; from: string; to: string; rule: string | null; unsorted: boolean }[] = [];
  for (const f of files.results) {
    if (!groupCache.has(f.group_id)) groupCache.set(f.group_id, groupDisplayName(await getGroup(c.env, f.group_id), f.group_id));
    const r = classifyFile(c.env, f, groupCache.get(f.group_id)!, rules);
    if (r.folderPath !== f.folder_path) {
      changes.push({ id: f.id, name: f.stored_name ?? f.original_name, from: f.folder_path ?? '', to: r.folderPath, rule: r.rule?.name ?? null, unsorted: r.unsorted });
    }
  }
  if (dryRun) return c.json({ dryRun: true, changes });

  let moved = 0;
  const errors: string[] = [];
  for (const ch of changes) {
    const f = files.results.find((x) => x.id === ch.id)!;
    try {
      const r = await moveAndRename(c.env, f, ch.to, f.stored_name!);
      const rule = classifyFile(c.env, f, groupCache.get(f.group_id)!, rules).rule;
      await c.env.DB.prepare(
        "UPDATE files SET folder_path = ?, stored_name = ?, unsorted = ?, matched_rule_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
        .bind(r.folderPath, r.storedName, ch.unsorted ? 1 : 0, rule?.id ?? null, f.id)
        .run();
      moved++;
    } catch (e) {
      errors.push(`${ch.name}：${(e as Error).message}`);
    }
  }
  await log(c.env, errors.length ? 'warn' : 'info', 'reapply', `${c.get('userEmail')} 重新套用規則：搬移 ${moved} 個檔案${errors.length ? `，${errors.length} 個失敗` : ''}`);
  return c.json({ dryRun: false, moved, errors, changes });
});

// ---------- 規則 ----------

interface RuleInput {
  name?: string;
  priority?: number;
  match_type?: MatchType;
  pattern?: string;
  group_id?: string | null;
  target_path?: string;
  rename_template?: string | null;
  enabled?: boolean;
}

function validateRule(input: RuleInput): Required<Omit<RuleInput, 'enabled'>> & { enabled: number } {
  const name = (input.name ?? '').trim();
  if (!name) throw new BadRequest('請輸入規則名稱');
  const match_type = input.match_type ?? 'keywords';
  if (!MATCH_TYPES.includes(match_type)) throw new BadRequest('比對方式不正確');
  const pattern = (input.pattern ?? '').trim();
  if (match_type !== 'any' && !pattern) throw new BadRequest('請輸入比對內容');
  if (match_type === 'regex') {
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw new BadRequest('正規表示式格式錯誤');
    }
  }
  const target_path = (input.target_path ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!target_path) throw new BadRequest('請輸入目標資料夾');
  return {
    name,
    priority: Number.isFinite(input.priority) ? Number(input.priority) : 100,
    match_type,
    pattern,
    group_id: input.group_id || null,
    target_path,
    rename_template: input.rename_template?.trim() || null,
    enabled: input.enabled === false ? 0 : 1,
  };
}

api.get('/rules', async (c) => c.json({ items: await listRules(c.env) }));

api.post('/rules', async (c) => {
  const r = validateRule(await readJson<RuleInput>(c.req.raw));
  const res = await c.env.DB.prepare(
    'INSERT INTO rules (name, priority, match_type, pattern, group_id, target_path, rename_template, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(r.name, r.priority, r.match_type, r.pattern, r.group_id, r.target_path, r.rename_template, r.enabled)
    .run();
  await log(c.env, 'info', 'rule', `${c.get('userEmail')} 新增規則「${r.name}」`);
  return c.json({ id: res.meta.last_row_id });
});

api.put('/rules/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const r = validateRule(await readJson<RuleInput>(c.req.raw));
  const res = await c.env.DB.prepare(
    `UPDATE rules SET name = ?, priority = ?, match_type = ?, pattern = ?, group_id = ?, target_path = ?,
     rename_template = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(r.name, r.priority, r.match_type, r.pattern, r.group_id, r.target_path, r.rename_template, r.enabled, id)
    .run();
  if (!res.meta.changes) return c.json({ error: '找不到規則' }, 404);
  await log(c.env, 'info', 'rule', `${c.get('userEmail')} 修改規則「${r.name}」`);
  return c.json({ ok: true });
});

api.delete('/rules/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(id).run();
  await c.env.DB.prepare('UPDATE files SET matched_rule_id = NULL WHERE matched_rule_id = ?').bind(id).run();
  await log(c.env, 'info', 'rule', `${c.get('userEmail')} 刪除規則 #${id}`);
  return c.json({ ok: true });
});

/** 一次更新多條規則的順序：body = { ids: [依新順序排列的規則 id] } */
api.post('/rules/reorder', async (c) => {
  const { ids } = await readJson<{ ids: number[] }>(c.req.raw);
  if (!Array.isArray(ids)) throw new BadRequest('ids 必須是陣列');
  await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare('UPDATE rules SET priority = ? WHERE id = ?').bind((i + 1) * 10, id)));
  return c.json({ ok: true });
});

/** 規則模擬器：輸入檔名看會被分到哪裡，可帶入尚未儲存的規則 */
api.post('/rules/test', async (c) => {
  const body = await readJson<{ fileName: string; groupId?: string; draft?: RuleInput & { id?: number } }>(c.req.raw);
  if (!body.fileName?.trim()) throw new BadRequest('請輸入檔名');
  let rules: Rule[] = await listRules(c.env);
  if (body.draft) {
    const d = validateRule(body.draft);
    const draft: Rule = { id: body.draft.id ?? -1, ...d };
    rules = [...rules.filter((r) => r.id !== draft.id), draft];
  }
  const groupId = body.groupId || '';
  const group = groupId ? await getGroup(c.env, groupId) : null;
  const result = classify(rules, {
    fileName: body.fileName.trim(),
    groupId,
    groupName: group ? groupDisplayName(group, groupId) : '範例群組',
    senderName: '範例成員',
    receivedAt: new Date(),
    timeZone: c.env.TIMEZONE || 'Asia/Taipei',
  });
  const root = (await getSetting(c.env, 'root_folder')) || DEFAULT_ROOT;
  return c.json({
    rule: result.rule ? { id: result.rule.id, name: result.rule.name } : null,
    folderPath: result.folderPath,
    storedName: result.storedName,
    unsorted: result.unsorted,
    fullPath: `${root}/${result.folderPath}/${result.storedName}`,
  });
});

/** 預覽路徑範本（規則編輯時即時顯示） */
api.post('/rules/preview-path', async (c) => {
  const { template } = await readJson<{ template: string }>(c.req.raw);
  const now = new Date();
  const vars: Record<string, string> = { group: '範例群組', sender: '範例成員', name: '報告', ext: 'pdf', filename: '報告.pdf' };
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: c.env.TIMEZONE || 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  vars.yyyy = d.find((p) => p.type === 'year')!.value;
  vars.MM = d.find((p) => p.type === 'month')!.value;
  vars.dd = d.find((p) => p.type === 'day')!.value;
  return c.json({ path: renderPath(template ?? '', vars) });
});

// ---------- 群組 ----------

api.get('/groups', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT g.*,
       (SELECT COUNT(*) FROM files f WHERE f.group_id = g.id AND f.status = 'done') AS file_count,
       (SELECT MAX(received_at) FROM files f WHERE f.group_id = g.id) AS last_file_at
     FROM groups g ORDER BY g.joined DESC, g.created_at DESC`,
  ).all();
  return c.json({ items: r.results });
});

api.patch('/groups/:id', async (c) => {
  const id = c.req.param('id');
  const body = await readJson<{ alias?: string | null; enabled?: boolean }>(c.req.raw);
  const g = await getGroup(c.env, id);
  if (!g) return c.json({ error: '找不到群組' }, 404);
  const alias = body.alias !== undefined ? body.alias?.trim() || null : g.alias;
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : g.enabled;
  await c.env.DB.prepare("UPDATE groups SET alias = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(alias, enabled, id)
    .run();
  return c.json({ ok: true });
});

// ---------- 設定 ----------

api.get('/settings', async (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    driveConnected: !!(await getSetting(c.env, 'google_refresh_token')),
    googleEmail: await getSetting(c.env, 'google_email'),
    rootFolder: (await getSetting(c.env, 'root_folder')) || DEFAULT_ROOT,
    lineConfigured: !!(c.env.LINE_CHANNEL_SECRET && c.env.LINE_CHANNEL_ACCESS_TOKEN),
    googleConfigured: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    queueEnabled: !!c.env.FILE_QUEUE,
    webhookUrl: `${origin}/webhook`,
    oauthRedirectUri: `${origin}/oauth/google/callback`,
    timezone: c.env.TIMEZONE || 'Asia/Taipei',
  });
});

api.put('/settings', async (c) => {
  const body = await readJson<{ rootFolder?: string }>(c.req.raw);
  if (body.rootFolder !== undefined) {
    const name = sanitizeSegment(body.rootFolder);
    if (!name || name === '_') throw new BadRequest('根目錄名稱不能是空的');
    await setSetting(c.env, 'root_folder', name);
    // 根目錄換了，子資料夾快取全部失效
    await c.env.DB.prepare('DELETE FROM drive_folders').run();
    await log(c.env, 'info', 'settings', `${c.get('userEmail')} 將根目錄改為「${name}」（之後的新檔案才會放到新位置）`);
  }
  return c.json({ ok: true });
});

api.post('/drive/disconnect', async (c) => {
  await disconnect(c.env);
  await log(c.env, 'warn', 'settings', `${c.get('userEmail')} 中斷 Google Drive 連線`);
  return c.json({ ok: true });
});

// ---------- 紀錄 ----------

api.get('/logs', async (c) => {
  const level = c.req.query('level');
  const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
  const r = level
    ? await c.env.DB.prepare('SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?').bind(level, limit).all()
    : await c.env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').bind(limit).all();
  return c.json({ items: r.results });
});
