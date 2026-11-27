-- 上傳者篩選與虛擬檢視：上傳者是檔案的獨立屬性（不是標籤、也不是資料夾），用唯一 ID 關聯
--   LINE：line:<User ID>（同一個 Bot／Provider 內固定）；Email：email:<寄件地址>；手動上傳：user:<GrabIt 帳號>
-- 缺少 ID 的舊檔案 uploader_key 留空，介面顯示為「未知上傳者」，不依名稱擅自合併
ALTER TABLE files ADD COLUMN uploader_key TEXT;
UPDATE files SET uploader_key = 'line:' || sender_id WHERE source = 'line' AND sender_id IS NOT NULL AND sender_id != '';
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_key, received_at);

CREATE TABLE IF NOT EXISTS uploaders (
  key TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- line、email、user
  display_name TEXT,                 -- 來源最近一次提供的名稱（LINE 顯示名稱會變）
  alias TEXT,                        -- 管理者自訂的別名；有別名時優先顯示
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO uploaders (key, source, display_name)
  SELECT f.uploader_key, 'line',
    (SELECT f2.sender_name FROM files f2 WHERE f2.uploader_key = f.uploader_key AND f2.sender_name IS NOT NULL ORDER BY f2.received_at DESC LIMIT 1)
  FROM files f WHERE f.uploader_key IS NOT NULL GROUP BY f.uploader_key;

-- 每個人自己的常用上傳者（釘選在清單最上面）
CREATE TABLE IF NOT EXISTS uploader_pins (
  email TEXT NOT NULL,
  uploader_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email, uploader_key)
);
