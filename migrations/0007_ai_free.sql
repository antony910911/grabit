-- 免費 AI 判讀（Level 2）：AI 改成歸檔完成後的獨立背景工作，失敗或額度用完都不影響收檔
ALTER TABLE files ADD COLUMN ai_status TEXT;      -- NULL＝沒有排入；queued、running、done、failed、skipped、deferred
ALTER TABLE files ADD COLUMN ai_error TEXT;       -- 失敗、略過或延後的原因
ALTER TABLE files ADD COLUMN ai_at TEXT;          -- 最後一次分析完成的時間
ALTER TABLE files ADD COLUMN ai_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_files_ai_status ON files(ai_status);

-- 這個群組的檔案可以送交外部 AI（例如 Gemini 免費版）。預設不可以：機密群組不會被送出去
ALTER TABLE groups ADD COLUMN ai_external INTEGER NOT NULL DEFAULT 0;

-- 每天的 AI 用量（本地估算），用來在免費額度內停下來；day 依各服務的重置時區計算
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  units REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);
