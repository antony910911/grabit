// LINE Messaging API 相關工具
const API = 'https://api.line.me';
const DATA_API = 'https://api-data.line.me';

export type SourceType = 'group' | 'room' | 'user';

export interface LineSource {
  type: SourceType;
  groupId?: string;
  roomId?: string;
  userId?: string;
}

export interface LineMessage {
  id: string;
  type: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
  contentProvider?: { type: 'line' | 'external'; originalContentUrl?: string };
  imageSet?: { id: string; index: number; total: number };
}

export interface LineEvent {
  type: string;
  timestamp: number;
  source: LineSource;
  webhookEventId?: string;
  replyToken?: string;
  message?: LineMessage;
}

export interface WebhookBody {
  destination: string;
  events: LineEvent[];
}

export const FILE_MESSAGE_TYPES = ['file', 'image', 'video', 'audio'] as const;

export function sourceId(source: LineSource): string {
  return source.groupId ?? source.roomId ?? source.userId ?? 'unknown';
}

function base64(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
}

export async function verifySignature(
  secret: string,
  body: string,
  signature: string | null | undefined,
): Promise<boolean> {
  if (!secret || !signature) return false;
  return timingSafeEqual(await signBody(secret, body), signature);
}

async function getJson<T>(token: string, url: string): Promise<T | null> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function getSourceName(token: string, source: LineSource): Promise<string> {
  if (source.type === 'group' && source.groupId) {
    const r = await getJson<{ groupName: string }>(token, `${API}/v2/bot/group/${source.groupId}/summary`);
    return r?.groupName ?? '';
  }
  if (source.type === 'user' && source.userId) {
    const r = await getJson<{ displayName: string }>(token, `${API}/v2/bot/profile/${source.userId}`);
    return r ? `${r.displayName}（一對一）` : '';
  }
  return '';
}

export async function getSenderName(token: string, source: LineSource): Promise<string | null> {
  const { userId } = source;
  if (!userId) return null;
  let url: string;
  if (source.type === 'group') url = `${API}/v2/bot/group/${source.groupId}/member/${userId}`;
  else if (source.type === 'room') url = `${API}/v2/bot/room/${source.roomId}/member/${userId}`;
  else url = `${API}/v2/bot/profile/${userId}`;
  const r = await getJson<{ displayName: string }>(token, url);
  return r?.displayName ?? null;
}

/** 影片與音訊要等 LINE 轉檔完成才能下載 */
export async function getTranscodingStatus(
  token: string,
  messageId: string,
): Promise<'processing' | 'succeeded' | 'failed' | 'unknown'> {
  const r = await getJson<{ status: 'processing' | 'succeeded' | 'failed' }>(
    token,
    `${DATA_API}/v2/bot/message/${messageId}/content/transcoding`,
  );
  return r?.status ?? 'unknown';
}

export function downloadContent(token: string, messageId: string): Promise<Response> {
  return fetch(`${DATA_API}/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

const DEFAULT_EXT: Record<string, string> = { image: 'jpg', video: 'mp4', audio: 'm4a' };
const TYPE_LABEL: Record<string, string> = { image: 'IMG', video: 'VID', audio: 'AUD' };

/** 圖片、影片、音訊沒有原始檔名，用「類型_日期時間_訊息ID」命名 */
export function generatedFileName(
  type: string,
  messageId: string,
  receivedAt: Date,
  timeZone = 'Asia/Taipei',
): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(receivedAt);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  const stamp = `${g('year')}${g('month')}${g('day')}_${g('hour')}${g('minute')}${g('second')}`;
  return `${TYPE_LABEL[type] ?? 'FILE'}_${stamp}_${messageId}.${DEFAULT_EXT[type] ?? 'bin'}`;
}
