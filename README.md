# grabit.｜多群組檔案集中管理

只要建立一個 GrabIt LINE Bot，加入多個 LINE 群組，就能把各群組上傳的檔案自動下載、分類、歸檔到你指定的雲端空間，並在同一個管理介面（電腦、手機都能用的 PWA）搜尋、整理、追蹤。

- **全部跑在 Cloudflare**：Workers（後端＋管理介面）、Queues（背景處理與重試）、D1（資料庫＋全文搜尋）、Access（登入）。
- **互動展示版**：`npm run build:demo` 會產生 `web/dist-demo/grabit-demo.html`，在瀏覽器裡執行完整的後端邏輯（資料、雲端與 AI 為模擬），不用部署就能試用。

## 功能

### 收檔
| 功能 | 說明 |
|---|---|
| 多群組 | 一個 Bot 加入多個群組；新群組自動出現在「待設定」，設定前先用預設值備份，不漏檔 |
| 檔案類型 | 檔案、照片、影片、錄音、相簿；圖片／影片自動命名 `IMG_日期_時間_訊息ID.jpg` |
| Email 附件 | 透過 Cloudflare Email Routing，把寄到指定信箱的附件也自動歸檔（限定寄件者） |
| 手動上傳 | 管理介面直接上傳，走同一套分類規則 |

### 分類（三層）
1. **群組來源**：每個群組可以指定雲端空間、預設資料夾、預設專案、改名規則。
2. **檔名規則**：關鍵字、副檔名、正規表示式、來源群組；路徑變數 `{group}` `{yyyy}` `{MM}` `{dd}` `{sender}` `{ext}`；可同時指定專案與標籤；規則模擬器即時預覽。
3. **AI 判讀內容**（選用，Claude）：讀 PDF、Word、Excel、簡報、圖片，產生摘要與標籤；規則判斷不了時建議資料夾，把握度高於門檻就自動歸檔，否則留在「待分類」並提供一鍵採用。

### 管理
| 功能 | 說明 |
|---|---|
| 檔案來源面板 | 依群組、專案、標籤、年度、檔案類型篩選；只看最新版本 |
| 搜尋 | 全文搜尋（D1 FTS5 trigram，支援中文任意片段）＋選用的語意搜尋（Workers AI＋Vectorize） |
| 問 AI | 用一句話查檔案與內容，回答附上檔案連結；只搜尋使用者有權限的群組 |
| 資料夾管理 | 樹狀目錄、拖拉檔案到資料夾、資料夾改名／搬移（雲端、紀錄、規則同步更新） |
| 版本管理 | 自動辨識 v1、v2、Final、修正版、(1)…，同一份文件的版本串在一起，可比對內文差異 |
| 重複偵測 | 依雲端回傳的雜湊判斷內容相同的檔案，移到 `_重複檔案`，可選擇保留或刪除 |
| 專案與標籤 | 來源與分類分開：不同群組的檔案可以歸到同一個研究專案；標籤可改名、合併 |
| 規則學習 | 手動搬移檔案後，系統找出這個資料夾特有的關鍵字，建議建立規則 |
| 重新套用規則 | 改規則後先預覽、再批次搬移舊檔案；手動調整過的不會動 |
| 復原 | 搬移、批次搬移、重新套用、資料夾改名都可以一鍵復原 |
| 失敗處理 | 自動重試（指數退避）、失敗清單、一鍵重試、處理紀錄 |
| 歸檔通知 | 群組可開啟：Bot 在 LINE 回覆「已歸檔到哪裡」（回覆訊息免費） |
| 多雲端 | Google Drive、OneDrive／SharePoint、Dropbox、NAS（WebDAV）；每個群組可以存到不同空間 |
| 多使用者權限 | 管理員／編輯者／檢視者；非管理員只看得到被授權的群組 |
| 外部整合 | 歸檔、搬移、刪除時呼叫你設定的 Webhook（HMAC 簽章），可串接 Folio、ProjectDeck 等系統 |

## 架構

```
LINE 群組 A/B/C ──webhook──▶ /webhook（驗簽、去重、群組設定）──▶ Queue
Email 附件 ──Email Routing──▶ email()  ─┐                         │
管理介面上傳 ──▶ /api/upload ───────────┼──────────────▶ 歸檔流程 ◀─┘
                                        │   群組設定 → 檔名規則 → AI 判讀
                                        │   → 上傳雲端 → 去重 → 版本 → 標籤／專案 → 索引 → 通知／Webhook
管理介面（PWA）──▶ /api/*（Cloudflare Access ＋ 角色權限）
```

```
src/worker/
  index.ts        路由入口（webhook、API、OAuth、email、queue）
  webhook.ts      LINE webhook
  ingest.ts       Email 附件、手動上傳
  processor.ts    歸檔流程與重試
  rules.ts        檔名規則引擎（純函式）
  ai.ts           Claude 文件判讀與自然語言查詢
  extract.ts      Office／文字檔內容擷取
  versions.ts     版本辨識
  learn.ts        從手動搬移學習規則
  search.ts       全文＋語意搜尋
  ops.ts          搬移、資料夾改名、復原
  permissions.ts  成員與群組權限
  notify.ts       LINE 回覆通知、外部 Webhook
  storage/        Google Drive、OneDrive、Dropbox、WebDAV、展示用記憶體空間
  api/            管理介面 API
web/src/          管理介面（React + Vite，PWA）
web/demo/         展示版（sql.js 取代 D1，模擬雲端與 AI）
migrations/       D1 資料表
test/             單元測試與端對端測試
```

## 部署

需要：Node.js 20+、Cloudflare 帳號、LINE 官方帳號，以及至少一種雲端空間。

