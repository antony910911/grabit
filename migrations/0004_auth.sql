-- Google 帳號登入：Session 與 OAuth 登入流程的暫存狀態

-- 登入 Session：只存 token 的 SHA-256，資料庫外洩也無法直接拿來登入
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,               -- SHA-256(session token)，十六進位
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,                  -- 絕對到期時間
  revoked_at  TEXT,                           -- 登出或被管理員撤銷
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX idx_sessions_email ON sessions(email);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- OAuth 登入流程中的 state / nonce / PKCE，10 分鐘內有效、只能用一次
CREATE TABLE auth_states (
  state_hash    TEXT PRIMARY KEY,             -- SHA-256(state)
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_to   TEXT NOT NULL DEFAULT '/',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL
);

-- 舊版「第一位登入者自動成為管理員」與 Cloudflare Access 都不再使用；
-- 成員名單（users / user_groups）與角色權限維持不變。
