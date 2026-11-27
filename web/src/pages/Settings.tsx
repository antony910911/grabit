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
  publicSite: { operator: string; contact: string; verification: string; homeUrl: string; privacyUrl: string; termsUrl: string; domain: string };
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
  const [form, setForm] = useState({ outgoingWebhook: '', outgoingWebhookSecret: '', emailAllowedSenders: '', publicOperator: '', publicContact: '', siteVerification: '' });

  useEffect(() => {
    if (s)
      setForm({
        outgoingWebhook: s.outgoingWebhook,
        outgoingWebhookSecret: '',
        emailAllowedSenders: s.emailAllowedSenders,
        publicOperator: s.publicSite.operator,
        publicContact: s.publicSite.contact,
        siteVerification: s.publicSite.verification,
      });
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
            <h2>Google 驗證與公開頁面（選用）</h2>
            <p className="muted small">
              GrabIt 只要求 Google 的基本登入資料，以及「只能存取 GrabIt 自己建立的檔案」的雲端硬碟權限，兩者都屬於<b>非敏感範圍</b>：在 Google Auth Platform 把應用程式發布成「實際運作中」就能使用，<b>不需要通過 Google 驗證</b>。只有想在 Google 登入畫面顯示 App 名稱與標誌時，才需要下面這些。
            </p>
            <p className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
              貼到 Google Auth Platform →「品牌塑造」的網址（不用登入就能打開）：
            </p>
            <div className="small muted">應用程式首頁</div>
            <Copy text={s.publicSite.homeUrl} />
            <div className="small muted" style={{ marginTop: 8 }}>
              隱私權政策
            </div>
            <Copy text={s.publicSite.privacyUrl} />
            <div className="small muted" style={{ marginTop: 8 }}>
              服務條款
            </div>
            <Copy text={s.publicSite.termsUrl} />
            <div className="small muted" style={{ marginTop: 8 }}>
              已授權網域
            </div>
            <Copy text={s.publicSite.domain} />
            <div className="grid-2" style={{ marginTop: 14 }}>
              <label className="field">
                <span>營運者名稱（顯示在公開頁面）</span>
                <input className="input" value={form.publicOperator} onChange={(e) => setForm({ ...form, publicOperator: e.target.value })} placeholder="例如：○○ 研究室" maxLength={60} />
              </label>
              <label className="field">
                <span>聯絡 Email（隱私權政策上的聯絡方式）</span>
                <input className="input" type="email" value={form.publicContact} onChange={(e) => setForm({ ...form, publicContact: e.target.value })} placeholder="contact@example.com" />
              </label>
            </div>
            <label className="field">
              <span>Google Search Console 網站驗證</span>
              <input className="input" value={form.siteVerification} onChange={(e) => setForm({ ...form, siteVerification: e.target.value })} placeholder='<meta name="google-site-verification" content="…"> 或 google1234abcd.html' />
              <small>到 Google Search Console 新增「網址前置字元」資源 {s.publicSite.homeUrl.replace(/\/about$/, '/')}，選「HTML 標記」貼上整段 meta 標籤，或選「HTML 檔案」貼上檔名；存好後回 Search Console 按「驗證」。</small>
            </label>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn sm primary"
                onClick={() => save({ publicOperator: form.publicOperator, publicContact: form.publicContact, siteVerification: form.siteVerification })}
              >
                儲存
              </button>
              <a className="btn sm" href="/about" target="_blank" rel="noopener">
                看公開首頁
              </a>
              <a className="btn sm" href="/privacy" target="_blank" rel="noopener">
                看隱私權政策
              </a>
            </div>
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
