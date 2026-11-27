// 端對端測試：node test/e2e/run.mjs
// 啟動 wrangler dev（真的 D1、Queue），把 LINE 與 Google Drive 換成假服務，從 webhook 一路驗證到歸檔與管理功能。
import { spawn, execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'e2e-secret';
const PORT = Number(process.env.E2E_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), 'grabit-e2e-'));
// 測試設定直接由 wrangler.toml 產生，避免兩邊不同步；E2E_NO_QUEUE=1 測試沒有 Queues（免費方案）的模式
const cfg = 'test/e2e/.wrangler.e2e.toml';
{
  let toml = readFileSync('wrangler.toml', 'utf8')
    .replace(/^main = .*$/m, 'main = "mock-worker.ts"')
    .replace('directory = "./web/dist"', 'directory = "../../web/dist"')
    .replace('migrations_dir = "migrations"', 'migrations_dir = "../../migrations"')
    .replace('max_batch_timeout = 5', 'max_batch_timeout = 1');
  if (process.env.E2E_NO_QUEUE) toml = toml.replace(/\[\[queues\.(producers|consumers)\]\][\s\S]*?(?=\n\n|\n#|$)/g, '');
  writeFileSync(cfg, toml);
}
const sh = (cmd) => execSync(cmd, { stdio: 'pipe' }).toString();

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ` ${extra}`}`);
  if (!cond) failed++;
};

sh(`npx wrangler d1 migrations apply grabit --local -c ${cfg} --persist-to ${persist}`);
sh(
  `npx wrangler d1 execute grabit --local -c ${cfg} --persist-to ${persist} --command "INSERT INTO storages (type, name, root_folder, secret, account, is_default) VALUES ('gdrive', 'Google Drive', 'LINE FileHub', '{\\"refresh_token\\":\\"fake\\"}', 'tester@example.com', 1)"`,
);

const dev = spawn(
  'npx',
  ['wrangler', 'dev', '--test-scheduled', '-c', cfg, '--port', String(PORT), '--persist-to', persist, '--var', `LINE_CHANNEL_SECRET:${SECRET}`, '--var', 'LINE_CHANNEL_ACCESS_TOKEN:x', '--var', 'GOOGLE_CLIENT_ID:x', '--var', 'GOOGLE_CLIENT_SECRET:x', '--var', 'ADMIN_EMAILS:Admin@Example.com'],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
let logs = '';
dev.stdout.on('data', (d) => (logs += d));
dev.stderr.on('data', (d) => (logs += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 目前登入者的 Session Cookie（測試裡手動管理）
let COOKIE = '';
const api = async (path, init = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { 'Content-Type': 'application/json', Cookie: COOKIE, ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const cookieOf = (res, name) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`)) ?? '';
const pair = (setCookie) => setCookie.split(';')[0];

