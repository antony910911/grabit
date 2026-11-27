import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { safeRedirect, sameOrigin, sha256Base64Url, randomToken } from '../src/worker/auth/session';
import { devBypass } from '../src/worker/auth';

describe('登入後導向（防 open redirect）', () => {
  it('只允許站內相對路徑', () => {
    expect(safeRedirect('/files?status=unsorted')).toBe('/files?status=unsorted');
    expect(safeRedirect('//evil.com')).toBe('/');
    expect(safeRedirect('/\\evil.com')).toBe('/');
    expect(safeRedirect('https://evil.com')).toBe('/');
    expect(safeRedirect('/auth/google/start')).toBe('/');
    expect(safeRedirect(null)).toBe('/');
  });
});

describe('CSRF：同源檢查', () => {
  const req = (method: string, headers: Record<string, string>) => new Request('https://grabit.example.workers.dev/api/x', { method, headers });
  it('GET 不檢查', () => expect(sameOrigin(req('GET', { Origin: 'https://evil.com' }))).toBe(true));
  it('同源 POST 允許、跨站 POST 拒絕', () => {
    expect(sameOrigin(req('POST', { Origin: 'https://grabit.example.workers.dev' }))).toBe(true);
    expect(sameOrigin(req('POST', { Origin: 'https://evil.com' }))).toBe(false);
    expect(sameOrigin(req('DELETE', { 'Sec-Fetch-Site': 'cross-site' }))).toBe(false);
    expect(sameOrigin(req('PATCH', { 'Sec-Fetch-Site': 'same-origin' }))).toBe(true);
  });
});

describe('PKCE 與隨機值', () => {
  it('S256 code challenge = base64url(SHA-256(verifier))', async () => {
    const verifier = randomToken(48);
    expect(await sha256Base64Url(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
  it('token 夠長且不重複', () => {
    const a = randomToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(randomToken());
  });
});

describe('DEV_NO_AUTH 只在本機有效', () => {
  const env = { DEV_NO_AUTH: 'true' } as never;
  it('正式網域不會略過登入', () => expect(devBypass(env, 'https://grabit.example.workers.dev/api/me')).toBe(false));
  it('本機可以略過', () => expect(devBypass(env, 'http://localhost:8787/api/me')).toBe(true));
});
