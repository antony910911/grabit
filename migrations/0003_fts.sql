-- 全文搜尋（trigram 分詞支援中文任意片段；三個字以下的查詢改用 LIKE）
CREATE VIRTUAL TABLE files_fts USING fts5(name, folder, summary, content, tags, tokenize = 'trigram');
