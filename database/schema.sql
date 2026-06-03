-- =============================================
-- WhatsToot Bot - Database Schema
-- =============================================

-- سجل الصور المرفوعة
CREATE TABLE IF NOT EXISTS uploads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order  TEXT NOT NULL,
    file_name   TEXT NOT NULL,
    file_hash   TEXT,
    drive_id    TEXT,
    drive_url   TEXT,
    group_id    TEXT,
    group_name  TEXT,
    sender      TEXT,
    caption     TEXT,
    status      TEXT DEFAULT 'completed' CHECK(status IN ('completed','failed','duplicate','pending')),
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ربط أرقام أوامر العمل بمعرّفات مجلدات Drive
CREATE TABLE IF NOT EXISTS folders (
    work_order TEXT PRIMARY KEY,
    drive_id   TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- سياق الرسائل لربط الصور بالأرقام
CREATE TABLE IF NOT EXISTS message_context (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    TEXT NOT NULL,
    work_order  TEXT NOT NULL,
    sender      TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at  DATETIME
);

-- طابور الصور التي تنتظر ربطها برقم أمر عمل
CREATE TABLE IF NOT EXISTS queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    image_path  TEXT NOT NULL,
    file_hash   TEXT,
    group_id    TEXT,
    group_name  TEXT,
    sender      TEXT,
    caption     TEXT,
    work_order  TEXT,
    status      TEXT DEFAULT 'waiting' CHECK(status IN ('waiting','processing','completed','unsorted','failed')),
    attempts    INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    timeout_at  DATETIME,
    processed_at DATETIME
);

-- إعدادات التطبيق
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- سجل الأحداث
CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    level      TEXT DEFAULT 'info' CHECK(level IN ('debug','info','warning','error')),
    message    TEXT NOT NULL,
    context    TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- فهارس للأداء
-- =============================================
CREATE INDEX IF NOT EXISTS idx_uploads_wo ON uploads(work_order);
CREATE INDEX IF NOT EXISTS idx_uploads_hash ON uploads(file_hash);
CREATE INDEX IF NOT EXISTS idx_uploads_date ON uploads(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status);
CREATE INDEX IF NOT EXISTS idx_context_group ON message_context(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_expires ON message_context(expires_at);
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, timeout_at);
CREATE INDEX IF NOT EXISTS idx_queue_group ON queue(group_id, status);
CREATE INDEX IF NOT EXISTS idx_log_level ON activity_log(level, created_at DESC);

-- =============================================
-- إعدادات افتراضية
-- =============================================
INSERT OR IGNORE INTO settings (key, value) VALUES ('bot_enabled', 'true');
INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_reply', 'true');
INSERT OR IGNORE INTO settings (key, value) VALUES ('monitor_groups', 'all');
INSERT OR IGNORE INTO settings (key, value) VALUES ('await_timeout', '90');
