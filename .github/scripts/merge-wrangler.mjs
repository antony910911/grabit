// 用法：node merge-wrangler.mjs <你的 wrangler.toml> <新版 wrangler.toml>
// 輸出新版的內容，但下面這些換回你自己的值（Deploy to Cloudflare 按鈕建立的資源）：
//   Worker 名稱（第一個 name）、D1 的 database_name／database_id、Queue 名稱
import { readFileSync } from 'node:fs';

const [mine, theirs] = process.argv.slice(2).map((p) => readFileSync(p, 'utf8'));

const first = (text, key) => text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
const all = (text, key) => [...text.matchAll(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'gm'))].map((m) => m[1]);

const keep = {
  name: first(mine, 'name'),
  database_name: first(mine, 'database_name'),
  database_id: first(mine, 'database_id'),
};
for (const [k, v] of Object.entries(keep)) {
  if (!v) {
    console.error(`你的 wrangler.toml 裡找不到 ${k}，為了不弄壞你的部署，停止更新。`);
    process.exit(1);
  }
}

let out = theirs;
for (const [k, v] of Object.entries(keep)) {
  // 只換第一個（name 只有最上面那個是 Worker 名稱）
  out = out.replace(new RegExp(`^(${k}\\s*=\\s*)"[^"]*"`, 'm'), `$1"${v}"`);
}

// 佇列：新版的每個佇列名稱對應到你的佇列名稱（依出現順序）
const myQueues = all(mine, 'queue');
const theirQueues = [...new Set(all(theirs, 'queue'))];
const mineUnique = [...new Set(myQueues)];
const map = new Map(theirQueues.map((q, i) => [q, mineUnique[i] ?? mineUnique[0] ?? q]));
out = out.replace(/^(queue\s*=\s*)"([^"]*)"/gm, (_, pre, q) => `${pre}"${map.get(q) ?? q}"`);

process.stdout.write(out);
