// 歸檔流程：取得內容 → 分類（群組 → 規則）→ 上傳 → 去重 → 版本 → 標籤／專案 → 索引 → 通知 → 排入 AI 判讀（獨立的背景工作）
import type { Env, FileJob, WaitUntil } from './env';
import { PermanentError, RetryLaterError } from './env';
import { addTags, getFile, getGroup, groupDisplayName, listRules, log, type FileRow, type GroupRow } from './db';
import { classify, splitList, type ClassifyResult, type Rule } from './rules';
import { downloadContent, getTranscodingStatus } from './line';
import { getStorage, providerFor, StorageError, type Body } from './storage';
import { AI_MAX_BYTES } from './ai';
import { queueAi, runAiJob } from './ai-job';
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
  // Office、純文字檔先擷取文字，給全文搜尋用（PDF、圖片的內容由之後的 AI 判讀補上）
  const small = content.length != null ? content.length <= AI_MAX_BYTES : true;
  if (small && TEXT_EXTRACT_EXT.has(file.ext)) {
    const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    body = buf;
    if (buf.byteLength <= AI_MAX_BYTES) {
      data = buf;
      extracted = extractContent(file.original_name, content.mime, data);
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
  const common = {
    hash: uploaded.hash,
    size: uploaded.size,
    mime: content.mime,
    rule: result.rule?.id ?? null,
    summary: null as string | null,
    suggestion: null as string | null,
    text: extracted.text.slice(0, 20_000) || null,
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
         content_text = ?, version_key = ?, version_label = ?, version_rank = ?, root_ref = ?, error = NULL, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(dup.id, common.hash, common.size, common.mime, storage.id, moved.ref, moved.link ?? uploaded.link, moved.name, DUPLICATE_FOLDER, folder, common.rule, projectId, classifiedBy, unsorted ? 1 : 0, common.summary, common.suggestion, common.text, version.key, version.label, version.rank, moved.root ?? uploaded.root ?? null, fileId)
        .run();
      if (tagNames.length) await addTags(env, fileId, tagNames, 'rule');
      await log(env, 'info', 'duplicate', `「${file.original_name}」與 ${dup.folder_path}/${dup.stored_name} 內容相同，已放到 ${DUPLICATE_FOLDER}`, fileId);
      return;
    }
  }

  await env.DB.prepare(
    `UPDATE files SET status = 'done', content_md5 = ?, size = ?, mime_type = ?, storage_id = ?, drive_file_id = ?, drive_link = ?, stored_name = ?, folder_path = ?,
     target_folder = NULL, matched_rule_id = ?, project_id = ?, classified_by = ?, unsorted = ?, ai_summary = ?, ai_suggestion = ?, content_text = ?,
     version_key = ?, version_label = ?, version_rank = ?, root_ref = ?, duplicate_of = NULL, error = NULL, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(common.hash, common.size, common.mime, storage.id, uploaded.ref, uploaded.link, uploaded.name, folder, common.rule, projectId, classifiedBy, unsorted ? 1 : 0, common.summary, common.suggestion, common.text, version.key, version.label, version.rank, uploaded.root ?? null, fileId)
    .run();
  if (tagNames.length) await addTags(env, fileId, tagNames, 'rule');
  await indexFile(env, fileId);

  const how: Record<string, string> = {
    rule: `規則「${result.rule?.name}」`,
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
    file: { id: fileId, name: uploaded.name, original_name: file.original_name, folder, storage: storage.name, link: uploaded.link, group: groupDisplayName(group, file.group_id), source: file.source, summary: null, tags: tagNames },
  });

  // AI 判讀是獨立的附加工作：檔案已經安全歸檔，AI 失敗、關閉或額度用完都不影響
  try {
    await queueAi(env, null, fileId);
  } catch (e) {
    await log(env, 'warn', 'ai', `無法排入 AI 判讀：${(e as Error).message}`, fileId);
  }
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

/**
 * 排程重試（沒有 Queues 時的備援）：撿回等待重試、或處理到一半中斷的檔案。
 * 依嘗試次數拉長間隔：第 n 次失敗後至少等 2^(n-1) × 5 分鐘。
 */
export async function retryPending(env: Env, limit = 5): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, attempts FROM files
     WHERE source = 'line' AND attempts < ? AND (
       (status = 'pending' AND updated_at <= datetime('now', '-' || (5 * (1 << MIN(attempts, 6))) || ' minutes'))
       OR (status = 'processing' AND updated_at <= datetime('now', '-15 minutes')))
     ORDER BY updated_at LIMIT ?`,
  )
    .bind(MAX_ATTEMPTS, limit)
    .all<{ id: number; attempts: number }>();
  for (const r of rows.results) await processWithStatus(env, r.id, r.attempts + 1);
  return rows.results.length;
}

export async function handleQueue(batch: MessageBatch<FileJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    if (msg.body.task === 'ai') {
      // AI 判讀自己處理延後與重試（額度重置後由排程撿回），佇列這邊一律確認
      await runAiJob(env, msg.body.fileId).catch(() => {});
      msg.ack();
      continue;
    }
    const r = await processWithStatus(env, msg.body.fileId, msg.attempts);
    if (r.outcome === 'retry') msg.retry({ delaySeconds: r.delaySeconds });
    else msg.ack();
  }
}
