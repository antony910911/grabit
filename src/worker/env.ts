import type { AiEngine } from './ai';

export interface FileJob {
  fileId: number;
  /** 'ai'：歸檔完成後的 AI 判讀工作；沒有時是歸檔工作 */
  task?: 'ai';
}

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  FILE_QUEUE?: Queue<FileJob>;
  // Workers AI：免費 AI 文件判讀（預設引擎），也用於選用的語意搜尋（搭配 Vectorize）
  AI?: { run(model: string, input: unknown): Promise<unknown>; toMarkdown?(files: { name: string; blob: Blob }[]): Promise<unknown> };
  VECTORIZE?: VectorizeIndex;

  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  DROPBOX_APP_KEY?: string;
  DROPBOX_APP_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  /** Gemini API 免費版的金鑰（選用；Google AI Studio 建立，專案不要開 Billing） */
  GEMINI_API_KEY?: string;
  AI_MODEL?: string;

  TIMEZONE?: string;
  /** 可以登入並自動成為管理員的 email（逗號分隔） */
  ADMIN_EMAILS?: string;
  /** Session 絕對有效天數（預設 30）與閒置逾時天數（預設 7） */
  SESSION_TTL_DAYS?: string;
  SESSION_IDLE_DAYS?: string;
  /** 只在本機開發／展示版生效：略過登入 */
  DEV_NO_AUTH?: string;

  // 展示版注入的模擬 AI
  DEMO_AI?: AiEngine;
}

/** 不需要重試的錯誤（例如 LINE 檔案已過期） */
export class PermanentError extends Error {}

/** 稍後再試（例如影片還在轉檔） */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly delaySeconds = 30,
  ) {
    super(message);
  }
}

/** 只需要 waitUntil，避免 Hono 與 workers-types 的 ExecutionContext 型別不一致 */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}
