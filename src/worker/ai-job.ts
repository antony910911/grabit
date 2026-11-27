// AI 文件判讀的背景工作（Level 2）。
// 原則：檔案先照群組與規則安全歸檔；AI 是之後才跑、可以延後與重試的附加工作。
// AI 關閉、額度用完、模型失敗都不影響收檔。免費額度用完就暫停到重置時間，不會改用付費模型。
import type { Env, WaitUntil } from './env';
import { addTags, getFile, getGroup, getSetting, groupDisplayName, log, projectIdByName, setSetting, deleteSetting, type FileRow, type GroupRow } from './db';
import { AI_MAX_BYTES, AiQuotaError, AiTransientError, createEngine, nextPacificMidnight, nextUtcMidnight, workersRate, WORKERS_MAX_OUTPUT, WORKERS_TEXT_LIMIT, DEFAULT_GEMINI_MODEL, DEFAULT_WORKERS_MODEL, type AiEngine, type AiProvider, type ContentRead } from './ai';
import { validateAnalysis, type Analysis } from './ai-schema';
import { extractContent } from './extract';
import { renderPath, templateVars } from './rules';
import { getStorage, providerFor } from './storage';
import { indexFile } from './search';
import { moveFile } from './ops';
import { newBatchId } from './api/util';

export type ProviderSetting = 'workers' | 'gemini' | 'claude' | 'off';

export interface AiFeatures {
  summary: boolean;
  tags: boolean;
  /** 分類建議與自動分類 */
  classify: boolean;
  /** 依內容建議新檔名，高信心時自動改名（預設關閉） */
  rename: boolean;
  /** 擷取重要資訊（日期、金額、編號） */
  keyInfo: boolean;
}

export interface AiSettings {
  provider: ProviderSetting;
  workersModel: string;
  geminiModel: string;
  /** 每天最多分析幾份 */
  dailyLimit: number;
  /** Workers AI 每天的 Neurons 預算（免費 10,000，預設留一成緩衝） */
  neuronBudget: number;
  /** 自動分類的信心門檻 */
  threshold: number;
  /** 只有規則無法分類時才呼叫 AI */
  onlyUnmatched: boolean;
  /** 沒有允許的群組不送交外部 AI（Gemini 免費版會用送出的內容改善產品） */
  externalNeedsConsent: boolean;
  features: AiFeatures;
}

export const DEFAULT_FEATURES: AiFeatures = { summary: true, tags: true, classify: true, rename: false, keyInfo: false };
export const DEFAULT_DAILY_LIMIT = 100;
export const DEFAULT_NEURON_BUDGET = 9000;
export const DEFAULT_THRESHOLD = 0.85;
/** 同一個檔案最多自動重試幾次（暫時性錯誤） */
const MAX_AI_ATTEMPTS = 4;

const bool = (v: string | null, d: boolean) => (v == null ? d : v === '1');
const num = (v: string | null, d: number, min: number, max: number) => {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? d : Math.max(min, Math.min(max, n));
};

/** 沒有選過引擎時的預設：沿用舊的 Claude 設定，否則用免費的 Workers AI */
function defaultProvider(env: Env, legacyEnabled: string | null): ProviderSetting {
  if (legacyEnabled === '0') return 'off';
  if (env.ANTHROPIC_API_KEY) return 'claude';
  if (env.AI || env.DEMO_AI) return 'workers';
  return 'off';
}

export async function loadAiSettings(env: Env): Promise<AiSettings> {
  const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all<{ key: string; value: string }>()).results;
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
  const p = get('ai_provider');
  let features = DEFAULT_FEATURES;
  try {
    features = { ...DEFAULT_FEATURES, ...(JSON.parse(get('ai_features') ?? '{}') as Partial<AiFeatures>) };
  } catch {
    // 設定損壞時用預設值
  }
  return {
    provider: p === 'workers' || p === 'gemini' || p === 'claude' || p === 'off' ? p : defaultProvider(env, get('ai_enabled')),
    workersModel: get('ai_model_workers') || DEFAULT_WORKERS_MODEL,
    geminiModel: get('ai_model_gemini') || DEFAULT_GEMINI_MODEL,
    dailyLimit: Math.round(num(get('ai_daily_limit'), DEFAULT_DAILY_LIMIT, 0, 5000)),
    neuronBudget: Math.round(num(get('ai_budget'), DEFAULT_NEURON_BUDGET, 0, 10000)),
    threshold: num(get('ai_threshold'), DEFAULT_THRESHOLD, 0.5, 1),
    onlyUnmatched: bool(get('ai_only_unmatched'), true),
    externalNeedsConsent: bool(get('ai_external_policy'), true),
    features,
  };
}

