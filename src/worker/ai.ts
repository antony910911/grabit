// AI 文件判讀：摘要、標籤、建議分類（第三層），以及自然語言查詢
import type { Env } from './env';
import { toBase64, type Extracted } from './extract';

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

export interface AnalyzeResult {
  summary: string;
  tags: string[];
  folder: string | null;
  project: string | null;
  confidence: number; // 0–1
  reason: string;
  text: string; // 給全文搜尋用的重點文字
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
  readonly name: string;
  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
  ask(question: string, tools: AskTools): Promise<string>;
}

/** 交給 AI 讀取內容的檔案大小上限 */
export const AI_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_LIMIT = 60_000;

const ANALYZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'tags', 'folder', 'project', 'confidence', 'reason', 'key_text'],
  properties: {
    summary: { type: 'string', description: '繁體中文摘要，2–3 句，說明文件是什麼、重點數據或結論' },
    tags: { type: 'array', items: { type: 'string' }, description: '3–6 個標籤，優先沿用既有標籤' },
    folder: { type: ['string', 'null'], description: '建議存放的資料夾路徑（用 / 分隔），優先選既有資料夾；無法判斷時為 null' },
    project: { type: ['string', 'null'], description: '所屬專案名稱，只能從既有專案中挑選；不屬於任何專案時為 null' },
    confidence: { type: 'number', description: '對 folder 建議的把握程度，0 到 1' },
    reason: { type: 'string', description: '一句話說明分類依據' },
    key_text: { type: 'string', description: '文件中最重要的原文片段（標題、關鍵詞、樣品編號、結論），最多 1500 字，供全文搜尋' },
  },
} as const;

const SYSTEM = `你是研發團隊的檔案歸檔助理。團隊透過 LINE 群組傳送實驗數據、報告、會議紀錄、報價單等檔案，你要判讀內容並協助歸檔。
規則：
- 一律使用繁體中文。
- 優先把檔案放進「既有資料夾」中最合適的一個；只有在明顯沒有合適資料夾時，才建議新的資料夾路徑（最多三層）。
- 沒有把握時，confidence 要低於 0.6，不要硬猜。
- 標籤要簡短（2–8 個字），優先沿用既有標籤，可以包含專案名、年度、檔案性質（例如：GC 分析、期末報告、報價）。`;

function analyzePrompt(input: AnalyzeInput, text: string, truncated: boolean): string {
  return [
    `檔名：${input.fileName}`,
    `來源群組：${input.groupName}`,
    `既有資料夾：\n${input.folders.slice(0, 80).map((f) => `- ${f}`).join('\n') || '（尚無）'}`,
    `既有專案：${input.projects.join('、') || '（尚無）'}`,
    `既有標籤：${input.tags.slice(0, 80).join('、') || '（尚無）'}`,
    text ? `文件內容${truncated ? `（內容很長，以下只提供前 ${TEXT_LIMIT} 字）` : ''}：\n${text}` : input.extracted.kind === 'none' ? '（無法讀取內容，請只依檔名判斷，confidence 應偏低）' : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

class ClaudeEngine implements AiEngine {
  readonly name: string;
  constructor(private env: Env) {
    this.name = env.AI_MODEL || 'claude-opus-5-5';
  }

  private async client() {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const client = await this.client();
    const text = input.extracted.text;
    const truncated = text.length > TEXT_LIMIT;
    const content: Array<Record<string, unknown>> = [];
    if (input.data && input.extracted.kind === 'pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(input.data) } });
    } else if (input.data && input.extracted.kind === 'image') {
      content.push({ type: 'image', source: { type: 'base64', media_type: input.extracted.mediaType, data: toBase64(input.data) } });
    }
    content.push({ type: 'text', text: analyzePrompt(input, truncated ? text.slice(0, TEXT_LIMIT) : text, truncated) });

    const response = await client.beta.messages.create({
      model: this.name,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ANALYZE_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content: content as never }],
    });
    if (response.stop_reason === 'refusal') throw new Error('AI 拒絕分析這個檔案');
    const out = response.content.find((b) => b.type === 'text');
    if (!out || out.type !== 'text') throw new Error('AI 沒有回傳結果');
    const parsed = JSON.parse(out.text) as { summary: string; tags: string[]; folder: string | null; project: string | null; confidence: number; reason: string; key_text: string };
    return {
      summary: parsed.summary,
      tags: parsed.tags.slice(0, 8),
      folder: parsed.folder,
      project: parsed.project,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reason: parsed.reason,
      text: text ? text.slice(0, 20_000) : parsed.key_text,
    };
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
      model: this.name,
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

/** 取得 AI 引擎：展示版用模擬引擎，正式環境需要設定 ANTHROPIC_API_KEY */
export async function aiEngine(env: Env): Promise<AiEngine | null> {
  if (env.DEMO_AI) return env.DEMO_AI;
  if (!env.ANTHROPIC_API_KEY) return null;
  const setting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ai_enabled'").first<{ value: string }>();
  if (setting?.value === '0') return null;
  return new ClaudeEngine(env);
}
