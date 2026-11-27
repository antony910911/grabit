// 分類規則引擎：純函式，不碰資料庫或網路，方便測試與預覽。

export type MatchType = 'keywords' | 'regex' | 'extension' | 'any';

export interface Rule {
  id: number;
  name: string;
  priority: number;
  match_type: MatchType;
  pattern: string;
  group_id: string | null;
  target_path: string;
  rename_template: string | null;
  enabled: number | boolean;
  project_id?: number | null;
  tags?: string | null;
}

export interface ClassifyOptions {
  /** 沒有規則符合時的資料夾（群組設定），預設「待分類/{group}」 */
  fallbackPath?: string | null;
  /** 規則沒有指定改名時使用的群組預設改名範本 */
  defaultRename?: string | null;
}

export interface FileContext {
  fileName: string; // 原始檔名（含副檔名）
  groupId: string;
  groupName: string; // 已套用自訂名稱
  senderName?: string | null;
  receivedAt: Date;
  timeZone?: string;
}

export interface ClassifyResult {
  rule: Rule | null;
  folderPath: string; // 相對於根目錄，以 / 分隔
  storedName: string;
  unsorted: boolean;
}

export const UNSORTED_PATH = '待分類/{group}';

const KEYWORD_SPLIT = /[,，、;；\n]+/;

export function splitExt(fileName: string): { name: string; ext: string } {
  const i = fileName.lastIndexOf('.');
  if (i <= 0 || i === fileName.length - 1) return { name: fileName, ext: '' };
  return { name: fileName.slice(0, i), ext: fileName.slice(i + 1).toLowerCase() };
}

export function ruleMatches(rule: Rule, ctx: FileContext): boolean {
  if (!rule.enabled) return false;
  if (rule.group_id && rule.group_id !== ctx.groupId) return false;
  const name = ctx.fileName.toLowerCase();
  switch (rule.match_type) {
    case 'any':
      return true;
    case 'keywords': {
      const words = rule.pattern
        .split(KEYWORD_SPLIT)
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean);
      return words.some((w) => name.includes(w));
    }
    case 'extension': {
      const { ext } = splitExt(ctx.fileName);
      const exts = rule.pattern
        .split(KEYWORD_SPLIT)
        .map((e) => e.trim().replace(/^\./, '').toLowerCase())
        .filter(Boolean);
      return ext !== '' && exts.includes(ext);
    }
    case 'regex': {
      try {
        return new RegExp(rule.pattern, 'i').test(ctx.fileName);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

export function sortRules<T extends Pick<Rule, 'priority' | 'id'>>(rules: T[]): T[] {
  return [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
}

export function classify(rules: Rule[], ctx: FileContext, opts: ClassifyOptions = {}): ClassifyResult {
  const rule = sortRules(rules).find((r) => ruleMatches(r, ctx)) ?? null;
  const template = rule ? rule.target_path : opts.fallbackPath?.trim() || UNSORTED_PATH;
  const vars = templateVars(ctx);
  return {
    rule,
    folderPath: renderPath(template, vars),
    storedName: renderFileName(rule?.rename_template || opts.defaultRename || null, ctx.fileName, vars),
    unsorted: rule === null,
  };
}

export function splitList(s: string | null | undefined): string[] {
  return (s ?? '')
    .split(KEYWORD_SPLIT)
    .map((x) => x.trim())
    .filter(Boolean);
}

function datePartsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    yyyy: get('year'),
    MM: get('month'),
    dd: get('day'),
    HH: get('hour'),
    mm: get('minute'),
    ss: get('second'),
  };
}

export function templateVars(ctx: FileContext): Record<string, string> {
  const d = datePartsIn(ctx.receivedAt, ctx.timeZone ?? 'Asia/Taipei');
  const { name, ext } = splitExt(ctx.fileName);
  return {
    group: ctx.groupName || ctx.groupId,
    sender: ctx.senderName || '未知成員',
    ...d,
    yyyyMMdd: `${d.yyyy}${d.MM}${d.dd}`,
    HHmmss: `${d.HH}${d.mm}${d.ss}`,
    name,
    ext,
    filename: ctx.fileName,
  };
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? vars[key]! : m));
}

/** 移除雲端資料夾/檔名中不合法的字元 */
export function sanitizeSegment(s: string): string {
  return s
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '_')
    .slice(0, 200);
}

export function renderPath(template: string, vars: Record<string, string>): string {
  // 先依 / 拆段再代入變數，避免變數值（例如群組名稱含 /）產生額外的層級
  return template
    .split('/')
    .map((seg) => sanitizeSegment(renderTemplate(seg, vars)))
    .filter((seg) => seg !== '' && seg !== '_')
    .join('/');
}

export function renderFileName(
  template: string | null,
  originalName: string,
  vars: Record<string, string>,
): string {
  if (!template || !template.trim()) return sanitizeSegment(originalName) || 'file';
  let out = sanitizeSegment(renderTemplate(template.trim(), vars));
  const ext = vars.ext;
  if (ext && !out.toLowerCase().endsWith(`.${ext}`)) out = `${out}.${ext}`;
  return out || sanitizeSegment(originalName) || 'file';
}

/** 同一資料夾有同名檔案時產生「名稱 (1).ext」 */
export function withCounter(fileName: string, n: number): string {
  const { name, ext } = splitExt(fileName);
  return ext ? `${name} (${n}).${ext}` : `${name} (${n})`;
}
