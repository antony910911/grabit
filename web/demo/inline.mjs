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
