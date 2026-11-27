// 通知：在 LINE 群組回覆歸檔結果、呼叫外部 Webhook（可串接 Folio、ProjectDeck 等系統）
import type { Env } from './env';
import { getSetting, log } from './db';
import { signBody } from './line';

/** LINE 回覆訊息免費，但 reply token 只能在收到訊息後短時間內使用 */
const REPLY_WINDOW_MS = 50_000;

export async function replyArchived(env: Env, replyToken: string | null, receivedAt: string, text: string, fileId: number): Promise<void> {
  if (!replyToken || Date.now() - new Date(receivedAt).getTime() > REPLY_WINDOW_MS) return;
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    });
    if (!res.ok) await log(env, 'warn', 'notify', `LINE 通知失敗：HTTP ${res.status}`, fileId);
  } catch (e) {
    await log(env, 'warn', 'notify', `LINE 通知失敗：${(e as Error).message}`, fileId);
  }
}

export interface WebhookEvent {
  event: 'file.archived' | 'file.moved' | 'file.deleted';
  file: Record<string, unknown>;
}

/** 對外 Webhook：以 HMAC-SHA256（base64）簽章放在 X-GrabIt-Signature */
export async function emitWebhook(env: Env, payload: WebhookEvent): Promise<void> {
  const url = await getSetting(env, 'webhook_url');
  if (!url) return;
  const secret = (await getSetting(env, 'webhook_secret')) ?? '';
  const body = JSON.stringify({ ...payload, sent_at: new Date().toISOString() });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GrabIt-Event': payload.event, 'X-GrabIt-Signature': await signBody(secret, body) },
      body,
    });
    if (!res.ok) await log(env, 'warn', 'webhook', `外部 Webhook 回應 HTTP ${res.status}`);
  } catch (e) {
    await log(env, 'warn', 'webhook', `外部 Webhook 失敗：${(e as Error).message}`);
  }
}
