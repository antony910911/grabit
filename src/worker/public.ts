// 不需要登入的公開頁面：關於（首頁）、隱私權政策、服務條款，以及 Google 網站擁有權驗證。
// Google 審核 OAuth 應用程式時，會檢查這些頁面能不能在沒登入的情況下打開、內容是否完整。
import { Hono } from 'hono';
import type { AppEnv } from './api/util';
import type { Env } from './env';
import { getSetting } from './db';

export const publicPages = new Hono<AppEnv>();

export interface SiteInfo {
  operator: string;
  contact: string;
  /** Google Search Console 驗證：meta 標籤的內容，或 HTML 驗證檔的檔名 */
  verification: { kind: 'meta' | 'file'; value: string } | null;
}

export async function siteInfo(env: Env): Promise<SiteInfo> {
  const [operator, contact, verification] = await Promise.all([getSetting(env, 'public_operator'), getSetting(env, 'public_contact'), getSetting(env, 'google_site_verification')]);
  const v = verification?.match(/^(meta|file):(.+)$/);
  return { operator: operator ?? '', contact: contact ?? '', verification: v ? { kind: v[1] as 'meta' | 'file', value: v[2]! } : null };
}

/**
 * 解析使用者從 Google Search Console 貼過來的驗證資訊：
 * 整段 meta 標籤、只有 content 的值，或 HTML 驗證檔的檔名（google1234abcd.html）。
 */
export function parseVerification(input: string): { kind: 'meta' | 'file'; value: string } | null {
  const s = input.trim();
  if (!s) return null;
  const file = s.match(/(google[0-9a-z]+\.html)/i);
  if (file) return { kind: 'file', value: file[1]! };
  const content = s.match(/content\s*=\s*["']([^"']+)["']/i)?.[1] ?? s;
  if (/^[A-Za-z0-9_-]{10,100}$/.test(content)) return { kind: 'meta', value: content };
  throw new Error('看不懂這個驗證碼：請貼上 Google Search Console 給的整段 meta 標籤，或 HTML 驗證檔的檔名');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, body: string, info: SiteInfo, origin: string, current: string): string {
  const nav = [
    ['/about', '關於 GrabIt'],
    ['/privacy', '隱私權政策'],
    ['/terms', '服務條款'],
  ]
    .map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('');
  const meta = info.verification?.kind === 'meta' ? `<meta name="google-site-verification" content="${esc(info.verification.value)}">` : '';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}｜GrabIt</title>