export function engineFor(env: Env, s: AiSettings): AiEngine | null {
  if (s.provider === 'off') return null;
  return createEngine(env, s.provider, { workers: s.workersModel, gemini: s.geminiModel });
}

/** 這個引擎會把內容送到 GrabIt 以外、而且可能拿來改善產品的服務 */
export const isExternal = (p: AiProvider | ProviderSetting) => p === 'gemini';

// ---------------------------------------------------------------------------
// 額度：每天件數＋模型預算，用單一 UPDATE 原子預留，並行時也不會超量

/** 額度的「一天」依各服務重置的時區：Workers AI 是 UTC，Gemini 是美西 */
export function usageDay(provider: string, now = new Date()): string {
  if (provider === 'gemini') return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
  return now.toISOString().slice(0, 10);
}
export function resetAt(provider: string, now = new Date()): Date {
  return provider === 'gemini' ? nextPacificMidnight(now) : nextUtcMidnight(now);
}

/** 預估一次分析最多用掉多少額度單位（Workers AI 是 Neurons；其他服務只算件數，單位是 token 僅供參考） */
export function estimateUnits(provider: string, model: string): number {
  if (provider !== 'workers') return 0;
  const r = workersRate(model);
  // 中文約 1.3 token／字；加上提示詞、既有資料夾與標籤清單
  const inputTokens = Math.ceil((WORKERS_TEXT_LIMIT + 3000) * 1.3);
  return (inputTokens * r.in + WORKERS_MAX_OUTPUT * r.out) / 1e6;
}
export function actualUnits(provider: string, model: string, usage: { input: number; output: number }): number {
  if (provider !== 'workers') return usage.input + usage.output;
  const r = workersRate(model);
  return (usage.input * r.in + usage.output * r.out) / 1e6;
}

export type Reservation = { ok: true; day: string; units: number } | { ok: false; why: 'count' | 'budget' };

export async function reserveUsage(env: Env, provider: string, model: string, s: AiSettings, now = new Date()): Promise<Reservation> {
  const day = usageDay(provider, now);
  const units = estimateUnits(provider, model);
  const budget = provider === 'workers' ? s.neuronBudget : Number.MAX_SAFE_INTEGER;
  await env.DB.prepare('INSERT OR IGNORE INTO ai_usage (day, provider) VALUES (?, ?)').bind(day, provider).run();
  const r = await env.DB.prepare('UPDATE ai_usage SET count = count + 1, units = units + ? WHERE day = ? AND provider = ? AND count < ? AND units + ? <= ?')
    .bind(units, day, provider, s.dailyLimit, units, budget)
    .run();
  if (r.meta.changes) return { ok: true, day, units };
  const row = await env.DB.prepare('SELECT count FROM ai_usage WHERE day = ? AND provider = ?').bind(day, provider).first<{ count: number }>();
  return { ok: false, why: (row?.count ?? 0) >= s.dailyLimit ? 'count' : 'budget' };
}

/** 用模型回報的實際用量取代預估；沒有回報時保留預估 */
async function settleUsage(env: Env, provider: string, res: { day: string; units: number }, actual: number | null): Promise<void> {
  if (actual == null) return;
  await env.DB.prepare('UPDATE ai_usage SET units = MAX(0, units - ? + ?) WHERE day = ? AND provider = ?').bind(res.units, actual, res.day, provider).run();
}