### 1. Cloudflare 資源

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler d1 create grabit
```

把輸出的 `database_id` 貼到 `wrangler.toml`。

```bash
npx wrangler queues create grabit-files
```

```bash
npm run db:migrate:remote
```

### 2. LINE

1. [LINE Developers](https://developers.line.biz/) 建立 Provider → **Messaging API channel**。
2. 複製 **Channel secret**，在 Messaging API 頁面產生 **Channel access token（long-lived）**。
3. [LINE Official Account Manager](https://manager.line.biz/) → 帳號設定：開啟**允許加入群組與多人聊天室**；關閉自動回應與歡迎訊息。

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
```

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
```

### 3. 雲端空間（用哪個設定哪個）

部署後在管理介面「雲端設定」新增空間並授權。各家需要先建立 OAuth 應用程式，重新導向網址是 `https://<你的網域>/oauth/<類型>/callback`（「系統設定」頁可以直接複製）。

| 空間 | 建立應用程式 | 權限 | Secrets |
|---|---|---|---|
| Google Drive | [Google Cloud Console](https://console.cloud.google.com/)：啟用 Drive API，建立「網頁應用程式」OAuth 用戶端；同意畫面發布為「正式版」（`drive.file` 不需審查，測試中狀態的授權 7 天會失效） | `drive.file`（只能存取本系統建立的檔案） | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` |
| OneDrive／SharePoint | [Microsoft Entra 應用程式註冊](https://entra.microsoft.com/)：平台選 Web，支援的帳戶類型依需求選擇 | `Files.ReadWrite`、`offline_access`、`User.Read` | `MS_CLIENT_ID`、`MS_CLIENT_SECRET` |
| Dropbox | [Dropbox App Console](https://www.dropbox.com/developers/apps)：Scoped access，權限勾選 `files.content.write`、`files.content.read`、`account_info.read` | 同左 | `DROPBOX_APP_KEY`、`DROPBOX_APP_SECRET` |
| NAS（WebDAV） | Synology：套件中心安裝 WebDAV Server 並開啟 HTTPS；QNAP、Nextcloud 也支援 | 建議建立只能寫入指定資料夾的專用帳號 | 在介面輸入網址、帳號、密碼 |

iCloud Drive 沒有伺服器可用的上傳 API，因此不支援直接串接。

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

（其他 secrets 依同樣方式設定。）

### 4. AI（選用）

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

預設模型是 `claude-opus-5-5`（`wrangler.toml` 的 `AI_MODEL` 可以改）。AI 判讀會讀取 10MB 以內的檔案內容，每個檔案呼叫一次 API；可以在「系統設定」整體關閉，或在「群組設定」對個別群組關閉。呼叫時已開啟伺服器端的 refusal fallback（`fallbacks: "default"`）。

語意搜尋另外需要 Workers AI 與 Vectorize，見 `wrangler.toml` 最下方的說明。

### 5. 部署與登入保護

```bash
npm run deploy
```

用 **Cloudflare Access** 保護管理介面（沒有設定時 `/api` 一律回 503）：

1. Zero Trust → Access → Applications → 新增 Self-hosted，Domain 填 Worker 網址，Policy 允許你與成員的 email。
2. 再新增一個 Application：同網域、Path 填 `webhook`、動作 **Bypass**（LINE 要能直接呼叫，安全性由簽章驗證負責）。
3. 把 team domain 與 Application Audience (AUD) Tag 填進 `wrangler.toml` 的 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`，重新部署。
4. 第一位登入的人（或 `ADMIN_EMAILS` 名單上的人）自動成為管理員；其他成員到「成員與權限」加入。

### 6. 開始使用

1. 「雲端設定」新增並授權空間。
2. 「系統設定」複製 Webhook URL，貼到 LINE Developers → Webhook URL，開啟 Use webhook。
3. 把 Bot 邀請進群組 →「群組設定」完成每個群組的設定。
4. 建立分類規則、專案；手機上「加入主畫面」安裝成 App。

### Email 收件（選用）

Cloudflare 後台 → 你的網域 → Email Routing → 建立一個地址（例如 `files@你的網域`），動作選「Send to a Worker」並選 `grabit`。再到「系統設定」填允許的寄件者。

## 開發與測試

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run build:demo
```

- `npm test`：規則引擎、版本辨識、規則學習、文字擷取、群組檔案類型、Dropbox 標頭等單元測試。
- `npm run test:e2e`：本機啟動 `wrangler dev`（真的 D1、Queue），LINE 與 Google Drive 換成假服務，從 webhook 驗證到歸檔、群組設定、規則學習、復原、重新套用、重複檔、資料夾改名、版本、搜尋、上傳與權限。
- OneDrive、Dropbox、WebDAV 與 Claude API 依官方文件實作，但沒有在測試中連線到真實服務，第一次使用時請先用少量檔案確認。

## 費用與限制

| 項目 | 說明 |
|---|---|
| LINE | 只接收訊息與回覆通知，不用付費訊息額度 |
| Cloudflare | 個人用量多在免費額度內。AI 判讀與大型檔案需要較多 CPU 時間，建議使用 Workers Paid（每月 5 美元） |
| Claude API | 依用量計費；可以整體或依群組關閉 |
| 雲端空間 | 使用你自己的帳號空間；Dropbox 單檔上限 150MB |

已知限制：Bot 只收得到加入群組之後的檔案；一個群組只能有一個官方帳號；LINE 上的檔案只保存一段時間，授權失效太久可能來不及補抓；跨雲端空間搬移檔案目前不支援（同一空間內可以自由搬移）。