/** 走完整的 Google 登入流程（Google 端由 mock-worker 模擬）；opts 可以製造各種異常 */
async function login(email, opts = {}) {
  const start = await fetch(`${BASE}/auth/google/start?next=${encodeURIComponent(opts.next ?? '/files')}`, { redirect: 'manual' });
  const loc = new URL(start.headers.get("location"));
  const stateCookie = cookieOf(start, '__Host-grabit_login_state');
  const state = loc.searchParams.get('state');
  const nonce = loc.searchParams.get('nonce');
  const code = ['login', email, opts.nonce ?? nonce, String(opts.verified ?? true), opts.aud ?? '', opts.iss ?? '', opts.signer ?? '', opts.expired ? '1' : ''].join('|');
  const cb = await fetch(`${BASE}/auth/google/callback?state=${encodeURIComponent(opts.state ?? state)}&code=${encodeURIComponent(code)}`, {
    redirect: 'manual',
    headers: { Cookie: opts.noStateCookie ? '' : pair(stateCookie) },
  });
  return { start, loc, stateCookie, state, code, status: cb.status, location: cb.headers.get('location'), session: cookieOf(cb, '__Host-grabit_session') };
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
const webhook = async (events, secret = SECRET) => {
  const body = JSON.stringify({ destination: 'U0', events });
  const sig = createHmac('sha256', secret).update(body).digest('base64');
  return fetch(`${BASE}/webhook`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'x-line-signature': sig } });
};
const ev = (id, type, fileName, group = 'Cgroup1') => ({
  type: 'message',
  timestamp: Date.parse('2026-11-27T06:30:00Z'),
  replyToken: `rt-${id}`,
  source: { type: 'group', groupId: group, userId: 'Uuser1' },
  message: { id, type, ...(fileName ? { fileName, fileSize: 10 } : {}) },
});
const drive = async () => (await (await fetch(BASE + '/api/__drive')).json()).filter((f) => !f.trashed).map((f) => f.path).sort();
const waitIdle = async (n) => {
  let items = [];
  for (let i = 0; i < 40; i++) {
    items = (await api('/api/files?status=all')).body.items;
    if (items.length >= n && items.every((f) => !['pending', 'processing'].includes(f.status))) break;
    await sleep(500);
  }
  return items;
};

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + '/api/me')).status === 401) break;
    } catch {}
    await sleep(500);
  }

  // ---------- Google 登入 ----------
  check('未登入時管理 API 回 401', (await api('/api/me')).status === 401);
  check('未登入時雲端授權路徑被擋下', (await fetch(`${BASE}/oauth/gdrive/start?storage=1`, { redirect: 'manual' })).status === 401);
  check('未登入時上傳被擋下', (await fetch(`${BASE}/api/upload`, { method: 'POST', body: new FormData() })).status === 401);

  let L = await login('admin@example.com');
  check('導向 Google：PKCE、nonce、state、只要求基本資料', L.loc.origin === 'https://accounts.google.com' && L.loc.searchParams.get('code_challenge_method') === 'S256' && !!L.loc.searchParams.get('nonce') && L.loc.searchParams.get('scope') === 'openid email profile' && L.loc.searchParams.get('redirect_uri') === `${BASE.replace('127.0.0.1', '127.0.0.1')}/auth/google/callback`, L.loc.toString());
  check('state Cookie 是 HttpOnly／Secure／SameSite', /HttpOnly/i.test(L.stateCookie) && /Secure/i.test(L.stateCookie) && /SameSite=Lax/i.test(L.stateCookie), L.stateCookie);
  check('管理員（ADMIN_EMAILS，大小寫不同）登入成功並導回原頁', L.status === 302 && L.location === '/files' && !!L.session, JSON.stringify({ status: L.status, location: L.location }));
  check('Session Cookie 是 __Host-、HttpOnly、Secure、SameSite、有期限', /^__Host-grabit_session=/.test(L.session) && /HttpOnly/i.test(L.session) && /Secure/i.test(L.session) && /SameSite=Lax/i.test(L.session) && /Max-Age=\d+/i.test(L.session) && /Path=\//.test(L.session), L.session);
  COOKIE = pair(L.session);
  const me = (await api('/api/me')).body;
  check('登入後取得身分與角色', me?.email === 'admin@example.com' && me.role === 'admin', JSON.stringify(me));

  const err = (r) => new URL(r.location ?? '/', BASE).searchParams.get('error');
  let R = await login('admin@example.com', { state: 'forged-state' });
  check('state 不符被拒絕（CSRF）', err(R) === 'state' && !R.session, JSON.stringify(R.location));
  R = await login('admin@example.com', { noStateCookie: true });
  check('缺少 state Cookie 被拒絕', err(R) === 'state' && !R.session);
  R = await login('admin@example.com');
  const replay = await fetch(`${BASE}/auth/google/callback?state=${encodeURIComponent(R.state)}&code=${encodeURIComponent(R.code)}`, { redirect: 'manual', headers: { Cookie: pair(R.stateCookie) } });
  check('同一個 state 不能重複使用', err({ location: replay.headers.get('location') }) === 'state' && !cookieOf(replay, '__Host-grabit_session'));
  R = await login('admin@example.com', { nonce: 'wrong-nonce' });
  check('nonce 不符被拒絕', err(R) === 'verify' && !R.session);
  R = await login('admin@example.com', { aud: 'someone-elses-client' });
  check('audience 不符被拒絕', err(R) === 'verify' && !R.session);
  R = await login('admin@example.com', { iss: 'https://evil.example.com' });
  check('issuer 不符被拒絕', err(R) === 'verify' && !R.session);
  R = await login('admin@example.com', { signer: 'attacker' });
  check('簽章不是 Google 金鑰被拒絕', err(R) === 'verify' && !R.session);
  R = await login('admin@example.com', { expired: true });
  check('過期的 ID Token 被拒絕', err(R) === 'verify' && !R.session);
  R = await login('admin@example.com', { verified: false });
  check('email 未驗證被拒絕', err(R) === 'unverified' && !R.session);
  R = await login('stranger@example.com');
  check('不是成員的帳號不能登入（不會自動成為管理員）', err(R) === 'not_member' && !R.session);
  R = await login('admin@example.com', { next: '//evil.example.com/phish' });
  check('登入後不會被導向外部網站', R.location === '/', R.location);
  check('跨站請求被擋下（CSRF）', (await api('/api/projects', { method: 'POST', body: '{"name":"x"}', headers: { Origin: 'https://evil.example.com' } })).status === 403);
  check('偽造的 Session Cookie 無效', (await api('/api/me', { headers: { Cookie: '__Host-grabit_session=forged' } })).status === 401);

  check('錯誤簽章被拒絕', (await webhook([], 'wrong')).status === 401);
  check('空的驗證請求回 200', (await webhook([])).status === 200);

  let r = await post('/api/projects', { name: 'Farnesene' });
  const farnesene = r.body.id;
  r = await post('/api/rules', { name: '分析數據', match_type: 'keywords', pattern: 'GC, HPLC', target_path: 'Farnesene/分析數據/{yyyy}', priority: 10, project_id: farnesene, tags: 'GC 分析, 數據' });
  check('新增規則（含專案與標籤）', r.status === 200, JSON.stringify(r.body));
  await post('/api/rules', { name: '會議', match_type: 'keywords', pattern: '會議紀錄', target_path: '會議紀錄/{yyyy}-{MM}', rename_template: '{yyyyMMdd}_{name}', priority: 20 });
  r = await post('/api/rules', { name: '壞規則', match_type: 'regex', pattern: '([', target_path: 'x' });
  check('錯誤的正規表示式被擋下', r.status === 400);
  r = await post('/api/rules/test', { fileName: 'Farnesene_GC.xlsx' });
  check('規則模擬器（顯示空間、專案、標籤）', r.body?.fullPath === `LINE FileHub/Farnesene/分析數據/${new Date().getFullYear()}/Farnesene_GC.xlsx` && r.body.project === 'Farnesene' && r.body.tags.length === 2, JSON.stringify(r.body));

  await webhook([ev('m1', 'file', '20261127_Farnesene_GC分析結果.xlsx'), ev('m2', 'file', '週會會議紀錄.docx'), ev('m4', 'file', '附件01.pdf'), ev('m5', 'image')]);
  await webhook([ev('m1', 'file', '20261127_Farnesene_GC分析結果.xlsx')]); // LINE 重送
  await sleep(2500);
  await webhook([ev('m3', 'file', 'GC結果_copy.xlsx')]); // 內容與 m1 相同
  await webhook([ev('m9', 'file', 'expired.pdf')]); // LINE 上已不存在

  let files = await waitIdle(6);
  let by = Object.fromEntries(files.map((f) => [f.message_type === 'image' ? 'm5' : f.original_name, f]));
  const f1 = files.find((f) => f.original_name.includes('Farnesene_GC'));
  const f2 = files.find((f) => f.original_name.includes('會議'));
  const f4 = files.find((f) => f.original_name === '附件01.pdf');
  const f5 = files.find((f) => f.message_type === 'image');
  const f3 = files.find((f) => f.original_name === 'GC結果_copy.xlsx');
  const f9 = files.find((f) => f.original_name === 'expired.pdf');
  check('重送的訊息不會重複建立', files.length === 6, `got ${files.length}`);
  check('依關鍵字歸檔＋專案＋標籤', f1?.status === 'done' && f1.folder_path === 'Farnesene/分析數據/2026' && f1.project_name === 'Farnesene' && f1.tags.length === 2 && f1.classified_by === 'rule', JSON.stringify(f1));
  check('自動改名＋月份資料夾', f2?.folder_path === '會議紀錄/2026-11' && f2.stored_name === '20261127_週會會議紀錄.docx', JSON.stringify(f2));
  check('沒有規則 → 待分類/群組名', f4?.unsorted === 1 && f4.folder_path === '待分類/酵母研發群組', JSON.stringify(f4));
  check('圖片自動命名', f5?.stored_name === 'IMG_20261127_143000_m5.jpg', JSON.stringify(f5));
  check('內容相同 → 標記重複並放到 _重複檔案', f3?.status === 'duplicate' && f3.duplicate_of === f1?.id && f3.folder_path === '_重複檔案' && f3.target_folder === 'Farnesene/分析數據/2026', JSON.stringify(f3));
  check('LINE 檔案過期 → 失敗且不重試', f9?.status === 'failed' && /過期/.test(f9.error ?? ''), JSON.stringify(f9));
  check('Drive 上的實際路徑', JSON.stringify(await drive()) === JSON.stringify([
    'LINE FileHub/Farnesene/分析數據/2026/20261127_Farnesene_GC分析結果.xlsx',
    'LINE FileHub/_重複檔案/GC結果_copy.xlsx',
    'LINE FileHub/待分類/酵母研發群組/IMG_20261127_143000_m5.jpg',
    'LINE FileHub/待分類/酵母研發群組/附件01.pdf',
    'LINE FileHub/會議紀錄/2026-11/20261127_週會會議紀錄.docx',
  ]), JSON.stringify(await drive()));

  // 新群組待設定、群組獨立設定（不備份照片、預設資料夾、改名）
  let groups = (await api('/api/groups')).body.items;
  check('新群組標記為待設定', groups[0]?.configured === 0, JSON.stringify(groups[0]));
  r = await patch('/api/groups/Cgroup1', { configured: true, backup_images: false, base_folder: '酵母研發/待確認', alias: '酵母研發' });
  check('更新群組設定', r.status === 200, JSON.stringify(r.body));
  await webhook([ev('m6', 'image'), ev('m7', 'file', '雜項說明.pdf')]);
  files = await waitIdle(8);
  const f6 = files.find((f) => f.message_type === 'image' && f.id !== f5.id);
  const f7 = files.find((f) => f.original_name === '雜項說明.pdf');
  check('關閉照片備份 → 新照片略過', !f6 && (await api('/api/files?status=skipped')).body.items.length === 1);
  check('群組預設資料夾', f7?.folder_path === '酵母研發/待確認' && f7.unsorted === 1 && f7.classified_by === 'group', JSON.stringify(f7));

  // 手動搬移 → 規則學習 → 復原
  r = await patch(`/api/files/${f7.id}`, { folderPath: '行政/雜項' });
  check('手動搬移產生規則建議', r.body?.suggestion?.pattern === '雜項說明' && r.body.suggestion.targetPath === '行政/雜項', JSON.stringify(r.body));
  const undoBatch = r.body.batchId;
  r = await api('/api/suggestions');
  check('建議規則清單', r.body.items.length >= 1, JSON.stringify(r.body));
  r = await post(`/api/operations/${undoBatch}/undo`, {});
  check('復原搬移', r.body?.undone === 1, JSON.stringify(r.body));
  check('復原後回到原位與原狀態', (await drive()).includes('LINE FileHub/酵母研發/待確認/雜項說明.pdf') && (await api(`/api/files/${f7.id}`)).body.unsorted === 1);
  r = await patch(`/api/files/${f4.id}`, { folderPath: '附件/暫存' });
  r = await post(`/api/operations/${r.body.batchId}/undo`, {});

  // 新增規則後重新套用到待分類
  await post('/api/rules', { name: '附件', match_type: 'regex', pattern: '^附件\\d+', target_path: '附件/{group}', priority: 30 });
  r = await post('/api/files/reapply', { scope: 'unsorted', dryRun: true });
  check('重新套用：預覽', r.body?.changes?.length === 1 && r.body.changes[0].to === '附件/酵母研發' && r.body.changes[0].name === '附件01.pdf', JSON.stringify(r.body));
  r = await post('/api/files/reapply', { scope: 'unsorted', dryRun: false });
  check('重新套用：實際搬移', r.body?.moved === 1, JSON.stringify(r.body));

  // 手動移動遇到同名
  r = await patch(`/api/files/${f5.id}`, { folderPath: 'Farnesene/分析數據/2026', storedName: '20261127_Farnesene_GC分析結果.xlsx' });
  check('手動移動遇到同名自動加編號', (await drive()).includes('LINE FileHub/Farnesene/分析數據/2026/20261127_Farnesene_GC分析結果 (1).xlsx'), JSON.stringify(await drive()));

  // 重複檔案：仍要保留
  r = await post(`/api/files/${f3.id}/keep`, {});
  check('重複檔案可以保留並搬回原位置', r.body?.folderPath === 'Farnesene/分析數據/2026', JSON.stringify(r.body));

  // 資料夾改名（規則同步更新）
  r = await post('/api/folders/rename', { storageId: 1, from: '會議紀錄', to: '行政/會議紀錄' });
  check('資料夾改名', r.body?.moved === 1, JSON.stringify(r.body));
  const rules = (await api('/api/rules')).body.items;
  check('資料夾改名後規則路徑同步', rules.some((x) => x.target_path === '行政/會議紀錄/{yyyy}-{MM}'), JSON.stringify(rules.map((x) => x.target_path)));
  check('Drive 資料夾已改名', (await drive()).includes('LINE FileHub/行政/會議紀錄/2026-11/20261127_週會會議紀錄.docx'), JSON.stringify(await drive()));

  // 版本管理
  await webhook([ev('v1', 'file', '期末報告_v1.docx'), ev('v2', 'file', '期末報告_v2.docx'), ev('v3', 'file', '期末報告_Final.docx')]);
  files = await waitIdle(11);
  const finalDoc = files.find((f) => f.original_name === '期末報告_Final.docx');
  r = await api(`/api/files/${finalDoc.id}`);
  check('版本辨識：三個版本歸為一組', r.body?.versions?.length === 3 && r.body.versions[0].version_label === 'Final', JSON.stringify(r.body?.versions));
  r = await api('/api/files?latest=1&q=期末報告');
  check('只顯示最新版本', r.body?.items?.length === 1 && r.body.items[0].original_name === '期末報告_Final.docx', JSON.stringify(r.body?.items?.map((x) => x.original_name)));

  // 標籤、篩選、搜尋
  r = await patch(`/api/files/${finalDoc.id}`, { tags: ['期末報告', 'FY115'], projectId: farnesene });
  r = await api(`/api/files?project=${farnesene}`);
  check('依專案篩選', r.body.items.length === 3, JSON.stringify(r.body.items.map((x) => x.original_name)));
  const sources = (await api('/api/sources')).body;
  const fy = sources.tags.find((t) => t.name === 'FY115');
  check('標籤清單與計數', fy?.count === 1, JSON.stringify(sources.tags));
  r = await api(`/api/files?q=${encodeURIComponent('會議')}`);
  check('搜尋（短關鍵字）', r.body.items.length === 1, JSON.stringify(r.body.items.map((x) => x.original_name)));
  r = await api(`/api/files?q=${encodeURIComponent('Farnesene')}`);
  check('搜尋（全文索引）', r.body.items.length >= 2, JSON.stringify(r.body.items.map((x) => x.original_name)));

  // 手動上傳
  const fd = new FormData();
  fd.append('file', new Blob(['hello upload'], { type: 'text/plain' }), '手動上傳_HPLC數據.txt');
  const up = await fetch(`${BASE}/api/upload`, { method: 'POST', body: fd, headers: { Cookie: COOKIE } });
  const upBody = await up.json();
  check('手動上傳走同一套規則', upBody.status === 'done' && upBody.folder === 'Farnesene/分析數據/2026', JSON.stringify(upBody));

  // 權限：viewer 只能看被授權的群組
  r = await post('/api/users', { email: 'viewer@example.com', role: 'viewer', groups: [] });
  check('新增成員', r.status === 200, JSON.stringify(r.body));

  // ---------- Google Drive 專屬資料夾與分享 ----------
  let st = (await api('/api/storages')).body.items[0];
  check('自動建立專屬資料夾並提供連結', /^https:\/\/drive\.google\.com\/drive\/folders\//.test(st.folderLink ?? '') && st.filesOutside === 0, JSON.stringify(st));
  const allFiles = await (await fetch(BASE + '/api/__drive')).json();
  check('所有檔案都在同一個專屬資料夾裡', new Set(allFiles.filter((f) => !f.trashed).map((f) => f.root)).size === 1);
  const rootId = st.folderLink.split('/').pop();
  const permsOf = async () => (await (await fetch(BASE + '/api/__drive/perms')).json())[rootId] ?? [];
  r = await patch('/api/storages/1', { share: 'anyone' });
  check('分享給知道連結的任何人', r.status === 200 && JSON.stringify(await permsOf()) === '["anyone"]', JSON.stringify(await permsOf()));
  r = await patch('/api/storages/1', { share: 'members' });
  let ps = await permsOf();
  check('改成只分享給 GrabIt 成員（移除公開連結）', !ps.includes('anyone') && ps.includes('admin@example.com') && ps.includes('viewer@example.com'), JSON.stringify(ps));
  await post('/api/users', { email: 'newbie@example.com', role: 'viewer' });
  await sleep(800);
  check('新增成員時自動分享資料夾', (await permsOf()).includes('newbie@example.com'), JSON.stringify(await permsOf()));
  await api('/api/users/newbie%40example.com', { method: 'DELETE' });
  await sleep(800);
  check('移除成員時自動取消分享', !(await permsOf()).includes('newbie@example.com'), JSON.stringify(await permsOf()));
  r = await patch('/api/storages/1', { share: 'private' });
  check('改成不分享', (await permsOf()).length === 0, JSON.stringify(await permsOf()));
  r = await patch('/api/storages/1', { root_folder: 'GrabIt 檔案' });
  check('專屬資料夾改名（檔案不用搬）', (await drive()).every((p) => p.startsWith('GrabIt 檔案/')), JSON.stringify(await drive()));

  // 資料夾被刪掉：不會自動另開新資料夾，而是暫停並提示；使用者決定重建後再把舊檔整理進來
  check('雲端硬碟沒有多餘的 GrabIt 資料夾', st.extraFolders === 0, JSON.stringify(st));
  await fetch(BASE + '/api/__drive/trash-roots');
  st = (await api('/api/storages')).body.items[0];
  check('偵測到專屬資料夾被刪除', st.rootMissing === true, JSON.stringify(st));
  const fdLost = new FormData();
  fdLost.append('file', new Blob(['while missing'], { type: 'text/plain' }), '資料夾不見時.txt');
  const lost = await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: fdLost, headers: { Cookie: COOKIE } })).json();
  const rootsNow = new Set((await (await fetch(BASE + '/api/__drive')).json()).filter((f) => !f.rootTrashed && !f.trashed).map((f) => f.root));
  check('資料夾不見時不會偷偷建立新的', lost.status === 'failed' && /專屬資料夾/.test(lost.error ?? '') && rootsNow.size === 0, JSON.stringify({ lost, roots: [...rootsNow] }));
  r = await post('/api/storages/1/recreate-root', {});
  check('使用者按下後重新建立專屬資料夾', r.status === 200 && !!r.body?.folderLink, JSON.stringify(r.body));
  r = await post('/api/storages/1/recreate-root', {});
  check('資料夾還在時不能重複建立', r.status === 400);
  let moved = 0;
  for (let i = 0; i < 10; i++) {
    r = await post('/api/storages/1/consolidate', {});
    moved += r.body?.moved ?? 0;
    if (!r.body?.remaining) break;
  }
  st = (await api('/api/storages')).body.items[0];
  const after = (await (await fetch(BASE + '/api/__drive')).json()).filter((f) => !f.trashed);
  check('舊檔整理到新的專屬資料夾', moved > 0 && st.filesOutside === 0 && !st.rootMissing && st.folderLink.split('/').pop() !== rootId && after.every((f) => !f.rootTrashed && f.root === st.folderLink.split('/').pop()), JSON.stringify({ moved, st, after: after.slice(0, 3) }));
  const fd2 = new FormData();
  fd2.append('file', new Blob(['after root change'], { type: 'text/plain' }), '新根目錄測試.txt');
  await fetch(`${BASE}/api/upload`, { method: 'POST', body: fd2, headers: { Cookie: COOKIE } });
  const latest = (await (await fetch(BASE + '/api/__drive')).json()).find((f) => f.path.endsWith('新根目錄測試.txt'));
  check('之後的新檔案也放進新的專屬資料夾', latest?.root === st.folderLink.split('/').pop(), JSON.stringify(latest));

  // ---------- 專案與標籤 ----------
  const proj2 = (await post('/api/projects', { name: '沼氣計畫' })).body.id;
  r = await post('/api/files/bulk', { ids: [f2.id, f4.id], projectId: proj2, addTags: ['重要', '待讀'] });
  const pf = (await api(`/api/files?project=${proj2}`)).body.items;
  check('批次加入專案與標籤', r.body?.updated === 2 && pf.length === 2 && pf.every((f) => f.tags.some((t) => t.name === '重要')), JSON.stringify(pf.map((f) => [f.original_name, f.tags.map((t) => t.name)])));
  r = await post('/api/files/bulk', { ids: [f2.id], removeTags: ['待讀'], projectId: null });
  const f2now = (await api(`/api/files/${f2.id}`)).body;
  check('批次移除標籤與移出專案', f2now.project_id === null && f2now.tags.every((t) => t.name !== '待讀'), JSON.stringify(f2now.tags));
  const untagged = (await api('/api/files?tag=none')).body.items;
  check('篩選還沒有標籤的檔案', untagged.every((f) => f.tags.length === 0) && untagged.length > 0);
  await patch('/api/groups/Cgroup1', { project_id: proj2 });
  r = await post('/api/groups/Cgroup1/apply-project', {});
  const grp = (await api('/api/groups')).body.items.find((g) => g.id === 'Cgroup1');
  check('群組預設專案套用到現有檔案（不覆蓋其他專案）', r.body?.updated > 0 && (await api(`/api/files/${f1.id}`)).body.project_name === 'Farnesene', JSON.stringify({ r: r.body, grp: grp?.outside_project }));
  await patch('/api/groups/Cgroup1', { project_id: null });

  const dl = await fetch(`${BASE}/api/files/${f1.id}/download`, { headers: { Cookie: COOKIE } });
  check('透過 GrabIt 下載（依 GrabIt 權限）', dl.ok && (await dl.text()) === 'farnesene gc data' && /attachment/.test(dl.headers.get('content-disposition') ?? ''));

  r = await api('/api/stats');
  check('統計', r.body?.archived >= 9 && r.body.failed === 2 && r.body.groups === 1, JSON.stringify(r.body));
  r = await post(`/api/files/${f9.id}/retry`, {});
  check('失敗檔案可以重試', r.status === 200);
  r = await api('/api/operations');
  check('操作紀錄', r.body.items.length >= 3);

  // ---------- 成員登入、權限、登出與撤銷 ----------
  const adminCookie = COOKIE;
  await post('/api/users', { email: 'Editor@Example.com', role: 'editor', groups: ['Cgroup1'] });
  const V = await login('viewer@example.com');
  check('被加入的成員可以登入', !!V.session, JSON.stringify(V.location));
  COOKIE = pair(V.session);
  check('檢視者不能修改', (await post('/api/projects', { name: '不該建立' })).status === 403);
  check('檢視者看不到未授權群組的檔案', (await api('/api/files')).body.items.length === 0);
  check('檢視者不能進入成員管理', (await api('/api/users')).status === 403);
  const E = await login('editor@example.com');
  COOKIE = pair(E.session);
  check('編輯者只看得到被授權的群組', (await api('/api/files')).body.items.every((f) => f.group_id === 'Cgroup1') && (await api('/api/files')).body.items.length > 0);
  COOKIE = adminCookie;
  r = await post('/api/users/viewer%40example.com/revoke-sessions', {});
  check('管理員強制登出成員', r.body?.revoked === 1, JSON.stringify(r.body));
  check('被強制登出後 Session 失效', (await api('/api/me', { headers: { Cookie: pair(V.session) } })).status === 401);
  await api('/api/users/editor%40example.com', { method: 'DELETE' });
  check('移除成員後立即失效', (await api('/api/me', { headers: { Cookie: pair(E.session) } })).status === 401);
  check('移除後無法再登入', err(await login('editor@example.com')) === 'not_member');
  const out = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { Cookie: COOKIE } });
  check('登出會清除 Cookie', out.ok && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookieOf(out, '__Host-grabit_session')), cookieOf(out, '__Host-grabit_session'));
  check('登出後 Session 失效', (await api('/api/me')).status === 401);
  check('LINE webhook 不受登入影響', (await webhook([])).status === 200);

  const sched = await fetch(BASE + '/__scheduled?cron=*/5+*+*+*+*');
  check('排程重試可以執行', sched.ok, String(sched.status));

  const page = await fetch(BASE + '/files');
  check('SPA 路由回傳管理介面', page.ok && (await page.text()).includes('<div id="root">'));
} catch (e) {
  console.error(e);
  failed++;
} finally {
  if (process.env.KEEP) {
    console.log('KEEP');
    await new Promise(() => {});
  }
  // 結束整個 process group（npx → wrangler → workerd）
  try {
    process.kill(-dev.pid, 'SIGTERM');
  } catch {}
  await sleep(1000);
  rmSync(persist, { recursive: true, force: true });
  if (failed) {
    console.log('\n--- wrangler 輸出 ---\n' + logs.slice(-4000));
    console.log(`\n${failed} 項失敗`);
    process.exit(1);
  }
  console.log('\n全部通過');
}
