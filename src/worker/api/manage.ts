// 總覽、規則、規則建議、專案、標籤、群組、雲端空間、成員、設定、紀錄、AI 查詢
import { Hono } from 'hono';
import { getGroup, getSetting, listRules, log, setSetting, deleteSetting } from '../db';
import { canSeeGroup, fileScope, type Role } from '../permissions';
import { classify, renderPath, splitList, templateVars, type MatchType, type Rule } from '../rules';
import { askEngine, WORKERS_MODELS, DEFAULT_GEMINI_MODEL } from '../ai';
import { aiStatus, loadAiSettings, queueAi, resumeAi, DEFAULT_FEATURES, type AiFeatures } from '../ai-job';
import { hasFts, searchForAi } from '../search';
import { STORAGE_LABEL, storageReady, type StorageRow, type StorageType } from '../storage';
import { oauthConfigured } from '../storage/oauth';
import { FolderCache } from '../storage/cache';
import { driveConfig, gdriveFolderLink, GoogleDrive, type ShareMode } from '../storage/gdrive';
import { consolidate, filesOutsideRoot, syncDriveSharing } from '../storage/share';
import { revokeAllSessions } from '../auth/session';
import { loginConfigured, LOGIN_CALLBACK_PATH } from '../auth/google';
import { bad, intParam, need, notFound, readJson, type AppEnv, type Ctx } from './util';

export const manage = new Hono<AppEnv>();

// ---------- 帳號、總覽 ----------

const PALETTES = ['indigo', 'ocean', 'forest', 'terracotta', 'plum', 'graphite'];
const MODES = ['system', 'light', 'dark'];

async function readPrefs(c: Ctx, email: string): Promise<{ mode: string; palette: string }> {
  const row = await c.env.DB.prepare('SELECT prefs FROM users WHERE email = ?').bind(email).first<{ prefs: string | null }>();
  let p: { mode?: string; palette?: string } = {};
  try {
    p = JSON.parse(row?.prefs || '{}');
  } catch {
    // 忽略損壞的設定
  }
  return { mode: MODES.includes(p.mode ?? '') ? p.mode! : 'system', palette: PALETTES.includes(p.palette ?? '') ? p.palette! : 'indigo' };
}

/** 個人外觀設定（每個人都可以改自己的） */
manage.put('/me/prefs', async (c) => {
  const u = c.get('user');
  const b = await readJson<{ mode?: string; palette?: string }>(c);
  const cur = await readPrefs(c, u.email);
  const next = { mode: b.mode && MODES.includes(b.mode) ? b.mode : cur.mode, palette: b.palette && PALETTES.includes(b.palette) ? b.palette : cur.palette };
  await c.env.DB.prepare('UPDATE users SET prefs = ? WHERE email = ?').bind(JSON.stringify(next), u.email).run();
  return c.json(next);
});

manage.get('/me', async (c) => {
  const u = c.get('user');
  return c.json({
    prefs: await readPrefs(c, u.email),
    email: u.email,
    name: u.name,
    role: u.role,
    allGroups: u.allGroups,
    aiAvailable: !!(await askEngine(c.env)),
    fullText: await hasFts(c.env),
    semantic: !!(c.env.AI && c.env.VECTORIZE),
    demo: !!c.env.DEMO_AI,
  });
});

/** 我目前登入中的裝置 */
manage.get('/me/sessions', async (c) => {
  const u = c.get('user');
  const r = await c.env.DB.prepare(
    "SELECT id, created_at, last_seen, expires_at, user_agent FROM sessions WHERE email = ? AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY last_seen DESC",
  )
    .bind(u.email)
    .all<{ id: string; created_at: string; last_seen: string; expires_at: string; user_agent: string | null }>();
  const current = c.get('sessionId');
  return c.json({ items: r.results.map((s) => ({ ...s, id: s.id.slice(0, 12), current: s.id === current })) });
});

/** 登出所有裝置（包含目前這台） */
manage.post('/me/logout-all', async (c) => {
  const u = c.get('user');
  const n = await revokeAllSessions(c.env, u.email);
  await log(c.env, 'info', 'login', `${u.email} 登出所有裝置（${n} 個登入）`);
  return c.json({ revoked: n });
});

/** 登出其他裝置（保留目前這台） */
manage.post('/me/logout-others', async (c) => {
  const u = c.get('user');
  const current = c.get('sessionId');
  const r = await c.env.DB.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE email = ? AND revoked_at IS NULL AND id != ?")
    .bind(u.email, current ?? '')
    .run();
  return c.json({ revoked: r.meta.changes ?? 0 });
});

