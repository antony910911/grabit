import { useEffect, useState, type ReactNode } from 'react';
import { Brand, Icon } from '../components';
import { currentUrl } from '../lib';
import { Copy } from './Settings';

type Setup = { ready: true } | { ready: false; google: boolean; admins: boolean; line: boolean; urls: { login: string; drive: string; webhook: string } };

const ERRORS: Record<string, string> = {
  config: '還沒設定 Google 登入（GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET）。照下面的「第一次設定」完成後再登入。',
  state: '登入流程已逾時或無效，請重新登入。',
  denied: '你取消了 Google 登入。',
  token: '無法向 Google 取得登入資訊，請稍後再試。',
  verify: 'Google 登入資訊驗證失敗，請重新登入。',
  unverified: '這個 Google 帳號的 email 尚未驗證，無法登入。',
  not_member: '這個 Google 帳號還不是 GrabIt 成員。請管理員到「成員與權限」加入你的 email 後再登入。',
};

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function Step({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className={done ? 'done' : ''}>
      <span className="setup-mark" aria-label={done ? '已完成' : '還沒完成'}>{done ? <Icon name="check" /> : null}</span>
      <div className="grow">{children}</div>
    </li>
  );
}

/** 第一次架設：列出要貼到 Google、LINE 的網址，設定好的項目自動打勾 */
function FirstRun({ s }: { s: Extract<Setup, { ready: false }> }) {
  return (
    <div className="card setup-card">
      <h2>第一次設定</h2>
      <p className="muted small">GrabIt 已經上線了，再完成下面幾項就能登入。詳細圖文步驟請看<a href="/setup.html" target="_blank" rel="noopener">架設說明書</a>。</p>
      <ol className="setup-list">
        <Step done={s.google}>
          <b>Google 登入</b>：在 Google Cloud 建立 OAuth 用戶端，「已授權的重新導向 URI」貼上這兩個網址，再把用戶端 ID 和密鑰設成 <code>GOOGLE_CLIENT_ID</code>、<code>GOOGLE_CLIENT_SECRET</code>。
          <Copy text={s.urls.login} />
          <Copy text={s.urls.drive} />
        </Step>
        <Step done={s.admins}>
          <b>管理員</b>：在 Cloudflare 設定 <code>ADMIN_EMAILS</code>，填你要用來登入的 Google 帳號 email。
        </Step>
        <Step done={s.line}>
          <b>LINE Bot</b>：設定 <code>LINE_CHANNEL_SECRET</code>、<code>LINE_CHANNEL_ACCESS_TOKEN</code>，再把這個網址貼到 LINE 的 Webhook URL。
          <Copy text={s.urls.webhook} />
        </Step>
      </ol>
      <p className="muted small">在 Cloudflare 存好之後，等幾秒再重新整理這一頁，完成的項目會打勾。</p>
    </div>
  );
}

export function Login({ message }: { message?: string | null }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  useEffect(() => {
    fetch('/auth/setup', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSetup)
      .catch(() => setSetup(null));
  }, []);
  const url = currentUrl();
  const error = url.searchParams.get('error');
  const next = url.pathname === '/login' ? url.searchParams.get('next') ?? '/' : url.pathname + url.search;
  const href = `/auth/google/start?next=${encodeURIComponent(next)}`;
  return (
    <div className="login-wrap">
      <div className="login card">
        <h1>
          <Brand />
        </h1>
        <p className="muted">多群組檔案集中管理</p>
        {(error || message) && <div className="notice danger" style={{ textAlign: 'left' }}>{error ? ERRORS[error] ?? '登入失敗，請再試一次。' : message}</div>}
        <a className="btn google-btn" href={href}>
          <GoogleMark />
          使用 Google 帳號登入
        </a>
        <p className="muted small" style={{ marginTop: 18 }}>
          只有管理員加入的成員可以登入。登入只會讀取你的 Google 帳號 email 與名稱，不會存取你的 Google Drive。
        </p>
      </div>
      {setup && !setup.ready && <FirstRun s={setup} />}
      <nav className="login-links muted small" aria-label="關於 GrabIt">
        <a href="/about">關於 GrabIt</a>
        <a href="/privacy">隱私權政策</a>
        <a href="/terms">服務條款</a>
      </nav>
    </div>
  );
}
