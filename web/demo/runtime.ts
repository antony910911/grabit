// 展示版執行環境：在瀏覽器裡跑正式的後端（Hono API、歸檔流程、規則、版本、去重…），
// 資料庫用 sql.js，雲端空間與 AI 用模擬版，LINE API 用假的回應。
// 依序載入所有資料表更新；全文搜尋（FTS5）在瀏覽器版 SQLite 不支援，略過
const MIGRATIONS = Object.entries(import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
  .filter(([name]) => !name.includes('_fts'))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, sql]) => sql);
import { app } from '../../src/worker/index';
import { handleEvents } from '../../src/worker/webhook';
import { ingestBuffer } from '../../src/worker/ingest';
import type { Env } from '../../src/worker/env';
import type { LineEvent } from '../../src/worker/line';
import { createDb } from './d1';
import { demoAi, fakeContent } from './ai';

const realFetch = window.fetch.bind(window);
const enc = new TextEncoder();
const content = new Map<string, { bytes: Uint8Array; mime: string }>();
const groupNames = new Map<string, string>();
const replyListeners = new Set<(text: string) => void>();
let env: Env;
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} };

async function settle() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
}

const json = (d: unknown) => new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } });

function mime(name: string): string {
  const ext = name.split('.').pop()!.toLowerCase();
  return (
    { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }[ext] ??
    'application/octet-stream'
  );
}

/** 攔截網頁發出的請求：/api/* 交給瀏覽器內的後端，LINE API 回傳模擬資料 */
async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const req = new Request(input instanceof Request ? input : new URL(String(input), location.href), init);
  const url = new URL(req.url);
  // 受限的 iframe 裡 location.origin 會是 "null"，所以同時比對原始字串與主機
  if (url.pathname.startsWith('/api/') && (raw.startsWith('/api/') || url.host === location.host)) {
    const res = await app.fetch(req, env, ctx as never);
    return res;
  }
  if (url.hostname === 'api.line.me') {
    if (url.pathname.endsWith('/summary')) return json({ groupName: groupNames.get(url.pathname.split('/')[4]!) ?? '新群組' });
    if (url.pathname.includes('/member/') || url.pathname.includes('/profile/')) return json({ displayName: decodeURIComponent(url.pathname.split('/').pop()!).replace(/^U/, '') });
    if (url.pathname.endsWith('/message/reply')) {
      const body = (await req.json()) as { messages: { text: string }[] };
      replyListeners.forEach((l) => l(body.messages[0]!.text));
      return json({});
    }
  }
  if (url.hostname === 'api-data.line.me') {
    if (url.pathname.endsWith('/transcoding')) return json({ status: 'succeeded' });
    const c = content.get(url.pathname.split('/')[4]!);
    if (!c) return new Response('not found', { status: 404 });
    return new Response(c.bytes, { headers: { 'Content-Type': c.mime, 'Content-Length': String(c.bytes.byteLength) } });
  }
  return realFetch(input, init);
}

let seq = 0;
function lineEvent(groupId: string, fileName: string, sender: string, daysAgo = 0, opts: { body?: string; expired?: boolean } = {}): LineEvent {
  const id = `m${++seq}`;
  const isImage = /\.(jpe?g|png)$/i.test(fileName);
  if (!opts.expired) content.set(id, { bytes: enc.encode(opts.body ?? fakeContent(fileName)), mime: isImage ? 'image/jpeg' : mime(fileName) });
  return {
    type: 'message',
    timestamp: Date.now() - daysAgo * 86_400_000 - seq * 60_000,
    replyToken: `rt-${id}`,
    source: { type: 'group', groupId, userId: `U${sender}` },
    message: isImage ? { id, type: 'image' } : { id, type: 'file', fileName, fileSize: 1000 },
  };
}

async function send(events: LineEvent[]) {
  await handleEvents(env, ctx, events);
  await settle();
}

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await demoFetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json() as Promise<Record<string, unknown>>;
}

const GROUPS: [string, string][] = [
  ['Cbiogas', '沼氣研發群組'],
  ['Cyeast', '酵母研發群組'],
  ['Cadmin', '行政工作群組'],
  ['Cprivate', '私人群組'],
];