manage.get('/stats', async (c) => {
  const scope = fileScope(c.get('user'));
  const s = await c.env.DB.prepare(
    `SELECT
      SUM(CASE WHEN f.status = 'done' THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN f.status = 'done' AND f.unsorted = 1 THEN 1 ELSE 0 END) AS unsorted,
      SUM(CASE WHEN f.status = 'done' AND f.unsorted = 0 THEN 1 ELSE 0 END) AS sorted,
      SUM(CASE WHEN f.status = 'done' AND f.classified_by = 'ai' THEN 1 ELSE 0 END) AS by_ai,
      SUM(CASE WHEN f.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN f.status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN f.status = 'duplicate' THEN 1 ELSE 0 END) AS duplicates,
      SUM(CASE WHEN f.status = 'done' AND f.unsorted = 1 AND f.ai_status = 'done' AND json_extract(f.ai_suggestion, '$.folder') IS NOT NULL
        AND COALESCE(json_extract(f.ai_suggestion, '$.dismissed'), 0) = 0 AND COALESCE(json_extract(f.ai_suggestion, '$.applied.folder'), 0) = 0 THEN 1 ELSE 0 END) AS ai_review,
      SUM(CASE WHEN f.status = 'done' THEN COALESCE(f.size, 0) ELSE 0 END) AS bytes,
      COUNT(DISTINCT CASE WHEN f.status = 'done' AND f.version_key IS NOT NULL THEN f.version_key END) AS families
     FROM files f WHERE ${scope.sql}`,
  )
    .bind(...scope.binds)
    .first<Record<string, number | null>>();
  const user = c.get('user');
  const groups = (await c.env.DB.prepare("SELECT id, configured FROM groups WHERE joined = 1 AND enabled = 1 AND source_type IN ('group', 'room', 'user')").all<{ id: string; configured: number }>()).results.filter((g) => canSeeGroup(user, g.id));
  const recent = await c.env.DB.prepare(
    `SELECT f.id, f.original_name, f.stored_name, f.ext, f.message_type, f.folder_path, f.status, f.unsorted, f.received_at, f.classified_by, COALESCE(g.alias, g.name, f.group_id) AS group_name
     FROM files f LEFT JOIN groups g ON g.id = f.group_id WHERE f.status NOT IN ('deleted', 'skipped') AND ${scope.sql} ORDER BY f.received_at DESC LIMIT 6`,
  )
    .bind(...scope.binds)
    .all();
  const storages = (await c.env.DB.prepare('SELECT * FROM storages ORDER BY is_default DESC, id').all<StorageRow>()).results;
  const suggestions = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM rule_suggestions WHERE status = 'open'").first<{ n: number }>();
  const archived = s?.archived ?? 0;
  return c.json({
    archived,
    unsorted: s?.unsorted ?? 0,
    byAi: s?.by_ai ?? 0,
    aiReview: s?.ai_review ?? 0,
    failed: s?.failed ?? 0,
    pending: s?.pending ?? 0,
    duplicates: s?.duplicates ?? 0,
    bytes: s?.bytes ?? 0,
    groups: groups.length,
    unconfiguredGroups: groups.filter((g) => !g.configured).length,
    autoRate: archived ? (s?.sorted ?? 0) / archived : null,
    storagesReady: storages.some(storageReady),
    hasStorage: storages.length > 0,
    suggestions: suggestions?.n ?? 0,
    recent: recent.results,
  });
});

/** 檔案頁左側的「檔案來源／專案／標籤」清單 */
manage.get('/sources', async (c) => {
  const user = c.get('user');
  const scope = fileScope(user);
  const groups = (
    await c.env.DB.prepare(
      `SELECT g.id, g.source_type, COALESCE(g.alias, g.name) AS name, g.configured, g.enabled, g.joined,
        (SELECT COUNT(*) FROM files f WHERE f.group_id = g.id AND f.status = 'done') AS count
       FROM groups g ORDER BY g.source_type = 'upload', g.source_type = 'email', count DESC`,
    ).all<{ id: string }>()
  ).results.filter((g) => canSeeGroup(user, g.id));
  const projects = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.color, (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id AND f.status = 'done' AND ${scope.sql}) AS count FROM projects p ORDER BY p.name`,
  )
    .bind(...scope.binds)
    .all();
  const tags = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.color, COUNT(f.id) AS count FROM tags t
     LEFT JOIN file_tags ft ON ft.tag_id = t.id LEFT JOIN files f ON f.id = ft.file_id AND f.status = 'done' AND ${scope.sql}
     GROUP BY t.id ORDER BY count DESC, t.name LIMIT 100`,
  )
    .bind(...scope.binds)
    .all();
  const years = await c.env.DB.prepare(`SELECT substr(f.received_at, 1, 4) AS year, COUNT(*) AS count FROM files f WHERE f.status = 'done' AND ${scope.sql} GROUP BY year ORDER BY year DESC`)
    .bind(...scope.binds)
    .all();
  return c.json({ groups, projects: projects.results, tags: tags.results, years: years.results });
});

// ---------- 規則 ----------

const MATCH_TYPES: MatchType[] = ['keywords', 'regex', 'extension', 'any'];

interface RuleInput {
  name?: string;
  priority?: number;
  match_type?: MatchType;
  pattern?: string;
  group_id?: string | null;
  target_path?: string;
  rename_template?: string | null;
  enabled?: boolean | number;
  project_id?: number | null;
  tags?: string | null;
}

function validateRule(input: RuleInput) {
  const name = (input.name ?? '').trim();
  if (!name) throw bad('請輸入規則名稱');
  const match_type = input.match_type ?? 'keywords';
  if (!MATCH_TYPES.includes(match_type)) throw bad('比對方式不正確');
  const pattern = (input.pattern ?? '').trim();
  if (match_type !== 'any' && !pattern) throw bad('請輸入比對內容');
  if (match_type === 'regex') {
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw bad('正規表示式格式錯誤');
    }
  }
  const target_path = (input.target_path ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!target_path) throw bad('請輸入目標資料夾');
  return {
    name,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
    match_type,
    pattern,
    group_id: input.group_id || null,
    target_path,
    rename_template: input.rename_template?.trim() || null,
    enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
    project_id: input.project_id || null,
    tags: splitList(input.tags).join(', ') || null,
  };
}

async function insertRule(c: Ctx, r: ReturnType<typeof validateRule>) {
  const res = await c.env.DB.prepare(
    'INSERT INTO rules (name, priority, match_type, pattern, group_id, target_path, rename_template, enabled, project_id, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(r.name, r.priority, r.match_type, r.pattern, r.group_id, r.target_path, r.rename_template, r.enabled, r.project_id, r.tags)
    .run();
  return Number(res.meta.last_row_id);
}

manage.get('/rules', async (c) => c.json({ items: await listRules(c.env) }));

manage.post('/rules', async (c) => {
  const user = need(c, 'editor');
  const r = validateRule(await readJson<RuleInput>(c));
  const id = await insertRule(c, r);
  await log(c.env, 'info', 'rule', `${user.email} 新增規則「${r.name}」`);
  return c.json({ id });
});

manage.put('/rules/:id', async (c) => {
  const user = need(c, 'editor');
  const r = validateRule(await readJson<RuleInput>(c));
  const res = await c.env.DB.prepare(
    `UPDATE rules SET name = ?, priority = ?, match_type = ?, pattern = ?, group_id = ?, target_path = ?, rename_template = ?, enabled = ?, project_id = ?, tags = ?,
     updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(r.name, r.priority, r.match_type, r.pattern, r.group_id, r.target_path, r.rename_template, r.enabled, r.project_id, r.tags, intParam(c))
    .run();
  if (!res.meta.changes) throw notFound('找不到規則');
  await log(c.env, 'info', 'rule', `${user.email} 修改規則「${r.name}」`);
  return c.json({ ok: true });
});

manage.delete('/rules/:id', async (c) => {
  const user = need(c, 'editor');
  const id = intParam(c);
  await c.env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(id).run();
  await c.env.DB.prepare('UPDATE files SET matched_rule_id = NULL WHERE matched_rule_id = ?').bind(id).run();
  await log(c.env, 'info', 'rule', `${user.email} 刪除規則 #${id}`);
  return c.json({ ok: true });
});

manage.post('/rules/reorder', async (c) => {
  need(c, 'editor');
  const { ids } = await readJson<{ ids: number[] }>(c);
  if (!Array.isArray(ids)) throw bad('ids 必須是陣列');
  await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare('UPDATE rules SET priority = ? WHERE id = ?').bind((i + 1) * 10, id)));
  return c.json({ ok: true });
});