/** 沒有真的用到（額度不足、暫時錯誤）時退回預留 */
async function refundUsage(env: Env, provider: string, res: { day: string; units: number }): Promise<void> {
  await env.DB.prepare('UPDATE ai_usage SET count = MAX(0, count - 1), units = MAX(0, units - ?) WHERE day = ? AND provider = ?').bind(res.units, res.day, provider).run();
}

export async function pausedUntil(env: Env): Promise<{ until: Date; reason: string } | null> {
  const until = await getSetting(env, 'ai_paused_until');
  if (!until || new Date(until).getTime() <= Date.now()) return null;
  return { until: new Date(until), reason: (await getSetting(env, 'ai_paused_reason')) ?? '' };
}
async function pause(env: Env, until: Date, reason: string): Promise<void> {
  await setSetting(env, 'ai_paused_until', until.toISOString());
  await setSetting(env, 'ai_paused_reason', reason);
  await log(env, 'warn', 'ai', `${reason}，AI 判讀暫停到 ${until.toISOString().slice(0, 16).replace('T', ' ')}（UTC），檔案照常歸檔`);
}
export async function resumeAi(env: Env): Promise<void> {
  await deleteSetting(env, 'ai_paused_until');
  await deleteSetting(env, 'ai_paused_reason');
}

// ---------------------------------------------------------------------------
// 排入工作

async function setAiStatus(env: Env, fileId: number, status: FileRow['ai_status'], error: string | null = null): Promise<void> {
  await env.DB.prepare("UPDATE files SET ai_status = ?, ai_error = ?, updated_at = datetime('now') WHERE id = ?").bind(status, error, fileId).run();
}

/** 不需要（或不可以）分析時回傳原因；可以分析時回傳 null */
export function skipReason(file: Pick<FileRow, 'status' | 'matched_rule_id' | 'size'>, group: Pick<GroupRow, 'ai_enabled' | 'ai_external'> | null, s: AiSettings, opts: { force?: boolean } = {}): string | null {
  if (s.provider === 'off') return 'AI 判讀已關閉';
  if (file.status !== 'done') return '檔案還沒歸檔完成';
  if (group && !group.ai_enabled) return '這個群組關閉了 AI 判讀';
  if (isExternal(s.provider) && s.externalNeedsConsent && !group?.ai_external) return '這個群組沒有允許送交外部 AI（Gemini）';
  if (s.onlyUnmatched && file.matched_rule_id && !opts.force) return '已由分類規則歸檔，不需要 AI';
  return null;
}

/**
 * 歸檔完成後排入 AI 判讀。有 Queue 時放進佇列，沒有時在背景直接跑。
 * 不符合條件的檔案直接標成「略過」並記下原因，不會呼叫模型。
 */
export async function queueAi(env: Env, ctx: WaitUntil | null, fileId: number, opts: { force?: boolean } = {}): Promise<{ queued: boolean; reason: string | null }> {
  const file = await getFile(env, fileId);
  if (!file) return { queued: false, reason: '找不到檔案' };
  const s = await loadAiSettings(env);
  const group = await getGroup(env, file.group_id);
  const why = skipReason(file, group, s, opts) ?? (engineFor(env, s) ? null : 'AI 引擎還沒設定好');
  if (why) {
    // 從沒排過的檔案才記成略過，避免覆蓋已經分析好的結果
    if (!file.ai_status || file.ai_status === 'queued' || opts.force) await setAiStatus(env, fileId, 'skipped', why);
    return { queued: false, reason: why };
  }
  await env.DB.prepare("UPDATE files SET ai_status = 'queued', ai_error = NULL, ai_attempts = CASE WHEN ? THEN 0 ELSE ai_attempts END, updated_at = datetime('now') WHERE id = ?").bind(opts.force ? 1 : 0, fileId).run();
  if (env.FILE_QUEUE) await env.FILE_QUEUE.send({ fileId, task: 'ai' });
  else if (ctx) ctx.waitUntil(runAiJob(env, fileId, opts).catch(() => {}));
  else await runAiJob(env, fileId, opts);
  return { queued: true, reason: null };
}

// ---------------------------------------------------------------------------
// 執行分析

