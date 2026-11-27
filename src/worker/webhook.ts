// LINE webhook：驗證簽章後立刻回 200，實際工作放到背景
import type { Env, WaitUntil } from './env';
import {
  FILE_MESSAGE_TYPES,
  generatedFileName,
  getSenderName,
  getSourceName,
  sourceId,
  verifySignature,
  type LineEvent,
  type WebhookBody,
} from './line';
import { getGroup, groupAccepts, log, touchUploader } from './db';
import { splitExt } from './rules';
import { enqueueFile } from './processor';

export async function handleWebhook(req: Request, env: Env, ctx: WaitUntil): Promise<Response> {
  const body = await req.text();
  const ok = await verifySignature(env.LINE_CHANNEL_SECRET, body, req.headers.get('x-line-signature'));
  if (!ok) return new Response('invalid signature', { status: 401 });

  let parsed: WebhookBody;
  try {
    parsed = JSON.parse(body) as WebhookBody;
  } catch {
    return new Response('bad request', { status: 400 });
  }
  ctx.waitUntil(
    handleEvents(env, ctx, parsed.events ?? []).catch((e) =>
      log(env, 'error', 'webhook', `處理 webhook 失敗：${(e as Error).message}`),
    ),
  );
  return new Response('ok');
}

async function upsertGroup(env: Env, event: LineEvent, joined: boolean) {
  const id = sourceId(event.source);
  const existing = await getGroup(env, id);
  if (!existing) {
    const name = await getSourceName(env.LINE_CHANNEL_ACCESS_TOKEN, event.source).catch(() => '');
    await env.DB.prepare('INSERT OR IGNORE INTO groups (id, source_type, name, joined) VALUES (?, ?, ?, ?)')
      .bind(id, event.source.type, name, joined ? 1 : 0)
      .run();
    await log(env, 'info', 'group', `Bot 加入新群組「${name || id}」，請到「群組」完成設定（在設定前會先用預設值備份）`);
    return getGroup(env, id);
  }
  if (joined && (!existing.joined || !existing.name)) {
    const name = existing.name || (await getSourceName(env.LINE_CHANNEL_ACCESS_TOKEN, event.source).catch(() => ''));
    await env.DB.prepare("UPDATE groups SET joined = 1, name = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(name, id)
      .run();
  }
  return existing;
}

export async function handleEvents(env: Env, ctx: WaitUntil, events: LineEvent[]): Promise<void> {
  for (const event of events) {
    if (event.type === 'join') {
      await upsertGroup(env, event, true);
      continue;
    }
    if (event.type === 'leave') {
      await env.DB.prepare("UPDATE groups SET joined = 0, updated_at = datetime('now') WHERE id = ?")
        .bind(sourceId(event.source))
        .run();
      continue;
    }
    if (event.type !== 'message' || !event.message) continue;
    const msg = event.message;
    if (!(FILE_MESSAGE_TYPES as readonly string[]).includes(msg.type)) continue;

    const group = await upsertGroup(env, event, true);
    if (group && !group.enabled) continue;

    const receivedAt = new Date(event.timestamp);
    const originalName =
      msg.type === 'file' && msg.fileName
        ? msg.fileName
        : generatedFileName(msg.type, msg.id, receivedAt, env.TIMEZONE || 'Asia/Taipei');
    const senderName = await getSenderName(env.LINE_CHANNEL_ACCESS_TOKEN, event.source).catch(() => null);
    // 上傳者用 LINE User ID 識別（同一個 Provider 內固定），不用會變的顯示名稱
    const uploaderKey = event.source.userId ? `line:${event.source.userId}` : null;
    const ext = splitExt(originalName).ext;
    // 群組設定不接收這種檔案（例如關閉照片備份）：記錄為略過，不下載
    const accepted = groupAccepts(group, ext, msg.type);

    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO files
       (line_message_id, group_id, sender_id, sender_name, message_type, original_name, ext, size, image_set_id, received_at, reply_token, source, status, uploader_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'line', ?, ?)`,
    )
      .bind(
        msg.id,
        sourceId(event.source),
        event.source.userId ?? null,
        senderName,
        msg.type,
        originalName,
        ext,
        msg.fileSize ?? null,
        msg.imageSet?.id ?? null,
        receivedAt.toISOString(),
        event.replyToken ?? null,
        accepted ? 'pending' : 'skipped',
        uploaderKey,
      )
      .run();
    // changes = 0 代表 LINE 重送的同一則訊息，已經處理過
    if (!r.meta.changes) continue;
    await touchUploader(env, uploaderKey, 'line', senderName);
    if (!accepted) continue;
    await enqueueFile(env, ctx, Number(r.meta.last_row_id));
  }
}