/** 規則模擬器：輸入檔名看會被分到哪裡，可帶入尚未儲存的規則 */
manage.post('/rules/test', async (c) => {
  const body = await readJson<{ fileName: string; groupId?: string; draft?: RuleInput & { id?: number } }>(c);
  if (!body.fileName?.trim()) throw bad('請輸入檔名');
  let rules: Rule[] = await listRules(c.env);
  if (body.draft) {
    const d = validateRule(body.draft);
    const draft: Rule = { id: body.draft.id ?? -1, ...d };
    rules = [...rules.filter((r) => r.id !== draft.id), draft];
  }
  const groupId = body.groupId || '';
  const group = groupId ? await getGroup(c.env, groupId) : null;
  const result = classify(
    rules,
    { fileName: body.fileName.trim(), groupId, groupName: group?.alias || group?.name || '範例群組', senderName: '範例成員', receivedAt: new Date(), timeZone: c.env.TIMEZONE || 'Asia/Taipei' },
    { fallbackPath: group?.base_folder, defaultRename: group?.rename_template },
  );
  const storage = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ? OR is_default = 1 ORDER BY id = ? DESC LIMIT 1')
    .bind(group?.storage_id ?? 0, group?.storage_id ?? 0)
    .first<StorageRow>();
  const project = result.rule?.project_id ?? group?.project_id;
  const projectName = project ? (await c.env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(project).first<{ name: string }>())?.name : null;
  return c.json({
    rule: result.rule ? { id: result.rule.id, name: result.rule.name } : null,
    folderPath: result.folderPath,
    storedName: result.storedName,
    unsorted: result.unsorted,
    storage: storage?.name ?? '（尚未設定雲端空間）',
    project: projectName ?? null,
    tags: splitList(result.rule?.tags),
    fullPath: `${storage?.root_folder ?? 'GrabIt'}/${result.folderPath}/${result.storedName}`,
  });
});

manage.post('/rules/preview-path', async (c) => {
  const { template } = await readJson<{ template: string }>(c);
  const vars = templateVars({ fileName: '報告.pdf', groupId: '', groupName: '範例群組', senderName: '範例成員', receivedAt: new Date(), timeZone: c.env.TIMEZONE || 'Asia/Taipei' });
  return c.json({ path: renderPath(template ?? '', vars) });
});

// ---------- 規則建議（從手動搬移學習） ----------

manage.get('/suggestions', async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM rule_suggestions WHERE status = 'open' ORDER BY support DESC, updated_at DESC LIMIT 20").all<{ examples: string }>();
  return c.json({ items: r.results.map((x) => ({ ...x, examples: JSON.parse(x.examples) })) });
});

manage.post('/suggestions/:id/accept', async (c) => {
  const user = need(c, 'editor');
  const s = await c.env.DB.prepare('SELECT * FROM rule_suggestions WHERE id = ?').bind(intParam(c)).first<{ id: number; pattern: string; target_path: string }>();
  if (!s) throw notFound();
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(priority), 0) AS p FROM rules').first<{ p: number }>();
  const id = await insertRule(c, validateRule({ name: `${s.pattern} → ${s.target_path.split('/').pop()}`, match_type: 'keywords', pattern: s.pattern, target_path: s.target_path, priority: (max?.p ?? 0) + 10 }));
  await c.env.DB.prepare("UPDATE rule_suggestions SET status = 'accepted', updated_at = datetime('now') WHERE id = ?").bind(s.id).run();
  await log(c.env, 'info', 'rule', `${user.email} 採用建議規則：含「${s.pattern}」→ ${s.target_path}`);
  return c.json({ ruleId: id });
});

manage.post('/suggestions/:id/dismiss', async (c) => {
  need(c, 'editor');
  await c.env.DB.prepare("UPDATE rule_suggestions SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?").bind(intParam(c)).run();
  return c.json({ ok: true });
});

// ---------- 專案與標籤 ----------

