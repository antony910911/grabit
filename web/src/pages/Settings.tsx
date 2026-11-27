import { useEffect, useMemo, useState } from 'react';
import { api, type Settings } from '../api';
import { ErrorBox, Icon, Loading } from '../components';
import { Link, useLoad, useToast } from '../lib';

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="row" style={{ padding: '6px 0', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <span className={`badge ${ok ? 'ok' : 'warn'}`}>{ok ? '完成' : '待設定'}</span>
      <span className="grow">{children}</span>
    </li>
  );
}

function Copy({ text }: { text: string }) {
  const toast = useToast();
  return (
    <div className="row" style={{ flexWrap: 'nowrap', marginTop: 6 }}>
      <code className="grow" style={{ padding: '8px 10px' }}>{text}</code>
      <button
        className="btn sm"
        onClick={() =>
          navigator.clipboard
            .writeText(text)
            .then(() => toast('已複製'))
            .catch(() => toast('無法複製，請手動選取', 'error'))
        }
      >
        複製
      </button>
    </div>
  );
}

export function SettingsPage() {
  const toast = useToast();
  const { data: s, error, loading, reload } = useLoad(() => api<Settings>('/settings'), []);
  const [root, setRoot] = useState('');
  const flash = useMemo(() => new URLSearchParams(location.search), []);

  useEffect(() => {
    if (s) setRoot(s.rootFolder);
  }, [s]);

  useEffect(() => {
    if (flash.get('drive') === 'connected') toast('Google Drive 連接成功');
    if (flash.get('drive') === 'error') toast(`Google Drive 連接失敗：${flash.get('message') ?? ''}`, 'error');
    if (flash.get('drive')) history.replaceState(null, '', '/settings');
  }, [flash, toast]);

  const saveRoot = async () => {
    try {
      await api('/settings', { method: 'PUT', json: { rootFolder: root } });
      toast('已更新根目錄');
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const disconnect = async () => {
    if (!confirm('中斷後，新檔案會停在「處理中」直到重新連接。確定中斷？')) return;
    await api('/drive/disconnect', { method: 'POST' });
    toast('已中斷 Google Drive');
    reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>設定</h1>
          <p>雲端空間與 LINE 連線</p>
        </div>
        <Link to="/logs" className="btn sm mobile-only">
          處理紀錄
        </Link>
      </div>
      {error && <ErrorBox message={error} onRetry={reload} />}
      {loading && !s && <Loading />}
      {s && (
        <div className="stack">
          <section className="card card-pad">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>Google Drive</h2>
              {s.driveConnected ? <span className="badge ok">已連接</span> : <span className="badge warn">未連接</span>}
            </div>
            <p className="muted small">
              {s.driveConnected
                ? `檔案會存到 ${s.googleEmail ?? '你的 Google 帳號'} 的「我的雲端硬碟 / ${s.rootFolder}」。`
                : '連接後，收到的檔案會自動上傳到你的 Google Drive。系統只能存取它自己建立的檔案，看不到你雲端硬碟裡的其他內容。'}
            </p>
            <div className="row">
              <a className="btn primary" href="/oauth/google/start">
                <Icon name="external" />
                {s.driveConnected ? '重新連接／換帳號' : '連接 Google Drive'}
              </a>
              {s.driveConnected && (
                <button className="btn danger" onClick={disconnect}>
                  中斷連接
                </button>
              )}
            </div>
            {!s.googleConfigured && (
              <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
                伺服器尚未設定 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET，請參考 README。
              </div>
            )}
            <label className="field" style={{ marginTop: 18 }}>
              <span>根目錄名稱</span>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input className="input grow" value={root} onChange={(e) => setRoot(e.target.value)} />
                <button className="btn" disabled={!root.trim() || root === s.rootFolder} onClick={saveRoot}>
                  儲存
                </button>
              </div>
              <small>只影響之後收到的檔案，已歸檔的檔案不會移動</small>
            </label>
          </section>

          <section className="card card-pad">
            <h2>LINE 連線</h2>
            <p className="muted small">把下面的網址貼到 LINE Developers → Messaging API → Webhook URL，並開啟「Use webhook」。</p>
            <Copy text={s.webhookUrl} />
          </section>

          <section className="card card-pad">
            <h2>設定檢查</h2>
            <ul className="list" style={{ marginTop: 8 }}>
              <Check ok={s.lineConfigured}>LINE Channel secret 與 access token</Check>
              <Check ok={s.googleConfigured}>Google OAuth 用戶端（Client ID / Secret）</Check>
              <Check ok={s.driveConnected}>已授權 Google Drive</Check>
              <Check ok={s.queueEnabled}>Cloudflare Queue（處理失敗時自動重試）</Check>
            </ul>
            <p className="muted small" style={{ marginBottom: 4 }}>Google OAuth 的「已授權的重新導向 URI」請填：</p>
            <Copy text={s.oauthRedirectUri} />
            <p className="muted small">日期變數時區：{s.timezone}</p>
          </section>

          <section className="card card-pad">
            <h2>在手機或電腦上安裝</h2>
            <ul className="small" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
              <li>iPhone／iPad：用 Safari 開啟 → 分享 → 加入主畫面</li>
              <li>Android：用 Chrome 開啟 → 選單 → 安裝應用程式</li>
              <li>Mac／Windows：用 Chrome 或 Edge 開啟 → 網址列右側的安裝圖示</li>
            </ul>
          </section>
        </div>
      )}
    </>
  );
}
