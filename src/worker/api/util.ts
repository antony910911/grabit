import type { Context } from 'hono';
import type { Env } from '../env';
import type { CurrentUser, Role } from '../permissions';
import { atLeast } from '../permissions';
import { sanitizeSegment } from '../rules';

export type AppEnv = { Bindings: Env; Variables: { user: CurrentUser; sessionId: string | null } };
export type Ctx = Context<AppEnv>;

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = '找不到資料') => new HttpError(404, msg);

export function need(c: Ctx, role: Role): CurrentUser {
  const user = c.get('user');
  if (!atLeast(user, role)) throw new HttpError(403, role === 'admin' ? '需要管理員權限' : '你的帳號只能檢視，不能修改');
  return user;
}

export async function readJson<T>(c: Ctx): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw bad('JSON 格式錯誤');
  }
}

/** 使用者輸入的資料夾路徑：去掉不合法字元與空白層級 */
export function cleanFolderPath(p: string): string {
  const out = p
    .split('/')
    .map((s) => sanitizeSegment(s))
    .filter((s) => s && s !== '_' && s !== '..')
    .join('/');
  if (!out) throw bad('資料夾路徑不能是空的');
  return out;
}

export function intParam(c: Ctx, name = 'id'): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n)) throw bad('ID 不正確');
  return n;
}

export function newBatchId(): string {
  return crypto.randomUUID();
}
