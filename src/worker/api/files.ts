// 檔案、資料夾、版本、重複檔案、上傳、下載、復原
import { Hono } from 'hono';
import { addTags, getFile, getGroup, log, type FileRow } from '../db';
import { canSeeGroup, fileScope } from '../permissions';
import { classifyFile, enqueueFile, DUPLICATE_FOLDER } from '../processor';
import { getStorage, providerFor } from '../storage';
import { indexFile, keywordCondition, semanticIds, type QueryParts } from '../search';
import { learnFromMove } from '../learn';
import { moveFile, renameFolder, undoBatch } from '../ops';
import { ingestBuffer } from '../ingest';
import { emitWebhook } from '../notify';
import { listRules } from '../db';
import { sanitizeSegment } from '../rules';
import { bad, cleanFolderPath, intParam, need, newBatchId, notFound, readJson, type AppEnv, type Ctx } from './util';

export const files = new Hono<AppEnv>();

const CATEGORY_EXT: Record<string, string[]> = {
  pdf: ['pdf'],
  document: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md'],
  spreadsheet: ['xls', 'xlsx', 'csv', 'ods'],
  presentation: ['ppt', 'pptx', 'odp', 'key'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp'],
  video: ['mp4', 'mov', 'm4v'],
  audio: ['m4a', 'mp3', 'wav'],
  archive: ['zip', 'rar', '7z'],
};

export const FILE_SELECT = `SELECT f.id, f.group_id, f.sender_name, f.message_type, f.original_name, f.stored_name, f.ext, f.size, f.folder_path, f.drive_link,
  f.unsorted, f.manual, f.status, f.duplicate_of, f.error, f.attempts, f.received_at, f.storage_id, f.project_id, f.source, f.classified_by,
  f.version_key, f.version_label, f.ai_summary, f.target_folder, f.matched_rule_id,
  COALESCE(g.alias, g.name, f.group_id) AS group_name, r.name AS rule_name, p.name AS project_name, p.color AS project_color, s.name AS storage_name,
  (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color, 'source', ft.source)) FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id) AS tags_json,
  (SELECT COUNT(*) FROM files v WHERE v.version_key = f.version_key AND v.status = 'done') AS version_count
  FROM files f
  LEFT JOIN groups g ON g.id = f.group_id
  LEFT JOIN rules r ON r.id = f.matched_rule_id
  LEFT JOIN projects p ON p.id = f.project_id
  LEFT JOIN storages s ON s.id = f.storage_id`;

export function shapeFile<T extends { tags_json?: string | null }>(row: T) {
  const { tags_json, ...rest } = row;
  return { ...rest, tags: tags_json ? (JSON.parse(tags_json) as unknown[]) : [] };
}

async function visibleFile(c: Ctx, id: number): Promise<FileRow> {
  const file = await getFile(c.env, id);
  if (!file || !canSeeGroup(c.get('user'), file.group_id)) throw notFound('找不到檔案');
  return file;
}

files.get('/files', async (c) => {
  const q = c.req.query();
  const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
  const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
  const scope = fileScope(c.get('user'));
  const parts: QueryParts = { where: [scope.sql], binds: [...scope.binds] };
  switch (q.status ?? 'all') {
    case 'unsorted':
      parts.where.push("f.status = 'done' AND f.unsorted = 1");
      break;
    case 'sorted':
      parts.where.push("f.status = 'done' AND f.unsorted = 0");
      break;
    case 'ai':
      parts.where.push("f.status = 'done' AND f.classified_by = 'ai'");
      break;
    case 'failed':
      parts.where.push("f.status = 'failed'");
      break;
    case 'pending':
      parts.where.push("f.status IN ('pending', 'processing')");
      break;
    case 'duplicate':
      parts.where.push("f.status = 'duplicate'");
      break;
    case 'skipped':
      parts.where.push("f.status = 'skipped'");
      break;
    default:
      parts.where.push("f.status NOT IN ('deleted', 'skipped')");
  }
  if (q.q?.trim()) await keywordCondition(c.env, q.q, parts, await semanticIds(c.env, q.q));
  if (q.group) {
    parts.where.push('f.group_id = ?');
    parts.binds.push(q.group);
  }
  if (q.project) {
    parts.where.push(q.project === 'none' ? 'f.project_id IS NULL' : 'f.project_id = ?');
    if (q.project !== 'none') parts.binds.push(Number(q.project));
  }
  if (q.tag === 'none') {
    parts.where.push('NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id)');
  } else if (q.tag) {
    parts.where.push('EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id AND ft.tag_id = ?)');
    parts.binds.push(Number(q.tag));
  }
  if (q.storage) {
    parts.where.push('f.storage_id = ?');
    parts.binds.push(Number(q.storage));
  }
  if (q.folder) {
    parts.where.push(q.recursive === '0' ? 'f.folder_path = ?' : '(f.folder_path = ? OR f.folder_path LIKE ?)');
    parts.binds.push(q.folder);
    if (q.recursive !== '0') parts.binds.push(`${q.folder}/%`);
  }
  if (q.type && CATEGORY_EXT[q.type]) {
    const exts = CATEGORY_EXT[q.type]!;
    parts.where.push(`(lower(f.ext) IN (${exts.map(() => '?').join(',')})${q.type === 'image' || q.type === 'video' || q.type === 'audio' ? ' OR f.message_type = ?' : ''})`);
    parts.binds.push(...exts);
    if (q.type === 'image' || q.type === 'video' || q.type === 'audio') parts.binds.push(q.type);
  }
  if (q.year) {
    parts.where.push("substr(f.received_at, 1, 4) = ?");
    parts.binds.push(q.year);
  }
  if (q.latest === '1') {
    // 同一組版本只顯示最新的一份
    parts.where.push(`(f.version_key IS NULL OR f.status != 'done' OR NOT EXISTS (SELECT 1 FROM files v WHERE v.version_key = f.version_key AND v.status = 'done'
      AND (v.version_rank > f.version_rank OR (v.version_rank = f.version_rank AND (v.received_at > f.received_at OR (v.received_at = f.received_at AND v.id > f.id))))))`);
  }
  const rows = await c.env.DB.prepare(`${FILE_SELECT} WHERE ${parts.where.join(' AND ')} ORDER BY f.received_at DESC, f.id DESC LIMIT ? OFFSET ?`)
    .bind(...parts.binds, limit + 1, offset)
    .all<{ tags_json: string | null }>();
  return c.json({ items: rows.results.slice(0, limit).map(shapeFile), hasMore: rows.results.length > limit });
});

files.get('/files/:id', async (c) => {
  const file = await visibleFile(c, intParam(c));
  const row = await c.env.DB.prepare(`${FILE_SELECT} WHERE f.id = ?`).bind(file.id).first<{ tags_json: string | null }>();
  const scope = fileScope(c.get('user'));
  const versions = file.version_key
    ? (
        await c.env.DB.prepare(
          `SELECT f.id, COALESCE(f.stored_name, f.original_name) AS name, f.version_label, f.version_rank, f.received_at, f.folder_path, f.sender_name, COALESCE(g.alias, g.name) AS group_name
           FROM files f LEFT JOIN groups g ON g.id = f.group_id WHERE f.version_key = ? AND f.status = 'done' AND ${scope.sql}
           ORDER BY f.version_rank DESC, f.received_at DESC`,
        )
          .bind(file.version_key, ...scope.binds)
          .all()
      ).results
    : [];
  const duplicates = (
    await c.env.DB.prepare(`SELECT f.id, COALESCE(f.stored_name, f.original_name) AS name, f.status, f.folder_path FROM files f WHERE (f.duplicate_of = ? OR f.id = ?) AND f.id != ? AND f.status != 'deleted' AND ${scope.sql}`)
      .bind(file.id, file.duplicate_of ?? -1, file.id, ...scope.binds)
      .all()
  ).results;
  return c.json({
    ...shapeFile(row!),
    content_excerpt: file.content_text?.slice(0, 1200) ?? null,
    ai_suggestion: file.ai_suggestion ? JSON.parse(file.ai_suggestion) : null,
    versions,
    duplicates,
  });
});

/** 比對兩個版本：回傳兩邊擷取出的文字，由前端做差異比對 */
files.get('/files/:id/compare/:other', async (c) => {
  const a = await visibleFile(c, intParam(c));
  const b = await visibleFile(c, intParam(c, 'other'));
  const pick = (f: FileRow) => ({ id: f.id, name: f.stored_name ?? f.original_name, version_label: f.version_label, received_at: f.received_at, summary: f.ai_summary, text: f.content_text ?? '', size: f.size, sender: f.sender_name });
  return c.json({ a: pick(a), b: pick(b) });
});

/** 透過系統下載／預覽（WebDAV、展示版這類沒有公開連結的空間） */
files.get('/files/:id/download', async (c) => {
  const file = await visibleFile(c, intParam(c));
  if (!file.drive_file_id) throw notFound('檔案尚未上傳');
  const storage = await getStorage(c.env, file.storage_id);
  if (!storage) throw notFound('找不到雲端空間');
  const res = await providerFor(c.env, storage).download(file.drive_file_id);
  const name = file.stored_name ?? file.original_name;
  return new Response(res.body, {
    headers: {
      'Content-Type': file.mime_type ?? res.headers.get('Content-Type') ?? 'application/octet-stream',
      'Content-Disposition': `${c.req.query('inline') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, max-age=300',
    },
  });
});

interface PatchBody {
  folderPath?: string;
  storedName?: string;
  projectId?: number | null;
  tags?: string[];
}

files.patch('/files/:id', async (c) => {
  const user = need(c, 'editor');
  const file = await visibleFile(c, intParam(c));
  const body = await readJson<PatchBody>(c);
  let suggestion = null;
  let batchId: string | null = null;
  if (body.folderPath != null || body.storedName != null) {
    if (file.status !== 'done') throw bad('只有已歸檔的檔案可以搬移或改名');
    const folderPath = body.folderPath != null ? cleanFolderPath(body.folderPath) : file.folder_path!;
    const storedName = body.storedName != null ? sanitizeSegment(body.storedName) : file.stored_name!;
    if (!storedName || storedName === '_') throw bad('檔名不能是空的');
    batchId = newBatchId();
    const r = await moveFile(c.env, file, folderPath, storedName, {
      batchId,
      description: `移動「${file.stored_name}」到 ${folderPath}`,
      userEmail: user.email,
      manual: true,
    });
    await log(c.env, 'info', 'manual', `${user.email} 將「${file.stored_name}」移到 ${r.folderPath}/${r.storedName}`, file.id);
    if (folderPath !== file.folder_path) suggestion = await learnFromMove(c.env, file.id);
  }
  if (body.projectId !== undefined) {
    await c.env.DB.prepare("UPDATE files SET project_id = ?, updated_at = datetime('now') WHERE id = ?").bind(body.projectId, file.id).run();
  }
  if (body.tags) {
    await c.env.DB.prepare('DELETE FROM file_tags WHERE file_id = ?').bind(file.id).run();
    await addTags(c.env, file.id, body.tags, 'manual');
    await indexFile(c.env, file.id);
  }
  return c.json({ ok: true, batchId, suggestion });
});

/** 批次設定專案／加標籤／移除標籤（看板拖拉、多選操作都用這個） */
files.post('/files/bulk', async (c) => {
  const user = need(c, 'editor');
  const b = await readJson<{ ids: number[]; projectId?: number | null; addTags?: string[]; removeTags?: string[] }>(c);
  if (!Array.isArray(b.ids) || !b.ids.length) throw bad('請選擇檔案');
  if (b.projectId) {
    const p = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(b.projectId).first();
    if (!p) throw bad('找不到這個專案');
  }
  let updated = 0;
  for (const id of b.ids.slice(0, 500)) {
    let file: FileRow;
    try {
      file = await visibleFile(c, id);
    } catch {
      continue;
    }
    if (b.projectId !== undefined) await c.env.DB.prepare("UPDATE files SET project_id = ?, updated_at = datetime('now') WHERE id = ?").bind(b.projectId, file.id).run();
    if (b.addTags?.length) await addTags(c.env, file.id, b.addTags, 'manual');
    if (b.removeTags?.length) {
      for (const t of b.removeTags) await c.env.DB.prepare('DELETE FROM file_tags WHERE file_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)').bind(file.id, t).run();
    }
    if (b.addTags?.length || b.removeTags?.length) await indexFile(c.env, file.id);
    updated++;
  }
  const what = [b.projectId !== undefined ? (b.projectId ? '設定專案' : '移出專案') : '', b.addTags?.length ? `加上標籤 ${b.addTags.join('、')}` : '', b.removeTags?.length ? `移除標籤 ${b.removeTags.join('、')}` : '']
    .filter(Boolean)
    .join('、');
  await log(c.env, 'info', 'manual', `${user.email} 對 ${updated} 個檔案${what}`);
  return c.json({ updated });
});

/** 批次搬移（拖拉多個檔案到資料夾） */
files.post('/files/move', async (c) => {
  const user = need(c, 'editor');
  const { ids, folderPath } = await readJson<{ ids: number[]; folderPath: string }>(c);
  if (!Array.isArray(ids) || !ids.length) throw bad('請選擇檔案');
  const folder = cleanFolderPath(folderPath);
  const batchId = newBatchId();
  let moved = 0;
  const errors: string[] = [];
  let suggestion = null;
  for (const id of ids.slice(0, 200)) {
    try {
      const file = await visibleFile(c, id);
      if (file.status !== 'done') continue;
      await moveFile(c.env, file, folder, file.stored_name!, { batchId, description: `批次移動 ${ids.length} 個檔案到 ${folder}`, userEmail: user.email, manual: true });
      moved++;
      suggestion = (await learnFromMove(c.env, id)) ?? suggestion;
    } catch (e) {
      errors.push(`#${id}：${(e as Error).message}`);
    }
  }
  await log(c.env, errors.length ? 'warn' : 'info', 'manual', `${user.email} 批次移動 ${moved} 個檔案到 ${folder}${errors.length ? `，${errors.length} 個失敗` : ''}`);
  return c.json({ moved, errors, batchId, suggestion });
});

async function deleteOne(c: Ctx, file: FileRow) {
  if (file.drive_file_id && (file.status === 'done' || file.status === 'duplicate')) {
    const storage = await getStorage(c.env, file.storage_id);
    if (storage) await providerFor(c.env, storage).trash(file.drive_file_id);
  }
  await c.env.DB.prepare("UPDATE files SET status = 'deleted', updated_at = datetime('now') WHERE id = ?").bind(file.id).run();
  await indexFile(c.env, file.id);
  await emitWebhook(c.env, { event: 'file.deleted', file: { id: file.id, name: file.stored_name ?? file.original_name } });
}

files.delete('/files/:id', async (c) => {
  const user = need(c, 'editor');
  const file = await visibleFile(c, intParam(c));
  await deleteOne(c, file);
  await log(c.env, 'info', 'delete', `${user.email} 刪除「${file.stored_name ?? file.original_name}」（已移到雲端垃圾桶）`, file.id);
  return c.json({ ok: true });
});

files.post('/files/delete', async (c) => {
  const user = need(c, 'editor');
  const { ids } = await readJson<{ ids: number[] }>(c);
  let n = 0;
  for (const id of ids ?? []) {
    try {
      await deleteOne(c, await visibleFile(c, id));
      n++;
    } catch {
      // 略過沒有權限或已不存在的檔案
    }
  }
  await log(c.env, 'info', 'delete', `${user.email} 批次刪除 ${n} 個檔案`);
  return c.json({ deleted: n });
});

files.post('/files/:id/retry', async (c) => {
  need(c, 'editor');
  const file = await visibleFile(c, intParam(c));
  if (!['failed', 'pending', 'skipped'].includes(file.status)) throw bad('只有失敗、等待中或略過的檔案可以重新處理');
  if (file.source !== 'line') throw bad('Email 或手動上傳的檔案無法重試，請重新上傳');
  await c.env.DB.prepare("UPDATE files SET status = 'pending', attempts = 0, error = NULL, updated_at = datetime('now') WHERE id = ?").bind(file.id).run();
  await enqueueFile(c.env, c.executionCtx, file.id);
  return c.json({ ok: true });
});

/** 重複檔案：仍要保留 → 搬回原本要放的位置 */
files.post('/files/:id/keep', async (c) => {
  const user = need(c, 'editor');
  const file = await visibleFile(c, intParam(c));
  if (file.status !== 'duplicate' || !file.drive_file_id) throw bad('這不是重複檔案');
  await c.env.DB.prepare("UPDATE files SET status = 'done', duplicate_of = NULL WHERE id = ?").bind(file.id).run();
  const r = await moveFile(c.env, { ...file, status: 'done' }, file.target_folder || '待分類', file.stored_name!, {
    batchId: newBatchId(),
    description: `保留重複檔案「${file.stored_name}」`,
    userEmail: user.email,
    manual: false,
  });
  await indexFile(c.env, file.id);
  await log(c.env, 'info', 'duplicate', `${user.email} 保留重複檔案，放到 ${r.folderPath}/${r.storedName}`, file.id);
  return c.json({ ok: true, ...r });
});

/** 採用 AI 建議的分類 */
files.post('/files/:id/accept-ai', async (c) => {
  const user = need(c, 'editor');
  const file = await visibleFile(c, intParam(c));
  const s = file.ai_suggestion ? (JSON.parse(file.ai_suggestion) as { folder: string | null; project: string | null }) : null;
  if (!s?.folder || file.status !== 'done') throw bad('沒有可以採用的 AI 建議');
  const batchId = newBatchId();
  const r = await moveFile(c.env, file, cleanFolderPath(s.folder), file.stored_name!, { batchId, description: `採用 AI 建議：${s.folder}`, userEmail: user.email, manual: false });
  await c.env.DB.prepare("UPDATE files SET unsorted = 0, classified_by = 'ai' WHERE id = ?").bind(file.id).run();
  return c.json({ ok: true, batchId, ...r });
});

/** 重新套用規則：先 dryRun 預覽，確認後再搬移；手動調整過的檔案不會動 */
files.post('/files/reapply', async (c) => {
  const user = need(c, 'editor');
  const body = await readJson<{ scope?: 'unsorted' | 'all'; dryRun?: boolean }>(c);
  const scope = body.scope === 'all' ? 'all' : 'unsorted';
  const dryRun = body.dryRun !== false;
  const vis = fileScope(user);
  const list = await c.env.DB.prepare(
    `SELECT * FROM files f WHERE f.status = 'done' AND f.manual = 0 AND ${vis.sql} ${scope === 'unsorted' ? 'AND f.unsorted = 1' : "AND f.classified_by != 'ai'"} ORDER BY f.received_at DESC LIMIT 300`,
  )
    .bind(...vis.binds)
    .all<FileRow>();
  const rules = await listRules(c.env);
  const groups = new Map<string, Awaited<ReturnType<typeof getGroup>>>();
  const changes: { id: number; name: string; from: string; to: string; rule: string | null; ruleId: number | null; unsorted: boolean }[] = [];
  for (const f of list.results) {
    if (!groups.has(f.group_id)) groups.set(f.group_id, await getGroup(c.env, f.group_id));
    const r = classifyFile(c.env, f, groups.get(f.group_id)!, rules);
    if (r.folderPath !== f.folder_path && !(r.unsorted && scope === 'unsorted')) {
      changes.push({ id: f.id, name: f.stored_name ?? f.original_name, from: f.folder_path ?? '', to: r.folderPath, rule: r.rule?.name ?? null, ruleId: r.rule?.id ?? null, unsorted: r.unsorted });
    }
  }
  if (dryRun) return c.json({ dryRun: true, changes });
  const batchId = newBatchId();
  let moved = 0;
  const errors: string[] = [];
  for (const ch of changes) {
    const f = list.results.find((x) => x.id === ch.id)!;
    try {
      await moveFile(c.env, f, ch.to, f.stored_name!, { batchId, description: `重新套用規則（${changes.length} 個檔案）`, userEmail: user.email, manual: false });
      await c.env.DB.prepare("UPDATE files SET unsorted = ?, matched_rule_id = ?, classified_by = ? WHERE id = ?")
        .bind(ch.unsorted ? 1 : 0, ch.ruleId, ch.ruleId ? 'rule' : 'none', f.id)
        .run();
      // 規則有指定專案、標籤時一起套用
      const rule = ch.ruleId ? rules.find((x) => x.id === ch.ruleId) : null;
      if (rule?.project_id) await c.env.DB.prepare('UPDATE files SET project_id = ? WHERE id = ?').bind(rule.project_id, f.id).run();
      if (rule?.tags) await addTags(c.env, f.id, rule.tags.split(/[,，、]/).map((x) => x.trim()).filter(Boolean), 'rule');
      moved++;
    } catch (e) {
      errors.push(`${ch.name}：${(e as Error).message}`);
    }
  }
  await log(c.env, errors.length ? 'warn' : 'info', 'reapply', `${user.email} 重新套用規則：搬移 ${moved} 個檔案${errors.length ? `，${errors.length} 個失敗` : ''}`);
  return c.json({ dryRun: false, moved, errors, changes, batchId });
});

/** 手動上傳（網頁、手機都可以） */
files.post('/upload', async (c) => {
  const user = need(c, 'editor');
  const form = await c.req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw bad('請選擇檔案');
  const blob = file as unknown as File;
  if (blob.size > 95 * 1024 * 1024) throw bad('網頁上傳單檔上限約 95MB');
  const folder = (form.get('folder') as string | null)?.trim();
  const project = Number(form.get('projectId') ?? 0) || null;
  const r = await ingestBuffer(c.env, {
    groupId: 'upload',
    groupType: 'upload',
    groupName: '手動上傳',
    name: blob.name,
    mime: blob.type,
    data: await blob.arrayBuffer(),
    sender: user.name ?? user.email,
    key: `upload:${crypto.randomUUID()}`,
    folder: folder ? cleanFolderPath(folder) : null,
    projectId: project,
  });
  if (!r.fileId) throw bad('「手動上傳」來源目前停用，或設定不接收這種檔案');
  const row = await getFile(c.env, r.fileId);
  return c.json({ id: r.fileId, status: row?.status, error: row?.error, folder: row?.folder_path, name: row?.stored_name });
});

// ---------- 資料夾 ----------

files.get('/folders', async (c) => {
  const scope = fileScope(c.get('user'));
  const storageId = Number(c.req.query('storage') ?? 0) || null;
  const r = await c.env.DB.prepare(
    `SELECT f.storage_id, f.folder_path AS path, COUNT(*) AS count, COALESCE(SUM(f.size), 0) AS bytes FROM files f
     WHERE f.status = 'done' AND f.folder_path IS NOT NULL AND ${scope.sql} ${storageId ? 'AND f.storage_id = ?' : ''}
     GROUP BY f.storage_id, f.folder_path ORDER BY f.folder_path`,
  )
    .bind(...scope.binds, ...(storageId ? [storageId] : []))
    .all<{ storage_id: number; path: string; count: number; bytes: number }>();
  return c.json({ items: r.results });
});

files.post('/folders/rename', async (c) => {
  const user = need(c, 'editor');
  const { storageId, from, to } = await readJson<{ storageId: number; from: string; to: string }>(c);
  const src = cleanFolderPath(from);
  const dst = cleanFolderPath(to);
  if (src === dst) throw bad('名稱沒有改變');
  if (dst.startsWith(`${src}/`)) throw bad('不能把資料夾移到自己裡面');
  const exists = await c.env.DB.prepare("SELECT 1 FROM files WHERE storage_id = ? AND status = 'done' AND (folder_path = ? OR folder_path LIKE ?) LIMIT 1")
    .bind(storageId, dst, `${dst}/%`)
    .first();
  if (exists) throw bad('目標資料夾已經有檔案，請改用「移動檔案」或換一個名稱');
  const batchId = newBatchId();
  const n = await renameFolder(c.env, storageId, src, dst, { batchId, description: `資料夾「${src}」改名為「${dst}」`, userEmail: user.email });
  await log(c.env, 'info', 'folder', `${user.email} 將資料夾「${src}」改為「${dst}」（${n} 個檔案，相關規則已同步更新）`);
  return c.json({ ok: true, moved: n, batchId });
});

// ---------- 操作紀錄與復原 ----------

files.get('/operations', async (c) => {
  need(c, 'editor');
  const r = await c.env.DB.prepare(
    `SELECT batch_id, MIN(description) AS description, MIN(user_email) AS user_email, COUNT(*) AS count, MIN(created_at) AS created_at, MIN(undone) AS undone
     FROM operations GROUP BY batch_id ORDER BY MAX(id) DESC LIMIT 50`,
  ).all();
  return c.json({ items: r.results });
});

files.post('/operations/:batch/undo', async (c) => {
  const user = need(c, 'editor');
  const r = await undoBatch(c.env, c.req.param('batch'), user.email);
  if (!r.undone && r.errors.length) throw bad(`無法復原：${r.errors[0]}`);
  return c.json(r);
});

export { DUPLICATE_FOLDER };