manage.get('/projects', async (c) => {
  const scope = fileScope(c.get('user'));
  const r = await c.env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id AND f.status = 'done' AND ${scope.sql}) AS count FROM projects p ORDER BY p.name`)
    .bind(...scope.binds)
    .all();
  return c.json({ items: r.results });
});

manage.post('/projects', async (c) => {
  need(c, 'editor');
  const b = await readJson<{ name: string; color?: string; description?: string }>(c);
  if (!b.name?.trim()) throw bad('請輸入專案名稱');
  try {
    const r = await c.env.DB.prepare('INSERT INTO projects (name, color, description) VALUES (?, ?, ?)').bind(b.name.trim(), b.color || '#4a6fa5', b.description ?? null).run();
    return c.json({ id: r.meta.last_row_id });
  } catch {
    throw bad('已經有同名的專案');
  }
});

manage.put('/projects/:id', async (c) => {
  need(c, 'editor');
  const b = await readJson<{ name: string; color?: string; description?: string }>(c);
  if (!b.name?.trim()) throw bad('請輸入專案名稱');
  await c.env.DB.prepare('UPDATE projects SET name = ?, color = ?, description = ? WHERE id = ?').bind(b.name.trim(), b.color || '#4a6fa5', b.description ?? null, intParam(c)).run();
  return c.json({ ok: true });
});

manage.delete('/projects/:id', async (c) => {
  need(c, 'editor');
  const id = intParam(c);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE files SET project_id = NULL WHERE project_id = ?').bind(id),
    c.env.DB.prepare('UPDATE rules SET project_id = NULL WHERE project_id = ?').bind(id),
    c.env.DB.prepare('UPDATE groups SET project_id = NULL WHERE project_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

manage.get('/tags', async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT t.*, COUNT(f.id) AS count FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id LEFT JOIN files f ON f.id = ft.file_id AND f.status = 'done' GROUP BY t.id ORDER BY count DESC, t.name",
  ).all();
  return c.json({ items: r.results });
});

manage.put('/tags/:id', async (c) => {
  need(c, 'editor');
  const b = await readJson<{ name: string; color?: string }>(c);
  if (!b.name?.trim()) throw bad('請輸入標籤名稱');
  const id = intParam(c);
  const clash = await c.env.DB.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').bind(b.name.trim(), id).first<{ id: number }>();
  if (clash) {
    // 改成已存在的名稱 = 合併標籤
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id, source) SELECT file_id, ?, source FROM file_tags WHERE tag_id = ?').bind(clash.id, id),
      c.env.DB.prepare('DELETE FROM file_tags WHERE tag_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id),
    ]);
    return c.json({ ok: true, mergedInto: clash.id });
  }
  await c.env.DB.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').bind(b.name.trim(), b.color || '#697181', id).run();
  return c.json({ ok: true });
});

manage.delete('/tags/:id', async (c) => {
  need(c, 'editor');
  const id = intParam(c);
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM file_tags WHERE tag_id = ?').bind(id), c.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id)]);
  return c.json({ ok: true });
});

// ---------- 群組（每個群組獨立設定） ----------

manage.get('/groups', async (c) => {
  const user = c.get('user');
  const r = await c.env.DB.prepare(
    `SELECT g.*, s.name AS storage_name, p.name AS project_name,
       (SELECT COUNT(*) FROM files f WHERE f.group_id = g.id AND f.status = 'done') AS file_count,
       (SELECT COUNT(*) FROM files f WHERE f.group_id = g.id AND f.status = 'done' AND (g.project_id IS NULL OR f.project_id IS NOT g.project_id)) AS outside_project,
       (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.group_id = g.id AND f.status = 'done') AS bytes,
       (SELECT MAX(received_at) FROM files f WHERE f.group_id = g.id) AS last_file_at,
       (SELECT json_group_array(email) FROM user_groups ug WHERE ug.group_id = g.id) AS members_json
     FROM groups g LEFT JOIN storages s ON s.id = g.storage_id LEFT JOIN projects p ON p.id = g.project_id
     ORDER BY g.configured, g.joined DESC, g.created_at DESC`,
  ).all<{ id: string; members_json: string; file_types: string | null }>();
  return c.json({
    items: r.results
      .filter((g) => canSeeGroup(user, g.id))
      .map(({ members_json, ...g }) => ({ ...g, file_types: g.file_types ? JSON.parse(g.file_types) : null, members: JSON.parse(members_json) })),
  });
});

interface GroupPatch {
  alias?: string | null;
  enabled?: boolean;
  storage_id?: number | null;
  base_folder?: string | null;
  rename_template?: string | null;
  file_types?: string[] | null;
  backup_images?: boolean;
  backup_videos?: boolean;
  notify?: boolean;
  ai_enabled?: boolean;
  ai_external?: boolean;
  project_id?: number | null;
  configured?: boolean;
  members?: string[];
}

manage.patch('/groups/:id', async (c) => {
  const user = need(c, 'admin');
  const id = c.req.param('id');
  const g = await getGroup(c.env, id);
  if (!g) throw notFound('找不到群組');
  const b = await readJson<GroupPatch>(c);
  const v = <K extends keyof GroupPatch>(k: K, cur: unknown) => (b[k] === undefined ? cur : b[k]);
  const bool = (x: unknown) => (x ? 1 : 0);
  await c.env.DB.prepare(
    `UPDATE groups SET alias = ?, enabled = ?, storage_id = ?, base_folder = ?, rename_template = ?, file_types = ?, backup_images = ?, backup_videos = ?,
     notify = ?, ai_enabled = ?, ai_external = ?, project_id = ?, configured = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(
      (v('alias', g.alias) as string | null)?.toString().trim() || null,
      bool(v('enabled', g.enabled)),
      v('storage_id', g.storage_id) ?? null,
      (v('base_folder', g.base_folder) as string | null)?.toString().trim() || null,
      (v('rename_template', g.rename_template) as string | null)?.toString().trim() || null,
      b.file_types === undefined ? g.file_types : b.file_types && b.file_types.length ? JSON.stringify(b.file_types) : null,
      bool(v('backup_images', g.backup_images)),
      bool(v('backup_videos', g.backup_videos)),
      bool(v('notify', g.notify)),
      bool(v('ai_enabled', g.ai_enabled)),
      bool(v('ai_external', g.ai_external)),
      v('project_id', g.project_id) ?? null,
      bool(v('configured', g.configured)),
      id,
    )
    .run();
  if (b.members) {
    await c.env.DB.prepare('DELETE FROM user_groups WHERE group_id = ?').bind(id).run();
    for (const email of b.members) await c.env.DB.prepare('INSERT OR IGNORE INTO user_groups (email, group_id) VALUES (?, ?)').bind(email.toLowerCase(), id).run();
  }
  await log(c.env, 'info', 'group', `${user.email} 更新群組「${g.alias || g.name}」的設定`);
  return c.json({ ok: true });
});