async function seed() {
  const db = env.DB;
  await db.prepare("INSERT INTO storages (type, name, root_folder, account, is_default) VALUES ('demo', '個人 Google Drive（展示）', 'GrabIt', 'me@gmail.com', 1), ('demo', '公司 OneDrive（展示）', 'GrabIt', 'me@lab.example.com', 0)").run();
  await db.prepare("INSERT INTO users (email, name, role, all_groups) VALUES ('dev@localhost', '展示管理員', 'admin', 1), ('assistant@lab.example.com', '行政助理', 'viewer', 0)").run();
  for (const [name, color] of [
    ['Farnesene', '#2c7a52'],
    ['厭氧消化', '#a75a1d'],
    ['FY115 計畫', '#6a4a97'],
  ]) await call('/projects', 'POST', { name, color });
  const projects = (await call('/projects')).items as { id: number; name: string }[];
  const pid = (n: string) => projects.find((p) => p.name === n)!.id;

  // Bot 加入四個群組（會先出現在「待設定」）
  for (const [id, name] of GROUPS) groupNames.set(id, name);
  await send(GROUPS.map(([id]) => ({ type: 'join', timestamp: Date.now(), source: { type: 'group', groupId: id } })));
  await call('/groups/Cbiogas', 'PATCH', { configured: true, project_id: pid('厭氧消化') });
  await call('/groups/Cyeast', 'PATCH', { configured: true, project_id: pid('Farnesene') });
  await call('/groups/Cadmin', 'PATCH', { configured: true, storage_id: 2, notify: true, members: ['assistant@lab.example.com'] });
  await call('/groups/Cprivate', 'PATCH', { configured: true, backup_images: false, base_folder: '私人/{yyyy}' });

  const rules = [
    { name: '沼氣操作紀錄', match_type: 'keywords', pattern: '操作紀錄, pH, VFA, BMP', group_id: 'Cbiogas', target_path: '沼氣研發/操作數據/{yyyy}', project_id: pid('厭氧消化'), tags: '操作數據' },
    { name: 'GC／HPLC 分析', match_type: 'keywords', pattern: 'GC, HPLC', group_id: 'Cyeast', target_path: 'Farnesene/分析數據/{yyyy}', project_id: pid('Farnesene'), tags: 'GC 分析' },
    { name: 'Farnesene', match_type: 'keywords', pattern: 'Farnesene, PPJ', target_path: 'Farnesene', project_id: pid('Farnesene') },
    { name: '期末報告', match_type: 'keywords', pattern: '期末, 結案', target_path: '計畫報告/期末報告', project_id: pid('FY115 計畫'), tags: '期末報告' },
    { name: '報價／採購', match_type: 'keywords', pattern: '報價, 採購', target_path: '行政/採購', tags: '採購' },
    { name: '會議紀錄', match_type: 'keywords', pattern: 'meeting, 會議紀錄', target_path: '會議紀錄/{yyyy}-{MM}', rename_template: '{yyyyMMdd}_{name}', tags: '會議紀錄' },
  ];
  for (const [i, r] of rules.entries()) await call('/rules', 'POST', { ...r, priority: (i + 1) * 10 });

  const same = 'GC 分析原始數據：Farnesene 1.8 g/L';
  await send([
    lineEvent('Cyeast', '期末報告_v1.docx', '小華', 30),
    lineEvent('Cyeast', '期末報告_v2.docx', '小華', 20),
    lineEvent('Cprivate', '旅遊行程.pdf', '我', 9),
    lineEvent('Cbiogas', '沼氣槽溫度紀錄_11月.xlsx', '阿德', 10),
    lineEvent('Cyeast', '期末報告_Final.docx', '小華', 8),
    lineEvent('Cadmin', '年終聚餐調查.xlsx', '行政助理', 7),
    lineEvent('Cadmin', '設備採購報價單.pdf', '行政助理', 6),
    lineEvent('Cyeast', 'PPJ培養結果.xlsx', '小明', 5),
    lineEvent('Cadmin', '11月會議紀錄.docx', '行政助理', 4),
    lineEvent('Cbiogas', 'BMP實驗數據.xlsx', '阿德', 3),
    lineEvent('Cyeast', 'SOP_儀器操作.pdf', '小明', 3),
    lineEvent('Cyeast', 'SOP_安全守則.docx', '小明', 3),
    lineEvent('Cadmin', '附件01.pdf', '行政助理', 2),
    lineEvent('Cbiogas', '反應槽照片.jpg', '阿德', 2),
    lineEvent('Cprivate', '風景.jpg', '我', 2),
    lineEvent('Cbiogas', '100L_操作紀錄.xlsx', '阿德', 1),
    lineEvent('Cyeast', 'Farnesene_GC分析.pdf', '小明', 0, { body: same }),
    lineEvent('Cadmin', '舊報表.pdf', '行政助理', 1, { expired: true }),
  ]);
  await send([lineEvent('Cyeast', 'GC分析_轉傳.pdf', '小華', 0, { body: same })]);
  await ingestBuffer(env, { groupId: 'email:files@grabit.example', groupType: 'email', groupName: 'Email：files@grabit.example', name: '報價單_GC管柱.pdf', mime: 'application/pdf', data: enc.encode(fakeContent('報價單_GC管柱.pdf')).buffer as ArrayBuffer, sender: '供應商 王先生', key: 'email:1' });

  // 手動把兩個 SOP 搬到同一個資料夾 → 系統學到「SOP」規則建議
  const sop = ((await call('/files?q=SOP')).items as { id: number }[]).map((f) => f.id);
  await call('/files/move', 'POST', { ids: sop, folderPath: '共用/SOP' });

  // 新加入、還沒設定的群組
  groupNames.set('Cnew', '新專案討論群');
  await send([{ type: 'join', timestamp: Date.now(), source: { type: 'group', groupId: 'Cnew' } }]);
}

export async function startDemo(): Promise<void> {
  const DB = await createDb(MIGRATIONS);
  env = { DB: DB as unknown as D1Database, LINE_CHANNEL_SECRET: 'demo', LINE_CHANNEL_ACCESS_TOKEN: 'demo', DEV_NO_AUTH: 'true', TIMEZONE: 'Asia/Taipei', DEMO_AI: demoAi } as Env;
  window.fetch = demoFetch as typeof fetch;
  await seed();
  window.__grabitDemo = {
    groups: () => [...groupNames.entries()].map(([id, name]) => ({ id, name })),
    samples: ['Farnesene_GC分析.pdf', 'BMP實驗數據_第二批.xlsx', '12月會議紀錄.docx', '期末報告_v3.docx', '新品報價單.pdf', 'HPLC_樣品A.csv', '未命名文件.pdf', '現場照片.jpg'],
    simulate: async (groupId, fileName, sender) => {
      await send([{ ...lineEvent(groupId, fileName, sender, 0), timestamp: Date.now() }]);
    },
    reset: () => location.reload(),
    onReply: (fn: (text: string) => void) => {
      replyListeners.add(fn);
      return () => replyListeners.delete(fn);
    },
  };
}
