/**
 * Logger - نظام تسجيل الأحداث
 * 
 * يسجل في ملفات يومية + قاعدة البيانات
 * بديل لـ src/Logger.php
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

class Logger {
    constructor(logsPath = null, db = null) {
        this.logsPath = logsPath || config.LOGS_PATH;
        this.db = db;

        if (!fs.existsSync(this.logsPath)) {
            fs.mkdirSync(this.logsPath, { recursive: true });
        }

        // Prepare DB statement once
        if (this.db) {
            try {
                this._insertStmt = this.db.prepare(
                    'INSERT INTO activity_log (level, message, context) VALUES (?, ?, ?)'
                );
            } catch (e) {
                // Table might not exist yet
                this._insertStmt = null;
            }
        }
    }

    debug(message, context = {}) { this._log('debug', message, context); }
    info(message, context = {}) { this._log('info', message, context); }
    warning(message, context = {}) { this._log('warning', message, context); }
    error(message, context = {}) { this._log('error', message, context); }

    /**
     * تسجيل حدث
     */
    _log(level, message, context = {}) {
        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const levelUpper = level.toUpperCase();
        const contextStr = Object.keys(context).length > 0 ? ' ' + JSON.stringify(context) : '';

        // كتابة في ملف يومي
        const logLine = `[${timestamp}] [${levelUpper}] ${message}${contextStr}\n`;
        const today = new Date().toISOString().substring(0, 10);
        const logFile = path.join(this.logsPath, `${today}.log`);

        try {
            fs.appendFileSync(logFile, logLine);
        } catch (e) {
            // تجاهل أخطاء الكتابة
        }

        // كتابة في قاعدة البيانات
        if (this._insertStmt) {
            try {
                this._insertStmt.run(level, message, contextStr || null);
            } catch (e) {
                // تجاهل أخطاء DB في اللوجر
            }
        }

        // طباعة في الـ console
        if (config.APP_DEBUG || config.APP_ENV === 'development') {
            const colors = {
                debug: '\x1b[90m',   // رمادي
                info: '\x1b[36m',    // أزرق فاتح
                warning: '\x1b[33m', // أصفر
                error: '\x1b[31m',   // أحمر
            };
            const color = colors[level] || '\x1b[0m';
            console.log(`${color}[${levelUpper}] ${message}\x1b[0m`);
        }
    }

    /**
     * جلب آخر الأحداث من قاعدة البيانات
     */
    getRecentLogs(limit = 100, level = null) {
        if (!this.db) return [];

        try {
            if (level) {
                return this.db.prepare('SELECT * FROM activity_log WHERE level = ? ORDER BY created_at DESC LIMIT ?').all(level, limit);
            }
            return this.db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').all(limit);
        } catch (e) {
            return [];
        }
    }

    /**
     * قراءة ملف لوق يومي
     */
    readLogFile(date = null, lines = 100) {
        date = date || new Date().toISOString().substring(0, 10);
        const logFile = path.join(this.logsPath, `${date}.log`);

        if (!fs.existsSync(logFile)) return '';

        try {
            const content = fs.readFileSync(logFile, 'utf8').trim();
            const allLines = content.split('\n');
            return allLines.slice(-lines).join('\n');
        } catch (e) {
            return '';
        }
    }
}

module.exports = Logger;