async function contextLists(env: Env, file: FileRow, group: GroupRow | null) {
  const vars = templateVars({ fileName: file.original_name, groupId: file.group_id, groupName: groupDisplayName(group, file.group_id), senderName: file.sender_name, receivedAt: new Date(file.received_at), timeZone: env.TIMEZONE || 'Asia/Taipei' });
  const [folders, rules, projects, tags] = await Promise.all([
    env.DB.prepare(
      "SELECT folder_path, COUNT(*) AS n FROM files WHERE status = 'done' AND storage_id = ? AND folder_path IS NOT NULL AND folder_path NOT LIKE '待分類%' AND folder_path != '_重複檔案' GROUP BY folder_path ORDER BY n DESC LIMIT 80",
    )
      .bind(file.storage_id)
      .all<{ folder_path: string }>(),
    env.DB.prepare('SELECT DISTINCT target_path FROM rules WHERE enabled = 1').all<{ target_path: string }>(),
    env.DB.prepare('SELECT name FROM projects ORDER BY name').all<{ name: string }>(),
    env.DB.prepare('SELECT t.name FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id GROUP BY t.id ORDER BY COUNT(ft.file_id) DESC LIMIT 60').all<{ name: string }>(),
  ]);
  // 規則的路徑是範本（例如 {yyyy}），先代入這個檔案的值，避免建出名字叫「{yyyy}」的資料夾
  const folderList = [...new Set([...folders.results.map((x) => x.folder_path), ...rules.results.map((x) => renderPath(x.target_path, vars))])];
  return { folders: folderList, projects: projects.results.map((p) => p.name), tags: tags.results.map((t) => t.name) };
}

export interface StoredSuggestion {
  folder: string | null;
  folderKnown: boolean;
  project: string | null;
  tags: string[];
  suggestedName: string | null;
  confidence: number;
  reason: string;
  keyInfo: string[];
  warnings: string[];
  provider: string;
  model: string;
  at: string;
  read: ContentRead;
  /** 系統已經自動套用了哪些建議 */
  applied: { folder?: boolean; name?: boolean; project?: boolean };
  dismissed?: boolean;
}

