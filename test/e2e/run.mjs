// 端對端測試：node test/e2e/run.mjs
// 啟動 wrangler dev（使用假的 LINE / Google 服務），送出簽章過的 webhook，檢查歸檔結果。
import { spawn, execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'e2e-secret';
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), 'grabit-e2e-'));
const cfg = 'test/e2e/wrangler.e2e.toml';
const sh = (cmd) => execSync(cmd, { stdio: 'pipe' }).toString();

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ` ${extra}`}`);
  if (!cond) failed++;
};

sh(`npx wrangler d1 migrations apply grabit --local -c ${cfg} --persist-to ${persist}`);
sh(`npx wrangler d1 execute grabit --local -c ${cfg} --persist-to ${persist} --command "INSERT INTO settings (key, value) VALUES ('google_refresh_token', 'fake'), ('google_email', 'tester@example.com')"`);

const dev = spawn('npx', ['wrangler', 'dev', '-c', cfg, '--port', String(PORT), '--persist-to', persist,
  '--var', `LINE_CHANNEL_SECRET:${SECRET}`, '--var', 'LINE_CHANNEL_ACCESS_TOKEN:x',
  '--var', 'GOOGLE_CLIENT_ID:x', '--var', 'GOOGLE_CLIENT_SECRET:x', '--var', 'DEV_NO_AUTH:true'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let logs = '';
dev.stdout.on('data', (d) => (logs += d));
dev.stderr.on('data', (d) => (logs += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const webhook = async (events, secret = SECRET) => {
  const body = JSON.stringify({ destination: 'U0', events });
  const sig = createHmac('sha256', secret).update(body).digest('base64');
  return fetch(`${BASE}/webhook`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'x-line-signature': sig } });
};
const ev = (id, type, fileName) => ({
  type: 'message', timestamp: Date.parse('2026-11-27T06:30:00Z'),
  source: { type: 'group', groupId: 'Cgroup1', userId: 'Uuser1' },
  message: { id, type, ...(fileName ? { fileName, fileSize: 10 } : {}) },
});

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/me')).ok) break; } catch {}
    await sleep(500);
  }

  check('錯誤簽章被拒絕', (await webhook([], 'wrong')).status === 401);
  check('空的驗證請求回 200', (await webhook([])).status === 200);

  let r = await api('/api/rules', { method: 'POST', body: JSON.stringify({ name: '分析數據', match_type: 'keywords', pattern: 'GC, HPLC', target_path: 'Farnesene/分析數據/{yyyy}', priority: 10 }) });
  check('新增規則', r.status === 200, JSON.stringify(r.body));
  r = await api('/api/rules', { method: 'POST', body: JSON.stringify({ name: '會議', match_type: 'keywords', pattern: '會議紀錄', target_path: '會議紀錄/{yyyy}-{MM}', rename_template: '{yyyyMMdd}_{name}', priority: 20 }) });
  check('新增第二條規則', r.status === 200);
  r = await api('/api/rules', { method: 'POST', body: JSON.stringify({ name: '壞規則', match_type: 'regex', pattern: '([', target_path: 'x' }) });
  check('錯誤的正規表示式被擋下', r.status === 400);

  r = await api('/api/rules/test', { method: 'POST', body: JSON.stringify({ fileName: 'Farnesene_GC.xlsx' }) });
  check('規則模擬器', r.body?.fullPath === `LINE FileHub/Farnesene/分析數據/${new Date().getFullYear()}/Farnesene_GC.xlsx`, JSON.stringify(r.body));

  await webhook([ev('m1', 'file', '20261127_Farnesene_GC分析結果.xlsx'), ev('m2', 'file', '週會會議紀錄.docx'), ev('m4', 'file', '附件01.pdf'), ev('m5', 'image')]);
  await webhook([ev('m1', 'file', '20261127_Farnesene_GC分析結果.xlsx')]); // LINE 重送
  await sleep(2500);
  await webhook([ev('m3', 'file', 'GC結果_copy.xlsx')]); // 內容與 m1 相同
  await webhook([ev('m9', 'file', 'expired.pdf')]); // LINE 上已不存在

  let files = [];
  for (let i = 0; i < 40; i++) {
    files = (await api('/api/files?status=all')).body.items;
    if (files.length === 6 && files.every((f) => !['pending', 'processing'].includes(f.status))) break;
    await sleep(500);
  }
  const by = Object.fromEntries(files.map((f) => [f.line_message_id, f]));
  check('重送的訊息不會重複建立', files.length === 6, `got ${files.length}`);
  check('依關鍵字歸檔', by.m1?.status === 'done' && by.m1.folder_path === 'Farnesene/分析數據/2026', JSON.stringify(by.m1));
  check('自動改名＋月份資料夾', by.m2?.folder_path === '會議紀錄/2026-11' && by.m2.stored_name === '20261127_週會會議紀錄.docx', JSON.stringify(by.m2));
  check('沒有規則 → 待分類/群組名', by.m4?.unsorted === 1 && by.m4.folder_path === '待分類/酵母研發群組', JSON.stringify(by.m4));
  check('圖片自動命名', by.m5?.stored_name === 'IMG_20261127_143000_m5.jpg', JSON.stringify(by.m5));
  check('上傳者名稱', by.m1?.sender_name === '小明');
  check('內容相同 → 標記重複', by.m3?.status === 'duplicate' && by.m3.duplicate_of === by.m1?.id, JSON.stringify(by.m3));
  check('LINE 檔案過期 → 失敗且不重試', by.m9?.status === 'failed' && /過期/.test(by.m9.error ?? ''), JSON.stringify(by.m9));

  let tree = await (await fetch(BASE + '/api/__drive')).json();
  const live = tree.filter((f) => !f.trashed).map((f) => f.path).sort();
  check('Google Drive 上的實際路徑', JSON.stringify(live) === JSON.stringify([
    'LINE FileHub/Farnesene/分析數據/2026/20261127_Farnesene_GC分析結果.xlsx',
    'LINE FileHub/待分類/酵母研發群組/IMG_20261127_143000_m5.jpg',
    'LINE FileHub/待分類/酵母研發群組/附件01.pdf',
    'LINE FileHub/會議紀錄/2026-11/20261127_週會會議紀錄.docx',
  ]), JSON.stringify(live));
  check('重複檔已移到垃圾桶', tree.some((f) => f.trashed && f.path.endsWith('GC結果_copy.xlsx')));

  // 新增規則後重新套用到待分類
  await api('/api/rules', { method: 'POST', body: JSON.stringify({ name: '附件', match_type: 'regex', pattern: '^附件\\d+', target_path: '附件/{group}', priority: 30 }) });
  r = await api('/api/files/reapply', { method: 'POST', body: JSON.stringify({ scope: 'unsorted', dryRun: true }) });
  check('重新套用：預覽', r.body?.changes?.length === 1 && r.body.changes[0].to === '附件/酵母研發群組', JSON.stringify(r.body));
  r = await api('/api/files/reapply', { method: 'POST', body: JSON.stringify({ scope: 'unsorted', dryRun: false }) });
  check('重新套用：實際搬移', r.body?.moved === 1, JSON.stringify(r.body));

  // 手動移動與改名（同名檔案自動加編號）
  r = await api(`/api/files/${by.m5.id}`, { method: 'PATCH', body: JSON.stringify({ folderPath: 'Farnesene/分析數據/2026', storedName: '20261127_Farnesene_GC分析結果.xlsx' }) });
  check('手動移動遇到同名自動加編號', r.body?.storedName === '20261127_Farnesene_GC分析結果 (1).xlsx', JSON.stringify(r.body));
  r = await api(`/api/files/${by.m2.id}`, { method: 'DELETE' });
  check('刪除', r.status === 200);

  tree = await (await fetch(BASE + '/api/__drive')).json();
  const live2 = tree.filter((f) => !f.trashed).map((f) => f.path).sort();
  check('操作後 Drive 狀態正確', JSON.stringify(live2) === JSON.stringify([
    'LINE FileHub/Farnesene/分析數據/2026/20261127_Farnesene_GC分析結果 (1).xlsx',
    'LINE FileHub/Farnesene/分析數據/2026/20261127_Farnesene_GC分析結果.xlsx',
    'LINE FileHub/附件/酵母研發群組/附件01.pdf',
  ]), JSON.stringify(live2));

  r = await api('/api/stats');
  check('統計', r.body?.archived === 3 && r.body.failed === 1 && r.body.duplicates === 1 && r.body.groups === 1, JSON.stringify(r.body));
  r = await api(`/api/files/${by.m9.id}/retry`, { method: 'POST' });
  check('失敗檔案可以重試', r.status === 200);

  const page = await fetch(BASE + '/files');
  check('SPA 路由回傳管理介面', page.ok && (await page.text()).includes('<div id="root">'));
} catch (e) {
  console.error(e);
  failed++;
} finally {
  // 結束整個 process group（npx → wrangler → workerd）
  try { process.kill(-dev.pid, 'SIGTERM'); } catch {}
  await sleep(1000);
  rmSync(persist, { recursive: true, force: true });
  if (failed) {
    console.log('\n--- wrangler 輸出 ---\n' + logs.slice(-4000));
    console.log(`\n${failed} 項失敗`);
    process.exit(1);
  }
  console.log('\n全部通過');
}
