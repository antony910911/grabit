// 端對端測試用：包住正式的 worker，把 LINE 與 Google 的 API 換成記憶體中的假服務。
// 用法：npx wrangler dev -c test/e2e/wrangler.e2e.toml
import worker from '../../src/worker/index';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// 假的 Google 登入伺服器：用自己產生的 RSA 金鑰簽 ID Token，並提供對應的 JWKS
let keys: { privateKey: CryptoKey; jwk: Record<string, unknown> } | null = null;
let attackerKey: CryptoKey | null = null;
async function googleKeys() {
  if (!keys) {
    const k = await generateKeyPair('RS256', { extractable: true });
    keys = { privateKey: k.privateKey as CryptoKey, jwk: { ...(await exportJWK(k.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' } };
    attackerKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  }
  return keys;
}

/** 測試用的授權碼格式：login|email|nonce|email_verified|aud|iss|signer|expired */
async function googleIdToken(code: string): Promise<string> {
  const [, email, nonce, verified, aud, iss, signer, expired] = code.split('|');
  const k = await googleKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: verified === 'true', nonce, name: '測試使用者' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(iss || 'https://accounts.google.com')
    .setAudience(aud || 'x')
    .setSubject(`sub-${email}`)
    .setIssuedAt(expired === '1' ? now - 7200 : now)
    .setExpirationTime(expired === '1' ? now - 3600 : now + 3600)
    .sign(signer === 'attacker' ? attackerKey! : k.privateKey);
}

type DriveFile = { id: string; name: string; parents: string[]; folder: boolean; trashed: boolean; md5?: string; size?: number };
const files = new Map<string, DriveFile>();
const uploads = new Map<string, { name: string; parents: string[] }>();
let seq = 0;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });

const CONTENT: Record<string, string> = {
  m1: 'farnesene gc data',
  m2: 'meeting notes',
  m3: 'farnesene gc data', // 和 m1 內容相同 → 應判定為重複
  m4: 'random attachment',
  m5: 'image bytes',
  m6: 'image 2',
  m7: 'misc notes',
  v1: 'report draft 1',
  v2: 'report draft 2',
  v3: 'report final',
};

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const host = url.hostname;
  const p = url.pathname;

  if (host === 'api.line.me') {
    if (p.endsWith('/summary')) return json({ groupName: '酵母研發群組' });
    if (p.includes('/member/') || p.includes('/profile/')) return json({ displayName: '小明' });
  }
  if (host === 'api-data.line.me') {
    if (p.endsWith('/transcoding')) return json({ status: 'succeeded' });
    const id = p.split('/')[4]!;
    const body = CONTENT[id];
    if (!body) return new Response('not found', { status: 404 });
    const bytes = new TextEncoder().encode(body);
    return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) } });
  }
  if (host === 'oauth2.googleapis.com') {
    const form = new URLSearchParams(await req.text());
    const code = form.get('code') ?? '';
    if (code.startsWith('login|')) {
      if (!form.get('code_verifier') || form.get('client_secret') !== 'x') return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'fake', expires_in: 3600, id_token: await googleIdToken(code) });
    }
    return json({ access_token: 'fake', expires_in: 3600 });
  }
  if (host === 'www.googleapis.com' && p === '/oauth2/v3/certs') return json({ keys: [(await googleKeys()).jwk] });
  if (host === 'fake-upload.test') {
    const meta = uploads.get(p)!;
    const buf = await req.arrayBuffer();
    const md5 = [...new Uint8Array(await crypto.subtle.digest('MD5', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const id = `f${++seq}`;
    files.set(id, { id, name: meta.name, parents: meta.parents, folder: false, trashed: false, md5, size: buf.byteLength });
    return json({ id, md5Checksum: md5, size: String(buf.byteLength) });
  }
  if (host === 'www.googleapis.com') {
    if (p === '/upload/drive/v3/files') {
      const meta = (await req.json()) as { name: string; parents: string[] };
      const key = `/u${++seq}`;
      uploads.set(key, meta);
      return new Response(null, { status: 200, headers: { Location: `https://fake-upload.test${key}` } });
    }
    if (p === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
      const hit = [...files.values()].find(
        (f) => f.name === name && !f.trashed && f.folder === wantFolder && (parent === 'root' ? f.parents.length === 0 : f.parents.includes(parent!)),
      );
      return json({ files: hit ? [{ id: hit.id }] : [] });
    }
    if (p === '/drive/v3/files' && req.method === 'POST') {
      const meta = (await req.json()) as { name: string; parents?: string[] };
      const id = `d${++seq}`;
      files.set(id, { id, name: meta.name, parents: meta.parents ?? [], folder: true, trashed: false });
      return json({ id });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (m) {
      const f = files.get(m[1]!);
      if (!f) return json({ error: 'not found' }, 404);
      if (req.method === 'GET') return json({ parents: f.parents, trashed: f.trashed, md5Checksum: f.md5 });
      if (req.method === 'PATCH') {
        const body = (await req.json()) as { name?: string; trashed?: boolean };
        if (body.name) f.name = body.name;
        if (body.trashed) f.trashed = true;
        const add = url.searchParams.get('addParents');
        if (add) f.parents = [add];
        if (body.trashed === false) f.trashed = false;
        return json({ id: f.id });
      }
    }
  }
  if (host === 'mock.test' && p === '/drive-tree') {
    // 把假 Drive 的內容輸出成路徑清單，方便測試檢查
    const pathOf = (f: DriveFile): string => (f.parents[0] && files.get(f.parents[0]) ? `${pathOf(files.get(f.parents[0])!)}/${f.name}` : f.name);
    return json([...files.values()].filter((f) => !f.folder).map((f) => ({ path: pathOf(f), trashed: f.trashed })));
  }
  return new Response(`unmocked ${req.method} ${req.url}`, { status: 599 });
}

globalThis.fetch = mockFetch as typeof fetch;

export default {
  fetch(req: Request, env: never, ctx: ExecutionContext) {
    const url = new URL(req.url);
    if (url.pathname === '/api/__drive') return mockFetch('https://mock.test/drive-tree');
    return worker.fetch(req, env, ctx);
  },
  queue: worker.queue,
  scheduled: worker.scheduled,
};
