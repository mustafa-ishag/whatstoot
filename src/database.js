/**
 * Database - إدارة قاعدة بيانات SQLite
 * 
 * يوفّر singleton ودوال مساعدة للعمليات الشائعة
 * بديل لـ src/Database.php
 */

const path = require('path');
const fs = require('fs');
const config = require('./config');

let Database; // lazy-loaded better-sqlite3

/** @type {import('better-sqlite3').Database} */
let _instance = null;

/**
 * الحصول على instance واحد
 */
function getInstance(dbPath) {
    if (_instance) return _instance;

    if (!Database) {
        Database = require('better-sqlite3');
    }

    dbPath = dbPath || config.DB_PATH;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    _instance = new Database(dbPath);

    // تحسينات أداء SQLite
    _instance.pragma('journal_mode = WAL');
    _instance.pragma('synchronous = NORMAL');
    _instance.pragma('foreign_keys = ON');

    return _instance;
}

/**
 * تطبيق schema قاعدة البيانات
 */
function applySchema(schemaPath) {
    const db = getInstance();
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
}

// =============================================
// 📤 Uploads
// =============================================

function logUpload(data) {
    const db = getInstance();
    const stmt = db.prepare(`
        INSERT INTO uploads (work_order, file_name, file_hash, drive_id, drive_url, group_id, group_name, sender, caption, status)
        VALUES (@work_order, @file_name, @file_hash, @drive_id, @drive_url, @group_id, @group_name, @sender, @caption, @status)
    `);
    const result = stmt.run({
        work_order: data.work_order,
        file_name: data.file_name,
        file_hash: data.file_hash || null,
        drive_id: data.drive_id || null,
        drive_url: data.drive_url || null,
        group_id: data.group_id || null,
        group_name: data.group_name || null,
        sender: data.sender || null,
        caption: data.caption || null,
        status: data.status || 'completed',
    });
    return result.lastInsertRowid;
}

function getUploads(limit = 50, offset = 0, woFilter = null, status = null) {
    const db = getInstance();
    let sql = 'SELECT * FROM uploads WHERE 1=1';
    const params = [];

    if (woFilter) {
        sql += ' AND work_order LIKE ?';
        params.push(`%${woFilter}%`);
    }
    if (status) {
        sql += ' AND status = ?';
        params.push(status);
    }

    sql += ' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(sql).all(...params);
}

// =============================================
// 📁 Folders
// =============================================

function getFolder(workOrder) {
    const db = getInstance();
    const row = db.prepare('SELECT drive_id FROM folders WHERE work_order = ?').get(workOrder);
    return row ? row.drive_id : null;
}

function saveFolder(workOrder, driveId) {
    const db = getInstance();
    db.prepare('INSERT OR REPLACE INTO folders (work_order, drive_id) VALUES (?, ?)').run(workOrder, driveId);
}

// =============================================
// 💬 Message Context
// =============================================

function saveContext(groupId, workOrder, sender = null, ttlSeconds = 300) {
    const db = getInstance();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString().replace('T', ' ').substring(0, 19);
    db.prepare('INSERT INTO message_context (group_id, work_order, sender, expires_at) VALUES (?, ?, ?, ?)').run(groupId, workOrder, sender, expiresAt);
}

function getRecentContext(groupId, sender = null) {
    const db = getInstance();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    let row;
    if (sender) {
        row = db.prepare(`
            SELECT work_order FROM message_context
            WHERE group_id = ? AND sender = ? AND expires_at > ?
            ORDER BY created_at DESC LIMIT 1
        `).get(groupId, sender, now);
    } else {
        row = db.prepare(`
            SELECT work_order FROM message_context
            WHERE group_id = ? AND expires_at > ?
            ORDER BY created_at DESC LIMIT 1
        `).get(groupId, now);
    }

    return row ? row.work_order : null;
}

function cleanExpiredContexts() {
    const db = getInstance();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const result = db.prepare('DELETE FROM message_context WHERE expires_at < ?').run(now);
    return result.changes;
}

// =============================================
// 📋 Queue
// =============================================

