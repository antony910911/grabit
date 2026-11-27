# grabit.｜多群組檔案集中管理

只要建立一個 GrabIt LINE Bot，加入多個 LINE 群組，就能把各群組上傳的檔案自動下載、分類、歸檔到你指定的雲端空間，並在同一個管理介面（電腦、手機都能用的 PWA）搜尋、整理、追蹤。

- **全部跑在 Cloudflare**：Workers（後端＋管理介面）、D1（資料庫＋全文搜尋）、Queues 與 Cron 排程（背景處理與失敗重試）；用 Google 帳號登入。
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
| 檔案（四種檢視） | **全部**：清單、篩選、多選批次操作；**資料夾**：像 Finder 的固定寬度版面，左邊樹狀目錄、右邊檔案，拖拉搬移、改名；**專案**：像 Trello 的看板，把卡片拖到別欄就換專案；**標籤**：標籤清單＋檔案，拖到標籤上就加標籤 |
| 版本管理 | 自動辨識 v1、v2、Final、修正版、(1)…，同一份文件的版本串在一起，可比對內文差異 |
| 重複偵測 | 依雲端回傳的雜湊判斷內容相同的檔案，移到 `_重複檔案`，可選擇保留或刪除 |
| 專案與標籤 | 來源與分類分開：不同群組的檔案可以歸到同一個研究專案；群組預設專案可以套用到現有檔案；檔案頁多選可以批次加入專案、加標籤；標籤可改名、合併 |
| 規則學習 | 手動搬移檔案後，系統找出這個資料夾特有的關鍵字，建議建立規則 |
| 重新套用規則 | 改規則後先預覽、再批次搬移舊檔案；手動調整過的不會動 |
| 復原 | 搬移、批次搬移、重新套用、資料夾改名都可以一鍵復原 |
| 失敗處理 | 自動重試（指數退避）、失敗清單、一鍵重試、處理紀錄 |
| 歸檔通知 | 群組可開啟：Bot 在 LINE 回覆「已歸檔到哪裡」（回覆訊息免費） |
| 多雲端 | Google Drive、OneDrive／SharePoint、Dropbox、NAS（WebDAV）；每個群組可以存到不同空間 |
| 多使用者權限 | 管理員／編輯者／檢視者；非管理員只看得到被授權的群組 |
| 個人外觀 | 每個人在「個人設定」選跟隨系統／淺色／深色，以及 6 種主題色（靛藍、湖水、森林、陶土、梅紫、石墨）；存在帳號上，換裝置登入也會保留 |
| 一致的版面 | 每一頁內容寬度相同（桌面最寬 1180px），切換頁面不會跳動 |
| 外部整合 | 歸檔、搬移、刪除時呼叫你設定的 Webhook（HMAC 簽章），可串接 Folio、ProjectDeck 等系統 |

### 選單與權限

| 選單 | 內容 | 誰看得到 |
|---|---|---|
| 總覽 | 歸檔數量、待處理事項 | 所有人 |
| 檔案 | 全部／資料夾／專案／標籤四種檢視（原本的「全部檔案」與「整理」合併） | 所有人（只看得到被授權的群組） |
| 問 AI | 用一句話查檔案 | 所有人 |
| 分類規則 | 規則、AI 建議、套用到舊檔案 | 編輯者、管理員 |
| 群組 | 每個 LINE 群組的雲端、資料夾、通知；編輯者只能看 | 編輯者、管理員 |
| 歸檔紀錄 | 處理紀錄、復原搬移 | 編輯者、管理員 |
| 設定 | 一般（Google 登入、LINE、AI、Email、Webhook）／雲端空間／成員與權限（原本三個選單合併） | **只有管理員** |
| 個人設定 | 外觀、登入裝置、自己能做哪些事（點左下角名字） | 所有人 |