/** 把群組的預設專案套用到這個群組現有、還沒有專案的檔案 */
manage.post('/groups/:id/apply-project', async (c) => {
  const user = need(c, 'editor');
  const g = await getGroup(c.env, c.req.param('id'));
  if (!g || !canSeeGroup(user, g.id)) throw notFound('找不到群組');
  if (!g.project_id) throw bad('這個群組沒有設定預設專案');
  const { overwrite } = await readJson<{ overwrite?: boolean }>(c);
  const r = await c.env.DB.prepare(
    `UPDATE files SET project_id = ?, updated_at = datetime('now') WHERE group_id = ? AND status IN ('done', 'duplicate') ${overwrite ? '' : 'AND project_id IS NULL'}`,
  )
    .bind(g.project_id, g.id)
    .run();
  await log(c.env, 'info', 'group', `${user.email} 把群組「${g.alias || g.name}」的 ${r.meta.changes ?? 0} 個檔案加入預設專案`);
  return c.json({ updated: r.meta.changes ?? 0 });
});

// ---------- 雲端空間 ----------

const SHARE_MODES: ShareMode[] = ['private', 'members', 'anyone'];

function publicStorage(row: StorageRow) {
  const cfg = JSON.parse(row.config || '{}') as Record<string, string>;
  const drive = row.type === 'gdrive' ? driveConfig(row) : null;
  return {
    id: row.id,
    type: row.type,
    typeLabel: STORAGE_LABEL[row.type],
    name: row.name,
    root_folder: drive?.root_name ?? row.root_folder,
    account: row.account,
    is_default: row.is_default,
    ready: storageReady(row),
    config: { url: cfg.url, username: cfg.username },
    // Google Drive 專屬資料夾
    folderLink: drive?.root_id ? gdriveFolderLink(drive.root_id) : null,
    share: drive ? (drive.share ?? 'private') : null,
    shareError: drive?.share_error ?? null,
  };
}

manage.get('/storages', async (c) => {
  const rows = (await c.env.DB.prepare('SELECT * FROM storages ORDER BY is_default DESC, id').all<StorageRow>()).results;
  // 非管理員只需要知道有哪些空間（瀏覽資料夾用），不顯示帳號、分享與連線細節
  if (c.get('user').role !== 'admin') {
    return c.json({ items: rows.map((r) => ({ id: r.id, type: r.type, typeLabel: STORAGE_LABEL[r.type], name: r.name, root_folder: driveConfig(r).root_name ?? r.root_folder, is_default: r.is_default })), types: [], redirectBase: '' });
  }
  const usage = (await c.env.DB.prepare("SELECT storage_id, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files WHERE status = 'done' GROUP BY storage_id").all<{ storage_id: number; n: number; bytes: number }>()).results;
  const types = (['gdrive', 'onedrive', 'dropbox', 'webdav'] as StorageType[]).map((t) => ({ type: t, label: STORAGE_LABEL[t], configured: t === 'webdav' || oauthConfigured(c.env, t) }));
  const outside = new Map<number, number>();
  const status = new Map<number, { missing: boolean; extras: number }>();
  for (const r of rows) {
    if (r.type !== 'gdrive' || !storageReady(r)) continue;
    if (driveConfig(r).root_id) outside.set(r.id, await filesOutsideRoot(c.env, r));
    const st = await new GoogleDrive({ env: c.env, row: r }).rootStatus().catch(() => null);
    if (st) status.set(r.id, { missing: st.missing, extras: st.extras.length });
  }
  return c.json({
    items: rows.map((r) => ({
      ...publicStorage(r),
      files: usage.find((u) => u.storage_id === r.id)?.n ?? 0,
      bytes: usage.find((u) => u.storage_id === r.id)?.bytes ?? 0,
      filesOutside: outside.get(r.id) ?? 0,
      rootMissing: status.get(r.id)?.missing ?? false,
      extraFolders: status.get(r.id)?.extras ?? 0,
    })),
    types,
    redirectBase: new URL(c.req.url).origin,
  });
});

