import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { ErrorBox, Loading, Switch } from '../components';
import { Link, useLoad, useMe, useToast } from '../lib';
import { AiCard, type AiSettingsResp } from './AiSettings';

interface SettingsResp {
  webhookUrl: string;
  lineConfigured: boolean;
  queueEnabled: boolean;
  timezone: string;
  ai: AiSettingsResp;
  fullText: boolean;
  semantic: boolean;
  outgoingWebhook: string;
  outgoingWebhookSecretSet: boolean;
  emailAllowedSenders: string;
  oauthRedirects: { type: string; label: string; uri: string; configured: boolean }[];
  loginConfigured: boolean;
  loginRedirectUri: string;
  adminEmails: string[];
}

function Check({ ok, children, optional }: { ok: boolean; children: ReactNode; optional?: boolean }) {
  return (
    <li className="row" style={{ padding: '6px 0', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <span className={`badge ${ok ? 'ok' : optional ? 'muted' : 'warn'}`}>{ok ? '完成' : optional ? '選用' : '待設定'}</span>
      <span className="grow">{children}</span>
    </li>
  );
}

export function Copy({ text }: { text: string }) {
  const toast = useToast();
  return (
    <div className="row" style={{ flexWrap: 'nowrap', marginTop: 6 }}>
      <code className="grow" style={{ padding: '8px 10px' }}>
        {text}
      </code>
      <button className="btn sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast('已複製')).catch(() => toast('無法複製，請手動選取', 'error'))}>
        複製
      </button>
    </div>
  );
}

export function SettingsPage() {
  const toast = useToast();
  const me = useMe();
  const { data: s, error, loading, reload } = useLoad(() => api<SettingsResp>('/settings'), []);
  const [form, setForm] = useState({ outgoingWebhook: '', outgoingWebhookSecret: '', emailAllowedSenders: '' });

  useEffect(() => {
    if (s) setForm({ outgoingWebhook: s.outgoingWebhook, outgoingWebhookSecret: '', emailAllowedSenders: s.emailAllowedSenders });
  }, [s]);

  if (me && me.role !== 'admin') return <div className="notice warn">只有管理員可以修改系統設定。</div>;

  const save = async (patch: Record<string, unknown>, msg = '已儲存') => {
    try {
      await api('/settings', { method: 'PUT', json: patch });
      toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>系統設定</h1>
          <p>LINE 連線、AI、Email 收件與外部整合</p>
        </div>
      </div>
      {error && <ErrorBox message={error} onRetry={reload} />}
      {loading && !s && <Loading />}
      {s && (
        <div className="stack">
          <section className="card card-pad">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>Google 帳號登入</h2>
              {s.loginConfigured ? <span className="badge ok">已啟用</span> : <span className="badge warn">待設定</span>}
            </div>
            <p className="muted small">
              成員用 Google 帳號登入 GrabIt。Google Cloud 的 OAuth 用戶端「已授權的重新導向 URI」要同時包含下面兩個網址（登入與 Google Drive 授權是分開的）：
            </p>
            <Copy text={s.loginRedirectUri} />
            {s.oauthRedirects.find((o) => o.type === 'gdrive') && <Copy text={s.oauthRedirects.find((o) => o.type === 'gdrive')!.uri} />}
            <p className="muted small" style={{ marginBottom: 0 }}>
              管理員名單（ADMIN_EMAILS）：{s.adminEmails.length ? s.adminEmails.join('、') : '未設定'}。其他人要先由管理員在 <Link to="/users">成員與權限</Link> 加入才能登入。
            </p>
          </section>

          <section className="card card-pad">
            <h2>LINE 連線</h2>
            <p className="muted small">把下面的網址貼到 LINE Developers → Messaging API → Webhook URL，並開啟「Use webhook」。一個 Bot 可以加入多個群組。</p>
            <Copy text={s.webhookUrl} />
          </section>

          <AiCard ai={s.ai} semantic={s.semantic} onSaved={reload} />

          <p className="muted small" style={{ margin: '-4px 4px 0' }}>
            搜尋：{s.fullText ? '全文搜尋已啟用' : '一般搜尋'}
            {s.semantic ? '，語意搜尋已啟用' : '，語意搜尋未啟用（需要 Workers AI 與 Vectorize，見 README）'}
          </p>

          <section className="card card-pad">
            <h2>Email 收件（選用）</h2>
            <p className="muted small">設定 Cloudflare Email Routing 後，寄到指定信箱的附件會自動歸檔（例如廠商寄來的報價單）。只接受下列寄件者：</p>
            <label className="field">
              <span>允許的寄件者</span>
              <input className="input" value={form.emailAllowedSenders} onChange={(e) => setForm({ ...form, emailAllowedSenders: e.target.value })} placeholder="me@example.com, @lab.example.com" />
              <small>多個用逗號分隔；@ 開頭代表整個網域</small>
            </label>
            <button className="btn sm" onClick={() => save({ emailAllowedSenders: form.emailAllowedSenders })}>
              儲存
            </button>
          </section>

          <section className="card card-pad">
            <h2>外部整合 Webhook（選用）</h2>
            <p className="muted small">每次歸檔、搬移、刪除時，把檔案資訊 POST 到這個網址，可以串接 Folio、ProjectDeck 或其他系統。請求帶有 X-GrabIt-Signature（HMAC-SHA256）。</p>
            <label className="field">
              <span>網址</span>
              <input className="input" value={form.outgoingWebhook} onChange={(e) => setForm({ ...form, outgoingWebhook: e.target.value })} placeholder="https://..." />
            </label>
            <label className="field">
              <span>簽章密鑰</span>
              <input className="input" type="password" value={form.outgoingWebhookSecret} onChange={(e) => setForm({ ...form, outgoingWebhookSecret: e.target.value })} placeholder={s.outgoingWebhookSecretSet ? '已設定（留空 = 不變）' : '自訂一組隨機字串'} autoComplete="new-password" />
            </label>
            <button className="btn sm" onClick={() => save({ outgoingWebhook: form.outgoingWebhook, ...(form.outgoingWebhookSecret ? { outgoingWebhookSecret: form.outgoingWebhookSecret } : {}) })}>
              儲存
            </button>
          </section>

          <section className="card card-pad">
            <h2>設定檢查</h2>
            <ul className="list" style={{ marginTop: 8 }}>
              <Check ok={s.lineConfigured}>LINE Channel secret 與 access token</Check>
              <Check ok={s.queueEnabled} optional>
                Cloudflare Queues（背景處理；沒有時每 5 分鐘自動重試失敗的檔案）
              </Check>
              <Check ok={s.ai.available.workers} optional>
                免費 AI 文件判讀（Workers AI）
              </Check>
              <Check ok={s.ai.available.gemini} optional>
                Gemini 免費 API（GEMINI_API_KEY）
              </Check>
              <Check ok={s.ai.available.claude} optional>
                Claude（ANTHROPIC_API_KEY，付費；也提供「問 AI」）
              </Check>
              <Check ok={s.semantic} optional>
                語意搜尋（Workers AI + Vectorize）
              </Check>
              {s.oauthRedirects.map((o) => (
                <Check key={o.type} ok={o.configured} optional>
                  {o.label} OAuth 用戶端，重新導向網址：<code>{o.uri}</code>
                </Check>
              ))}
            </ul>
            <p className="muted small">日期變數時區：{s.timezone}。雲端空間請到 <Link to="/storages">雲端設定</Link>。</p>
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
