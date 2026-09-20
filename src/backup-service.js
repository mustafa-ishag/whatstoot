/**
 * BackupService - خدمة النسخ الاحتياطي التلقائي لقاعدة بيانات SQLite
 * 
 * تستخدم ميزة db.backup() المدمجة في better-sqlite3
 * لإنشاء نسخة احتياطية متسقة وآمنة بدون قفل قاعدة البيانات.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./database');

class BackupService {
    /**
     * @param {import('./logger')} logger 
     * @param {number} maxBackups عدد النسخ المحتفظ بها (افتراضي 7)
     */
    constructor(logger, maxBackups = 7) {
        this.logger = logger;
        this.maxBackups = maxBackups;
        this.backupDir = path.join(config.BASE_PATH, 'storage', 'backups');
        this.intervalId = null;

        if (!fs.existsSync(this.backupDir)) {
            try {
                fs.mkdirSync(this.backupDir, { recursive: true });
            } catch (e) {}
        }
    }

    /**
     * إنشاء نسخة احتياطية فورية
     * @returns {Promise<{ success: boolean, backupFile?: string, sizeBytes?: number, message: string }>}
     */
    async createBackupNow() {
        try {
            const rawDb = db.getInstance();
            if (!rawDb) {
                throw new Error('Database instance not ready');
            }

            const now = new Date();
            const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const fileName = `backup_${dateStr}.sqlite`;
            const destPath = path.join(this.backupDir, fileName);

            console.log(`💾 [BackupService] جاري إنشاء نسخة احتياطية: ${fileName}...`);

            // استخدام دالة backup المدمجة في better-sqlite3
            await rawDb.backup(destPath);

            const sizeBytes = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
            const mb = (sizeBytes / (1024 * 1024)).toFixed(2);

            console.log(`💾 [BackupService] ✅ تمت النسخة الاحتياطية بنجاح: ${fileName} (${mb} MB)`);
            if (this.logger && typeof this.logger.info === 'function') {
                this.logger.info(`Backup created: ${fileName} (${mb} MB)`);
            }

            // تدوير النسخ القديمة والاحتفاظ بآخر N نسخة
            this._rotateOldBackups();

            return {
                success: true,
                backupFile: fileName,
                sizeBytes,
                message: `تم إنشاء النسخة الاحتياطية بنجاح (${mb} MB)`,
            };
        } catch (e) {
            console.error('❌ [BackupService] فشل إنشاء النسخة الاحتياطية:', e.message);
            if (this.logger && typeof this.logger.error === 'function') {
                this.logger.error(`Backup failed: ${e.message}`);
            }
            return {
                success: false,
                message: `فشل النسخ الاحتياطي: ${e.message}`,
            };
        }
    }

    /**
     * تدوير وحذف النسخ القديمة
     */
    _rotateOldBackups() {
        try {
            if (!fs.existsSync(this.backupDir)) return;

            const files = fs.readdirSync(this.backupDir)
                .filter(f => f.startsWith('backup_') && f.endsWith('.sqlite'))
                .map(f => {
                    const fp = path.join(this.backupDir, f);
                    return { name: f, path: fp, time: fs.statSync(fp).mtimeMs };
                })
                .sort((a, b) => b.time - a.time); // الأحدث أولاً

            if (files.length > this.maxBackups) {
                const toDelete = files.slice(this.maxBackups);
                for (const item of toDelete) {
                    try {
                        fs.unlinkSync(item.path);
                        console.log(`🗑️ [BackupService] تم حذف نسخة احتياطية قديمة: ${item.name}`);
                    } catch (e) {}
                }
            }
        } catch (e) {
            console.error('⚠️ [BackupService] خطأ في تدوير النسخ الاحتياطية:', e.message);
        }
    }

    /**
     * بدء الجدولة اليومية (كل 24 ساعة)
     */
    start(intervalMs = 24 * 60 * 60 * 1000) {
        if (this.intervalId) return;

        // أول نسخة بعد دقيقة من تشغيل السيرفر إن لم توجد نسخ حديثة خلال 24 ساعة
        setTimeout(() => {
            const hasRecent = this._hasRecentBackup();
            if (!hasRecent) {
                this.createBackupNow();
            }
        }, 60000);

        this.intervalId = setInterval(() => {
            this.createBackupNow();
        }, intervalMs);

        console.log(`💾 [BackupService] تم تفعيل خدمة النسخ الاحتياطي اليومي لقاعدة البيانات`);
    }

    _hasRecentBackup() {
        try {
            if (!fs.existsSync(this.backupDir)) return false;
            const files = fs.readdirSync(this.backupDir)
                .filter(f => f.startsWith('backup_') && f.endsWith('.sqlite'));
            if (files.length === 0) return false;

            const now = Date.now();
            return files.some(f => {
                const stat = fs.statSync(path.join(this.backupDir, f));
                return (now - stat.mtimeMs) < (24 * 60 * 60 * 1000);
            });
        } catch (e) {
            return false;
        }
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}

module.exports = BackupService;