manage.post('/storages', async (c) => {
  const user = need(c, 'admin');
  const b = await readJson<{ type: StorageType; name?: string; root_folder?: string; url?: string; username?: string; password?: string; share?: ShareMode }>(c);
  if (!['gdrive', 'onedrive', 'dropbox', 'webdav'].includes(b.type) && !(b.type === 'demo' && c.env.DEMO_AI)) throw bad('不支援的空間類型');
  if (b.type === 'webdav' && !/^https:\/\//.test(b.url ?? '')) throw bad('WebDAV 網址必須是 https:// 開頭');
  if (b.type !== 'webdav' && b.type !== 'demo' && !oauthConfigured(c.env, b.type)) throw bad(`伺服器尚未設定 ${STORAGE_LABEL[b.type]} 的 OAuth 用戶端，請參考 README`);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM storages').first<{ n: number }>();
  const config =
    b.type === 'webdav'
      ? JSON.stringify({ url: b.url, username: b.username ?? '' })
      : b.type === 'gdrive'
        ? JSON.stringify({ share: SHARE_MODES.includes(b.share as ShareMode) ? b.share : 'members' })
        : '{}';
  const secret = b.type === 'webdav' ? JSON.stringify({ password: b.password ?? '' }) : '{}';
  const r = await c.env.DB.prepare('INSERT INTO storages (type, name, root_folder, config, secret, is_default) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(b.type, b.name?.trim() || STORAGE_LABEL[b.type], b.root_folder?.trim() || 'GrabIt', config, secret, count?.n ? 0 : 1)
    .run();
  const id = Number(r.meta.last_row_id);
  await log(c.env, 'info', 'storage', `${user.email} 新增雲端空間「${b.name || STORAGE_LABEL[b.type]}」`);
  return c.json({ id, authorizeUrl: b.type === 'webdav' || b.type === 'demo' ? null : `/oauth/${b.type}/start?storage=${id}` });
});

manage.patch('/storages/:id', async (c) => {
  need(c, 'admin');
  const id = intParam(c);
  const row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?').bind(id).first<StorageRow>();
  if (!row) throw notFound();
  const b = await readJson<{ name?: string; root_folder?: string; is_default?: boolean; url?: string; username?: string; password?: string; share?: ShareMode }>(c);
  if (b.share !== undefined && !SHARE_MODES.includes(b.share)) throw bad('分享方式不正確');
  if (b.is_default) await c.env.DB.prepare('UPDATE storages SET is_default = 0').run();
  let config = row.config;
  let secret = row.secret;
  if (row.type === 'webdav' && (b.url || b.username !== undefined)) {
    const cur = JSON.parse(row.config || '{}');
    config = JSON.stringify({ url: b.url ?? cur.url, username: b.username ?? cur.username });
  }
  if (row.type === 'webdav' && b.password) secret = JSON.stringify({ password: b.password });
  const root = b.root_folder?.trim();
  await c.env.DB.prepare('UPDATE storages SET name = ?, root_folder = ?, is_default = ?, config = ?, secret = ? WHERE id = ?')
    .bind(b.name?.trim() || row.name, root || row.root_folder, b.is_default ? 1 : row.is_default, config, secret, id)
    .run();
  if (row.type === 'gdrive') {
    // Google Drive：改名直接改專屬資料夾的名稱（檔案不用搬）；改分享方式立即套用
    const fresh = (await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?').bind(id).first<StorageRow>())!;
    const drive = new GoogleDrive({ env: c.env, row: fresh });
    if (storageReady(fresh) && root && root !== (driveConfig(row).root_name ?? row.root_folder)) await drive.renameRoot(root);
    if (b.share !== undefined) {
      fresh.config = JSON.stringify({ ...driveConfig(fresh), share: b.share });
      await c.env.DB.prepare('UPDATE storages SET config = ? WHERE id = ?').bind(fresh.config, id).run();
      if (storageReady(fresh)) {
        const r = await drive.applySharing();
        await log(c.env, r.errors.length ? 'warn' : 'info', 'storage', `${c.get('user').email} 將「${row.name}」的分享方式改為 ${{ private: '不分享', members: 'GrabIt 成員', anyone: '知道連結的任何人' }[b.share]}${r.errors.length ? `（部分失敗：${r.errors[0]}）` : ''}`);
        return c.json({ ok: true, errors: r.errors });
      }
    }
    return c.json({ ok: true });
  }
  if (root && root !== row.root_folder) await new FolderCache(c.env, id).clear();
  return c.json({ ok: true });
});

/** 專屬資料夾被刪除時，由使用者決定重新建立 */
manage.post('/storages/:id/recreate-root', async (c) => {
  const user = need(c, 'admin');
  const row = await c.env.DB.prepare("SELECT * FROM storages WHERE id = ? AND type = 'gdrive'").bind(intParam(c)).first<StorageRow>();
  if (!row) throw notFound('找不到 Google Drive 空間');
  const drive = new GoogleDrive({ env: c.env, row });
  const st = await drive.rootStatus();
  if (!st.missing) throw bad('專屬資料夾還在，不需要重新建立');
  const id = await drive.rootId({ create: true });
  await log(c.env, 'info', 'storage', `${user.email} 重新建立「${row.name}」的專屬資料夾`);
  return c.json({ ok: true, folderLink: gdriveFolderLink(id) });
});

/** 把散落在舊位置的檔案搬進 Google Drive 專屬資料夾（每次一批，前端會重複呼叫直到完成） */
manage.post('/storages/:id/consolidate', async (c) => {
  need(c, 'admin');
  const row = await c.env.DB.prepare("SELECT * FROM storages WHERE id = ? AND type = 'gdrive'").bind(intParam(c)).first<StorageRow>();
  if (!row) throw notFound('找不到 Google Drive 空間');
  if (!storageReady(row)) throw bad('請先完成授權');
  return c.json(await consolidate(c.env, row));
});

manage.delete('/storages/:id', async (c) => {
  need(c, 'admin');
  const id = intParam(c);
  const used = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE storage_id = ? AND status IN ('done', 'duplicate')").bind(id).first<{ n: number }>();
  if (used?.n) throw bad(`這個空間還有 ${used.n} 個檔案的紀錄，無法移除`);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE groups SET storage_id = NULL WHERE storage_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM storage_folders WHERE storage_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM storages WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---------- 成員與權限 ----------

manage.get('/users', async (c) => {
  need(c, 'admin');
  const r = await c.env.DB.prepare(
    `SELECT u.*, (SELECT json_group_array(group_id) FROM user_groups ug WHERE ug.email = u.email) AS groups_json,
       (SELECT COUNT(*) FROM sessions s WHERE s.email = u.email AND s.revoked_at IS NULL AND s.expires_at > datetime('now')) AS active_sessions
     FROM users u ORDER BY u.role = 'admin' DESC, u.email`,
  ).all<{ groups_json: string }>();
  return c.json({ items: r.results.map(({ groups_json, ...u }) => ({ ...u, groups: JSON.parse(groups_json) })) });
});

interface UserBody {
  email?: string;
  name?: string;
  role?: Role;
  all_groups?: boolean;
  groups?: string[];
}

async function saveUserGroups(c: Ctx, email: string, groups?: string[]) {
  if (!groups) return;
  await c.env.DB.prepare('DELETE FROM user_groups WHERE email = ?').bind(email).run();
  for (const g of groups) await c.env.DB.prepare('INSERT OR IGNORE INTO user_groups (email, group_id) VALUES (?, ?)').bind(email, g).run();
}

manage.post('/users', async (c) => {
  const me = need(c, 'admin');
  const b = await readJson<UserBody>(c);
  const email = b.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('請輸入正確的 email');
  const role: Role = b.role && ['admin', 'editor', 'viewer'].includes(b.role) ? b.role : 'viewer';
  try {
    await c.env.DB.prepare('INSERT INTO users (email, name, role, all_groups) VALUES (?, ?, ?, ?)').bind(email, b.name ?? null, role, b.all_groups ? 1 : 0).run();
  } catch {
    throw bad('這個 email 已經是成員');
  }
  await saveUserGroups(c, email, b.groups);
  await log(c.env, 'info', 'user', `${me.email} 新增成員 ${email}（${role}）`);
  c.executionCtx.waitUntil(syncDriveSharing(c.env));
  return c.json({ ok: true });
});

manage.patch('/users/:email', async (c) => {
  const me = need(c, 'admin');
  const email = decodeURIComponent(c.req.param('email')).toLowerCase();
  const b = await readJson<UserBody>(c);
  const cur = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<{ role: Role; all_groups: number; name: string | null }>();
  if (!cur) throw notFound('找不到成員');
  const role = b.role ?? cur.role;
  if (email === me.email && role !== 'admin') throw bad('不能移除自己的管理員權限');
  await c.env.DB.prepare('UPDATE users SET name = ?, role = ?, all_groups = ? WHERE email = ?')
    .bind(b.name ?? cur.name, role, b.all_groups === undefined ? cur.all_groups : b.all_groups ? 1 : 0, email)
    .run();
  await saveUserGroups(c, email, b.groups);
  return c.json({ ok: true });
});

manage.delete('/users/:email', async (c) => {
  const me = need(c, 'admin');
  const email = decodeURIComponent(c.req.param('email')).toLowerCase();
  if (email === me.email) throw bad('不能刪除自己');
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM user_groups WHERE email = ?').bind(email), c.env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email)]);
  const n = await revokeAllSessions(c.env, email);
  await log(c.env, 'info', 'user', `${me.email} 移除成員 ${email}（撤銷 ${n} 個登入）`);
  c.executionCtx.waitUntil(syncDriveSharing(c.env));
  return c.json({ ok: true });
});

/** 管理員強制登出某位成員的所有裝置 */
manage.post('/users/:email/revoke-sessions', async (c) => {
  const me = need(c, 'admin');
  const email = decodeURIComponent(c.req.param('email')).toLowerCase();
  const n = await revokeAllSessions(c.env, email);
  await log(c.env, 'info', 'user', `${me.email} 強制登出 ${email}（${n} 個登入）`);
  return c.json({ revoked: n });
});

// ---------- 系統設定 ----------

manage.get('/settings', async (c) => {
  need(c, 'admin');
  const origin = new URL(c.req.url).origin;
  return c.json({
    webhookUrl: `${origin}/webhook`,
    lineConfigured: !!(c.env.LINE_CHANNEL_SECRET && c.env.LINE_CHANNEL_ACCESS_TOKEN),
    queueEnabled: !!c.env.FILE_QUEUE,
    timezone: c.env.TIMEZONE || 'Asia/Taipei',
    ai: await aiSettingsView(c),
    fullText: await hasFts(c.env),
    semantic: !!(c.env.AI && c.env.VECTORIZE),
    outgoingWebhook: (await getSetting(c.env, 'webhook_url')) ?? '',
    outgoingWebhookSecretSet: !!(await getSetting(c.env, 'webhook_secret')),
    emailAllowedSenders: (await getSetting(c.env, 'email_allowed_senders')) ?? '',
    loginConfigured: loginConfigured(c.env),
    loginRedirectUri: `${origin}${LOGIN_CALLBACK_PATH}`,
    adminEmails: (c.env.ADMIN_EMAILS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    oauthRedirects: (['gdrive', 'onedrive', 'dropbox'] as const).map((t) => ({ type: t, label: STORAGE_LABEL[t], uri: `${origin}/oauth/${t}/callback`, configured: oauthConfigured(c.env, t) })),
  });
});

/** AI 文件判讀的設定與狀態（只有管理員看得到） */
async function aiSettingsView(c: Ctx) {
  const s = await loadAiSettings(c.env);
  return {
    ...s,
    available: {
      workers: !!c.env.AI || !!c.env.DEMO_AI,
      gemini: !!c.env.GEMINI_API_KEY,
      claude: !!c.env.ANTHROPIC_API_KEY,
    },
    workersModels: WORKERS_MODELS.map((m) => ({ id: m.id, label: m.label })),
    defaultGeminiModel: DEFAULT_GEMINI_MODEL,
    claudeModel: c.env.AI_MODEL || 'claude-opus-5-5',
    demo: !!c.env.DEMO_AI,
    status: await aiStatus(c.env, s),
  };
}

interface AiSettingsPatch {
  provider?: string;
  workersModel?: string;
  geminiModel?: string;
  dailyLimit?: number;
  neuronBudget?: number;
  threshold?: number;
  onlyUnmatched?: boolean;
  externalNeedsConsent?: boolean;
  features?: Partial<AiFeatures>;
}

async function saveAiSettings(c: Ctx, b: AiSettingsPatch): Promise<void> {
  const env = c.env;
  if (b.provider !== undefined) {
    if (!['workers', 'gemini', 'claude', 'off'].includes(b.provider)) throw bad('不支援的 AI 引擎');
    await setSetting(env, 'ai_provider', b.provider);
  }
  const model = (v: string, re: RegExp, label: string) => {
    const m = v.trim();
    if (!re.test(m)) throw bad(`${label}的模型名稱格式不正確`);
    return m;
  };
  if (b.workersModel !== undefined) await setSetting(env, 'ai_model_workers', model(b.workersModel, /^@(cf|hf)\/[\w.\-/]+$/, 'Workers AI '));
  if (b.geminiModel !== undefined) await setSetting(env, 'ai_model_gemini', model(b.geminiModel.replace(/^models\//, ''), /^[\w.\-]+$/, 'Gemini '));
  if (b.dailyLimit !== undefined) await setSetting(env, 'ai_daily_limit', String(Math.max(0, Math.min(5000, Math.round(Number(b.dailyLimit) || 0)))));
  if (b.neuronBudget !== undefined) await setSetting(env, 'ai_budget', String(Math.max(0, Math.min(10000, Math.round(Number(b.neuronBudget) || 0)))));
  if (b.threshold !== undefined) await setSetting(env, 'ai_threshold', String(Math.max(0.5, Math.min(1, Number(b.threshold) || 0.85))));
  if (b.onlyUnmatched !== undefined) await setSetting(env, 'ai_only_unmatched', b.onlyUnmatched ? '1' : '0');
  if (b.externalNeedsConsent !== undefined) await setSetting(env, 'ai_external_policy', b.externalNeedsConsent ? '1' : '0');
  if (b.features) {
    const cur = (await loadAiSettings(env)).features;
    const next: AiFeatures = { ...DEFAULT_FEATURES, ...cur };
    for (const k of Object.keys(DEFAULT_FEATURES) as (keyof AiFeatures)[]) if (b.features[k] !== undefined) next[k] = !!b.features[k];
    await setSetting(env, 'ai_features', JSON.stringify(next));
  }
}

manage.put('/settings', async (c) => {
  const me = need(c, 'admin');
  const b = await readJson<{ ai?: AiSettingsPatch; outgoingWebhook?: string; outgoingWebhookSecret?: string; emailAllowedSenders?: string }>(c);
  if (b.ai) await saveAiSettings(c, b.ai);
  if (b.outgoingWebhook !== undefined) {
    if (b.outgoingWebhook && !/^https:\/\//.test(b.outgoingWebhook)) throw bad('Webhook 網址必須是 https:// 開頭');
    if (b.outgoingWebhook) await setSetting(c.env, 'webhook_url', b.outgoingWebhook);
    else await deleteSetting(c.env, 'webhook_url');
  }
  if (b.outgoingWebhookSecret) await setSetting(c.env, 'webhook_secret', b.outgoingWebhookSecret);
  if (b.emailAllowedSenders !== undefined) await setSetting(c.env, 'email_allowed_senders', b.emailAllowedSenders.trim());
  await log(c.env, 'info', 'settings', `${me.email} 更新系統設定`);
  return c.json({ ok: true });
});

// ---------- AI 文件判讀 ----------

manage.get('/ai/status', async (c) => {
  need(c, 'admin');
  return c.json(await aiStatus(c.env, await loadAiSettings(c.env)));
});

/** 額度重置前手動繼續（例如調高了每日上限） */
manage.post('/ai/resume', async (c) => {
  const me = need(c, 'admin');
  await resumeAi(c.env);
  await log(c.env, 'info', 'ai', `${me.email} 讓 AI 判讀繼續執行`);
  return c.json({ ok: true });
});

/** 分析還沒判讀過的舊檔案（照樣受每日上限與群組政策限制） */
manage.post('/ai/backfill', async (c) => {
  const me = need(c, 'admin');
  const { limit } = await readJson<{ limit?: number }>(c);
  const n = Math.max(1, Math.min(200, Math.round(Number(limit) || 20)));
  const rows = (
    await c.env.DB.prepare("SELECT id FROM files WHERE status = 'done' AND (ai_status IS NULL OR ai_status = 'failed') AND ai_summary IS NULL ORDER BY received_at DESC LIMIT ?").bind(n).all<{ id: number }>()
  ).results;
  let queued = 0;
  const skipped: Record<string, number> = {};
  for (const r of rows) {
    const q = await queueAi(c.env, c.executionCtx, r.id);
    if (q.queued) queued++;
    else if (q.reason) skipped[q.reason] = (skipped[q.reason] ?? 0) + 1;
  }
  await log(c.env, 'info', 'ai', `${me.email} 排入 ${queued} 份舊檔案做 AI 判讀`);
  return c.json({ queued, skipped, scanned: rows.length });
});

/** 列出這把 Gemini 金鑰可以用的模型（不會送出任何檔案） */
manage.get('/ai/gemini-models', async (c) => {
  need(c, 'admin');
  if (!c.env.GEMINI_API_KEY) throw bad('還沒有設定 GEMINI_API_KEY');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { headers: { 'x-goog-api-key': c.env.GEMINI_API_KEY } });
  const data = (await res.json().catch(() => ({}))) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[]; error?: { message?: string } };
  if (!res.ok) throw bad(`無法取得 Gemini 模型清單：${data.error?.message ?? res.status}`);
  return c.json({
    items: (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName ?? m.name })),
  });
});

manage.get('/logs', async (c) => {
  need(c, 'editor');
  const level = c.req.query('level');
  const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
  const r = level
    ? await c.env.DB.prepare('SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?').bind(level, limit).all()
    : await c.env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').bind(limit).all();
  return c.json({ items: r.results });
});

// ---------- 自然語言查詢 ----------

manage.post('/ask', async (c) => {
  const user = c.get('user');
  const { question } = await readJson<{ question: string }>(c);
  if (!question?.trim()) throw bad('請輸入問題');
  const engine = await askEngine(c.env);
  if (!engine?.ask) throw bad('「問 AI」需要 Claude：請設定 ANTHROPIC_API_KEY。免費的 AI 文件判讀不包含跨文件問答');
  const scope = fileScope(user);
  const seen = new Set<number>();
  const answer = await engine.ask(question.trim().slice(0, 1000), {
    search: async (args) => {
      const hits = await searchForAi(c.env, scope, args);
      hits.forEach((h) => seen.add(h.id));
      return hits;
    },
    read: async (id) => {
      const f = await c.env.DB.prepare(`SELECT f.id, COALESCE(f.stored_name, f.original_name) AS name, f.ai_summary AS summary, f.content_text AS text, f.group_id FROM files f WHERE f.id = ? AND f.status = 'done' AND ${scope.sql}`)
        .bind(id, ...scope.binds)
        .first<{ name: string; summary: string | null; text: string | null }>();
      if (!f) return null;
      seen.add(id);
      return { name: f.name, summary: f.summary, text: (f.text ?? '').slice(0, 8000) };
    },
  });
  const ids = [...new Set([...answer.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1])))].filter((id) => seen.has(id));
  const filesRows = ids.length
    ? (
        await c.env.DB.prepare(
          `SELECT f.id, COALESCE(f.stored_name, f.original_name) AS name, f.ext, f.message_type, f.folder_path, f.received_at, COALESCE(g.alias, g.name) AS group_name
           FROM files f LEFT JOIN groups g ON g.id = f.group_id WHERE f.id IN (${ids.map(() => '?').join(',')})`,
        )
          .bind(...ids)
          .all()
      ).results
    : [];
  await log(c.env, 'info', 'ask', `${user.email} 詢問：${question.slice(0, 100)}`);
  return c.json({ answer, files: filesRows });
});
