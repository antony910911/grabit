// 把 vite 產出的 JS / CSS 內嵌進 HTML，變成單一檔案
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const dir = new URL('../dist-demo/', import.meta.url).pathname;
let html = readFileSync(join(dir, 'demo.html'), 'utf8');
for (const f of readdirSync(join(dir, 'assets'))) {
  const body = readFileSync(join(dir, 'assets', f), 'utf8');
  if (f.endsWith('.js')) {
    html = html.replace(new RegExp(`<script type="module" crossorigin src="/assets/${f.replace('.', '\\.')}"></script>`), () => `<script type="module">${body.replace(/<\/script/gi, '<\\/script')}</script>`);
  } else if (f.endsWith('.css')) {
    html = html.replace(new RegExp(`<link rel="stylesheet" crossorigin href="/assets/${f.replace('.', '\\.')}">`), () => `<style>${body}</style>`);
  }
}
writeFileSync(join(dir, 'grabit-demo.html'), html);
console.log('grabit-demo.html', (html.length / 1024).toFixed(0), 'KB', /src="\/assets/.test(html) ? '(有未內嵌的檔案!)' : '');

// 發佈成 Artifact 用的版本：外層 <html>/<head>/<body> 由發佈平台提供，這裡只留內容
const title = html.match(/<title>.*?<\/title>/)[0];
const styles = [...html.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]).join('\n');
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
const scripts = [...html.matchAll(/<script type="module">[\s\S]*?<\/script>/g)].map((m) => m[0]).join('\n');
const bodyNoScripts = body.replace(/<script type="module">[\s\S]*?<\/script>/g, '').trim();
writeFileSync(join(dir, 'grabit-demo.artifact.html'), `${title}\n${styles}\n${bodyNoScripts}\n${scripts}\n`);
