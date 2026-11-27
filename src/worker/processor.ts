// 背景處理：下載 LINE 檔案 → 套用規則 → 上傳 Google Drive → 去重 → 記錄
import type { Env, FileJob, WaitUntil } from './env';
import { PermanentError, RetryLaterError } from './env';
import { getFile, getGroup, groupDisplayName, listRules, log, type FileRow } from './db';
import { classify } from './rules';
import { downloadContent, getTranscodingStatus } from './line';
import { Drive, driveLink } from './drive';

export const MAX_ATTEMPTS = 6;

export async function enqueueFile(env: Env, ctx: WaitUntil, fileId: number): Promise<void> {
  if (env.FILE_QUEUE) {
    await env.FILE_QUEUE.send({ fileId });
  } else {
    // 沒有設定 Queue 時（例如本機開發）直接在背景處理
    ctx.waitUntil(processWithStatus(env, fileId, 1).catch(() => {}));
  }
}

export function classifyFile(env: Env, file: FileRow, groupName: string, rules: Awaited<ReturnType<typeof listRules>>) {
  return classify(rules, {
    fileName: file.original_name,
    groupId: file.group_id,
    groupName,
    senderName: file.sender_name,
    receivedAt: new Date(file.received_at),
    timeZone: env.TIMEZONE || 'Asia/Taipei',
  });
}

export async function processFile(env: Env, fileId: number): Promise<void> {
  const file = await getFile(env, fileId);
  if (!file) return;
  if (file.status === 'done' || file.status === 'duplicate' || file.status === 'deleted') return;

  await env.DB.prepare(
    "UPDATE files SET status = 'processing', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(fileId)
    .run();

  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (file.message_type === 'video' || file.message_type === 'audio') {
    const status = await getTranscodingStatus(token, file.line_message_id);
    if (status === 'processing') throw new RetryLaterError('LINE 還在轉檔，稍後再試', 30);
    if (status === 'failed') throw new PermanentError('LINE 轉檔失敗，無法下載');
  }

  const group = await getGroup(env, file.group_id);
  const result = classifyFile(env, file, groupDisplayName(group, file.group_id), await listRules(env));

  const drive = await Drive.connect(env);
  const folderId = await drive.ensureFolder(result.folderPath);
  const name = await drive.uniqueName(folderId, result.storedName);

  const res = await downloadContent(token, file.line_message_id);
  if (res.status === 404 || res.status === 410) {
    throw new PermanentError('LINE 上的檔案已過期或不存在，無法下載');
  }
  if (!res.ok || !res.body) throw new Error(`LINE 下載失敗：HTTP ${res.status}`);
  const mime = res.headers.get('Content-Type') || 'application/octet-stream';
  const lenHeader = res.headers.get('Content-Length');
  const length = lenHeader ? Number(lenHeader) : file.size;

  const uploaded = await drive.upload(folderId, name, mime, res.body, length ?? null);

  // 去重：Drive 算出的 MD5 和已歸檔檔案相同 → 刪掉新上傳的那份
  if (uploaded.md5) {
    const dup = await env.DB.prepare(
      "SELECT id, stored_name, folder_path FROM files WHERE content_md5 = ? AND status = 'done' AND id != ? LIMIT 1",
    )
      .bind(uploaded.md5, fileId)
      .first<{ id: number; stored_name: string; folder_path: string }>();
    if (dup) {
      await drive.trash(uploaded.id);
      await env.DB.prepare(
        `UPDATE files SET status = 'duplicate', duplicate_of = ?, content_md5 = ?, size = ?, mime_type = ?,
         stored_name = ?, folder_path = ?, matched_rule_id = ?, unsorted = ?, error = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      )
        .bind(dup.id, uploaded.md5, uploaded.size, mime, name, result.folderPath, result.rule?.id ?? null, result.unsorted ? 1 : 0, fileId)
        .run();
      await log(env, 'info', 'duplicate', `「${file.original_name}」與已歸檔的 ${dup.folder_path}/${dup.stored_name} 內容相同，已略過`, fileId);
      return;
    }
  }

  await env.DB.prepare(
    `UPDATE files SET status = 'done', drive_file_id = ?, drive_link = ?, content_md5 = ?, size = ?, mime_type = ?,
     stored_name = ?, folder_path = ?, matched_rule_id = ?, unsorted = ?, error = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(
      uploaded.id,
      driveLink(uploaded.id),
      uploaded.md5,
      uploaded.size,
      mime,
      name,
      result.folderPath,
      result.rule?.id ?? null,
      result.unsorted ? 1 : 0,
      fileId,
    )
    .run();
  await log(
    env,
    'info',
    'archived',
    `「${file.original_name}」→ ${result.folderPath}/${name}${result.rule ? `（規則：${result.rule.name}）` : '（待分類）'}`,
    fileId,
  );
}

async function markFailed(env: Env, fileId: number, message: string): Promise<void> {
  await env.DB.prepare("UPDATE files SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(message.slice(0, 1000), fileId)
    .run();
  await log(env, 'error', 'failed', message, fileId);
}

/** 處理並回報結果：'done' | 'retry'（含延遲秒數）| 'failed' */
export async function processWithStatus(
  env: Env,
  fileId: number,
  attempt: number,
): Promise<{ outcome: 'done' } | { outcome: 'retry'; delaySeconds: number } | { outcome: 'failed' }> {
  try {
    await processFile(env, fileId);
    return { outcome: 'done' };
  } catch (e) {
    const err = e as Error;
    if (e instanceof PermanentError) {
      await markFailed(env, fileId, err.message);
      return { outcome: 'failed' };
    }
    if (e instanceof RetryLaterError) {
      if (attempt >= MAX_ATTEMPTS) {
        await markFailed(env, fileId, `等待逾時：${err.message}`);
        return { outcome: 'failed' };
      }
      await env.DB.prepare("UPDATE files SET status = 'pending', error = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(err.message, fileId)
        .run();
      return { outcome: 'retry', delaySeconds: e.delaySeconds };
    }
    if (attempt >= MAX_ATTEMPTS) {
      await markFailed(env, fileId, `重試 ${attempt} 次仍失敗：${err.message}`);
      return { outcome: 'failed' };
    }
    await env.DB.prepare("UPDATE files SET status = 'pending', error = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(err.message.slice(0, 1000), fileId)
      .run();
    await log(env, 'warn', 'retry', `第 ${attempt} 次處理失敗，稍後重試：${err.message}`, fileId);
    return { outcome: 'retry', delaySeconds: Math.min(30 * 2 ** (attempt - 1), 600) };
  }
}

export async function handleQueue(batch: MessageBatch<FileJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const r = await processWithStatus(env, msg.body.fileId, msg.attempts);
    if (r.outcome === 'retry') msg.retry({ delaySeconds: r.delaySeconds });
    else msg.ack();
  }
}
