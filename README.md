# Grabit FileHub

把 LINE 群組裡上傳的檔案自動下載到 Google Drive，依檔名規則分類到不同資料夾，並提供一個電腦、手機都能用的管理介面（PWA）。

- **全部跑在 Cloudflare**：Workers（後端＋管理介面）、Queues（背景處理與重試）、D1（資料庫）、Access（登入）。
- **個人用量可以做到每月 0 元**（見下方「費用與限制」）。

## 功能（V1）

| 功能 | 說明 |
|---|---|
| 自動收檔 | Bot 加入群組後，群組裡的檔案、圖片、影片、音訊都會自動備份 |
| 依規則分類 | 關鍵字、副檔名、正規表示式、來源群組；第一條符合的規則決定資料夾 |
| 路徑變數 | `{group}` `{yyyy}` `{MM}` `{dd}` `{sender}` `{ext}`，例：`Farnesene/分析數據/{yyyy}` |
| 自動改名 | 例：`{yyyyMMdd}_{name}`，副檔名自動補上；同名檔案自動加 `(1)` |
| 待分類收件匣 | 沒有規則符合的檔案放到 `待分類/{group}`，可手動搬移 |
| 規則模擬器 | 輸入檔名立即看到會分到哪裡；編輯規則時也能即時試 |
| 重新套用規則 | 改了規則後，先預覽、再把舊檔案批次搬到新位置（手動調整過的不會動） |
| 重複偵測 | 用 Google Drive 算出的 MD5 比對，內容相同的檔案不會存第二份 |
| 檔案管理 | 搜尋、篩選、移動、改名、刪除（移到 Drive 垃圾桶）、多選批次操作 |
| 群組管理 | 自訂群組顯示名稱、個別暫停備份 |
| 失敗處理 | 自動重試（指數退避）、失敗清單、一鍵重試、處理紀錄 |
| 跨裝置 | 響應式 PWA，iPhone／Android／Mac／Windows 都能「安裝」成 App |

## 架構

```
LINE 群組 ──webhook──▶ Worker /webhook ──驗簽、寫入 D1──▶ Cloudflare Queue
                                                            │
                         ┌──────────────────────────────────┘
                         ▼
                   Queue consumer：LINE 下載 ─串流─▶ Google Drive 上傳 → 分類 → 去重 → 記錄
                                                            │
             管理介面（PWA，/）◀── /api/*（Cloudflare Access 保護）◀──┘
```

```
src/worker/
  index.ts      路由入口（webhook、API、OAuth、靜態檔）
  webhook.ts    LINE webhook：驗簽後立刻回 200，工作丟到佇列
  processor.ts  佇列處理：下載、分類、上傳、去重、重試
  rules.ts      分類規則引擎（純函式）
  drive.ts      Google Drive OAuth 與 REST API（串流上傳）
  line.ts       LINE Messaging API
  api.ts        管理介面 API
  auth.ts       Cloudflare Access JWT 驗證
web/            管理介面（React + Vite，PWA）
migrations/     D1 資料表
test/           單元測試與端對端測試
```

## 部署步驟

需要：Node.js 20+、Cloudflare 帳號、LINE 官方帳號、Google 帳號。

### 1. 安裝與建立 Cloudflare 資源

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler d1 create grabit
```

把輸出的 `database_id` 貼到 `wrangler.toml` 的 `[[d1_databases]]`。

```bash
npx wrangler queues create grabit-files
```

```bash
npm run db:migrate:remote
```

### 2. LINE 設定

1. 到 [LINE Developers](https://developers.line.biz/) 建立 Provider → **Messaging API channel**（會同時建立 LINE 官方帳號）。
2. 在 **Basic settings** 複製 **Channel secret**；在 **Messaging API** 頁面產生 **Channel access token（long-lived）**。
3. 到 [LINE Official Account Manager](https://manager.line.biz/) → 設定 → 帳號設定：開啟 **允許加入群組與多人聊天室**；回應設定裡關閉「自動回應訊息」與「加入好友的歡迎訊息」（避免 Bot 在群組裡說話）。

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
```

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
```

### 3. Google Drive 設定

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案，啟用 **Google Drive API**。
2. **OAuth 同意畫面**：類型選「外部」，加入你自己的 Google 帳號為測試使用者。範圍只需要 `drive.file`（系統只能存取它自己建立的檔案，看不到你雲端硬碟其他內容）。
   - 建議把發布狀態改成「正式版」：`drive.file` 不需要 Google 審查，而「測試中」狀態的授權每 7 天會失效。
3. **憑證** → 建立 OAuth 用戶端 ID → 類型「網頁應用程式」，已授權的重新導向 URI 填：
   `https://<你的網域>/oauth/google/callback`（部署後在管理介面「設定」頁可以直接複製）。

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 4. 部署

