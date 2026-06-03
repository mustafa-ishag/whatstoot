<?php

namespace WhatsToot;

/**
 * MessageContext - إدارة سياق الرسائل
 * 
 * يتتبع آخر أرقام أوامر العمل لكل مرسل في كل مجموعة
 * ⚠️ القاعدة: رقم أمر العمل يُربط بصور نفس المرسل فقط
 */
class MessageContext
{
    private Database $db;
    private WorkOrderExtractor $extractor;

    public function __construct(Database $db, ?WorkOrderExtractor $extractor = null)
    {
        $this->db = $db;
        $this->extractor = $extractor ?? new WorkOrderExtractor();
    }

    /**
     * معالجة رسالة نصية — استخراج رقم أمر العمل وحفظه مرتبطاً بالمرسل
     * 
     * @return string|null رقم أمر العمل إذا وُجد
     */
    public function processTextMessage(string $text, string $groupId, ?string $sender = null): ?string
    {
        $workOrder = $this->extractor->extract($text);

        if ($workOrder && $sender) {
            $this->db->saveContext($groupId, $workOrder, $sender, 300); // صالح 5 دقائق
        }

        return $workOrder;
    }

    /**
     * إيجاد رقم أمر العمل لصورة — مرتبط بالمرسل فقط
     * 
     * الترتيب:
     * 1. الكابشن المرفق بالصورة
     * 2. آخر رقم أرسله نفس الشخص في المجموعة
     * 3. null (سيذهب للطابور أو UNSORTED)
     */
    public function resolveWorkOrder(?string $caption, string $groupId, ?string $sender = null): ?string
    {
        // 1. بحث في الكابشن
        if ($caption) {
            $wo = $this->extractor->extract($caption);
            if ($wo) {
                // حفظ في السياق ليكون متاحاً للصور الأخرى التي تصل لاحقاً بدون كابشن
                if ($sender) {
                    $this->db->saveContext($groupId, $wo, $sender, 300); // صالح 5 دقائق
                }
                return $wo;
            }
        }

        // 2. بحث في سياق نفس المرسل فقط
        return $this->db->getRecentContext($groupId, $sender);
    }

    /**
     * معالجة الصور المعلّقة في الطابور عند وصول رقم أمر عمل
     * ⚠️ فقط صور نفس المرسل تُربط
     * 
     * @return array قائمة IDs الصور التي تم تحديثها
     */
    public function processWaitingImages(string $groupId, string $workOrder, ?string $sender = null): array
    {
        // فقط صور نفس المرسل
        $waitingImages = $this->db->getWaitingImages($groupId, $sender);
        $processedIds = [];

        foreach ($waitingImages as $image) {
            $this->db->updateQueueStatus($image['id'], 'processing', $workOrder);
            $processedIds[] = $image['id'];
        }

        return $processedIds;
    }

    /**
     * تنظيف السياقات المنتهية
     */
    public function cleanup(): int
    {
        return $this->db->cleanExpiredContexts();
    }
}