function enqueue(data) {
    const db = getInstance();
    const timeout = config.AWAIT_TIMEOUT_SECONDS || 90;
    const timeoutAt = new Date(Date.now() + timeout * 1000).toISOString().replace('T', ' ').substring(0, 19);

    const stmt = db.prepare(`
        INSERT INTO queue (image_path, file_hash, group_id, group_name, sender, caption, work_order, status, timeout_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
        data.image_path,
        data.file_hash || null,
        data.group_id || null,
        data.group_name || null,
        data.sender || null,
        data.caption || null,
        data.work_order || null,
        data.status || 'waiting',
        timeoutAt
    );

    return result.lastInsertRowid;
}

function getExpiredQueue() {
    const db = getInstance();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    return db.prepare('SELECT * FROM queue WHERE status = ? AND timeout_at <= ?').all('waiting', now);
}

function getWaitingImages(groupId, sender = null) {
    const db = getInstance();
    if (sender) {
        return db.prepare('SELECT * FROM queue WHERE group_id = ? AND sender = ? AND status = ?').all(groupId, sender, 'waiting');
    }
    return db.prepare('SELECT * FROM queue WHERE group_id = ? AND status = ?').all(groupId, 'waiting');
}

function updateQueueStatus(id, status, workOrder = null) {
    const db = getInstance();
    if (workOrder !== null) {
        db.prepare('UPDATE queue SET status = ?, work_order = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, workOrder, id);
    } else {
        db.prepare('UPDATE queue SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
    }
}

function incrementQueueAttempts(id) {
    const db = getInstance();
    db.prepare('UPDATE queue SET attempts = attempts + 1 WHERE id = ?').run(id);
}

function getProcessingQueue() {
    const db = getInstance();
    return db.prepare('SELECT * FROM queue WHERE status = ?').all('processing');
}

// =============================================
// 🔑 Settings
// =============================================

function getSetting(key, defaultValue = null) {
    const db = getInstance();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
}

function setSetting(key, value) {
    const db = getInstance();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function getAllSettings() {
    const db = getInstance();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

// =============================================
// 📊 Statistics
// =============================================

function getStats() {
    const db = getInstance();

    const today = new Date().toISOString().substring(0, 10);

    const totalUploads = db.prepare("SELECT COUNT(*) as c FROM uploads WHERE status = 'completed'").get().c;
    const todayUploads = db.prepare("SELECT COUNT(*) as c FROM uploads WHERE status = 'completed' AND DATE(uploaded_at) = ?").get(today).c;
    const uniqueWO = db.prepare("SELECT COUNT(DISTINCT work_order) as c FROM uploads WHERE work_order != 'UNSORTED' AND status = 'completed'").get().c;
    const unsorted = db.prepare("SELECT COUNT(*) as c FROM uploads WHERE work_order = 'UNSORTED' AND status = 'completed'").get().c;
    const pending = db.prepare("SELECT COUNT(*) as c FROM queue WHERE status = 'waiting'").get().c;
    const duplicates = db.prepare("SELECT COUNT(*) as c FROM uploads WHERE status = 'duplicate'").get().c;
    const failed = db.prepare("SELECT COUNT(*) as c FROM uploads WHERE status = 'failed'").get().c;

    // رفعات هذا الأسبوع
    const now = new Date();
    const dayOfWeek = now.getDay() || 7; // Sunday = 7
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek + 1);
    const weekStart = monday.toISOString().substring(0, 10);
    const weekUploads = db.prepare("SELECT COUNT(*) as c FROM uploads WHERE status = 'completed' AND DATE(uploaded_at) >= ?").get(weekStart).c;

    return {
        total_uploads: totalUploads,
        today_uploads: todayUploads,
        week_uploads: weekUploads,
        unique_wo: uniqueWO,
        unsorted,
        pending,
        duplicates,
        failed,
    };
}

// =============================================
// 🔍 Duplicate Check
// =============================================

function isDuplicate(hash, workOrder = null) {
    const db = getInstance();
    if (workOrder) {
        const row = db.prepare("SELECT COUNT(*) as c FROM uploads WHERE file_hash = ? AND work_order = ? AND status = 'completed'").get(hash, workOrder);
        return row.c > 0;
    }
    const row = db.prepare("SELECT COUNT(*) as c FROM uploads WHERE file_hash = ? AND status = 'completed'").get(hash);
    return row.c > 0;
}

// =============================================
// 🗑️ Reset & Move (for API routes)
// =============================================

function resetWorkOrder(workOrder) {
    const db = getInstance();

    const deletedUploads = db.prepare('DELETE FROM uploads WHERE work_order = ?').run(workOrder).changes;
    const deletedFolders = db.prepare('DELETE FROM folders WHERE work_order = ?').run(workOrder).changes;
    const deletedQueue = db.prepare('DELETE FROM queue WHERE work_order = ?').run(workOrder).changes;

    return { deletedUploads, deletedFolders, deletedQueue };
}

function getUploadsForMove(fromWO, count) {
    const db = getInstance();
    return db.prepare(`
        SELECT id, file_name, file_hash, drive_id 
        FROM uploads 
        WHERE work_order = ? AND status = 'completed' 
        ORDER BY id DESC 
        LIMIT ?
    `).all(fromWO, count);
}

function updateUploadWorkOrder(id, toWO) {
    const db = getInstance();
    db.prepare('UPDATE uploads SET work_order = ? WHERE id = ?').run(toWO, id);
}

module.exports = {
    getInstance,
    applySchema,
    // Uploads
    logUpload, getUploads,
    // Folders
    getFolder, saveFolder,
    // Context
    saveContext, getRecentContext, cleanExpiredContexts,
    // Queue
    enqueue, getExpiredQueue, getWaitingImages, updateQueueStatus, incrementQueueAttempts, getProcessingQueue,
    // Settings
    getSetting, setSetting, getAllSettings,
    // Stats
    getStats,
    // Duplicate
    isDuplicate,
    // Reset & Move
    resetWorkOrder, getUploadsForMove, updateUploadWorkOrder,
};