| 能做的事 | 檢視者 | 編輯者 | 管理員 |
|---|---|---|---|
| 看檔案、下載、搜尋、問 AI | 被授權的群組 | 被授權的群組 | 全部群組 |
| 搬移、改名、刪除檔案，設定專案與標籤 | — | ✓ | ✓ |
| 分類規則、套用到舊檔案 | — | ✓ | ✓ |
| 歸檔紀錄、復原搬移 | — | ✓ | ✓ |
| 群組設定 | — | 只能看 | ✓ |
| 雲端空間、成員與權限、系統設定 | — | — | ✓ |
| 自己的外觀與登入裝置 | ✓ | ✓ | ✓ |

權限是在伺服器端檢查的：非管理員呼叫系統設定 API 會被拒絕（403），雲端空間 API 只回傳空間名稱，不含帳號、分享與連線資訊。

## 架構

```
LINE 群組 A/B/C ──webhook──▶ /webhook（驗簽、去重、群組設定）──▶ Queue
Email 附件 ──Email Routing──▶ email()  ─┐                         │
管理介面上傳 ──▶ /api/upload ───────────┼──────────────▶ 歸檔流程 ◀─┘
                                        │   群組設定 → 檔名規則 → AI 判讀
                                        │   → 上傳雲端 → 去重 → 版本 → 標籤／專案 → 索引 → 通知／Webhook
管理介面（PWA）──▶ /api/*（Google 登入 Session ＋ 角色與群組權限）
```

```
src/worker/
  index.ts        路由入口（webhook、登入、API、OAuth、email、queue、排程）
  auth/           Google 登入（OIDC）與 Session
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

## 部署（全部在網頁上操作）

不需要在電腦上安裝任何東西，也不用開終端機。Cloudflare 會從 GitHub 讀取程式碼，自動打包與部署；之後 GitHub 有更新也會自動重新部署。**所有密鑰都在 Cloudflare 後台設定，不會寫進 GitHub。**

### 1. Cloudflare：資料庫、佇列與自動部署

1. [Cloudflare 後台](https://dash.cloudflare.com/) → **Storage & Databases → D1** → Create，名稱 `grabit`。把 Database ID 填進 GitHub 上的 `wrangler.toml`（網頁上按鉛筆圖示編輯）。
2. **Storage & Databases → Queues** → Create，名稱 `grabit-files`。免費方案沒有 Queues：把 `wrangler.toml` 裡兩段 `[[queues...]]` 註解掉，系統會改成直接處理，失敗的檔案由每 5 分鐘的排程重試。
3. **Workers & Pages → Create → Import a repository**，選這個 GitHub 專案：
   - Worker 名稱：`grabit`
   - Build command：`npm run build:web`
   - Deploy command：`npm run deploy:cloudflare`（會自動建立／更新資料表再部署）
4. 部署完成後記下網址，例如 `https://grabit.你的帳號.workers.dev`。

### 2. Google：登入與 Google Drive 共用一組 OAuth 用戶端