```bash
npm run deploy
```

部署完成會得到 `https://grabit.<帳號>.workers.dev`（也可以在 Cloudflare 綁自己的網域）。

### 5. 用 Cloudflare Access 保護管理介面（必要）

沒有設定登入保護時，所有 `/api` 會回傳 503，避免資料外洩。

1. Cloudflare 後台 → **Zero Trust** → Access → Applications → **Add an application** → Self-hosted。
2. Domain 填你的 Worker 網址；Policy 選 **Allow**，Include → Emails 填你（和同事）的 email。登入方式預設是 email 一次性驗證碼，也可以加 Google 登入。
3. **再建立一個 Application** 給 webhook：Domain 一樣，Path 填 `webhook`，Policy 動作選 **Bypass**、Include → Everyone。（LINE 伺服器必須能直接呼叫 webhook，安全性由 LINE 簽章驗證負責。）
4. 打開第一個 Application 的設定，複製 **Application Audience (AUD) Tag**；你的 team domain 在 Zero Trust → Settings 可以看到（像 `xxx.cloudflareaccess.com`）。
5. 填到 `wrangler.toml`：

```toml
ACCESS_TEAM_DOMAIN = "xxx.cloudflareaccess.com"
ACCESS_AUD = "貼上 AUD tag"
```

```bash
npm run deploy
```

### 6. 連接並開始使用

1. 打開管理介面 → **設定** → **連接 Google Drive**，用你的 Google 帳號授權。
2. 複製設定頁上的 **Webhook URL**，貼到 LINE Developers → Messaging API → Webhook URL，按 Verify，並開啟 **Use webhook**。
3. 在 LINE 把官方帳號邀請進群組，傳一個檔案測試，幾秒內就會出現在「檔案」頁，並存到 Google Drive 的「LINE FileHub」資料夾。
4. 到 **分類規則** 建立規則，可以先用右邊的模擬器測試。
5. 手機上用 Safari／Chrome 開啟網址 →「加入主畫面」，就能像 App 一樣使用。

## 本機開發

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

`.dev.vars` 裡的 `DEV_NO_AUTH=true` 會略過登入，**正式環境絕對不要設定**。只改前端時可以另外跑 `npm run dev:web`（有熱更新，API 會轉到 `wrangler dev`）。

## 測試

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm test`：規則引擎、路徑變數、LINE 簽章等單元測試。
- `npm run test:e2e`：在本機啟動 `wrangler dev`（真的 D1 與 Queue），把 LINE 與 Google Drive 換成假服務，從 webhook 一路驗證到歸檔、去重、重新套用規則、手動搬移與刪除。

## 費用與限制

| 項目 | 說明 |
|---|---|
| LINE | 只接收訊息、不主動推播，不會用到付費訊息額度 |
| Cloudflare Workers／Queues／D1 | 個人用量通常在免費額度內。**大檔案注意**：免費方案每次執行的 CPU 時間很短；檔案是串流傳輸，主要花在等待網路，一般文件沒問題。如果常傳大影片而出現 CPU 超時，可升級 Workers Paid（每月 5 美元） |
| Cloudflare Access | 50 人以內免費 |
| Google Drive | 使用你自己帳號的空間 |

已知限制：

- **Bot 只收得到加入群組之後的檔案**，LINE 官方 API 拿不到歷史檔案。
- LINE 只保存使用者上傳的內容一段時間，系統收到就會立即處理；如果 Google Drive 授權失效太久，期間的檔案可能會過期而無法補抓。
- **一個群組只能加入一個 LINE 官方帳號**。
- 圖片、影片、音訊在 LINE 上沒有原始檔名，系統會命名為 `IMG_日期_時間_訊息ID.jpg`，所以這類檔案只能用群組或副檔名規則分類。
- 改變根目錄名稱或群組顯示名稱，只影響之後的新檔案。

## 之後可以做（V2 / V3）

版本管理（v1、v2、Final 關聯）、多標籤、從手動拖曳學習規則、多雲端（OneDrive、Dropbox）、LINE LIFF 入口、AI 讀取內容分類與全文搜尋。
