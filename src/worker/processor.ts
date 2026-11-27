// 歸檔流程：取得內容 → 三層分類（群組 → 規則 → AI）→ 上傳 → 去重 → 版本 → 標籤／專案 → 索引 → 通知
import type { Env, FileJob, WaitUntil } from './env';
import { PermanentError, RetryLaterError } from './env';
import { addTags, getFile, getGroup, getSetting, groupDisplayName, listRules, log, projectIdByName, type FileRow, type GroupRow } from './db';
import { classify, splitList, type ClassifyResult, type Rule } from './rules';
import { downloadContent, getTranscodingStatus } from './line';
import { getStorage, providerFor, StorageError, type Body, type StorageRow } from './storage';
import { aiEngine, AI_MAX_BYTES, type AnalyzeResult } from './ai';
import { extractContent, type Extracted } from './extract';
import { versionInfo } from './versions';
import { indexFile } from './search';
import { emitWebhook, replyArchived } from './notify';

export const MAX_ATTEMPTS = 6;
export const DUPLICATE_FOLDER = '_重複檔案';
const TEXT_EXTRACT_EXT = new Set(['docx', 'pptx', 'xlsx', 'txt', 'csv', 'md', 'tsv', 'json']);

export interface Content {
  body: Body;
  length: number | null;
  mime: string;
}
export type ContentSource = () => Promise<Content>;

export async function enqueueFile(env: Env, ctx: WaitUntil, fileId: number): Promise<void> {
  if (env.FILE_QUEUE) {
    await env.FILE_QUEUE.send({ fileId });
  } else {
    // 沒有設定 Queue 時（本機開發、展示版）直接在背景處理
    ctx.waitUntil(processWithStatus(env, fileId, 1).catch(() => {}));
  }
}

export function classifyFile(env: Env, file: FileRow, group: GroupRow | null, rules: Rule[]): ClassifyResult {
  return classify(
    rules,
    {
      fileName: file.original_name,
      groupId: file.group_id,
      groupName: groupDisplayName(group, file.group_id),
      senderName: file.sender_name,
      receivedAt: new Date(file.received_at),
      timeZone: env.TIMEZONE || 'Asia/Taipei',
    },
    { fallbackPath: group?.base_folder, defaultRename: group?.rename_template },
  );
}

/** LINE 檔案的內容來源 */
export function lineSource(env: Env, file: FileRow): ContentSource {
  return async () => {
    const token = env.LINE_CHANNEL_ACCESS_TOKEN;
    if (file.message_type === 'video' || file.message_type === 'audio') {
      const status = await getTranscodingStatus(token, file.line_message_id);
      if (status === 'processing') throw new RetryLaterError('LINE 還在轉檔，稍後再試', 30);
      if (status === 'failed') throw new PermanentError('LINE 轉檔失敗，無法下載');
    }
    const res = await downloadContent(token, file.line_message_id);
    if (res.status === 404 || res.status === 410) throw new PermanentError('LINE 上的檔案已過期或不存在，無法下載');
    if (!res.ok || !res.body) throw new Error(`LINE 下載失敗：HTTP ${res.status}`);
    const len = res.headers.get('Content-Length');
    return { body: res.body, length: len ? Number(len) : file.size, mime: res.headers.get('Content-Type') || 'application/octet-stream' };
  };
}

async function existingFolders(env: Env, storageId: number): Promise<string[]> {
  const r = await env.DB.prepare(
    "SELECT folder_path, COUNT(*) AS n FROM files WHERE status = 'done' AND storage_id = ? AND folder_path IS NOT NULL AND folder_path NOT LIKE '待分類%' GROUP BY folder_path ORDER BY n DESC LIMIT 80",
  )
    .bind(storageId)
    .all<{ folder_path: string }>();
  const fromRules = (await env.DB.prepare('SELECT DISTINCT target_path FROM rules WHERE enabled = 1').all<{ target_path: string }>()).results.map((x) => x.target_path);
  return [...new Set([...r.results.map((x) => x.folder_path), ...fromRules])];
}

async function runAi(env: Env, file: FileRow, group: GroupRow | null, storage: StorageRow, data: ArrayBuffer | null, mime: string, extracted: Extracted): Promise<AnalyzeResult | null> {
  if (group && !group.ai_enabled) return null;
  const engine = await aiEngine(env);
  if (!engine) return null;
  try {
    const [folders, projects, tags] = await Promise.all([
      existingFolders(env, storage.id),
      env.DB.prepare('SELECT name FROM projects ORDER BY name').all<{ name: string }>(),
      env.DB.prepare('SELECT t.name FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id GROUP BY t.id ORDER BY COUNT(ft.file_id) DESC LIMIT 80').all<{ name: string }>(),
    ]);
    return await engine.analyze({
      fileName: file.original_name,
      mime,
      data,
      extracted,
      groupName: groupDisplayName(group, file.group_id),
      folders,
      projects: projects.results.map((p) => p.name),
      tags: tags.results.map((t) => t.name),
    });
  } catch (e) {
    await log(env, 'warn', 'ai', `AI 判讀失敗，改用規則分類：${(e as Error).message}`, file.id);
    return null;
  }
}

