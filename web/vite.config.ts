import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // `npm run dev:web` 時把 API 轉給 `wrangler dev`
    proxy: { '/api': 'http://localhost:8787', '/oauth': 'http://localhost:8787' },
  },
});