1. [Google Cloud Console](https://console.cloud.google.com/) 建立專案，「API 和服務」→「程式庫」啟用 **Google Drive API**。
2. 「OAuth 同意畫面」：類型「外部」，範圍加入 `openid`、`email`、`profile`、`.../auth/drive.file`，發布狀態改成**正式版**（測試中狀態的授權 7 天就會失效）。
3. 「憑證」→ 建立 OAuth 用戶端 ID（網頁應用程式），**已授權的重新導向 URI** 加入兩個：
   - `https://你的網址/auth/google/callback`（登入 GrabIt）
   - `https://你的網址/oauth/gdrive/callback`（授權存取 Google Drive）
4. 複製用戶端 ID 與密鑰。

登入只要求 email 與名稱；存取 Google Drive 是另外在「雲端設定」授權，而且只能存取 GrabIt 自己建立的檔案（`drive.file`）。

### 3. LINE

1. [LINE Developers](https://developers.line.biz/) 建立 Provider → **Messaging API channel**，複製 **Channel secret**，在 Messaging API 分頁產生 **Channel access token**。
2. [LINE Official Account Manager](https://manager.line.biz/) → 帳號設定：開啟**允許加入群組與多人聊天室**；回應設定關閉自動回應與歡迎訊息。

### 4. 在 Cloudflare 後台設定密鑰與變數

**Workers & Pages → grabit → Settings → Variables and Secrets → Add**：

| 名稱 | 類型 | 內容 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Secret | Google OAuth 用戶端 ID |
| `GOOGLE_CLIENT_SECRET` | Secret | Google OAuth 用戶端密鑰 |
| `LINE_CHANNEL_SECRET` | Secret | LINE Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | Secret | LINE Channel access token |
| `ADMIN_EMAILS` | Text | 管理員的 Google 帳號 email，多個用逗號分隔 |
| `SESSION_TTL_DAYS`、`SESSION_IDLE_DAYS` | Text（選用） | 登入有效天數（預設 30）、閒置多久需重新登入（預設 7） |
| `ANTHROPIC_API_KEY` | Secret（選用） | AI 文件判讀 |
| `MS_CLIENT_ID`、`MS_CLIENT_SECRET`、`DROPBOX_APP_KEY`、`DROPBOX_APP_SECRET` | Secret（選用） | OneDrive、Dropbox |

變數儲存後如果沒有自動生效，到 **Deployments** 對最新一筆按重新部署。

### 5. 登入並完成設定

1. 打開網址 → **使用 Google 帳號登入**。只有 `ADMIN_EMAILS` 裡的帳號，以及管理員在「成員與權限」加入的帳號可以登入；其他人會看到「還不是 GrabIt 成員」。
2. **雲端設定** → 新增 Google Drive → 選擇分享方式 → 授權。授權後會在「我的雲端硬碟」建立一個全新的專屬資料夾，之後所有檔案都只放在這個資料夾裡。
3. **系統設定** → 複製 Webhook URL → 貼到 LINE Developers 的 Webhook URL，按 Verify，開啟 Use webhook。
4. 把 Bot 邀請進群組 →「群組設定」完成每個群組的設定。
5. 手機上「加入主畫面」安裝成 App。

### 登入與安全

- Google OAuth 2.0 授權碼流程＋PKCE；驗證 ID Token 的簽章（Google 公鑰）、issuer、audience、有效期限、nonce、`email_verified`；state 同時存在 D1 與 Cookie，只能使用一次，10 分鐘內有效。
- Session 存在 D1（只存 token 的 SHA-256），Cookie 為 `__Host-` 前綴、`HttpOnly`、`Secure`、`SameSite=Lax`，有絕對期限與閒置逾時。
- 會修改資料的請求必須同源（CSRF 防護）；登入後只會導回站內頁面。
- 可以自己「登出其他裝置／所有裝置」；管理員可以強制登出成員；移除成員會立即撤銷他所有的登入。
- LINE `/webhook` 不需要登入，改用 LINE 簽章驗證。

### Google Drive 專屬資料夾與分享

- 連結 Google Drive 時會使用一個**專屬資料夾**：GrabIt 之前建立過同名資料夾就沿用，沒有才建立，並用資料夾 ID 記住。所有收錄的檔案與子資料夾都放在這裡。
- 專屬資料夾被刪除時，系統**不會自己另開新資料夾**，而是暫停歸檔並在「雲端設定」提示；可以先從 Google Drive 垃圾桶還原，或按「重新建立資料夾」。
- 分享方式（「雲端設定」→ 設定，隨時可以改）：
  - **GrabIt 成員（建議）**：自動分享給「成員與權限」裡每個人的 Google 帳號（檢視者權限），新增或移除成員時自動同步。
  - **知道連結的任何人**：拿到連結的人不用登入就能檢視與下載；連結外流時外人也看得到。Google Workspace 的組織可能禁止這種分享。
  - **不分享**：只有連結的 Google 帳號看得到。
- Google Drive 的分享是整個資料夾一起分享，無法依 GrabIt 的群組權限細分；需要依群組限制時，請選「不分享」，成員改用 GrabIt 檔案詳情裡的「下載」按鈕（會檢查群組權限）。
- 舊版散落的檔案或多出來的 GrabIt 資料夾：「雲端設定」會顯示數量，按「合併並清理」會保留子資料夾結構把檔案搬進專屬資料夾（Google Drive 檔案連結不變），再把 GrabIt 多建、已經清空的資料夾移到垃圾桶；裡面還有其他檔案的資料夾不會動。

### 雲端空間（選用）

部署後在「雲端設定」新增。各家需要先建立 OAuth 應用程式，重新導向網址是 `https://你的網址/oauth/<類型>/callback`（「系統設定」頁可以直接複製）。

| 空間 | 建立應用程式 | 權限 | Secrets |
|---|---|---|---|
| Google Drive | 與登入共用第 2 步的用戶端 | `drive.file` | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` |
| OneDrive／SharePoint | [Microsoft Entra 應用程式註冊](https://entra.microsoft.com/)，平台選 Web | `Files.ReadWrite`、`offline_access`、`User.Read` | `MS_CLIENT_ID`、`MS_CLIENT_SECRET` |
| Dropbox | [Dropbox App Console](https://www.dropbox.com/developers/apps)，Scoped access，勾選 `files.content.write`、`files.content.read`、`account_info.read` | 同左 | `DROPBOX_APP_KEY`、`DROPBOX_APP_SECRET` |
| NAS（WebDAV） | Synology／QNAP／Nextcloud 開啟 WebDAV（HTTPS） | 建議專用帳號 | 在介面輸入 |

iCloud Drive 沒有伺服器可用的上傳 API，因此不支援。

### AI（選用）

設定 `ANTHROPIC_API_KEY` 後啟用。預設模型 `claude-opus-5-5`（`wrangler.toml` 的 `AI_MODEL`），依用量計費；可以在「系統設定」整體關閉，或在「群組設定」對個別群組關閉。語意搜尋另外需要 Workers AI 與 Vectorize（見 `wrangler.toml` 最下方）。

### Email 收件（選用）

網域在 Cloudflare 上時：後台 → 網域 → Email Routing → 建立地址（例如 `files@你的網域`），動作選「Send to a Worker」→ `grabit`。再到「系統設定」填允許的寄件者。

## 開發與測試（給開發者，一般部署不需要）

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

- `npm test`：規則引擎、版本辨識、規則學習、文字擷取、群組檔案類型、Dropbox 標頭、登入導向／CSRF／PKCE 等單元測試。
- 本機開發可以在 `.dev.vars` 設 `DEV_NO_AUTH=true` 略過登入；這個設定只在 `localhost` 有效，誤設在正式環境也不會生效。
- `npm run test:e2e`：本機啟動 `wrangler dev`（真的 D1、Queue），LINE、Google 登入與 Google Drive 換成假服務（Google ID Token 用測試金鑰實際簽章），驗證登入流程與各種攻擊情境（偽造 state、重放、nonce／audience／issuer／簽章錯誤、過期、未驗證 email、非成員、CSRF、open redirect）、Session 撤銷，以及歸檔、群組設定、規則學習、復原、版本、搜尋、上傳與權限。`E2E_NO_QUEUE=1` 測試沒有 Queues 的模式。
- OneDrive、Dropbox、WebDAV 與 Claude API 依官方文件實作，但沒有在測試中連線到真實服務，第一次使用時請先用少量檔案確認。

## 費用與限制

| 項目 | 說明 |
|---|---|
| LINE | 只接收訊息與回覆通知，不用付費訊息額度 |
| Cloudflare | 個人用量多在免費額度內。AI 判讀與大型檔案需要較多 CPU 時間，建議使用 Workers Paid（每月 5 美元） |
| Claude API | 依用量計費；可以整體或依群組關閉 |
| 雲端空間 | 使用你自己的帳號空間；Dropbox 單檔上限 150MB |

已知限制：Bot 只收得到加入群組之後的檔案；一個群組只能有一個官方帳號；LINE 上的檔案只保存一段時間，授權失效太久可能來不及補抓；跨雲端空間搬移檔案目前不支援（同一空間內可以自由搬移）。
