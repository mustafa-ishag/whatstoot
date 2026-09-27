/**
 * TempCleaner - منظف الملفات المؤقتة التلقائي
 * 
 * يقوم بفحص مجلد storage/temp وحذف الملفات المؤقتة
 * التي مضى على إنشائها أكثر من 24 ساعة لتفادي امتلاء مساحة السيرفر.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

class TempCleaner {
    /**
     * @param {import('./logger')} logger 
     * @param {number} maxAgeHours أقصى عمر للملف بالساعات (افتراضي: 24)
     */
    constructor(logger, maxAgeHours = 24) {
        this.logger = logger;
        this.maxAgeMs = maxAgeHours * 60 * 60 * 1000;
        this.tempPath = config.TEMP_PATH;
        this.intervalId = null;
    }

    /**
     * تشغيل التنظيف الفوري
     * @returns {{ deletedCount: number, freedBytes: number, errors: number }}
     */
    cleanNow() {
        if (!fs.existsSync(this.tempPath)) {
            return { deletedCount: 0, freedBytes: 0, errors: 0 };
        }

        const now = Date.now();
        let deletedCount = 0;
        let freedBytes = 0;
        let errors = 0;

        try {
            const files = fs.readdirSync(this.tempPath);

            for (const file of files) {
                // تجنب حذف ملفات النظام أو التثبيت
                if (file.startsWith('.') || file === 'README.md') continue;

                const filePath = path.join(this.tempPath, file);
                try {
                    const stats = fs.statSync(filePath);

                    // إذا كان ملفاً ومضى عليه أكثر من 24 ساعة
                    if (stats.isFile() && (now - stats.mtimeMs > this.maxAgeMs)) {
                        const size = stats.size;
                        fs.unlinkSync(filePath);
                        deletedCount++;
                        freedBytes += size;
                    }
                } catch (err) {
                    errors++;
                }
            }

            if (deletedCount > 0) {
                const mbFreed = (freedBytes / (1024 * 1024)).toFixed(2);
                console.log(`🧹 [TempCleaner] تم تنظيف ${deletedCount} ملف مؤقت (مساحة محررة: ${mbFreed} MB)`);
                if (this.logger && typeof this.logger.info === 'function') {
                    this.logger.info(`TempCleaner: Deleted ${deletedCount} old temp files, freed ${mbFreed} MB`);
                }
            }
        } catch (e) {
            console.error('❌ [TempCleaner] خطأ أثناء فحص الملفات المؤقتة:', e.message);
        }

        return { deletedCount, freedBytes, errors };
    }

    /**
     * بدء الجدولة الدورية (افتراضي كل 6 ساعات)
     */
    start(intervalMs = 6 * 60 * 60 * 1000) {
        if (this.intervalId) return;

        // تشغيل فوري بعد 10 ثوانٍ من بدء التشغيل
        setTimeout(() => this.cleanNow(), 10000);

        // جدولة دورية
        this.intervalId = setInterval(() => {
            this.cleanNow();
        }, intervalMs);

        console.log(`🧹 [TempCleaner] تم تفعيل منظف الملفات المؤقتة (فحص كل ${intervalMs / 3600000} ساعة)`);
    }

    /**
     * إيقاف الجدولة
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}

module.exports = TempCleaner;
