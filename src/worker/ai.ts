// AI 文件判讀引擎：Cloudflare Workers AI（免費額度，預設）、Gemini 免費 API（選用）、Claude（付費，選用）。
// 引擎只負責「讀內容、回傳原始 JSON」，驗證、額度與套用都在 ai-job.ts。
import type { Env } from './env';
import { toBase64, type Extracted } from './extract';
import { ANALYZE_SCHEMA, SYSTEM_PROMPT, buildPrompt, parseJsonOutput, type RawAnalysis } from './ai-schema';

export type AiProvider = 'workers' | 'gemini' | 'claude' | 'demo';

export interface AnalyzeInput {
  fileName: string;
  mime: string;
  data: ArrayBuffer | null;
  extracted: Extracted;
  groupName: string;
  folders: string[]; // 目前已有的資料夾（給 AI 參考，盡量放進既有分類）
  projects: string[];
  tags: string[];
}

/** 實際讀到多少內容：全文、部分（太長被截斷）、只有檔名 */
export type ContentRead = 'full' | 'partial' | 'filename';

export interface EngineOutput {
  raw: RawAnalysis;
  /** 模型回報的 token 用量；沒有回報時為 undefined，改用估算 */
  usage?: { input: number; output: number };
  read: ContentRead;
  /** 擷取出的文字（給全文搜尋用） */
  text: string;
}

export interface SearchHit {
  id: number;
  name: string;
  folder: string | null;
  group: string;
  project: string | null;
  received_at: string;
  summary: string | null;
  tags: string[];
}

export interface SearchArgs {
  query?: string;
  group?: string;
  project?: string;
  tag?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface AskTools {
  search(args: SearchArgs): Promise<SearchHit[]>;
  read(id: number): Promise<{ name: string; summary: string | null; text: string } | null>;
}

export interface AiEngine {
  readonly provider: AiProvider;
  readonly model: string;
  analyze(input: AnalyzeInput): Promise<EngineOutput>;
  /** 用一句話查檔案（跨文件問答）；只有 Claude 與展示版提供 */
  ask?(question: string, tools: AskTools): Promise<string>;
}

/** 免費額度用完：暫停到 resetAt，不會改用付費模型 */
export class AiQuotaError extends Error {
  constructor(
    message: string,
    readonly resetAt: Date,
  ) {
    super(message);
  }
}

/** 暫時性錯誤（每分鐘上限、服務忙碌、逾時）：稍後再試 */
export class AiTransientError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 120,
  ) {
    super(message);
  }
}

/** 交給 AI 讀取內容的檔案大小上限 */
export const AI_MAX_BYTES = 10 * 1024 * 1024;

/** 下一個 UTC 午夜（Workers AI 的免費額度在這時重置） */
export function nextUtcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** 下一個美西午夜（Gemini API 的每日上限在這時重置） */
export function nextPacificMidnight(now = new Date()): Date {
  // 找出美西時間的日期，再往後找到日期改變的那一刻（處理夏令時間）
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const today = day(now);
  let t = Math.ceil(now.getTime() / 3_600_000) * 3_600_000;
  while (day(new Date(t)) === today) t += 3_600_000;
  return new Date(t);
}

function promptFor(input: AnalyzeInput, text: string, limit: number, attached: boolean) {
  const truncated = text.length > limit;
  return {
    prompt: buildPrompt({ fileName: input.fileName, groupName: input.groupName, folders: input.folders, projects: input.projects, tags: input.tags, text: truncated ? text.slice(0, limit) : text, truncated, attached }),
    read: (attached ? 'full' : text ? (truncated ? 'partial' : 'full') : 'filename') as ContentRead,
  };
}

// ---------------------------------------------------------------------------
// Cloudflare Workers AI：跑在同一個 Cloudflare 帳號裡，每天 10,000 Neurons 免費

