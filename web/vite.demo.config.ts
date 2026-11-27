// 展示版：把正式後端程式碼打包進前端，在瀏覽器裡執行，輸出成單一 HTML
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const stub = fileURLToPath(new URL('./demo/sdk-stub.ts', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@anthropic-ai\/sdk.*$/, replacement: stub },
    ],
  },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./demo.html', import.meta.url)),
      output: { inlineDynamicImports: true },
    },
  },
});
