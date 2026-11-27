import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from './theme';

initTheme();
import { App } from './App';
import { ToastProvider } from './lib';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