export interface ArchiveOptions {
  /** 手動上傳時使用者指定的資料夾 */
  folderOverride?: string | null;
  projectOverride?: number | null;
  /** 內容重複也要保存 */
  forceKeep?: boolean;
}

export async function archiveFile(env: Env, fileId: number, source: ContentSource, opts: ArchiveOptions = {}): Promise<void> {
  const file = await getFile(env, fileId);
  if (!file || ['done', 'deleted', 'skipped'].includes(file.status) || (file.status === 'duplicate' && !opts.forceKeep)) return;
  await env.DB.prepare("UPDATE files SET status = 'processing', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").bind(fileId).run();

  const group = await getGroup(env, file.group_id);
  const storage = await getStorage(env, group?.storage_id ?? file.storage_id);
  if (!storage) throw new PermanentError('還沒有設定雲端空間，請到「雲端設定」新增');
  const provider = providerFor(env, storage);
  const rules = await listRules(env);
  const result = classifyFile(env, file, group, rules);

  // 第一～二層：群組設定＋檔名規則
  let folder = result.folderPath;
  let classifiedBy: string = result.rule ? 'rule' : 'none';
  let unsorted = result.unsorted;
  let projectId = result.rule?.project_id ?? group?.project_id ?? null;
  const tagNames = splitList(result.rule?.tags);

  const content = await source();
  let body = content.body;
  let data: ArrayBuffer | null = null;
  let extracted: Extracted = { kind: 'none', text: '' };
  const small = content.length != null ? content.length <= AI_MAX_BYTES : true;
  const wantsAi = !group || !!group.ai_enabled;
  if (small && (wantsAi || TEXT_EXTRACT_EXT.has(file.ext))) {
    const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    body = buf;
    if (buf.byteLength <= AI_MAX_BYTES) {
      data = buf;
      extracted = extractContent(file.original_name, content.mime, data);
    }
  }

  // 第三層：AI 判讀內容（摘要、標籤一律保存；分類只在規則沒有符合時採用）
  const ai = wantsAi ? await runAi(env, file, group, storage, data, content.mime, extracted) : null;
  const threshold = Number((await getSetting(env, 'ai_threshold')) ?? 0.7);
  if (ai) {
    tagNames.push(...ai.tags);
    projectId ??= await projectIdByName(env, ai.project);
    if (!result.rule && ai.folder && ai.confidence >= threshold) {
      folder = ai.folder
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean)
        .join('/');
      classifiedBy = 'ai';
      unsorted = false;
    }
  }
  if (opts.folderOverride) {
    folder = opts.folderOverride;
    classifiedBy = 'manual';
    unsorted = false;
  }
  if (opts.projectOverride) projectId = opts.projectOverride;
  if (unsorted && group?.base_folder) classifiedBy = 'group';

  const uploaded = await provider.upload(folder, result.storedName, content.mime, body, body instanceof ArrayBuffer ? body.byteLength : content.length);
  const version = versionInfo(file.original_name);
  const engine = ai ? await aiEngine(env) : null;
  const common = {
    hash: uploaded.hash,
    size: uploaded.size,
    mime: content.mime,
    rule: result.rule?.id ?? null,
    summary: ai?.summary ?? null,
    suggestion: ai ? JSON.stringify({ folder: ai.folder, project: ai.project, tags: ai.tags, confidence: ai.confidence, reason: ai.reason, model: engine?.name }) : null,
    text: (extracted.text || ai?.text || '').slice(0, 20_000) || null,
  };

  // 去重：內容相同就移到「_重複檔案」，可以在介面決定保留或刪除
  if (uploaded.hash && !opts.forceKeep) {
    const dup = await env.DB.prepare("SELECT id, stored_name, folder_path FROM files WHERE content_md5 = ? AND status = 'done' AND id != ? LIMIT 1")
      .bind(uploaded.hash, fileId)
      .first<{ id: number; stored_name: string; folder_path: string }>();
    if (dup) {
      const moved = await provider.move(uploaded.ref, DUPLICATE_FOLDER, uploaded.name);
      await env.DB.prepare(
        `UPDATE files SET status = 'duplicate', duplicate_of = ?, content_md5 = ?, size = ?, mime_type = ?, storage_id = ?, drive_file_id = ?, drive_link = ?,
         stored_name = ?, folder_path = ?, target_folder = ?, matched_rule_id = ?, project_id = ?, classified_by = ?, unsorted = ?, ai_summary = ?, ai_suggestion = ?,
         content_text = ?, version_key = ?, version_label = ?, version_rank = ?, error = NULL, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(dup.id, common.hash, common.size, common.mime, storage.id, moved.ref, moved.link ?? uploaded.link, moved.name, DUPLICATE_FOLDER, folder, common.rule, projectId, classifiedBy, unsorted ? 1 : 0, common.summary, common.suggestion, common.text, version.key, version.label, version.rank, fileId)
        .run();
      if (tagNames.length) await addTags(env, fileId, tagNames, result.rule ? 'rule' : 'ai');
      await log(env, 'info', 'duplicate', `「${file.original_name}」與 ${dup.folder_path}/${dup.stored_name} 內容相同，已放到 ${DUPLICATE_FOLDER}`, fileId);
      return;
    }
  }

  await env.DB.prepare(
    `UPDATE files SET status = 'done', content_md5 = ?, size = ?, mime_type = ?, storage_id = ?, drive_file_id = ?, drive_link = ?, stored_name = ?, folder_path = ?,
     target_folder = NULL, matched_rule_id = ?, project_id = ?, classified_by = ?, unsorted = ?, ai_summary = ?, ai_suggestion = ?, content_text = ?,
     version_key = ?, version_label = ?, version_rank = ?, duplicate_of = NULL, error = NULL, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(common.hash, common.size, common.mime, storage.id, uploaded.ref, uploaded.link, uploaded.name, folder, common.rule, projectId, classifiedBy, unsorted ? 1 : 0, common.summary, common.suggestion, common.text, version.key, version.label, version.rank, fileId)
    .run();
  if (tagNames.length) await addTags(env, fileId, tagNames, result.rule ? 'rule' : 'ai');
  await indexFile(env, fileId);

  const how: Record<string, string> = {
    rule: `規則「${result.rule?.name}」`,
    ai: `AI 判讀（把握度 ${Math.round((ai?.confidence ?? 0) * 100)}%）`,
    manual: '手動指定',
    group: '群組預設資料夾（待確認）',
    none: '待分類',
  };
  await log(env, 'info', 'archived', `「${file.original_name}」→ ${storage.name}：${folder}/${uploaded.name}（${how[classifiedBy]}）`, fileId);

  if (group?.notify && file.source === 'line' && !file.image_set_id) {
    await replyArchived(env, file.reply_token, file.received_at, unsorted ? `📥 已收到「${uploaded.name}」，放在 ${folder}，等待分類` : `✅ 已歸檔「${uploaded.name}」\n📁 ${folder}`, fileId);
  }
  await emitWebhook(env, {
    event: 'file.archived',
    file: { id: fileId, name: uploaded.name, original_name: file.original_name, folder, storage: storage.name, link: uploaded.link, group: groupDisplayName(group, file.group_id), source: file.source, summary: ai?.summary ?? null, tags: tagNames },
  });
}

async function markFailed(env: Env, fileId: number, message: string): Promise<void> {
  await env.DB.prepare("UPDATE files SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?").bind(message.slice(0, 1000), fileId).run();
  await log(env, 'error', 'failed', message, fileId);
}

export type Outcome = { outcome: 'done' } | { outcome: 'retry'; delaySeconds: number } | { outcome: 'failed' };

/** 執行並分類錯誤：永久錯誤直接失敗、暫時錯誤重試（指數退避） */
export async function runWithStatus(env: Env, fileId: number, attempt: number, fn: () => Promise<void>): Promise<Outcome> {
  try {
    await fn();
    return { outcome: 'done' };
  } catch (e) {
    const err = e as Error;
    if (e instanceof PermanentError || (e instanceof StorageError && e.permanent)) {
      await markFailed(env, fileId, err.message);
      return { outcome: 'failed' };
    }
    if (attempt >= MAX_ATTEMPTS) {
      await markFailed(env, fileId, e instanceof RetryLaterError ? `等待逾時：${err.message}` : `重試 ${attempt} 次仍失敗：${err.message}`);
      return { outcome: 'failed' };
    }
    await env.DB.prepare("UPDATE files SET status = 'pending', error = ?, updated_at = datetime('now') WHERE id = ?").bind(err.message.slice(0, 1000), fileId).run();
    if (e instanceof RetryLaterError) return { outcome: 'retry', delaySeconds: e.delaySeconds };
    await log(env, 'warn', 'retry', `第 ${attempt} 次處理失敗，稍後重試：${err.message}`, fileId);
    return { outcome: 'retry', delaySeconds: Math.min(30 * 2 ** (attempt - 1), 600) };
  }
}

export async function processWithStatus(env: Env, fileId: number, attempt: number, opts: ArchiveOptions = {}): Promise<Outcome> {
  const file = await getFile(env, fileId);
  if (!file) return { outcome: 'failed' };
  if (file.source !== 'line') {
    await markFailed(env, fileId, '這個檔案來自 Email 或手動上傳，原始內容已不在系統中，請重新上傳');
    return { outcome: 'failed' };
  }
  return runWithStatus(env, fileId, attempt, () => archiveFile(env, fileId, lineSource(env, file), opts));
}

export async function handleQueue(batch: MessageBatch<FileJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const r = await processWithStatus(env, msg.body.fileId, msg.attempts);
    if (r.outcome === 'retry') msg.retry({ delaySeconds: r.delaySeconds });
    else msg.ack();
  }
}
