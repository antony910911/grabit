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
import { getGroup, log } from './db';
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
    await log(env, 'info', 'group', `新增來源：${name || id}`);
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

    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO files
       (line_message_id, group_id, sender_id, sender_name, message_type, original_name, ext, size, image_set_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        msg.id,
        sourceId(event.source),
        event.source.userId ?? null,
        senderName,
        msg.type,
        originalName,
        splitExt(originalName).ext,
        msg.fileSize ?? null,
        msg.imageSet?.id ?? null,
        receivedAt.toISOString(),
      )
      .run();
    // changes = 0 代表 LINE 重送的同一則訊息，已經處理過
    if (!r.meta.changes) continue;
    await enqueueFile(env, ctx, Number(r.meta.last_row_id));
  }
}
