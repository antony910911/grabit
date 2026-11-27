import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, FileJob } from './env';
import { requireAuth } from './auth';
import { files } from './api/files';
import { manage } from './api/manage';
import { HttpError, need, type AppEnv } from './api/util';
import { handleWebhook } from './webhook';
import { handleQueue } from './processor';
import { handleEmail } from './ingest';
import { buildAuthUrl, exchangeCode, OAUTH } from './storage/oauth';
import { FolderCache } from './storage/cache';
import { STORAGE_LABEL, type StorageRow, type StorageType } from './storage';
import { log } from './db';

export const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: err.message || '伺服器錯誤' }, 500);
});

// LINE webhook（不經過登入驗證，改用 LINE 簽章驗證）
app.post('/webhook', (c) => handleWebhook(c.req.raw, c.env, c.executionCtx));

app.use('/api/*', requireAuth);
app.use('/oauth/*', requireAuth);
app.route('/api', files);
app.route('/api', manage);

// 雲端空間 OAuth（Google Drive、OneDrive、Dropbox）
const back = (msg: string, ok = false) => `/storages?${ok ? 'connected=1' : `error=${encodeURIComponent(msg)}`}`;

app.get('/oauth/:type/start', async (c) => {
  need(c, 'admin');
  const type = c.req.param('type') as StorageType;
  const storageId = Number(c.req.query('storage'));
  if (!OAUTH[type] || !storageId) return c.redirect(back('不支援的空間類型'));
  const state = `${crypto.randomUUID()}.${storageId}`;
  setCookie(c, 'grabit_oauth', state, { path: '/oauth', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 });
  return c.redirect(buildAuthUrl(c.env, type, new URL(`/oauth/${type}/callback`, c.req.url).toString(), state));
});

app.get('/oauth/:type/callback', async (c) => {
  const user = need(c, 'admin');
  const type = c.req.param('type') as StorageType;
  const { code, state, error, error_description } = c.req.query();
  const expected = getCookie(c, 'grabit_oauth');
  deleteCookie(c, 'grabit_oauth', { path: '/oauth' });
  if (error) return c.redirect(back(error_description || error));
  if (!code || !state || state !== expected) return c.redirect(back('驗證狀態不符，請重新連接'));
  const storageId = Number(state.split('.')[1]);
  const row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ? AND type = ?').bind(storageId, type).first<StorageRow>();
  if (!row) return c.redirect(back('找不到要連接的空間'));
  try {
    const r = await exchangeCode(c.env, type, code, new URL(`/oauth/${type}/callback`, c.req.url).toString());
    await c.env.DB.prepare('UPDATE storages SET secret = ?, account = ? WHERE id = ?').bind(JSON.stringify(r.secret), r.account, storageId).run();
    await new FolderCache(c.env, storageId).clear();
    await log(c.env, 'info', 'storage', `${user.email} 連接 ${STORAGE_LABEL[type]}「${row.name}」${r.account ? `（${r.account}）` : ''}`);
    return c.redirect(back('', true));
  } catch (e) {
    return c.redirect(back((e as Error).message));
  }
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.all('*', (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound()));

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<FileJob>, env: Env) => handleQueue(batch, env),
  email: (message: ForwardableEmailMessage, env: Env) => handleEmail(message, env),
} satisfies ExportedHandler<Env, FileJob>;
