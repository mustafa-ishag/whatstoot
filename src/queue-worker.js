/**
 * QueueWorker - معالج طابور الصور
 * 
 * يعمل كـ setInterval داخل نفس عملية Node.js
 * بديل لـ worker.php
 */

const fs = require('fs');
const db = require('./database');

class QueueWorker {
    constructor(uploader, logger, sendMessage = null) {
        this.uploader = uploader;
        this.logger = logger;
        this.sendMessage = sendMessage; // دالة إرسال رسالة واتساب (اختياري)
        this.cycleCount = 0;
        this.interval = null;
        this.isRunning = false;
    }

    /**
     * بدء Worker (كل 5 ثوان)
     */
    start(intervalMs = 5000) {
        if (this.interval) return;

        this.logger.info('Queue worker started');
        console.log('\n╔══════════════════════════════════════════╗');
        console.log('║   📋 Queue Worker Started (integrated)   ║');
        console.log('╚══════════════════════════════════════════╝\n');

        this.interval = setInterval(() => this.cycle(), intervalMs);
    }

    /**
     * إيقاف Worker
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            this.logger.info('Queue worker stopped');
        }
    }

    /**
     * دورة معالجة واحدة
     */
    async cycle() {
        if (this.isRunning) return; // لا تشغّل دورتين في نفس الوقت
        this.isRunning = true;
        this.cycleCount++;

        try {
            // 1. معالجة الصور التي انتهت مهلة الانتظار
            await this.processExpiredQueue();

            // 2. معالجة الصور التي وصلها رقم أمر عمل (حالة processing)
            await this.processLinkedQueue();

            // 3. تنظيف سياقات منتهية كل 50 دورة
            if (this.cycleCount % 50 === 0) {
                const cleaned = db.cleanExpiredContexts();
                if (cleaned > 0) {
                    this.logger.debug(`Cleaned ${cleaned} expired contexts`);
                }
            }

            // 4. طباعة حالة كل 60 دورة (5 دقائق)
            if (this.cycleCount % 60 === 0) {
                const stats = db.getStats();
                console.log(`[${new Date().toLocaleTimeString('en-GB')}] 📊 Total: ${stats.total_uploads} | Today: ${stats.today_uploads} | Pending: ${stats.pending}`);
            }

        } catch (e) {
            this.logger.error('Worker cycle error: ' + e.message);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * معالجة عناصر الطابور المنتهية المهلة
     */
    async processExpiredQueue() {
        const expired = db.getExpiredQueue();

        for (const item of expired) {
            this.logger.info(`Processing expired queue item #${item.id}...`);

            try {
                const imagePath = item.image_path;

                // التحقق من وجود الملف
                if (!fs.existsSync(imagePath)) {
                    this.logger.warning(`Temp file missing for queue #${item.id}: ${imagePath}`);
                    db.updateQueueStatus(item.id, 'failed');
                    continue;
                }

                // تحديد أمر العمل
                const workOrder = item.work_order || 'UNSORTED';

                // رفع
                const folderId = await this.uploader.getOrCreateFolder(workOrder);
                const ext = this._getExtension(imagePath);
                const fileName = this.uploader.buildFileName(workOrder, ext);
                const result = await this.uploader.upload(imagePath, folderId, fileName);

                // تسجيل في DB
                db.logUpload({
                    work_order: workOrder,
                    file_name: fileName,
                    file_hash: item.file_hash,
                    drive_id: result.id,
                    drive_url: result.url,
                    group_id: item.group_id,
                    group_name: item.group_name,
                    sender: item.sender,
                    caption: item.caption,
                    status: 'completed',
                });

                // تحديث حالة الطابور
                db.updateQueueStatus(item.id, workOrder === 'UNSORTED' ? 'unsorted' : 'completed', workOrder);

                // حذف الملف المؤقت
                this._safeUnlink(imagePath);

                this.logger.info(`✅ Queue #${item.id} uploaded as ${fileName} → ${workOrder}`);

                // إرسال رسالة تأكيد
                if (workOrder !== 'UNSORTED' && this.sendMessage && item.group_id) {
                    try {
                        await this.sendMessage(item.group_id, `✅ تم رفع الصورة بنجاح\n📁 أمر العمل: ${workOrder}\n📄 ${fileName}`);
                    } catch (e) {
                        // تجاهل أخطاء الإرسال
                    }
                }

            } catch (e) {
                this.logger.error(`Error processing queue #${item.id}: ${e.message}`);
                db.incrementQueueAttempts(item.id);

                // بعد 3 محاولات → فشل نهائي
                if ((item.attempts + 1) >= 3) {
                    db.updateQueueStatus(item.id, 'failed');
                    this.logger.error(`Queue #${item.id} failed permanently after 3 attempts`);
                }
            }
        }
    }

    /**
     * معالجة الصور التي وصلها رقم أمر عمل
     */
    async processLinkedQueue() {
        const processing = db.getProcessingQueue();

        for (const item of processing) {
            if (!item.work_order) continue;

            this.logger.info(`Processing linked queue #${item.id} → WO ${item.work_order}`);

            try {
                const imagePath = item.image_path;
                if (!fs.existsSync(imagePath)) {
                    db.updateQueueStatus(item.id, 'failed');
                    continue;
                }

                const workOrder = item.work_order;
                const folderId = await this.uploader.getOrCreateFolder(workOrder);
                const ext = this._getExtension(imagePath);
                const fileName = this.uploader.buildFileName(workOrder, ext);
                const result = await this.uploader.upload(imagePath, folderId, fileName);

                db.logUpload({
                    work_order: workOrder,
                    file_name: fileName,
                    file_hash: item.file_hash,
                    drive_id: result.id,
                    drive_url: result.url,
                    group_id: item.group_id,
                    group_name: item.group_name,
                    sender: item.sender,
                    caption: item.caption,
                    status: 'completed',
                });

                db.updateQueueStatus(item.id, 'completed', workOrder);

                this._safeUnlink(imagePath);

                this.logger.info(`✅ Queue #${item.id} uploaded as ${fileName} → ${workOrder}`);

            } catch (e) {
                this.logger.error(`Error processing queue #${item.id}: ${e.message}`);
                db.incrementQueueAttempts(item.id);

                if ((item.attempts + 1) >= 3) {
                    db.updateQueueStatus(item.id, 'failed');
                    this.logger.error(`Queue #${item.id} failed permanently after 3 attempts`);
                }
            }
        }
    }

    _getExtension(filePath) {
        const ext = filePath.split('.').pop();
        return ext || 'jpg';
    }

    _safeUnlink(filePath) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }
}

module.exports = QueueWorker;
