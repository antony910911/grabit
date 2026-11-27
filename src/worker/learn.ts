// 從手動搬移學習分類規則：找出「這個資料夾的檔案都有、其他資料夾很少有」的關鍵字
import type { Env } from './env';
import { classify, splitExt, type Rule } from './rules';

const STOP = new Set(['copy', 'final', 'file', 'scan', 'img', 'vid', 'aud', 'doc', 'pdf', 'xlsx', 'docx', 'pptx', 'the', 'and', '附件', '檔案', '資料', '最新', '修正版', '修訂版', '副本', '新增']);

/** 從檔名切出可以當關鍵字的片段 */
export function candidateTokens(fileName: string): string[] {
  const { name } = splitExt(fileName);
  const parts = name
    // 中文與英數字交界也切開：Farnesene_GC分析 → Farnesene / GC / 分析
    .replace(/([\p{Script=Han}])([A-Za-z0-9])/gu, '$1 $2')
    .replace(/([A-Za-z0-9])([\p{Script=Han}])/gu, '$1 $2')
    .split(/[\s_\-.,，、()（）[\]【】{}+&＋/\\]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (const p of parts) {
    if (/^\d+$/.test(p)) continue; // 純數字、日期
    if (/^v\d+$/i.test(p) || /^rev\d+$/i.test(p)) continue;
    const t = /^[\x00-\x7f]+$/.test(p) ? p : p;
    if (t.length < 2 || STOP.has(t.toLowerCase())) continue;
    out.add(t);
  }
  return [...out];
}

/** 把路徑中的年份、年月換成變數，讓規則明年也適用 */
export function generalizePath(folder: string, receivedAt: Date): string {
  const y = String(receivedAt.getUTCFullYear());
  return folder
    .split('/')
    .map((seg) => {
      if (seg === y) return '{yyyy}';
      const ym = seg.match(/^(\d{4})[-_.](\d{2})$/);
      if (ym && ym[1] === y) return '{yyyy}-{MM}';
      return seg;
    })
    .join('/');
}

interface Row {
  id: number;
  original_name: string;
  folder_path: string;
  manual: number;
}

export interface Suggestion {
  pattern: string;
  targetPath: string;
  support: number;
  conflicts: number;
  examples: string[];
}

/** 純函式：給定目標資料夾的檔案與其他檔案，挑出最好的關鍵字 */
export function pickKeyword(fileName: string, folder: string, files: Row[]): Omit<Suggestion, 'targetPath'> | null {
  const inFolder = files.filter((f) => f.folder_path === folder);
  const outside = files.filter((f) => f.folder_path !== folder && !f.folder_path.startsWith(`${folder}/`));
  let best: Omit<Suggestion, 'targetPath'> | null = null;
  for (const token of candidateTokens(fileName)) {
    const lower = token.toLowerCase();
    const support = inFolder.filter((f) => f.original_name.toLowerCase().includes(lower));
    const conflicts = outside.filter((f) => f.original_name.toLowerCase().includes(lower)).length;
    const precision = support.length / (support.length + conflicts);
    const ok = (support.length >= 2 && precision >= 0.8) || (conflicts === 0 && token.length >= 2);
    if (!ok) continue;
    const score = support.length * 10 - conflicts * 15 + Math.min(token.length, 8);
    const bestScore = best ? best.support * 10 - best.conflicts * 15 + Math.min(best.pattern.length, 8) : -Infinity;
    if (score > bestScore) {
      best = { pattern: token, support: support.length, conflicts, examples: support.slice(0, 5).map((f) => f.original_name) };
    }
  }
  return best;
}

/** 手動搬移後呼叫：符合條件就新增或更新一筆規則建議 */
export async function learnFromMove(env: Env, fileId: number): Promise<Suggestion | null> {
  const file = await env.DB.prepare('SELECT id, original_name, folder_path, manual, group_id, storage_id, received_at, message_type FROM files WHERE id = ?')
    .bind(fileId)
    .first<Row & { group_id: string; storage_id: number; received_at: string; message_type: string }>();
  // 照片、影片的檔名是系統產生的，學不到有意義的關鍵字
  if (file && file.message_type !== 'file') return null;
  if (!file?.folder_path || file.folder_path.startsWith('待分類') || file.folder_path.startsWith('_重複檔案')) return null;

  // 已經有規則會放到這裡就不用再建議
  const rules = (await env.DB.prepare('SELECT * FROM rules WHERE enabled = 1').all<Rule>()).results;
  const now = new Date(file.received_at);
  const existing = classify(rules, { fileName: file.original_name, groupId: file.group_id, groupName: '', receivedAt: now });
  if (existing.rule && existing.folderPath === file.folder_path) return null;

  const files = (
    await env.DB.prepare("SELECT id, original_name, folder_path, manual FROM files WHERE status = 'done' AND storage_id IS ? AND folder_path IS NOT NULL")
      .bind(file.storage_id)
      .all<Row>()
  ).results;
  const pick = pickKeyword(file.original_name, file.folder_path, files);
  if (!pick) return null;
  const targetPath = generalizePath(file.folder_path, now);
  const prev = await env.DB.prepare('SELECT status FROM rule_suggestions WHERE pattern = ? AND target_path = ?').bind(pick.pattern, targetPath).first<{ status: string }>();
  if (prev && prev.status !== 'open') return null; // 使用者已經略過或採用
  await env.DB.prepare(
    `INSERT INTO rule_suggestions (pattern, target_path, storage_id, support, conflicts, examples) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (pattern, target_path) DO UPDATE SET support = excluded.support, conflicts = excluded.conflicts,
       examples = excluded.examples, updated_at = datetime('now')`,
  )
    .bind(pick.pattern, targetPath, file.storage_id, pick.support, pick.conflicts, JSON.stringify(pick.examples))
    .run();
  // 同一個資料夾只保留最有把握的建議，避免一次跳出好幾條
  await env.DB.prepare("DELETE FROM rule_suggestions WHERE status = 'open' AND target_path = ? AND pattern != ? AND support <= ?")
    .bind(targetPath, pick.pattern, pick.support)
    .run();
  return { ...pick, targetPath };
}
