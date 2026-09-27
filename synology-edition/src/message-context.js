/**
 * MessageContext - إدارة سياق الرسائل
 * 
 * يتتبع آخر أرقام أوامر العمل لكل مرسل في كل مجموعة
 * ⚠️ القاعدة: رقم أمر العمل يُربط بصور نفس المرسل فقط
 * بديل لـ src/MessageContext.php
 */

const db = require('./database');
const WorkOrderExtractor = require('./work-order-extractor');

class MessageContext {
    constructor(extractor = null) {
        this.extractor = extractor || new WorkOrderExtractor();
    }

    /**
     * معالجة رسالة نصية — استخراج رقم أمر العمل وحفظه مرتبطاً بالمرسل
     * @returns {string|null} رقم أمر العمل إذا وُجد
     */
    processTextMessage(text, groupId, sender = null) {
        const workOrder = this.extractor.extract(text);

        if (workOrder && sender) {
            db.saveContext(groupId, workOrder, sender, 300); // صالح 5 دقائق
        }

        return workOrder;
    }

    /**
     * إيجاد رقم أمر العمل لصورة — مرتبط بالمرسل فقط
     * 
     * الترتيب:
     * 1. الكابشن المرفق بالصورة
     * 2. آخر رقم أرسله نفس الشخص في المجموعة
     * 3. null (سيذهب للطابور أو UNSORTED)
     */
    resolveWorkOrder(caption, groupId, sender = null) {
        // 1. بحث في الكابشن
        if (caption) {
            const wo = this.extractor.extract(caption);
            if (wo) {
                // حفظ في السياق ليكون متاحاً للصور الأخرى
                if (sender) {
                    db.saveContext(groupId, wo, sender, 300);
                }
                return wo;
            }
        }

        // 2. بحث في سياق نفس المرسل فقط
        return db.getRecentContext(groupId, sender);
    }

    /**
     * معالجة الصور المعلّقة في الطابور عند وصول رقم أمر عمل
     * ⚠️ فقط صور نفس المرسل تُربط
     * @returns {number[]} قائمة IDs الصور التي تم تحديثها
     */
    processWaitingImages(groupId, workOrder, sender = null) {
        const waitingImages = db.getWaitingImages(groupId, sender);
        const processedIds = [];

        for (const image of waitingImages) {
            db.updateQueueStatus(image.id, 'processing', workOrder);
            processedIds.push(image.id);
        }

        return processedIds;
    }

    /**
     * تنظيف السياقات المنتهية
     */
    cleanup() {
        return db.cleanExpiredContexts();
    }
}

module.exports = MessageContext;
