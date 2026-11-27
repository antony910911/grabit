-- GrabIt V2：多雲端、群組獨立設定、專案、標籤、版本、AI、規則學習、權限、復原

-- 雲端儲存空間（每個群組可以指定不同的空間）
CREATE TABLE storages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,              -- gdrive | onedrive | dropbox | webdav | demo
  name        TEXT NOT NULL,
  root_folder TEXT NOT NULL DEFAULT 'GrabIt',
  config      TEXT NOT NULL DEFAULT '{}', -- 非機密設定（WebDAV 網址、帳號）
  secret      TEXT NOT NULL DEFAULT '{}', -- OAuth token / 密碼（只在伺服器端使用，API 不回傳）
  account     TEXT,                       -- 連接的帳號（email）
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 把 V1 的 Google Drive 連線搬成第一個儲存空間
INSERT INTO storages (type, name, root_folder, secret, account, is_default)
SELECT 'gdrive', 'Google Drive',
       COALESCE((SELECT value FROM settings WHERE key = 'root_folder'), 'LINE FileHub'),
       json_object('refresh_token', value),
       (SELECT value FROM settings WHERE key = 'google_email'),
       1
FROM settings WHERE key = 'google_refresh_token';

CREATE TABLE storage_folders (
  storage_id INTEGER NOT NULL,
  path       TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  PRIMARY KEY (storage_id, path)
);
INSERT INTO storage_folders (storage_id, path, folder_id)
SELECT (SELECT id FROM storages ORDER BY id LIMIT 1), path, folder_id FROM drive_folders
WHERE EXISTS (SELECT 1 FROM storages);
DROP TABLE drive_folders;

-- 專案：讓不同群組的檔案歸到同一個研究專案
CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT '#4a6fa5',
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#697181'
);
CREATE TABLE file_tags (
  file_id INTEGER NOT NULL,
  tag_id  INTEGER NOT NULL,
  source  TEXT NOT NULL DEFAULT 'manual', -- rule | ai | manual
  PRIMARY KEY (file_id, tag_id)
);
CREATE INDEX idx_file_tags_tag ON file_tags(tag_id);

-- 群組獨立設定
ALTER TABLE groups ADD COLUMN storage_id INTEGER;            -- NULL = 預設空間
ALTER TABLE groups ADD COLUMN base_folder TEXT;              -- 沒有規則符合時的存放資料夾
ALTER TABLE groups ADD COLUMN rename_template TEXT;          -- 群組預設改名規則
ALTER TABLE groups ADD COLUMN file_types TEXT;               -- JSON 陣列：document/spreadsheet/presentation/pdf/archive/other；NULL = 全部
ALTER TABLE groups ADD COLUMN backup_images INTEGER NOT NULL DEFAULT 1;
ALTER TABLE groups ADD COLUMN backup_videos INTEGER NOT NULL DEFAULT 1; -- 影片與錄音
ALTER TABLE groups ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;        -- 在 LINE 回覆歸檔結果
ALTER TABLE groups ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE groups ADD COLUMN project_id INTEGER;            -- 群組預設專案
ALTER TABLE groups ADD COLUMN configured INTEGER NOT NULL DEFAULT 0;    -- 0 = 新加入、待設定
UPDATE groups SET configured = 1;

ALTER TABLE rules ADD COLUMN project_id INTEGER;
ALTER TABLE rules ADD COLUMN tags TEXT;                      -- 逗號分隔的標籤名稱

ALTER TABLE files ADD COLUMN storage_id INTEGER;
ALTER TABLE files ADD COLUMN project_id INTEGER;
ALTER TABLE files ADD COLUMN source TEXT NOT NULL DEFAULT 'line'; -- line | email | upload
ALTER TABLE files ADD COLUMN classified_by TEXT;             -- rule | ai | group | manual | none
ALTER TABLE files ADD COLUMN version_key TEXT;
ALTER TABLE files ADD COLUMN version_label TEXT;
ALTER TABLE files ADD COLUMN version_rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN ai_summary TEXT;
ALTER TABLE files ADD COLUMN ai_suggestion TEXT;             -- JSON：{folder, project, tags, confidence, reason}
ALTER TABLE files ADD COLUMN content_text TEXT;              -- 擷取出的文字（全文搜尋、版本比對）
ALTER TABLE files ADD COLUMN reply_token TEXT;
ALTER TABLE files ADD COLUMN target_folder TEXT;             -- 重複檔案原本要放的位置
UPDATE files SET storage_id = (SELECT id FROM storages ORDER BY id LIMIT 1), classified_by =
  CASE WHEN manual = 1 THEN 'manual' WHEN matched_rule_id IS NOT NULL THEN 'rule' WHEN status = 'done' THEN 'none' ELSE NULL END;
CREATE INDEX idx_files_version ON files(version_key);
CREATE INDEX idx_files_project ON files(project_id);
CREATE INDEX idx_files_storage_folder ON files(storage_id, folder_path);

-- 從手動搬移學到的規則建議
CREATE TABLE rule_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern     TEXT NOT NULL,
  target_path TEXT NOT NULL,
  storage_id  INTEGER,
  support     INTEGER NOT NULL DEFAULT 1,
  conflicts   INTEGER NOT NULL DEFAULT 0,
  examples    TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'open', -- open | accepted | dismissed
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pattern, target_path)
);

-- 搬移紀錄，用來復原
CREATE TABLE operations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    TEXT NOT NULL,
  file_id     INTEGER NOT NULL,
  action      TEXT NOT NULL,              -- move
  from_folder TEXT,
  from_name   TEXT,
  to_folder   TEXT,
  to_name     TEXT,
  description TEXT,
  prev_state  TEXT,                       -- 搬移前的分類狀態（JSON），復原時還原
  user_email  TEXT,
  undone      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_operations_batch ON operations(batch_id);

-- 使用者與權限
CREATE TABLE users (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  role       TEXT NOT NULL DEFAULT 'viewer', -- admin | editor | viewer
  all_groups INTEGER NOT NULL DEFAULT 0,     -- 1 = 可以看所有群組
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT
);
CREATE TABLE user_groups (
  email    TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY (email, group_id)
);
