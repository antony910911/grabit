export interface FileJob {
  fileId: number;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  FILE_QUEUE?: Queue<FileJob>;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TIMEZONE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_NO_AUTH?: string;
}

/** 不需要重試的錯誤（例如 LINE 檔案已過期） */
export class PermanentError extends Error {}

/** 稍後再試（例如影片還在轉檔） */
export class RetryLaterError extends Error {
  constructor(message: string, readonly delaySeconds = 30) {
    super(message);
  }
}

/** 只需要 waitUntil，避免 Hono 與 workers-types 的 ExecutionContext 型別不一致 */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}
