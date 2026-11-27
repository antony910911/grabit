-- 雲端空間的專屬根資料夾：記錄每個檔案目前放在哪個根資料夾底下，
-- 換了新的根資料夾後可以把舊檔案搬過去
ALTER TABLE files ADD COLUMN root_ref TEXT;