/** 執行一個檔案的 AI 判讀；所有錯誤都在這裡處理掉，不會影響檔案本身 */
export async function runAiJob(env: Env, fileId: number, opts: { force?: boolean } = {}): Promise<void> {
  const file = await getFile(env, fileId);
  if (!file) return;
  if (!opts.force && file.ai_status !== 'queued' && file.ai_status !== 'deferred') return;
  const s = await loadAiSettings(env);
  const group = await getGroup(env, file.group_id);
  const why = skipReason(file, group, s, opts);
  if (why) return setAiStatus(env, fileId, 'skipped', why);
  const engine = engineFor(env, s);
  if (!engine) return setAiStatus(env, fileId, 'skipped', 'AI 引擎還沒設定好');

  const paused = await pausedUntil(env);
  if (paused) return setAiStatus(env, fileId, 'deferred', `${paused.reason}，${paused.until.toISOString().slice(0, 16).replace('T', ' ')}（UTC）後自動繼續`);

  const reservation = await reserveUsage(env, engine.provider, engine.model, s);
  if (!reservation.ok) {
    const until = resetAt(engine.provider);
    const reason = reservation.why === 'count' ? `今天已分析 ${s.dailyLimit} 份（每日上限）` : '今天的免費額度預算已用完';
    await pause(env, until, reason);
    return setAiStatus(env, fileId, 'deferred', `${reason}，額度重置後自動繼續`);
  }

  // 同一時間只讓一個工作處理這個檔案
  const claim = await env.DB.prepare("UPDATE files SET ai_status = 'running', ai_attempts = ai_attempts + 1, updated_at = datetime('now') WHERE id = ? AND (ai_status IS NULL OR ai_status != 'running' OR ?)").bind(fileId, opts.force ? 1 : 0).run();
  if (!claim.meta.changes) return refundUsage(env, engine.provider, reservation);

  try {
    const storage = await getStorage(env, file.storage_id);
    if (!storage || !file.drive_file_id) throw new Error('找不到檔案所在的雲端空間');
    // 下載雲端上的檔案；太大的檔案只依檔名判斷
    let data: ArrayBuffer | null = null;
    let mime = file.mime_type ?? 'application/octet-stream';
    if ((file.size ?? 0) <= AI_MAX_BYTES) {
      const res = await providerFor(env, storage).download(file.drive_file_id);
      if (!res.ok) throw new AiTransientError(`無法從雲端讀取檔案（HTTP ${res.status}）`);
      mime = res.headers.get('Content-Type') || mime;
      data = await res.arrayBuffer();
      if (data.byteLength > AI_MAX_BYTES) data = null;
    }
    const extracted = data ? extractContent(file.original_name, mime, data) : { kind: 'none' as const, text: file.content_text ?? '' };
    const lists = await contextLists(env, file, group);
    const out = await engine.analyze({ fileName: file.original_name, mime, data, extracted, groupName: groupDisplayName(group, file.group_id), ...lists });
    await settleUsage(env, engine.provider, reservation, out.usage ? actualUnits(engine.provider, engine.model, out.usage) : null);
    const a = validateAnalysis(out.raw, { fileName: file.original_name, folders: lists.folders, projects: lists.projects });
    if (out.read === 'filename') a.warnings.unshift('沒有讀到文件內容，只依檔名判斷');
    else if (out.read === 'partial') a.warnings.unshift('文件很長，只讀了前面一部分');
    await applyAnalysis(env, file, a, s, { provider: engine.provider, model: engine.model, read: out.read, text: out.text });
  } catch (e) {
    const err = e as Error;
    if (e instanceof AiQuotaError) {
      await refundUsage(env, engine.provider, reservation);
      await env.DB.prepare('UPDATE files SET ai_attempts = MAX(0, ai_attempts - 1) WHERE id = ?').bind(fileId).run();
      await pause(env, e.resetAt, err.message);
      return setAiStatus(env, fileId, 'deferred', `${err.message}，額度重置後自動繼續`);
    }
    if (e instanceof AiTransientError && file.ai_attempts + 1 < MAX_AI_ATTEMPTS) {
      await refundUsage(env, engine.provider, reservation);
      return setAiStatus(env, fileId, 'deferred', `${err.message}（稍後自動重試）`);
    }
    await log(env, 'warn', 'ai', `AI 判讀失敗（檔案已照常歸檔）：${err.message}`, fileId);
    return setAiStatus(env, fileId, 'failed', err.message.slice(0, 500));
  }
}

/** 儲存結果，並在安全的條件下自動套用 */
async function applyAnalysis(env: Env, file: FileRow, a: Analysis, s: AiSettings, meta: { provider: string; model: string; read: ContentRead; text: string }): Promise<void> {
  const fresh = (await getFile(env, file.id)) ?? file;
  const high = a.confidence >= s.threshold;
  const applied: StoredSuggestion['applied'] = {};

  // 自動分類：規則沒有分類、沒被手動調整過、信心夠高，而且是既有的資料夾
  let folder = fresh.folder_path ?? '';
  let name = fresh.stored_name ?? fresh.original_name;
  const canMove = s.features.classify && high && fresh.unsorted === 1 && !fresh.manual && !fresh.matched_rule_id && !!a.folder && a.folderKnown && a.folder !== fresh.folder_path;
  const canRename = s.features.rename && high && !fresh.manual && !!a.suggestedName;
  if ((canMove || canRename) && fresh.drive_file_id) {
    if (canMove) folder = a.folder!;
    if (canRename) name = a.suggestedName!;
    try {
      const r = await moveFile(env, fresh, folder, name, { batchId: newBatchId(), description: `AI 判讀（把握度 ${Math.round(a.confidence * 100)}%）`, userEmail: 'AI', manual: false });
      if (canMove) {
        await env.DB.prepare("UPDATE files SET unsorted = 0, classified_by = 'ai' WHERE id = ?").bind(file.id).run();
        applied.folder = true;
      }
      if (canRename) applied.name = true;
      await log(env, 'info', 'ai', `AI 判讀：「${file.original_name}」→ ${r.folderPath}/${r.storedName}（把握度 ${Math.round(a.confidence * 100)}%）`, file.id);
    } catch (e) {
      a.warnings.push(`自動套用失敗：${(e as Error).message}`);
    }
  }
  if (s.features.classify && high && a.project && !fresh.project_id) {
    const pid = await projectIdByName(env, a.project);
    if (pid) {
      await env.DB.prepare('UPDATE files SET project_id = ? WHERE id = ?').bind(pid, file.id).run();
      applied.project = true;
    }
  }
  if (s.features.tags && a.tags.length) await addTags(env, file.id, a.tags, 'ai');

  const suggestion: StoredSuggestion = {
    folder: a.folder,
    folderKnown: a.folderKnown,
    project: a.project,
    tags: a.tags,
    suggestedName: a.suggestedName,
    confidence: a.confidence,
    reason: a.reason,
    keyInfo: s.features.keyInfo ? a.keyInfo : [],
    warnings: a.warnings,
    provider: meta.provider,
    model: meta.model,
    at: new Date().toISOString(),
    read: meta.read,
    applied,
  };
  const text = (meta.text || a.keyText || '').slice(0, 20_000);
  await env.DB.prepare(
    `UPDATE files SET ai_summary = CASE WHEN ? THEN ? ELSE ai_summary END, ai_suggestion = ?, content_text = COALESCE(NULLIF(content_text, ''), ?),
     ai_status = 'done', ai_error = NULL, ai_at = datetime('now') WHERE id = ?`,
  )
    .bind(s.features.summary ? 1 : 0, a.summary || null, JSON.stringify(suggestion), text || null, file.id)
    .run();
  await indexFile(env, file.id);
}