/** Workers AI 建議模型（都支援 JSON 輸出與繁體中文）；費率是每百萬 token 的 Neurons，用來估算免費額度 */
export const WORKERS_MODELS: { id: string; label: string; in: number; out: number }[] = [
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B（建議，速度快、長文件）', in: 24545, out: 77273 },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B（判斷較穩，額度用得較快）', in: 26668, out: 204805 },
  { id: '@cf/openai/gpt-oss-120b', label: 'gpt-oss 120B（推理較強）', in: 31818, out: 68182 },
];
export const DEFAULT_WORKERS_MODEL = WORKERS_MODELS[0]!.id;
/** 不在清單上的模型用保守的費率估算，寧可少分析幾份也不要超過免費額度 */
const UNKNOWN_RATE = { in: 60000, out: 300000 };
export function workersRate(model: string): { in: number; out: number } {
  return WORKERS_MODELS.find((m) => m.id === model) ?? UNKNOWN_RATE;
}
/** Workers AI 只讀文字，送給模型的內容上限（字）；越長越耗免費額度 */
export const WORKERS_TEXT_LIMIT = 4000;
export const WORKERS_MAX_OUTPUT = 900;

class WorkersAiEngine implements AiEngine {
  readonly provider = 'workers' as const;
  constructor(
    private env: Env,
    readonly model: string,
  ) {}

  private async pdfText(input: AnalyzeInput): Promise<string> {
    const ai = this.env.AI;
    if (!ai?.toMarkdown || !input.data) return '';
    // PDF 轉文字是免費的（不佔 Neurons）；掃描檔可能讀不到字
    const r = (await ai.toMarkdown([{ name: input.fileName, blob: new Blob([input.data], { type: 'application/pdf' }) }])) as unknown;
    const doc = (Array.isArray(r) ? r[0] : r) as { format?: string; data?: string } | undefined;
    return doc?.format === 'markdown' && typeof doc.data === 'string' ? doc.data.replace(/\n{3,}/g, '\n\n').trim() : '';
  }

  async analyze(input: AnalyzeInput): Promise<EngineOutput> {
    const ai = this.env.AI;
    if (!ai) throw new Error('沒有設定 Workers AI（wrangler.toml 的 [ai] binding）');
    let text = input.extracted.text;
    if (!text && input.extracted.kind === 'pdf') text = await this.pdfText(input).catch(() => '');
    const { prompt, read } = promptFor(input, text, WORKERS_TEXT_LIMIT, false);
    let res: { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      res = (await ai.run(this.model, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_schema', json_schema: ANALYZE_SCHEMA },
        max_tokens: WORKERS_MAX_OUTPUT,
        temperature: 0.2,
      })) as typeof res;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // 4006：今天的免費額度用完
      if (/4006|daily free allocation|neurons/i.test(msg)) throw new AiQuotaError('Workers AI 今天的免費額度已用完', nextUtcMidnight());
      if (/429|3040|capacity|rate limit|timeout|timed out/i.test(msg)) throw new AiTransientError(`Workers AI 暫時忙碌：${msg}`);
      throw new Error(`Workers AI 呼叫失敗：${msg}`);
    }
    const u = res.usage;
    return {
      raw: parseJsonOutput(res.response),
      usage: u?.prompt_tokens != null ? { input: u.prompt_tokens, output: u.completion_tokens ?? 0 } : undefined,
      read,
      text,
    };
  }
}

// ---------------------------------------------------------------------------
// Gemini API 免費版（Google AI Studio 的金鑰，專案不要開 Billing）

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_TEXT_LIMIT = 30_000;
/** Gemini 直接讀 PDF／圖片時，單一檔案的上限（內嵌傳送） */
const GEMINI_INLINE_MAX = 15 * 1024 * 1024;

/** Gemini 的 responseJsonSchema 不接受 additionalProperties，拿掉 */
function geminiSchema(): Record<string, unknown> {
  const { additionalProperties: _a, ...rest } = ANALYZE_SCHEMA as unknown as Record<string, unknown>;
  return rest;
}

