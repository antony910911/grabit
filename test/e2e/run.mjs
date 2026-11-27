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
  // AI binding 在 wrangler dev 需要登入 Cloudflare；測試改用 mock-worker 裡的假 Workers AI
  toml = toml.replace(/^\[ai\]\nbinding = "AI"\n/m, '');
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
  ['wrangler', 'dev', '--test-scheduled', '-c', cfg, '--port', String(PORT), '--persist-to', persist, '--var', `LINE_CHANNEL_SECRET:${SECRET}`, '--var', 'LINE_CHANNEL_ACCESS_TOKEN:x', '--var', 'GOOGLE_CLIENT_ID:x', '--var', 'GOOGLE_CLIENT_SECRET:x', '--var', 'ADMIN_EMAILS:Admin@Example.com', '--var', 'GEMINI_API_KEY:x'],
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
  const setupRes = await api('/auth/setup');
  check('設定完成後，第一次設定清單只回傳 ready（不透露設定細節）', setupRes.status === 200 && JSON.stringify(setupRes.body) === '{"ready":true}', JSON.stringify(setupRes.body));
  check('未登入時雲端授權路徑被擋下', (await fetch(`${BASE}/oauth/gdrive/start?storage=1`, { redirect: 'manual' })).status === 401);
  check('未登入時上傳被擋下', (await fetch(`${BASE}/api/upload`, { method: 'POST', body: new FormData() })).status === 401);
  // 公開頁面：Google 審核 OAuth 應用程式時要能不登入就打開
  for (const [path, must] of [['/about', '成員登入'], ['/privacy', 'Limited Use'], ['/terms', '服務條款']]) {
    const res = await fetch(BASE + path);
    const html = await res.text();
    check(`公開頁面 ${path} 不用登入就能打開`, res.status === 200 && html.includes(must) && html.includes('/privacy'), `${res.status} ${html.slice(0, 80)}`);
  }
  const home0 = await (await fetch(BASE + '/')).text();
  check('沒有設定驗證碼時首頁照常是管理介面', home0.includes('<div id="root">') && !home0.includes('google-site-verification'));

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
  // 使用者直接在 Google Drive 改名：GrabIt 讀回新名稱（例如把「GrabIt (2)」改回「GrabIt」）
  await fetch(BASE + '/api/__drive/rename-roots?name=' + encodeURIComponent('GrabIt'));
  st = (await api('/api/storages')).body.items[0];
  const afterRename = (await api('/api/storages')).body.items[0];
  check('在 Google Drive 改專屬資料夾名稱後，GrabIt 跟著顯示新名稱', st.root_folder === 'GrabIt' && afterRename.root_folder === 'GrabIt', JSON.stringify([st.root_folder, afterRename.root_folder]));

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

  // ---------- 免費 AI 文件判讀（AI 是歸檔後的獨立工作） ----------
  const byName = async (name) => (await api('/api/files?limit=200')).body.items.find((f) => f.original_name === name);
  const waitAi = async (name, until = (f) => !['queued', 'running'].includes(f.ai_status)) => {
    for (let i = 0; i < 80; i++) {
      const f = await byName(name);
      if (f && f.status === 'done' && f.ai_status && until(f)) return (await api(`/api/files/${f.id}`)).body;
      await sleep(400);
    }
    return byName(name);
  };
  const aiCalls = async () => (await (await fetch(BASE + '/api/__ai')).json());
  let ai = (await api('/api/settings')).body.ai;
  check('沒有 Claude 金鑰時預設用免費的 Workers AI，自動改名預設關閉', ai.provider === 'workers' && ai.status.ready && ai.features.rename === false && ai.onlyUnmatched === true && ai.threshold === 0.85 && ai.dailyLimit === 100, JSON.stringify({ p: ai.provider, f: ai.features, t: ai.threshold }));
  const f1ai = (await api(`/api/files/${f1.id}`)).body;
  check('規則已分類的檔案不呼叫 AI', f1ai.ai_status === 'skipped' && /規則/.test(f1ai.ai_error ?? ''), JSON.stringify([f1ai.ai_status, f1ai.ai_error]));
  r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { workersModel: 'rm -rf /' } }) });
  check('不合法的模型名稱被拒絕', r.status === 400);

  // Google Search Console 網站驗證與公開頁面上的聯絡方式
  r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ siteVerification: '<meta name="google-site-verification" content="abcDEF123_xyz-456" />', publicOperator: '測試研究室', publicContact: 'contact@example.com' }) });
  const home1 = await (await fetch(BASE + '/')).text();
  check('貼上 meta 標籤後首頁帶有驗證碼', r.status === 200 && home1.includes('<meta name="google-site-verification" content="abcDEF123_xyz-456">') && home1.includes('<div id="root">'), home1.slice(0, 300));
  const priv = await (await fetch(BASE + '/privacy')).text();
  check('隱私權政策顯示營運者與聯絡方式', priv.includes('測試研究室') && priv.includes('contact@example.com'));
  r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ siteVerification: 'google1a2b3c4d5e.html' }) });
  const vf = await fetch(BASE + '/google1a2b3c4d5e.html');
  const vfText = await vf.text();
  check('HTML 驗證檔可以下載，其他檔名不行', r.status === 200 && vf.status === 200 && vfText === 'google-site-verification: google1a2b3c4d5e.html' && (await fetch(BASE + '/google999.html')).status === 404, `${vf.status} ${vfText}`);
  check('不合法的驗證碼與 Email 被拒絕', (await api('/api/settings', { method: 'PUT', body: JSON.stringify({ siteVerification: '<script>x</script>' }) })).status === 400 && (await api('/api/settings', { method: 'PUT', body: JSON.stringify({ publicContact: 'not an email' }) })).status === 400);
  const pubSite = (await api('/api/settings')).body.publicSite;
  check('系統設定提供要貼到 Google 的網址', pubSite.homeUrl.endsWith('/about') && pubSite.privacyUrl.endsWith('/privacy') && pubSite.termsUrl.endsWith('/terms') && pubSite.verification === 'google1a2b3c4d5e.html', JSON.stringify(pubSite));

  await webhook([ev('a1', 'file', '掃描檔A.pdf'), ev('a2', 'file', '不明檔案B.pdf'), ev('a3', 'file', '可疑檔案C.pdf')]);
  const a1 = await waitAi('掃描檔A.pdf');
  check('高信心＋既有資料夾 → AI 自動歸檔、加專案與標籤', a1?.ai_status === 'done' && a1.folder_path === 'Farnesene/分析數據/2026' && a1.classified_by === 'ai' && a1.unsorted === 0 && a1.project_name === 'Farnesene' && a1.tags.some((t) => t.name === 'AI標籤') && a1.ai_summary === 'GC 分析的測試摘要' && a1.ai_suggestion?.applied?.folder === true, JSON.stringify(a1));
  check('自動改名預設關閉：只顯示建議檔名，不改原檔', a1?.stored_name !== 'AI建議檔名.pdf' && a1?.ai_suggestion?.suggestedName === 'AI建議檔名.pdf', JSON.stringify([a1?.stored_name, a1?.ai_suggestion?.suggestedName]));
  check('AI 搬移的檔案真的在雲端的新位置', (await drive()).some((p) => p.endsWith('Farnesene/分析數據/2026/掃描檔A.pdf')), JSON.stringify(await drive()));
  check('PDF 先轉成文字再交給模型（免費）', (await aiCalls()).some((c) => c.prompt.includes('AI_HIGH 這是一份 GC 分析報告')));
  const a2 = await waitAi('不明檔案B.pdf');
  check('低信心 → 留在原處，列入「AI 待確認」', a2?.ai_status === 'done' && a2.unsorted === 1 && a2.ai_suggestion?.folder === 'Farnesene/分析數據/2026' && !a2.ai_suggestion?.applied?.folder, JSON.stringify(a2));
  r = await api('/api/files?status=ai_review');
  check('「AI 待確認」清單與計數', r.body.items.some((f) => f.id === a2.id) && (await api('/api/stats')).body.aiReview >= 1, JSON.stringify(r.body.items.map((f) => f.original_name)));
  const a3 = await waitAi('可疑檔案C.pdf');
  const evilCall = (await aiCalls()).find((c) => c.prompt.includes('AI_EVIL'));
  check('文件內容放在 <document> 裡當成資料', !!evilCall && /<document>[\s\S]*AI_EVIL[\s\S]*<\/document>/.test(evilCall.prompt));
  check('不合法的路徑、不存在的專案、過多的標籤都不會被套用', a3?.unsorted === 1 && a3.ai_suggestion?.folder === null && a3.ai_suggestion?.project === null && a3.ai_suggestion?.tags.length <= 6 && a3.ai_suggestion?.warnings.some((w) => /不合法/.test(w)), JSON.stringify(a3?.ai_suggestion));

  r = await post(`/api/files/${a2.id}/accept-ai`, { folder: '行政/確認過', project: 'Farnesene', name: '確認後的檔名.pdf' });
  const a2b = (await api(`/api/files/${a2.id}`)).body;
  check('編輯後採用 AI 建議（資料夾、專案、檔名）', r.status === 200 && a2b.folder_path === '行政/確認過' && a2b.stored_name === '確認後的檔名.pdf' && a2b.project_name === 'Farnesene' && a2b.unsorted === 0 && !!r.body.batchId, JSON.stringify(a2b));
  await post(`/api/files/${a3.id}/ai/dismiss`, {});
  check('略過的建議不再列入「AI 待確認」', !(await api('/api/files?status=ai_review')).body.items.some((f) => f.id === a3.id));

  // 免費額度用完：檔案照常歸檔，AI 暫停並延後，不會改用付費模型
  await webhook([ev('a4', 'file', '額度測試D.pdf')]);
  const a4 = await waitAi('額度測試D.pdf');
  ai = (await api('/api/settings')).body.ai;
  check('免費額度用完 → 檔案照常歸檔、AI 延後並暫停', a4?.status === 'done' && a4.ai_status === 'deferred' && !!ai.status.paused && /免費額度/.test(ai.status.paused.reason), JSON.stringify([a4?.status, a4?.ai_status, a4?.ai_error, ai.status.paused]));
  const callsBefore = (await aiCalls()).length;
  await webhook([ev('a5', 'file', '暫停中收到E.pdf')]);
  const a5 = await waitAi('暫停中收到E.pdf');
  check('暫停期間收到的檔案先歸檔，AI 延後且不呼叫模型', a5?.status === 'done' && a5.ai_status === 'deferred' && (await aiCalls()).length === callsBefore, JSON.stringify([a5?.ai_status, a5?.ai_error]));
  await post('/api/ai/resume', {});
  r = await post(`/api/files/${a5.id}/ai`, {});
  const a5b = await waitAi('暫停中收到E.pdf', (f) => f.ai_status === 'done');
  check('恢復後重新分析可以完成', r.status === 200 && a5b?.ai_status === 'done' && a5b.classified_by === 'ai', JSON.stringify([r.status, r.body, a5b?.ai_status, a5b?.ai_error]));
  ai = (await api('/api/settings')).body.ai;
  check('今日用量（本地估算）有記錄', ai.status.today.count >= 3 && ai.status.today.units > 0 && ai.status.today.unitLabel === 'Neurons', JSON.stringify(ai.status.today));

  // 每日件數上限
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { dailyLimit: ai.status.today.count } }) });
  await post(`/api/files/${a3.id}/ai`, {});
  const a3b = await waitAi('可疑檔案C.pdf');
  check('超過每日上限 → 延後到隔天', a3b?.ai_status === 'deferred' && /每日上限/.test(a3b.ai_error ?? ''), JSON.stringify([a3b?.ai_status, a3b?.ai_error]));
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { dailyLimit: 100 } }) });
  await post('/api/ai/resume', {});

  // Gemini（外部 AI）：沒有允許的群組不送出
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { provider: 'gemini' } }) });
  await webhook([ev('a6', 'file', '外部測試F.pdf')]);
  const a6 = await waitAi('外部測試F.pdf');
  check('使用 Gemini 時，沒有允許的群組不會送出', a6?.ai_status === 'skipped' && /外部 AI/.test(a6.ai_error ?? '') && !(await aiCalls()).some((c) => c.model.startsWith('gemini')), JSON.stringify([a6?.ai_status, a6?.ai_error]));
  await patch('/api/groups/Cgroup1', { ai_external: true });
  r = await post(`/api/files/${a6.id}/ai`, {});
  const a6b = await waitAi('外部測試F.pdf', (f) => f.ai_status === 'done' || f.ai_status === 'failed');
  check('群組允許後由 Gemini 分析（PDF 直接附上）', a6b?.ai_status === 'done' && a6b.ai_suggestion?.provider === 'gemini' && a6b.ai_summary === 'Gemini 測試摘要', JSON.stringify([a6b?.ai_status, a6b?.ai_error, a6b?.ai_suggestion]));
  r = await api('/api/ai/gemini-models');
  check('可以查詢 Gemini 可用模型', r.body?.items?.[0]?.id === 'gemini-flash-latest', JSON.stringify(r.body));
  await patch('/api/groups/Cgroup1', { ai_external: false });

  // 不使用 AI：照常歸檔
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { provider: 'off' } }) });
  await webhook([ev('a7', 'file', '關閉測試G.pdf')]);
  const a7 = await waitAi('關閉測試G.pdf');
  check('選「不使用 AI」時照常歸檔，AI 標成略過', a7?.status === 'done' && a7.ai_status === 'skipped' && /關閉/.test(a7.ai_error ?? ''), JSON.stringify([a7?.status, a7?.ai_status, a7?.ai_error]));
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { provider: 'workers' } }) });

  // ---------- 問 AI（免費引擎：拆搜尋條件 → 依權限搜尋 → 依找到的檔案回答） ----------
  check('選了免費的 Workers AI，「問 AI」就能用', (await api('/api/me')).body.aiAvailable === true);
  let calls0 = (await aiCalls()).length;
  const used0 = (await api('/api/settings')).body.ai.status.today.count;
  r = await post('/api/ask', { question: '幫我找 Farnesene 的 GC 分析' });
  let newCalls = (await aiCalls()).slice(calls0);
  check('問 AI：兩次模型呼叫，回答附上找到的檔案', r.status === 200 && newCalls.length === 2 && /<document id="\d+"/.test(newCalls[1].prompt) && r.body.files.length === 1 && r.body.answer.includes(`[#${r.body.files[0].id}]`), JSON.stringify([r.status, r.body, newCalls.length]));
  check('模型編造的檔案編號不會變成連結', !r.body.files.some((f) => f.id === 999999));
  check('問 AI 和文件判讀共用每天的免費額度', (await api('/api/settings')).body.ai.status.today.count === used0 + 1);
  calls0 = (await aiCalls()).length;
  r = await post('/api/ask', { question: '有沒有 Zzyzx 的資料' });
  check('找不到檔案時只呼叫一次模型（省額度）', r.status === 200 && /找不到/.test(r.body.answer) && (await aiCalls()).length === calls0 + 1, JSON.stringify(r.body));
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { dailyLimit: (await api('/api/settings')).body.ai.status.today.count } }) });
  r = await post('/api/ask', { question: '再問一次 Farnesene' });
  check('超過每日上限時問 AI 會提示明天恢復', r.status === 400 && /上限/.test(r.body.error ?? ''), JSON.stringify(r.body));
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { dailyLimit: 100, provider: 'gemini' } }) });
  r = await post('/api/ask', { question: '幫我找 Farnesene 的 GC 分析' });
  check('用 Gemini 時只查允許外部 AI 的群組', r.status === 200 && /找不到/.test(r.body.answer) && /允許送交外部 AI/.test(r.body.answer), JSON.stringify(r.body));
  await patch('/api/groups/Cgroup1', { ai_external: true });
  r = await post('/api/ask', { question: '幫我找 Farnesene 的 GC 分析' });
  check('群組允許後，Gemini 可以回答', r.status === 200 && r.body.files.length === 1, JSON.stringify(r.body));
  await patch('/api/groups/Cgroup1', { ai_external: false });
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { provider: 'workers' } }) });

  // ---------- 上傳者篩選與虛擬檢視 ----------
  const evU = (id, fileName, group, userId) => ({ ...ev(id, 'file', fileName, group), source: { type: 'group', groupId: group, userId } });
  const driveBefore = await drive();
  await webhook([evU('u1', '上傳者甲_群組二.pdf', 'Cgroup2', 'Uuser1'), evU('u2', '同名的另一人.pdf', 'Cgroup1', 'Uuser2'), evU('u3', '只在群組二.pdf', 'Cgroup2', 'Uuser3')]);
  for (const n of ['上傳者甲_群組二.pdf', '同名的另一人.pdf', '只在群組二.pdf']) await waitAi(n);
  let ups = (await api('/api/uploaders')).body;
  const me1 = ups.items.find((u) => u.key === 'line:Uuser1');
  const me2 = ups.items.find((u) => u.key === 'line:Uuser2');
  check('上傳者清單依 LINE User ID 區分，同名的兩個人不會合併', !!me1 && !!me2 && me1.name === '小明' && me2.name === '小明' && me1.count > me2.count && me1.groups === 2, JSON.stringify(ups.items.map((u) => [u.key, u.name, u.count, u.groups])));
  r = await api(`/api/files?limit=200&uploader=${encodeURIComponent('line:Uuser1')}`);
  check('點選上傳者：跨群組的檔案都在，沒有別人的', r.body.items.some((f) => f.original_name === '上傳者甲_群組二.pdf') && r.body.items.some((f) => f.group_id === 'Cgroup1') && r.body.items.every((f) => f.uploader_key === 'line:Uuser1'), JSON.stringify(r.body.items.map((f) => [f.original_name, f.group_id])));
  check('虛擬檢視不會移動或複製雲端上的檔案', (await drive()).filter((p) => driveBefore.includes(p)).length === driveBefore.length && (await drive()).length === driveBefore.length + 3);
  r = await api(`/api/files?limit=200&uploader=${encodeURIComponent('line:Uuser1')}&group=Cgroup2`);
  check('上傳者可以和群組交叉篩選', r.body.items.length === 1 && r.body.items[0].original_name === '上傳者甲_群組二.pdf', JSON.stringify(r.body.items.map((f) => f.original_name)));
  r = await api(`/api/files?limit=200&uploader=${encodeURIComponent('line:Uuser1')}&project=${proj2}`);
  check('上傳者可以和專案交叉篩選', r.body.items.every((f) => f.uploader_key === 'line:Uuser1' && f.project_id === proj2), JSON.stringify(r.body.items.map((f) => f.original_name)));
  r = await patch(`/api/uploaders/${encodeURIComponent('line:Uuser2')}`, { alias: '小明（品管）' });
  const u2file = (await api('/api/files?limit=200')).body.items.find((f) => f.original_name === '同名的另一人.pdf');
  ups = (await api('/api/uploaders')).body;
  check('設定別名後，舊檔案用新名稱顯示，另一個同名者不受影響', r.status === 200 && u2file?.uploader_name === '小明（品管）' && ups.items.find((u) => u.key === 'line:Uuser1')?.name === '小明', JSON.stringify([r.body, u2file?.uploader_name]));
  r = await api(`/api/uploaders/${encodeURIComponent('line:Uuser3')}/pin`, { method: 'PUT', body: JSON.stringify({ pinned: true }) });
  ups = (await api('/api/uploaders')).body;
  check('釘選的上傳者排在最上面', r.status === 200 && ups.items[0].key === 'line:Uuser3' && ups.items[0].pinned === true, JSON.stringify(ups.items.map((u) => [u.key, u.pinned])));
  r = await api('/api/uploaders?q=品管');
  check('可以搜尋上傳者（包含別名）', r.body.items.length === 1 && r.body.items[0].key === 'line:Uuser2', JSON.stringify(r.body.items));
  const upFile = (await api('/api/files?limit=200')).body.items.find((f) => f.source === 'upload');
  check('手動上傳的檔案用 GrabIt 帳號當上傳者', upFile?.uploader_key === 'user:admin@example.com', JSON.stringify(upFile && [upFile.uploader_key, upFile.uploader_name]));

  // ---------- 成員登入、權限、登出與撤銷 ----------
  const adminCookie = COOKIE;
  await post('/api/users', { email: 'Editor@Example.com', role: 'editor', groups: ['Cgroup1'] });
  const V = await login('viewer@example.com');
  check('被加入的成員可以登入', !!V.session, JSON.stringify(V.location));
  COOKIE = pair(V.session);
  check('檢視者不能修改', (await post('/api/projects', { name: '不該建立' })).status === 403);
  check('檢視者看不到未授權群組的檔案', (await api('/api/files')).body.items.length === 0);
  check('檢視者不能進入成員管理', (await api('/api/users')).status === 403);
  check('檢視者沒有授權群組時看不到任何上傳者', (await api('/api/uploaders')).body.items.length === 0 && (await api('/api/uploaders')).body.unknown === 0);
  check('檢視者不能改上傳者的名稱', (await patch(`/api/uploaders/${encodeURIComponent('line:Uuser1')}`, { alias: 'x' })).status === 403);
  check('檢視者不能重新分析或改 AI 設定', (await post('/api/ai/backfill', {})).status === 403 && (await post('/api/ai/resume', {})).status === 403);
  check('檢視者不能看或改系統設定', (await api('/api/settings')).status === 403 && (await api('/api/settings', { method: 'PUT', body: '{"ai_enabled":"0"}' })).status === 403);
  const vst = (await api('/api/storages')).body;
  check('檢視者只看得到雲端空間名稱（沒有帳號與分享細節）', vst.items.length > 0 && vst.items.every((s) => !('account' in s) && !('config' in s) && !('folderLink' in s) && !('share' in s)) && vst.types.length === 0, JSON.stringify(vst));
  r = await api('/api/me/prefs', { method: 'PUT', body: JSON.stringify({ mode: 'dark', palette: 'forest', fontSize: 'xl' }) });
  check('每個人都可以改自己的外觀與字體大小', r.status === 200 && r.body.mode === 'dark' && r.body.palette === 'forest' && r.body.fontSize === 'xl', JSON.stringify(r.body));
  r = await api('/api/me/prefs', { method: 'PUT', body: JSON.stringify({ palette: 'hacker<script>', fontSize: '200px' }) });
  const vme = (await api('/api/me')).body;
  check('外觀設定會保存，不合法的值被忽略', vme.prefs?.mode === 'dark' && vme.prefs.palette === 'forest' && vme.prefs.fontSize === 'xl', JSON.stringify(vme.prefs));
  const E = await login('editor@example.com');
  COOKIE = pair(E.session);
  check('外觀設定是每個人自己的', (await api('/api/me')).body.prefs?.palette === 'indigo' && (await api('/api/me')).body.prefs?.fontSize === 'md');
  check('編輯者只看得到被授權的群組', (await api('/api/files')).body.items.every((f) => f.group_id === 'Cgroup1') && (await api('/api/files')).body.items.length > 0);
  // 上傳者清單與數量只算看得到的檔案
  const eUps = (await api('/api/uploaders')).body;
  check('成員只看到被授權群組裡的上傳者與數量', !eUps.items.some((u) => u.key === 'line:Uuser3') && eUps.items.find((u) => u.key === 'line:Uuser1')?.groups === 1, JSON.stringify(eUps.items.map((u) => [u.key, u.count, u.groups])));
  check('看不到的上傳者不能改名或釘選', (await patch(`/api/uploaders/${encodeURIComponent('line:Uuser3')}`, { alias: 'x' })).status === 404 && (await api(`/api/uploaders/${encodeURIComponent('line:Uuser3')}/pin`, { method: 'PUT', body: '{"pinned":true}' })).status === 404);
  check('依上傳者篩選也不會看到未授權群組的檔案', (await api(`/api/files?limit=200&uploader=${encodeURIComponent('line:Uuser1')}`)).body.items.every((f) => f.group_id === 'Cgroup1'));
  // 雲端連結只給打得開的人；其他人用 GrabIt 下載
  const ef = (await api('/api/files')).body.items.find((f) => f.status === 'done');
  check('雲端沒分享給他時，不給「在雲端開啟」的連結', !!ef && ef.drive_link === null && (await api(`/api/files/${ef.id}`)).body.drive_link === null, JSON.stringify(ef));
  const edl = await fetch(`${BASE}/api/files/${ef.id}/download`, { headers: { Cookie: COOKIE } });
  check('沒有雲端權限也能透過 GrabIt 下載', edl.ok && (await edl.arrayBuffer()).byteLength > 0, String(edl.status));
  const editorCookie = COOKIE;
  COOKIE = adminCookie;
  await patch('/api/storages/1', { share: 'members' });
  COOKIE = editorCookie;
  check('專屬資料夾分享給成員後，成員就看得到雲端連結', /^https:\/\/drive\.google\.com\//.test((await api(`/api/files/${ef.id}`)).body.drive_link ?? ''));
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
