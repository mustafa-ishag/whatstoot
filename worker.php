<?php
/**
 * WhatsToot Bot - Queue Worker
 * 
 * يعمل باستمرار ويعالج الصور المعلّقة في الطابور
 * 
 * التشغيل: php worker.php
 */

require_once __DIR__ . '/vendor/autoload.php';
require_once __DIR__ . '/config/app.php';

use WhatsToot\Database;
use WhatsToot\UploaderFactory;
use WhatsToot\Logger;

echo "\n";
echo "╔══════════════════════════════════════════╗\n";
echo "║   📋 WhatsToot Queue Worker Started      ║\n";
echo "╚══════════════════════════════════════════╝\n\n";

$db     = Database::getInstance();
$logger = new Logger(LOGS_PATH, $db->getPdo());
$drive  = UploaderFactory::create($db, $logger);

$logger->info('Queue worker started');

$cycleCount = 0;

// =============================================
// 🔄 حلقة المعالجة الرئيسية
// =============================================

while (true) {
    $cycleCount++;

    try {
        // 1. معالجة الصور التي انتهت مهلة الانتظار (90 ثانية)
        $expired = $db->getExpiredQueue();

        foreach ($expired as $item) {
            $logger->info("Processing expired queue item #{$item['id']}...");

            try {
                $imagePath = $item['image_path'];

                // التحقق من وجود الملف
                if (!file_exists($imagePath)) {
                    $logger->warning("Temp file missing for queue #{$item['id']}: {$imagePath}");
                    $db->updateQueueStatus($item['id'], 'failed');
                    continue;
                }

                // تحديد أمر العمل (من الطابور أو UNSORTED)
                $workOrder = $item['work_order'] ?: 'UNSORTED';

                // رفع إلى Drive
                $folderId = $drive->getOrCreateFolder($workOrder);
                $ext = pathinfo($imagePath, PATHINFO_EXTENSION) ?: 'jpg';
                $fileName = $drive->buildFileName($workOrder, $ext);
                $result = $drive->upload($imagePath, $folderId, $fileName);

                // تسجيل في DB
                $db->logUpload([
                    'work_order' => $workOrder,
                    'file_name'  => $fileName,
                    'file_hash'  => $item['file_hash'],
                    'drive_id'   => $result['id'],
                    'drive_url'  => $result['url'],
                    'group_id'   => $item['group_id'],
                    'group_name' => $item['group_name'],
                    'sender'     => $item['sender'],
                    'caption'    => $item['caption'],
                    'status'     => 'completed',
                ]);

                // تحديث حالة الطابور
                $db->updateQueueStatus($item['id'], $workOrder === 'UNSORTED' ? 'unsorted' : 'completed', $workOrder);

                // حذف الملف المؤقت
                if (file_exists($imagePath)) {
                    unlink($imagePath);
                }

                $logger->info("✅ Queue #{$item['id']} uploaded as {$fileName} → {$workOrder}");

                // إرسال رسالة تأكيد عبر Node.js
                if ($workOrder !== 'UNSORTED' && defined('AUTO_REPLY_ENABLED') && AUTO_REPLY_ENABLED && $item['group_id']) {
                    sendBotMessage($item['group_id'], "✅ تم رفع الصورة بنجاح\n📁 أمر العمل: {$workOrder}\n📄 {$fileName}");
                }

            } catch (\Exception $e) {
                $logger->error("Error processing queue #{$item['id']}: " . $e->getMessage());
                $db->incrementQueueAttempts($item['id']);

                // بعد 3 محاولات → فشل نهائي
                if (($item['attempts'] + 1) >= 3) {
                    $db->updateQueueStatus($item['id'], 'failed');
                    $logger->error("Queue #{$item['id']} failed permanently after 3 attempts");
                }
            }
        }

        // 2. معالجة الصور التي وصلها رقم أمر عمل (حالة processing)
        $processing = $db->getPdo()->prepare('SELECT * FROM queue WHERE status = ?');
        $processing->execute(['processing']);
        $processingItems = $processing->fetchAll(\PDO::FETCH_ASSOC);

        foreach ($processingItems as $item) {
            if (empty($item['work_order'])) {
                continue;
            }

            $logger->info("Processing linked queue #{$item['id']} → WO {$item['work_order']}");

            try {
                $imagePath = $item['image_path'];
                if (!file_exists($imagePath)) {
                    $db->updateQueueStatus($item['id'], 'failed');
                    continue;
                }

                $workOrder = $item['work_order'];
                $folderId = $drive->getOrCreateFolder($workOrder);
                $ext = pathinfo($imagePath, PATHINFO_EXTENSION) ?: 'jpg';
                $fileName = $drive->buildFileName($workOrder, $ext);
                $result = $drive->upload($imagePath, $folderId, $fileName);

                $db->logUpload([
                    'work_order' => $workOrder,
                    'file_name'  => $fileName,
                    'file_hash'  => $item['file_hash'],
                    'drive_id'   => $result['id'],
                    'drive_url'  => $result['url'],
                    'group_id'   => $item['group_id'],
                    'group_name' => $item['group_name'],
                    'sender'     => $item['sender'],
                    'caption'    => $item['caption'],
                    'status'     => 'completed',
                ]);

                $db->updateQueueStatus($item['id'], 'completed', $workOrder);

                if (file_exists($imagePath)) {
                    unlink($imagePath);
                }

                $logger->info("✅ Queue #{$item['id']} uploaded as {$fileName} → {$workOrder}");

            } catch (\Exception $e) {
                $logger->error("Error processing queue #{$item['id']}: " . $e->getMessage());
                $db->incrementQueueAttempts($item['id']);

                // بعد 3 محاولات → فشل نهائي
                if (($item['attempts'] + 1) >= 3) {
                    $db->updateQueueStatus($item['id'], 'failed');
                    $logger->error("Queue #{$item['id']} failed permanently after 3 attempts");
                }
            }
        }

        // 3. تنظيف سياقات منتهية كل 50 دورة
        if ($cycleCount % 50 === 0) {
            $cleaned = $db->cleanExpiredContexts();
            if ($cleaned > 0) {
                $logger->debug("Cleaned {$cleaned} expired contexts");
            }
        }

    } catch (\Exception $e) {
        $logger->error('Worker cycle error: ' . $e->getMessage());
    }

    // انتظار 5 ثوان
    sleep(5);

    // طباعة حالة كل 60 دورة (5 دقائق)
    if ($cycleCount % 60 === 0) {
        $stats = $db->getStats();
        echo "[" . date('H:i:s') . "] 📊 Total: {$stats['total_uploads']} | Today: {$stats['today_uploads']} | Pending: {$stats['pending']}\n";
    }
}

// =============================================
// 🔗 إرسال رسالة عبر Node.js bot
// =============================================

function sendBotMessage(string $groupId, string $message): void
{
    try {
        $url = NODE_BOT_URL . '/send-message';
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 5);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
            'number'  => $groupId,
            'message' => $message,
            'isGroup' => true,
        ]));
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_exec($ch);
        curl_close($ch);
    } catch (\Exception $e) {
        // تجاهل أخطاء الإرسال
    }
}
