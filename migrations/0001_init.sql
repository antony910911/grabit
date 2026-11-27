-- 系統設定（Google Drive 連線、根目錄等）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- LINE 群組 / 聊天室 / 一對一來源
CREATE TABLE groups (
  id           TEXT PRIMARY KEY,           -- LINE groupId / roomId / userId
  source_type  TEXT NOT NULL,              -- group | room | user
  name         TEXT NOT NULL DEFAULT '',   -- LINE 上的名稱
  alias        TEXT,                       -- 管理介面自訂顯示名稱（用於 {group} 變數）
  enabled      INTEGER NOT NULL DEFAULT 1, -- 0 = 不備份這個群組
  joined       INTEGER NOT NULL DEFAULT 1, -- bot 是否仍在群組內
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 分類規則：priority 小的先比對，第一條符合即套用
CREATE TABLE rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 100,
  match_type      TEXT NOT NULL,          -- keywords | regex | extension | any
  pattern         TEXT NOT NULL DEFAULT '',
  group_id        TEXT,                   -- NULL = 不限群組
  target_path     TEXT NOT NULL,          -- 例：Farnesene/分析數據/{yyyy}
  rename_template TEXT,                   -- 例：{yyyyMMdd}_{name}；NULL = 保留原檔名
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rules_priority ON rules(priority, id);

-- 收到的檔案
CREATE TABLE files (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  line_message_id  TEXT NOT NULL UNIQUE,  -- LINE 可能重送事件，用來防止重複處理
  group_id         TEXT NOT NULL,
  sender_id        TEXT,
  sender_name      TEXT,
  message_type     TEXT NOT NULL,         -- file | image | video | audio
  original_name    TEXT NOT NULL,         -- 原檔名（圖片/影片為系統產生）
  stored_name      TEXT,                  -- 雲端上的檔名
  ext              TEXT NOT NULL DEFAULT '',
  mime_type        TEXT,
  size             INTEGER,
  content_md5      TEXT,                  -- Google Drive 計算的 MD5，用來偵測重複檔案
  folder_path      TEXT,                  -- 雲端相對路徑（不含根目錄）
  drive_file_id    TEXT,
  drive_link       TEXT,
  matched_rule_id  INTEGER,
  unsorted         INTEGER NOT NULL DEFAULT 0, -- 1 = 沒有規則符合，在待分類
  manual           INTEGER NOT NULL DEFAULT 0, -- 1 = 曾在管理介面手動搬移，重新套用規則時略過
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | duplicate | failed | deleted
  duplicate_of     INTEGER,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  image_set_id     TEXT,
  received_at      TEXT NOT NULL,         -- LINE 事件時間（ISO）
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_files_group ON files(group_id);
CREATE INDEX idx_files_status ON files(status);
CREATE INDEX idx_files_received ON files(received_at DESC);
CREATE INDEX idx_files_md5 ON files(content_md5);

-- 雲端資料夾路徑快取，避免每次都查 Drive
CREATE TABLE drive_folders (
  path      TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL
);

-- 操作與處理紀錄
CREATE TABLE logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL,               -- info | warn | error
  action     TEXT NOT NULL,
  file_id    INTEGER,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_logs_created ON logs(created_at DESC);
