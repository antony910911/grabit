-- 個人偏好（外觀：淺色／深色、主題色），存在帳號上，換裝置登入也一樣
ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
