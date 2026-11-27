import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, FileJob } from './env';
import { requireAuth, type AuthVars } from './auth';
import { api } from './api';
import { handleWebhook } from './webhook';
import { handleQueue } from './processor';
import { authUrl, exchangeCode } from './drive';
import { log } from './db';

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// LINE webhook（不經過登入驗證，改用 LINE 簽章驗證）
app.post('/webhook', (c) => handleWebhook(c.req.raw, c.env, c.executionCtx));

app.use('/api/*', requireAuth);
app.use('/oauth/*', requireAuth);
app.route('/api', api);

// Google Drive OAuth
app.get('/oauth/google/start', (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.redirect('/settings?drive=error&message=' + encodeURIComponent('尚未設定 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET'));
  }
  const state = crypto.randomUUID();
  setCookie(c, 'grabit_oauth_state', state, { path: '/oauth', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 });
  const redirectUri = new URL('/oauth/google/callback', c.req.url).toString();
  return c.redirect(authUrl(c.env, redirectUri, state));
});

app.get('/oauth/google/callback', async (c) => {
  const { code, state, error } = c.req.query();
  const expected = getCookie(c, 'grabit_oauth_state');
  deleteCookie(c, 'grabit_oauth_state', { path: '/oauth' });
  if (error) return c.redirect('/settings?drive=error&message=' + encodeURIComponent(error));
  if (!code || !state || state !== expected) {
    return c.redirect('/settings?drive=error&message=' + encodeURIComponent('驗證狀態不符，請重新連接'));
  }
  try {
    await exchangeCode(c.env, code, new URL('/oauth/google/callback', c.req.url).toString());
    await log(c.env, 'info', 'settings', `${c.get('userEmail')} 連接 Google Drive`);
    return c.redirect('/settings?drive=connected');
  } catch (e) {
    return c.redirect('/settings?drive=error&message=' + encodeURIComponent((e as Error).message));
  }
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<FileJob>, env: Env) => handleQueue(batch, env),
} satisfies ExportedHandler<Env, FileJob>;