class GeminiEngine implements AiEngine {
  readonly provider = 'gemini' as const;
  constructor(
    private env: Env,
    readonly model: string,
  ) {}

  private async call(body: Record<string, unknown>): Promise<Response> {
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.env.GEMINI_API_KEY ?? '' },
      body: JSON.stringify(body),
    });
  }

  async analyze(input: AnalyzeInput): Promise<EngineOutput> {
    const parts: Record<string, unknown>[] = [];
    const attachable = !!input.data && (input.extracted.kind === 'pdf' || input.extracted.kind === 'image') && input.data.byteLength <= GEMINI_INLINE_MAX;
    if (attachable) parts.push({ inline_data: { mime_type: input.extracted.mediaType ?? input.mime, data: toBase64(input.data!) } });
    const { prompt, read } = promptFor(input, input.extracted.text, GEMINI_TEXT_LIMIT, attachable);
    parts.push({ text: prompt });
    const base = { systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: 'user', parts }] };
    let res = await this.call({ ...base, generationConfig: { responseMimeType: 'application/json', responseJsonSchema: geminiSchema(), temperature: 0.2, maxOutputTokens: 8192 } });
    // 較舊的模型不支援 responseJsonSchema：改成只要求 JSON
    if (res.status === 400 && /responseJsonSchema|response_json_schema/i.test(await res.clone().text())) {
      res = await this.call({ ...base, generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 8192 } });
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; status?: string; details?: { violations?: { quotaId?: string }[]; retryDelay?: string }[] };
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    if (!res.ok) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 429) {
        const quotaIds = (data.error?.details ?? []).flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? '');
        if (quotaIds.some((q) => /PerDay/i.test(q)) || /per day|daily/i.test(msg)) throw new AiQuotaError('Gemini 今天的免費額度已用完', nextPacificMidnight());
        const delay = (data.error?.details ?? []).map((d) => Number.parseInt(d.retryDelay ?? '', 10)).find((n) => n > 0);
        throw new AiTransientError(`Gemini 每分鐘上限：${msg}`, delay ?? 60);
      }
      if (res.status >= 500) throw new AiTransientError(`Gemini 暫時無法使用：${msg}`);
      throw new Error(`Gemini 呼叫失敗：${msg}`);
    }
    const cand = data.candidates?.[0];
    if (!cand || cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') throw new Error('Gemini 拒絕分析這個檔案');
    const out = (cand.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const u = data.usageMetadata;
    return {
      raw: parseJsonOutput(out),
      usage: u?.promptTokenCount != null ? { input: u.promptTokenCount, output: u.candidatesTokenCount ?? 0 } : undefined,
      read,
      text: input.extracted.text,
    };
  }
}

// ---------------------------------------------------------------------------
// Claude（付費，需要 ANTHROPIC_API_KEY）：也提供「問 AI」

const CLAUDE_TEXT_LIMIT = 60_000;

class ClaudeEngine implements AiEngine {
  readonly provider = 'claude' as const;
  readonly model: string;
  constructor(private env: Env) {
    this.model = env.AI_MODEL || 'claude-opus-5-5';
  }

  private async client() {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
  }

  async analyze(input: AnalyzeInput): Promise<EngineOutput> {
    const client = await this.client();
    const content: Array<Record<string, unknown>> = [];
    let attached = false;
    if (input.data && input.extracted.kind === 'pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(input.data) } });
      attached = true;
    } else if (input.data && input.extracted.kind === 'image') {
      content.push({ type: 'image', source: { type: 'base64', media_type: input.extracted.mediaType, data: toBase64(input.data) } });
      attached = true;
    }
    const { prompt, read } = promptFor(input, input.extracted.text, CLAUDE_TEXT_LIMIT, attached);
    content.push({ type: 'text', text: prompt });
    let response;
    try {
      response = await client.beta.messages.create({
        model: this.model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: ANALYZE_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{ role: 'user', content: content as never }],
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429 || status === 529 || (status ?? 0) >= 500) throw new AiTransientError(`Claude 暫時無法使用：${(e as Error).message}`);
      throw e;
    }
    if (response.stop_reason === 'refusal') throw new Error('AI 拒絕分析這個檔案');
    const out = response.content.find((b) => b.type === 'text');
    if (!out || out.type !== 'text') throw new Error('AI 沒有回傳結果');
    return { raw: parseJsonOutput(out.text), usage: { input: response.usage.input_tokens, output: response.usage.output_tokens }, read, text: input.extracted.text };
  }

