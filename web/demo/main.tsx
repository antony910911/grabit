import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../src/theme';

initTheme();
import { App } from '../src/App';
import { replaceUrl, ToastProvider } from '../src/lib';
import '../src/styles.css';
import { startDemo } from './runtime';

const root = createRoot(document.getElementById('root')!);
startDemo()
  .then(() => {
    // 展示頁面的網址路徑不一定是 /，統一從總覽開始
    replaceUrl('/');
    root.render(
      <StrictMode>
        <ToastProvider>
          <App />
        </ToastProvider>
      </StrictMode>,
    );
  })
  .catch((e: Error) => {
    document.getElementById('root')!.innerHTML = `<div style="padding:24px;font:15px system-ui">展示版載入失敗：${e.message}</div>`;
    console.error(e);
  });
