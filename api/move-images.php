<?php
/**
 * WhatsToot Bot - Move Images Between Work Orders
 * 
 * ينقل آخر N صورة من أمر عمل إلى أمر عمل آخر
 * 
 * POST /whatstoot/api/move-images.php
 * Body: { "from_wo": "262040204", "to_wo": "123456789", "count": 1 }
 */

ini_set('display_errors', 0);
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-API-Key');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed'], JSON_UNESCAPED_UNICODE);
    exit;
}

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../config/app.php';

use WhatsToot\Database;
use WhatsToot\Logger;
use WhatsToot\SynologyUploader;

$input = json_decode(file_get_contents('php://input'), true);
$fromWO = $input['from_wo'] ?? null;
$toWO = $input['to_wo'] ?? null;
$count = max(1, min((int)($input['count'] ?? 1), 50)); // 1-50 صورة

if (empty($fromWO) || empty($toWO)) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => 'from_wo و to_wo مطلوبان',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $db = Database::getInstance();
    $logger = new Logger(LOGS_PATH, $db->getPdo());
    $pdo = $db->getPdo();
    $synology = new SynologyUploader($db, $logger);

    // 1. جلب آخر N صورة من أمر العمل المصدر
    $stmt = $pdo->prepare('
        SELECT id, file_name, file_hash, drive_id 
        FROM uploads 
        WHERE work_order = ? AND status = "completed" 
        ORDER BY id DESC 
        LIMIT ?
    ');
    $stmt->execute([$fromWO, $count]);
    $images = $stmt->fetchAll(\PDO::FETCH_ASSOC);

    if (empty($images)) {
        echo json_encode([
            'success' => false,
            'message' => "لا توجد صور في أمر العمل {$fromWO}",
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 2. تأكد من وجود مجلد أمر العمل الجديد
    $newFolder = $synology->getOrCreateFolder($toWO);
    $oldFolder = $synology->getOrCreateFolder($fromWO);

    // 3. نقل كل صورة
    $moved = 0;
    $movedFiles = [];
    
    foreach ($images as $img) {
        // تحديث سجل قاعدة البيانات
        $stmt = $pdo->prepare('UPDATE uploads SET work_order = ? WHERE id = ?');
        $stmt->execute([$toWO, $img['id']]);
        
        // محاولة نقل الملف على Synology (اختياري - إذا فشل نكمل)
        try {
            // نقل الملف من المجلد القديم للجديد عبر Synology API
            $synology->moveFile(
                $oldFolder . '/' . $img['file_name'],
                $newFolder
            );
        } catch (\Exception $e) {
            $logger->warning("Could not move file {$img['file_name']} on NAS: " . $e->getMessage());
            // لا نوقف العملية - السجل تم تحديثه
        }
        
        $moved++;
        $movedFiles[] = $img['file_name'];
    }

    $logger->info("Moved {$moved} images from WO {$fromWO} to WO {$toWO}");

    echo json_encode([
        'success' => true,
        'moved' => $moved,
        'from_wo' => $fromWO,
        'to_wo' => $toWO,
        'files' => $movedFiles,
        'message' => "تم نقل {$moved} صورة من أمر العمل {$fromWO} إلى {$toWO}",
    ], JSON_UNESCAPED_UNICODE);

} catch (\Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