  async ask(question: string, tools: AskTools): Promise<string> {
    const client = await this.client();
    const { betaTool } = await import('@anthropic-ai/sdk/helpers/beta/json-schema');
    const search = betaTool({
      name: 'search_files',
      description: '搜尋已歸檔的檔案。可以依關鍵字（比對檔名、摘要、內文）、群組、專案、標籤、收到日期篩選。回傳檔案清單與摘要。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '關鍵字；留空代表只用篩選條件' },
          group: { type: 'string', description: '群組名稱（部分即可）' },
          project: { type: 'string', description: '專案名稱' },
          tag: { type: 'string', description: '標籤名稱' },
          from: { type: 'string', description: '收到日期起（YYYY-MM-DD）' },
          to: { type: 'string', description: '收到日期迄（YYYY-MM-DD）' },
          limit: { type: 'integer', description: '最多幾筆，預設 20' },
        },
        additionalProperties: false,
      },
      run: async (args) => JSON.stringify(await tools.search(args as SearchArgs)),
    });
    const read = betaTool({
      name: 'read_file',
      description: '讀取單一檔案的摘要與擷取出的內文，用來回答關於檔案內容的細節。',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
      run: async ({ id }) => JSON.stringify((await tools.read(Number(id))) ?? { error: '找不到檔案或沒有權限' }),
    });
    const today = new Date().toISOString().slice(0, 10);
    const final = await client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 16000,
      max_iterations: 6,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: `你是 GrabIt 檔案庫的查詢助理，根據使用者能看到的檔案回答問題。今天是 ${today}。
- 先用 search_files 找檔案，需要內容細節時再用 read_file。
- 用繁體中文簡潔回答。提到檔案時一定要用 [#檔案ID] 標註，例如「GC 分析結果 [#12]」，介面會把它變成連結。
- 找不到就直說找不到，並建議可以換什麼關鍵字。不要編造檔案。`,
      tools: [search, read],
      messages: [{ role: 'user', content: question }],
    });
    if (final.stop_reason === 'refusal') return '抱歉，這個問題無法回答。';
    return final.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim();
  }
}

/** 依設定建立分析引擎；該引擎沒有設定好時回傳 null */
export function createEngine(env: Env, provider: AiProvider, models: { workers: string; gemini: string }): AiEngine | null {
  if (env.DEMO_AI) return env.DEMO_AI;
  if (provider === 'workers') return env.AI ? new WorkersAiEngine(env, models.workers || DEFAULT_WORKERS_MODEL) : null;
  if (provider === 'gemini') return env.GEMINI_API_KEY ? new GeminiEngine(env, models.gemini || DEFAULT_GEMINI_MODEL) : null;
  if (provider === 'claude') return env.ANTHROPIC_API_KEY ? new ClaudeEngine(env) : null;
  return null;
}

/** 「問 AI」用的引擎：跨文件問答只有 Claude 與展示版提供（不屬於免費 Level 2 範圍） */
export async function askEngine(env: Env): Promise<AiEngine | null> {
  if (env.DEMO_AI) return env.DEMO_AI;
  if (!env.ANTHROPIC_API_KEY) return null;
  const off = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ai_enabled'").first<{ value: string }>();
  if (off?.value === '0') return null;
  return new ClaudeEngine(env);
}
