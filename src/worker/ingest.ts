// Email 附件與手動上傳：內容已經在記憶體中，直接走同一套歸檔流程
import PostalMime from 'postal-mime';
import type { Env } from './env';
import { getGroup, getSetting, groupAccepts, log, touchUploader } from './db';
import { splitExt } from './rules';
import { archiveFile, runWithStatus, type Outcome } from './processor';

export interface IngestInput {
  groupId: string;
  groupType: 'email' | 'upload';
  groupName: string;
  name: string;
  mime: string;
  data: ArrayBuffer;
  sender: string | null;
  /** 上傳者的唯一身分：Email 的寄件地址、手動上傳的 GrabIt 帳號 */
  senderId?: string | null;
  key: string; // 唯一鍵，避免重複處理
  folder?: string | null;
  projectId?: number | null;
}

async function ensureSource(env: Env, id: string, type: string, name: string) {
  await env.DB.prepare('INSERT OR IGNORE INTO groups (id, source_type, name, configured) VALUES (?, ?, ?, 1)').bind(id, type, name).run();
  return getGroup(env, id);
}

export async function ingestBuffer(env: Env, input: IngestInput): Promise<{ fileId: number | null; outcome: Outcome | null }> {
  const group = await ensureSource(env, input.groupId, input.groupType, input.groupName);
  if (group && !group.enabled) return { fileId: null, outcome: null };
  const ext = splitExt(input.name).ext;
  const accepted = groupAccepts(group, ext, 'file');
  const senderId = input.senderId?.trim().toLowerCase() || null;
  const uploaderKey = senderId ? `${input.groupType === 'email' ? 'email' : 'user'}:${senderId}` : null;
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO files (line_message_id, group_id, sender_id, sender_name, message_type, original_name, ext, size, received_at, source, status, uploader_key)
     VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(input.key, input.groupId, input.senderId ?? null, input.sender, input.name, ext, input.data.byteLength, new Date().toISOString(), input.groupType, accepted ? 'pending' : 'skipped', uploaderKey)
    .run();
  if (r.meta.changes) await touchUploader(env, uploaderKey, input.groupType === 'email' ? 'email' : 'user', input.sender);
  if (!r.meta.changes || !accepted) return { fileId: null, outcome: null };
  const fileId = Number(r.meta.last_row_id);
  const outcome = await runWithStatus(env, fileId, 6, () =>
    archiveFile(env, fileId, async () => ({ body: input.data, length: input.data.byteLength, mime: input.mime || 'application/octet-stream' }), {
      folderOverride: input.folder,
      projectOverride: input.projectId,
    }),
  );
  return { fileId, outcome };
}

function senderAllowed(list: string, from: string): boolean {
  const addr = from.toLowerCase();
  return list
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => (rule.startsWith('@') ? addr.endsWith(rule) : addr === rule));
}

/** Cloudflare Email Routing：把寄到指定信箱的附件自動歸檔 */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const allowed = (await getSetting(env, 'email_allowed_senders')) ?? '';
  if (!senderAllowed(allowed, message.from)) {
    await log(env, 'warn', 'email', `拒收 ${message.from} 的郵件（不在允許的寄件者名單）`);
    message.setReject('Sender not allowed');
    return;
  }
  const email = await PostalMime.parse(message.raw);
  const attachments = email.attachments.filter((a) => a.disposition !== 'inline' && a.filename);
  if (!attachments.length) {
    await log(env, 'info', 'email', `${message.from} 的郵件「${email.subject ?? ''}」沒有附件`);
    return;
  }
  const to = message.to.toLowerCase();
  const msgId = email.messageId ?? `${Date.now()}`;
  for (const [i, a] of attachments.entries()) {
    const data = typeof a.content === 'string' ? new TextEncoder().encode(a.content).buffer : (a.content as ArrayBuffer);
    await ingestBuffer(env, {
      groupId: `email:${to}`,
      groupType: 'email',
      groupName: `Email：${to}`,
      name: a.filename!,
      mime: a.mimeType,
      data: data as ArrayBuffer,
      sender: email.from?.name || email.from?.address || message.from,
      senderId: email.from?.address || message.from,
      key: `email:${msgId}:${i}`,
    });
  }
}
