<?php
/**
 * WhatsToot Bot - Process Image API
 * 
 * يستقبل رسائل من Node.js bot ويعالجها (صور ونصوص)
 * 
 * POST /whatstoot/api/process-image.php
 */

ini_set('display_errors', 0);
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST');
header('Access-Control-Allow-Headers: Content-Type, X-API-Key');

// Handle preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Only accept POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed'], JSON_UNESCAPED_UNICODE);
    exit;
}

// =============================================
// Bootstrap
// =============================================
require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../config/app.php';

use WhatsToot\Database;
use WhatsToot\WorkOrderExtractor;
use WhatsToot\UploaderFactory;
use WhatsToot\MessageContext;
use WhatsToot\DuplicateChecker;
use WhatsToot\Logger;

// =============================================
// API Key Check
// =============================================
$apiKey = $_SERVER['HTTP_X_API_KEY'] ?? '';
if ($apiKey !== NODE_BOT_API_KEY) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Invalid API key'], JSON_UNESCAPED_UNICODE);
    exit;
}

// =============================================
// Parse Request
// =============================================
$input = json_decode(file_get_contents('php://input'), true);

if (!$input) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid JSON'], JSON_UNESCAPED_UNICODE);
    exit;
}

$type      = $input['type'] ?? 'unknown';
$groupId   = $input['group_id'] ?? '';
$groupName = $input['group_name'] ?? '';
$sender    = $input['sender'] ?? '';
$timestamp = $input['timestamp'] ?? time();

// =============================================
// Initialize Services
// =============================================
try {
    $db        = Database::getInstance();
    $logger    = new Logger(LOGS_PATH, $db->getPdo());
    $extractor = new WorkOrderExtractor();
    $context   = new MessageContext($db, $extractor);
    $checker   = new DuplicateChecker($db);
    $drive     = UploaderFactory::create($db, $logger);

    $logger->info("Received {$type} message from {$sender} in {$groupName}");

} catch (\Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Server initialization error: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
    exit;
}

// =============================================
// Handle Text Message
// =============================================
if ($type === 'text') {
    $body = $input['body'] ?? '';
    $workOrder = $context->processTextMessage($body, $groupId, $sender);

    $response = ['success' => true, 'type' => 'text'];

    if ($workOrder) {
        $response['work_order'] = $workOrder;
        $response['message'] = "تم التعرف على رقم أمر العمل: {$workOrder}";

        // فحص الطابور — هل هناك صور تنتظر من نفس المرسل؟
        $processedIds = $context->processWaitingImages($groupId, $workOrder, $sender);
        if (!empty($processedIds)) {
            $response['queued_images_updated'] = count($processedIds);
            $logger->info("Linked {$workOrder} to " . count($processedIds) . " waiting images from {$sender}");
        }
    } else {
        $response['message'] = 'لم يتم العثور على رقم أمر عمل';
    }

    echo json_encode($response, JSON_UNESCAPED_UNICODE);
    exit;
}

