-- FileCodeBox Cloudflare 迁移 - 初始化建表
-- 用法: wrangler d1 execute filecodebox --remote --file=./migrations/0001_init.sql

-- 分享记录（对应原版 FileCodes 表）
CREATE TABLE IF NOT EXISTS file_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,                -- 取件码
    prefix TEXT NOT NULL DEFAULT '',          -- 文件名主体（不含扩展名）
    suffix TEXT NOT NULL DEFAULT '',          -- 扩展名
    uuid_file_name TEXT,                      -- 存储文件名
    file_path TEXT,                           -- 存储路径（不含文件名）
    size INTEGER NOT NULL DEFAULT 0,          -- 字节大小
    text TEXT,                                -- 文本分享内容（文件分享为 NULL）
    expired_at TEXT,                          -- 过期时间（ISO 8601 UTC，次数型为 NULL 但非 forever）
    expired_count INTEGER NOT NULL DEFAULT -1, -- -1=时间式；>0=剩余可领次数；0=已耗尽
    used_count INTEGER NOT NULL DEFAULT 0,    -- 已领次数
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    file_hash TEXT,
    is_chunked INTEGER NOT NULL DEFAULT 0,
    upload_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_codes_expired ON file_codes(expired_at);
CREATE INDEX IF NOT EXISTS idx_file_codes_created ON file_codes(created_at);

-- 键值配置（对应原版 KeyValue 表）
CREATE TABLE IF NOT EXISTS key_value (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT,                               -- JSON 字符串
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