<meta name="description" content="GrabIt 把 LINE 群組裡的檔案自動歸檔到 Google 雲端硬碟，依檔名與內容分類，並提供網頁管理介面。">
${meta}
<link rel="icon" href="/icon.svg">
<style>
:root { --bg: #f5f6f8; --surface: #fff; --text: #1f2430; --muted: #5f6778; --line: #e1e4e9; --accent: #2f4a73; --soft: #e6ecf5; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #14171c; --surface: #1c2027; --text: #e5e8ee; --muted: #9ba3b2; --line: #2c323d; --accent: #9fb6dd; --soft: #232d40; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.75 -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif; }
.wrap { max-width: 760px; margin: 0 auto; padding: 28px max(16px, env(safe-area-inset-left)) 64px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
.logo { font-weight: 800; font-size: 26px; letter-spacing: -.02em; color: var(--text); text-decoration: none; }
.logo b { color: var(--accent); }
nav { display: flex; gap: 14px; flex-wrap: wrap; font-size: 14px; }
nav a { color: var(--muted); text-decoration: none; }
nav a[aria-current] { color: var(--accent); font-weight: 650; }
main { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 24px 26px; }
h1 { font-size: 26px; line-height: 1.35; margin: 0 0 6px; }
h2 { font-size: 18px; margin: 28px 0 8px; }
p, li { margin: 8px 0; }
ul { padding-left: 22px; }
a { color: var(--accent); }
.muted { color: var(--muted); font-size: 14px; }
.cta { display: inline-block; margin-top: 16px; padding: 10px 20px; border-radius: 10px; background: var(--accent); color: var(--surface); font-weight: 700; text-decoration: none; }
.note { background: var(--soft); border-radius: 10px; padding: 12px 16px; margin: 14px 0; }
footer { margin-top: 24px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
<header><a class="logo" href="/about">grabit<b>.</b></a><nav>${nav}<a href="/">登入</a></nav></header>
<main>
${body}
</main>
<footer class="muted">GrabIt${info.operator ? ` · 由 ${esc(info.operator)} 營運` : ''} · <a href="${esc(origin)}/about">${esc(new URL(origin).host)}</a>${info.contact ? ` · 聯絡：<a href="mailto:${esc(info.contact)}">${esc(info.contact)}</a>` : ''}</footer>
</div>
</body>
</html>`;
}

function contactLine(info: SiteInfo): string {
  return info.contact ? `<a href="mailto:${esc(info.contact)}">${esc(info.contact)}</a>` : '這個 GrabIt 的管理員';
}

const UPDATED = '2026-11-27';

publicPages.get('/about', async (c) => {
  const info = await siteInfo(c.env);
  const origin = new URL(c.req.url).origin;
  const body = `
<h1>GrabIt：LINE 群組檔案自動歸檔</h1>
<p>GrabIt 是${info.operator ? ` ${esc(info.operator)} ` : '團隊'}內部使用的檔案管理工具。把 GrabIt 的 LINE 官方帳號加進群組後，大家在群組裡傳的檔案、照片和影片，會自動存進團隊的 Google 雲端硬碟，依檔名、規則與內容分到對的資料夾，並且可以在網頁上搜尋、整理與分享。</p>
<h2>主要功能</h2>
<ul>
  <li>自動收檔：LINE 群組、Email 附件與網頁上傳的檔案集中到同一個 Google 雲端硬碟資料夾。</li>
  <li>自動分類：依群組設定與檔名規則歸檔；可選用 AI 讀取內容，產生摘要、標籤與分類建議。</li>
  <li>管理介面：依群組、上傳者、專案、標籤、年度篩選與全文搜尋；版本串連、重複偵測、搬移與復原。</li>
  <li>權限控管：只有管理員加入的成員能登入，每個人只看得到被授權的群組。</li>
</ul>
<h2>GrabIt 如何使用你的 Google 帳號資料</h2>
<ul>
  <li><b>Google 登入</b>（openid、email、profile）：只用來確認你是誰，以及你是不是被加入的成員。</li>
  <li><b>Google 雲端硬碟</b>（drive.file）：只由管理員授權一次，GrabIt 只能存取<b>它自己建立</b>的資料夾與檔案，用來存放和整理歸檔的檔案；看不到雲端硬碟裡的其他檔案。</li>
</ul>
<div class="note">詳細說明請看 <a href="/privacy">隱私權政策</a> 與 <a href="/terms">服務條款</a>。GrabIt 不販售任何資料，也不用於廣告。</div>
<a class="cta" href="/">成員登入</a>
<p class="muted">還不是成員？請聯絡${contactLine(info)}。</p>`;
  return c.html(layout('關於 GrabIt', body, info, origin, '/about'));
});

publicPages.get('/privacy', async (c) => {
  const info = await siteInfo(c.env);
  const origin = new URL(c.req.url).origin;
  const op = info.operator ? esc(info.operator) : '本服務的營運者';
  const body = `
<h1>隱私權政策</h1>
<p class="muted">最後更新：${UPDATED}</p>
<p>這份政策說明 ${op}（以下稱「我們」）營運的 GrabIt（${esc(origin)}）會收集哪些資料、怎麼使用、保存在哪裡，以及你可以如何刪除。GrabIt 是提供給受邀成員使用的內部檔案管理工具。</p>

<h2>1. 我們收集的資料</h2>
<ul>
  <li><b>Google 帳號基本資料</b>：你用 Google 帳號登入時，我們透過 OpenID Connect（openid、email、profile）取得你的 email 地址、名稱與 Google 帳號識別碼，用來確認身分與權限。我們不會取得你的密碼、聯絡人、行事曆或其他 Google 資料。</li>
  <li><b>Google 雲端硬碟檔案</b>：管理員授權 Google 雲端硬碟（drive.file 權限）後，GrabIt 只能建立、讀取、搬移、分享與刪除<b>它自己建立</b>的資料夾與檔案，也就是歸檔進來的檔案。GrabIt 無法存取雲端硬碟裡的其他檔案。</li>
  <li><b>LINE 群組中的檔案</b>：GrabIt 的 LINE 官方帳號被加入群組後，會接收群組中傳送的檔案、照片、影片與錄音，以及傳送者的 LINE 顯示名稱、LINE 使用者 ID、群組名稱與傳送時間。一般文字訊息不會被保存。</li>
  <li><b>Email 與網頁上傳</b>：寄到 GrabIt 收件地址的附件（含寄件者名稱與地址），以及成員在網頁上傳的檔案。</li>
  <li><b>檔案內容的衍生資料</b>：為了分類與搜尋，GrabIt 可能從檔案擷取文字，並產生摘要、標籤與分類建議。</li>
  <li><b>使用紀錄</b>：登入工作階段（建立與最後使用時間、IP 位址、瀏覽器資訊）、個人外觀設定，以及歸檔、搬移、刪除等操作紀錄。</li>
</ul>

<h2>2. 我們如何使用資料</h2>
<ul>
  <li>提供 GrabIt 的功能：歸檔與分類檔案、搜尋、版本與重複檔案管理、權限控管、在 LINE 回覆歸檔通知。</li>
  <li>確認登入者的身分與可以看到的群組，並記錄操作以便復原與稽核。</li>
  <li>我們<b>不會</b>把資料用於廣告、不會販售資料，也不會用來建立個人輪廓。</li>
</ul>

<h2>3. AI 處理</h2>
<p>如果管理員開啟「AI 文件判讀」，檔案內容或擷取出的文字會送到管理員選擇的 AI 服務，用來產生摘要、標籤與分類建議，以及回答成員在「問 AI」提出的問題：</p>
<ul>
  <li>Cloudflare Workers AI：在營運者自己的 Cloudflare 帳號內執行。</li>
  <li>Google Gemini API：只會送出管理員明確允許「送交外部 AI」的群組的檔案。Gemini 免費版可能會由 Google 用來改善其產品。</li>
  <li>Anthropic Claude API：管理員選用付費服務時使用。</li>
</ul>
<p>管理員可以整體關閉 AI，或針對個別群組關閉。</p>

<h2>4. Google 使用者資料的使用限制</h2>
<p>GrabIt 對於從 Google API 取得之資訊的使用及傳輸，將遵守 <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Google API 服務使用者資料政策</a>，包括其中的「有限使用（Limited Use）」規定。</p>
<p lang="en">GrabIt's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<ul>
  <li>Google 使用者資料只用於提供上述使用者看得到的功能。</li>
  <li>不會把 Google 使用者資料轉移給第三方，除非是為了提供這些功能、遵守法律，或在合併、收購時並事先告知。</li>
  <li>不會把 Google 使用者資料用於廣告，也不會用來訓練通用的 AI 或機器學習模型。</li>
  <li>人員不會閱讀這些資料，除非取得你的同意、為了安全或防止濫用、遵守法律，或資料已經過彙整與匿名化。</li>
</ul>

<h2>5. 資料保存在哪裡、如何保護</h2>
<ul>
  <li>檔案本身存放在營運者的 Google 雲端硬碟；檔案清單、分類規則、成員與設定存放在營運者的 Cloudflare 帳號（Cloudflare D1 資料庫）。</li>
  <li>所有連線都使用 HTTPS。登入工作階段以雜湊形式保存，可以隨時撤銷；API 金鑰與密碼存放在 Cloudflare 的加密設定中，不會出現在程式碼裡。</li>
  <li>成員只能看到管理員授權給他的群組的檔案。</li>
</ul>

<h2>6. 資料的分享</h2>
<p>歸檔的檔案會依管理員的設定，分享給 GrabIt 的成員（或不分享）。除了上述 AI 服務與基礎設施（Cloudflare、Google、LINE）之外，我們不會把資料提供給其他第三方。</p>

<h2>7. 保存期間與刪除</h2>
<ul>
  <li>檔案與相關紀錄會保存到管理員刪除為止。刪除檔案時，雲端上的檔案會移到垃圾桶。</li>
  <li>管理員移除成員時，該成員的登入會立即失效。</li>
  <li>你可以聯絡${contactLine(info)}，要求查詢或刪除和你有關的資料。</li>
  <li>你也可以隨時到 <a href="https://myaccount.google.com/permissions" rel="noopener">Google 帳戶的第三方存取權</a> 移除 GrabIt 的存取權。</li>
</ul>

<h2>8. 聯絡我們</h2>
<p>對這份政策或你的資料有任何問題，請聯絡${contactLine(info)}。</p>

<h2>9. 政策變更</h2>
<p>政策有重大變更時，我們會更新本頁上方的日期，並在 GrabIt 內通知成員。</p>`;
  return c.html(layout('隱私權政策', body, info, origin, '/privacy'));
});

publicPages.get('/terms', async (c) => {
  const info = await siteInfo(c.env);
  const origin = new URL(c.req.url).origin;
  const op = info.operator ? esc(info.operator) : '本服務的營運者';
  const body = `
<h1>服務條款</h1>
<p class="muted">最後更新：${UPDATED}</p>
<p>GrabIt（${esc(origin)}）由 ${op} 營運，提供給受邀成員管理 LINE 群組、Email 與上傳的檔案。使用 GrabIt 即表示你同意以下條款。</p>
<h2>1. 使用資格</h2>
<p>只有管理員加入的成員可以登入。請使用你自己的 Google 帳號，不要把帳號借給他人。</p>
<h2>2. 你的內容</h2>
<p>你上傳或在群組傳送的檔案仍屬於你或你的組織。你同意 GrabIt 為了提供服務而儲存、分類、建立索引，並依管理員的設定分享這些檔案。請不要上傳你無權分享的內容。</p>
<h2>3. 可接受的使用方式</h2>
<p>不得用 GrabIt 散布違法或侵權內容、嘗試存取未被授權的資料，或干擾服務運作。</p>
<h2>4. AI 功能</h2>
<p>AI 產生的摘要、標籤與分類建議僅供參考，可能有錯，重要的決定請以原始檔案為準。</p>
<h2>5. 服務的提供</h2>
<p>GrabIt 依現狀提供，我們會盡力維持服務與資料的完整，但不保證不中斷或沒有錯誤。重要檔案請另外保留備份。</p>
<h2>6. 隱私</h2>
<p>我們如何處理資料，請見 <a href="/privacy">隱私權政策</a>。</p>
<h2>7. 聯絡</h2>
<p>有任何問題請聯絡${contactLine(info)}。</p>`;
  return c.html(layout('服務條款', body, info, origin, '/terms'));
});

/** Google Search Console 的 HTML 驗證檔（只有管理員設定的那個檔名才會回應） */
publicPages.get('/:name{google[0-9a-zA-Z]+\\.html}', async (c) => {
  const info = await siteInfo(c.env);
  const name = c.req.param('name');
  if (info.verification?.kind !== 'file' || info.verification.value !== name) return c.notFound();
  return c.text(`google-site-verification: ${name}`, 200, { 'Content-Type': 'text/html; charset=utf-8' });
});

/** 首頁：照常回傳管理介面，設定了 Search Console 驗證碼時在 <head> 加上 meta 標籤 */
publicPages.get('/', async (c) => {
  const res = await c.env.ASSETS!.fetch(new Request(new URL('/', c.req.url), c.req.raw));
  const info = await siteInfo(c.env);
  if (info.verification?.kind !== 'meta' || !(res.headers.get('Content-Type') ?? '').includes('text/html')) return res;
  const tag = `<meta name="google-site-verification" content="${esc(info.verification.value)}">`;
  return new HTMLRewriter()
    .on('head', {
      element: (el) => {
        el.append(tag, { html: true });
      },
    })
    .transform(res);
});