// =============================================
// Handle Image Message
// =============================================
if ($type === 'image') {
    $imageBase64 = $input['image_base64'] ?? '';
    $mimetype    = $input['mimetype'] ?? 'image/jpeg';
    $caption     = $input['caption'] ?? '';

    if (empty($imageBase64)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No image data'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    try {
        // 1. فك base64 وحفظ مؤقت
        $imageData = base64_decode($imageBase64);
        if ($imageData === false) {
            throw new \RuntimeException('Invalid base64 data');
        }

        $ext = $drive->getExtensionFromMime($mimetype);
        $tempName = 'img_' . uniqid() . '.' . $ext;
        $tempPath = TEMP_PATH . '/' . $tempName;
        file_put_contents($tempPath, $imageData);

        $logger->info("Saved temp image: {$tempName} (" . strlen($imageData) . " bytes)");

        // 2. حساب hash وفحص التكرار
        $hash = $checker->hashFile($tempPath);

        // 3. تحديد رقم أمر العمل (من البوت مباشرة أو من الكابشن/السياق)
        $workOrder = $input['work_order'] ?? '';
        if (empty($workOrder)) {
            $workOrder = $context->resolveWorkOrder($caption, $groupId, $sender);
        } else {
            // إذا تم إرساله مباشرة من البوت، نحفظه في السياق لتحديث قاعدة البيانات
            if ($sender) {
                $db->saveContext($groupId, $workOrder, $sender, 300);
            }
        }

        if ($workOrder) {
            // معالجة أي صور معلّقة لهذا المرسل في الطابور إذا تم العثور على رقم أمر عمل
            $processedIds = $context->processWaitingImages($groupId, $workOrder, $sender);
            if (!empty($processedIds)) {
                $logger->info("Linked {$workOrder} to " . count($processedIds) . " waiting images from {$sender} via resolved work order");
            }
        }

        // فحص التكرار مع رقم أمر العمل
        if ($workOrder && $checker->isDuplicate($hash, $workOrder)) {
            unlink($tempPath);
            $db->logUpload([
                'work_order' => $workOrder,
                'file_name'  => $tempName,
                'file_hash'  => $hash,
                'group_id'   => $groupId,
                'group_name' => $groupName,
                'sender'     => $sender,
                'caption'    => $caption,
                'status'     => 'duplicate',
            ]);
            $logger->warning("Duplicate image skipped for WO {$workOrder}");

            echo json_encode([
                'success'    => true,
                'action'     => 'skipped',
                'reason'     => 'duplicate',
                'work_order' => $workOrder,
                'message'    => "⚠️ الصورة مكررة — تم تخطيها (أمر العمل: {$workOrder})",
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }

        // 4. إذا لم يوجد رقم أمر عمل → إضافة للطابور
        if (!$workOrder) {
            $queueId = $db->enqueue([
                'image_path' => $tempPath,
                'file_hash'  => $hash,
                'group_id'   => $groupId,
                'group_name' => $groupName,
                'sender'     => $sender,
                'caption'    => $caption,
            ]);

            $logger->info("Image queued (ID: {$queueId}), waiting for work order number...");

            echo json_encode([
                'success'  => true,
                'action'   => 'queued',
                'queue_id' => $queueId,
                'message'  => "⏳ تم استلام الصورة — بانتظار رقم أمر العمل...",
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }

        // 5. رفع إلى Google Drive
        $folderId = $drive->getOrCreateFolder($workOrder);
        $fileName = $drive->buildFileName($workOrder, $ext);
        $result   = $drive->upload($tempPath, $folderId, $fileName);

        // 6. تسجيل في قاعدة البيانات
        $uploadId = $db->logUpload([
            'work_order' => $workOrder,
            'file_name'  => $fileName,
            'file_hash'  => $hash,
            'drive_id'   => $result['id'],
            'drive_url'  => $result['url'],
            'group_id'   => $groupId,
            'group_name' => $groupName,
            'sender'     => $sender,
            'caption'    => $caption,
            'status'     => 'completed',
        ]);

        // 7. حذف الملف المؤقت
        unlink($tempPath);

        $logger->info("✅ Uploaded {$fileName} to Drive for WO {$workOrder}");

        echo json_encode([
            'success'    => true,
            'action'     => 'uploaded',
            'work_order' => $workOrder,
            'file_name'  => $fileName,
            'drive_id'   => $result['id'],
            'drive_url'  => $result['url'],
            'upload_id'  => $uploadId,
            'message'    => "✅ تم رفع الصورة بنجاح\n📁 أمر العمل: {$workOrder}\n📄 الملف: {$fileName}",
        ], JSON_UNESCAPED_UNICODE);

    } catch (\Exception $e) {
        $logger->error("Image processing error: " . $e->getMessage());

        // حفظ الصورة في UNSORTED عند الخطأ
        try {
            if (isset($tempPath) && file_exists($tempPath)) {
                $folderId = $drive->getOrCreateFolder('UNSORTED');
                $fileName = $drive->buildFileName('ERROR', $ext ?? 'jpg');
                $drive->upload($tempPath, $folderId, $fileName);
                unlink($tempPath);
            }
        } catch (\Exception $e2) {
            // تجاهل
        }

        http_response_code(500);
        echo json_encode([
            'success' => false,
            'message' => 'خطأ في معالجة الصورة: ' . $e->getMessage(),
        ], JSON_UNESCAPED_UNICODE);
    }

    exit;
}

// Unknown type
http_response_code(400);
echo json_encode(['success' => false, 'message' => "Unknown message type: {$type}"], JSON_UNESCAPED_UNICODE);