/** 排程：撿回延後（額度重置、暫時錯誤）與卡住的 AI 工作；暫停中就不動 */
export async function retryAi(env: Env, limit = 3): Promise<number> {
  if (await pausedUntil(env)) return 0;
  const rows = await env.DB.prepare(
    `SELECT id FROM files WHERE status = 'done' AND (
       ai_status = 'deferred' OR (ai_status = 'queued' AND updated_at <= datetime('now', '-10 minutes'))
       OR (ai_status = 'running' AND updated_at <= datetime('now', '-15 minutes')))
     ORDER BY updated_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: number }>();
  for (const r of rows.results) {
    await env.DB.prepare("UPDATE files SET ai_status = 'queued' WHERE id = ? AND ai_status != 'done'").bind(r.id).run();
    await runAiJob(env, r.id);
  }
  return rows.results.length;
}

/** 管理介面顯示的狀態（用量是本地估算） */
export async function aiStatus(env: Env, s: AiSettings) {
  const engine = engineFor(env, s);
  const provider = engine?.provider ?? s.provider;
  const day = usageDay(provider);
  const usage = await env.DB.prepare('SELECT count, units FROM ai_usage WHERE day = ? AND provider = ?').bind(day, provider).first<{ count: number; units: number }>();
  const counts = (await env.DB.prepare("SELECT ai_status AS s, COUNT(*) AS n FROM files WHERE ai_status IN ('queued', 'running', 'deferred', 'failed') GROUP BY ai_status").all<{ s: string; n: number }>()).results;
  const n = (k: string) => counts.find((c) => c.s === k)?.n ?? 0;
  const last = await env.DB.prepare("SELECT MAX(ai_at) AS at FROM files WHERE ai_status = 'done'").first<{ at: string | null }>();
  const paused = await pausedUntil(env);
  return {
    ready: !!engine,
    provider,
    model: engine?.model ?? null,
    today: { count: usage?.count ?? 0, units: Math.round(usage?.units ?? 0), unitLabel: provider === 'workers' ? 'Neurons' : 'tokens', estimated: true, resetAt: resetAt(provider).toISOString() },
    queued: n('queued') + n('running'),
    deferred: n('deferred'),
    failed: n('failed'),
    lastAt: last?.at ?? null,
    paused: paused ? { until: paused.until.toISOString(), reason: paused.reason } : null,
    estimatedDocsPerDay: provider === 'workers' ? Math.floor(s.neuronBudget / Math.max(1, estimateUnits('workers', s.workersModel) * 0.5)) : null,
  };
}
