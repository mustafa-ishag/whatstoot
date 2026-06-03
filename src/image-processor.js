/**
 * ImageProcessor - معالجة الصور والنصوص
 * 
 * دمج منطق api/process-image.php كوحدة Node.js
 * يُستدعى مباشرة من البوت (بدون HTTP)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const db = require('./database');
const DuplicateChecker = require('./duplicate-checker');
const MessageContext = require('./message-context');

class ImageProcessor {
    constructor(uploader, logger) {
        this.uploader = uploader;
        this.logger = logger;
        this.checker = new DuplicateChecker();
        this.context = new MessageContext();

        // التأكد من وجود مجلد temp
        if (!fs.existsSync(config.TEMP_PATH)) {
            fs.mkdirSync(config.TEMP_PATH, { recursive: true });
        }
    }

    /**
     * معالجة رسالة نصية
     * @returns {{ success: boolean, work_order?: string, queued_images_updated?: number, message: string }}
     */
    processText(input) {
        const { body, group_id, sender } = input;

        const workOrder = this.context.processTextMessage(body, group_id, sender);

        const response = { success: true, type: 'text' };

        if (workOrder) {
            response.work_order = workOrder;
            response.message = `تم التعرف على رقم أمر العمل: ${workOrder}`;

            // فحص الطابور — هل هناك صور تنتظر من نفس المرسل؟
            const processedIds = this.context.processWaitingImages(group_id, workOrder, sender);
            if (processedIds.length > 0) {
                response.queued_images_updated = processedIds.length;
                this.logger.info(`Linked ${workOrder} to ${processedIds.length} waiting images from ${sender}`);
            }
        } else {
            response.message = 'لم يتم العثور على رقم أمر عمل';
        }

        return response;
    }

    /**
     * معالجة صورة
     * @returns {Promise<{ success: boolean, action: string, work_order?: string, file_name?: string, message: string }>}
     */
    async processImage(input) {
        const { image_base64, mimetype, caption, work_order: inputWO, group_id, group_name, sender } = input;

        if (!image_base64) {
            return { success: false, message: 'No image data' };
        }

        try {
            // 1. فك base64 وحفظ مؤقت
            const imageData = Buffer.from(image_base64, 'base64');
            const ext = this.uploader.getExtensionFromMime(mimetype || 'image/jpeg');
            const tempName = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
            const tempPath = path.join(config.TEMP_PATH, tempName);
            fs.writeFileSync(tempPath, imageData);

            this.logger.info(`Saved temp image: ${tempName} (${imageData.length} bytes)`);

            // 2. حساب hash وفحص التكرار
            const hash = this.checker.hashData(imageData);

            // 3. تحديد رقم أمر العمل
            let workOrder = inputWO || '';
            if (!workOrder) {
                workOrder = this.context.resolveWorkOrder(caption, group_id, sender);
            } else {
                // إذا تم إرساله من البوت، نحفظه في السياق
                if (sender) {
                    db.saveContext(group_id, workOrder, sender, 300);
                }
            }

            if (workOrder) {
                // معالجة أي صور معلّقة لهذا المرسل
                const processedIds = this.context.processWaitingImages(group_id, workOrder, sender);
                if (processedIds.length > 0) {
                    this.logger.info(`Linked ${workOrder} to ${processedIds.length} waiting images from ${sender} via resolved work order`);
                }
            }

            // فحص التكرار مع رقم أمر العمل
            if (workOrder && this.checker.isDuplicate(hash, workOrder)) {
                this._safeUnlink(tempPath);
                db.logUpload({
                    work_order: workOrder,
                    file_name: tempName,
                    file_hash: hash,
                    group_id, group_name, sender, caption,
                    status: 'duplicate',
                });
                this.logger.warning(`Duplicate image skipped for WO ${workOrder}`);

                return {
                    success: true,
                    action: 'skipped',
                    reason: 'duplicate',
                    work_order: workOrder,
                    message: `⚠️ الصورة مكررة — تم تخطيها (أمر العمل: ${workOrder})`,
                };
            }

            // 4. إذا لم يوجد رقم أمر عمل → إضافة للطابور
            if (!workOrder) {
                const queueId = db.enqueue({
                    image_path: tempPath,
                    file_hash: hash,
                    group_id, group_name, sender, caption,
                });

                this.logger.info(`Image queued (ID: ${queueId}), waiting for work order number...`);

                return {
                    success: true,
                    action: 'queued',
                    queue_id: queueId,
                    message: '⏳ تم استلام الصورة — بانتظار رقم أمر العمل...',
                };
            }

            // 5. رفع إلى Storage (Synology/Drive)
            const folderId = await this.uploader.getOrCreateFolder(workOrder);
            const fileName = this.uploader.buildFileName(workOrder, ext);
            const result = await this.uploader.upload(tempPath, folderId, fileName);

            // 6. تسجيل في قاعدة البيانات
            const uploadId = db.logUpload({
                work_order: workOrder,
                file_name: fileName,
                file_hash: hash,
                drive_id: result.id,
                drive_url: result.url,
                group_id, group_name, sender, caption,
                status: 'completed',
            });

            // 7. حذف الملف المؤقت
            this._safeUnlink(tempPath);

            this.logger.info(`✅ Uploaded ${fileName} to Drive for WO ${workOrder}`);

            return {
                success: true,
                action: 'uploaded',
                work_order: workOrder,
                file_name: fileName,
                drive_id: result.id,
                drive_url: result.url,
                upload_id: uploadId,
                message: `✅ تم رفع الصورة بنجاح\n📁 أمر العمل: ${workOrder}\n📄 الملف: ${fileName}`,
            };

        } catch (e) {
            this.logger.error(`Image processing error: ${e.message}`);

            // حفظ الصورة في UNSORTED عند الخطأ
            try {
                const tempPath = path.join(config.TEMP_PATH, `img_${Date.now()}_error.jpg`);
                if (fs.existsSync(tempPath)) {
                    const folderId = await this.uploader.getOrCreateFolder('UNSORTED');
                    const fileName = this.uploader.buildFileName('ERROR', 'jpg');
                    await this.uploader.upload(tempPath, folderId, fileName);
                    this._safeUnlink(tempPath);
                }
            } catch (e2) {
                // تجاهل
            }

            return {
                success: false,
                message: 'خطأ في معالجة الصورة: ' + e.message,
            };
        }
    }

    _safeUnlink(filePath) {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
            // تجاهل
        }
    }
}

module.exports = ImageProcessor;
