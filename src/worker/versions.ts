// 版本辨識：v1、v2、Final、修正版、(1)… 同一份文件的不同版本歸為同一組
import { splitExt } from './rules';

export interface VersionInfo {
  key: string; // 同一組版本共用的鍵
  label: string | null; // 例：v3、Final、修正版2
  rank: number; // 越大越新（同分再看收到時間）
}

const SEP = '[\\s._\\-－—]*';
const PATTERNS: { re: RegExp; label: (m: RegExpMatchArray) => string; rank: (m: RegExpMatchArray) => number }[] = [
  { re: new RegExp(`${SEP}(final|最終版|最終|定稿|完稿)$`, 'i'), label: (m) => (/^final$/i.test(m[1]!) ? 'Final' : m[1]!), rank: () => 10000 },
  { re: new RegExp(`${SEP}v(?:er(?:sion)?)?\\.?\\s?(\\d+(?:\\.\\d+)?)$`, 'i'), label: (m) => `v${m[1]}`, rank: (m) => Math.round(Number(m[1]) * 100) },
  { re: new RegExp(`${SEP}rev\\.?\\s?(\\d+)$`, 'i'), label: (m) => `rev${m[1]}`, rank: (m) => Number(m[1]) * 100 },
  { re: new RegExp(`${SEP}第\\s?(\\d+)\\s?版$`), label: (m) => `第${m[1]}版`, rank: (m) => Number(m[1]) * 100 },
  { re: new RegExp(`${SEP}(修正版|修訂版|修改版|更新版)(\\d*)$`), label: (m) => `${m[1]}${m[2] ?? ''}`, rank: (m) => 5000 + Number(m[2] || 1) },
  { re: /\s?[(（](\d{1,2})[)）]$/, label: (m) => `副本${m[1]}`, rank: (m) => Number(m[1]) },
  { re: new RegExp(`${SEP}(copy|複本|副本)$`, 'i'), label: () => '副本', rank: () => 1 },
];
// 日期不算在版本鍵裡：20261127_報告_v2 與 20261130_報告_v3 是同一份文件
const DATE = /(^|[\s._\-])(\d{8}|\d{4}[-.]\d{1,2}[-.]\d{1,2}|\d{6})(?=$|[\s._\-])/g;

export function versionInfo(fileName: string): VersionInfo {
  const { name, ext } = splitExt(fileName);
  let base = name.trim();
  const labels: string[] = [];
  let rank = 0;
  for (let guard = 0; guard < 4; guard++) {
    const hit = PATTERNS.map((p) => ({ p, m: base.match(p.re) })).find((x) => x.m);
    if (!hit || !hit.m) break;
    labels.unshift(hit.p.label(hit.m));
    rank = Math.max(rank, hit.p.rank(hit.m));
    base = base.slice(0, hit.m.index).trim();
  }
  const key =
    base
      .replace(DATE, '$1')
      .toLowerCase()
      .replace(/[\s._\-－—]+/g, ' ')
      .trim() || name.toLowerCase();
  return { key: `${key}.${ext}`, label: labels.length ? labels.join(' ') : null, rank };
}
