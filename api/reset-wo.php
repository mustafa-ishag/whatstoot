<?php
/**
 * WhatsToot Bot - Reset Work Order API
 * 
 * يمسح سجلات أمر عمل من قاعدة البيانات لإعادة رفع الصور
 * 
 * POST /whatstoot/api/reset-wo.php
 * Body: { "work_order": "262040204" }
 * 
 * أو عبر GET للسهولة:
 * GET /whatstoot/api/reset-wo.php?wo=262040204
 */

ini_set('display_errors', 0);
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-API-Key');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../config/app.php';

use WhatsToot\Database;
use WhatsToot\Logger;

// =============================================
// تحديد رقم أمر العمل
// =============================================
$workOrder = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    $workOrder = $input['work_order'] ?? null;
} else {
    $workOrder = $_GET['wo'] ?? null;
}

if (empty($workOrder) || !preg_match('/^\d{' . WORK_ORDER_DIGITS . '}$/', $workOrder)) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => 'رقم أمر العمل مطلوب (يجب أن يكون ' . WORK_ORDER_DIGITS . ' أرقام)',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// =============================================
// تنفيذ الحذف
// =============================================
try {
    $db = Database::getInstance();
    $logger = new Logger(LOGS_PATH, $db->getPdo());
    $pdo = $db->getPdo();

    // 1. عدد السجلات قبل الحذف
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM uploads WHERE work_order = ?');
    $stmt->execute([$workOrder]);
    $uploadCount = $stmt->fetchColumn();

    // 2. حذف سجلات الرفع
    $stmt = $pdo->prepare('DELETE FROM uploads WHERE work_order = ?');
    $stmt->execute([$workOrder]);
    $deletedUploads = $stmt->rowCount();

    // 3. حذف كاش المجلد
    $stmt = $pdo->prepare('DELETE FROM folders WHERE work_order = ?');
    $stmt->execute([$workOrder]);
    $deletedFolders = $stmt->rowCount();

    // 4. حذف عناصر الطابور
    $stmt = $pdo->prepare('DELETE FROM queue WHERE work_order = ?');
    $stmt->execute([$workOrder]);
    $deletedQueue = $stmt->rowCount();

    $logger->info("Reset WO {$workOrder}: deleted {$deletedUploads} uploads, {$deletedFolders} folder cache, {$deletedQueue} queue items");

    echo json_encode([
        'success' => true,
        'work_order' => $workOrder,
        'deleted_uploads' => $deletedUploads,
        'deleted_folders' => $deletedFolders,
        'deleted_queue' => $deletedQueue,
        'message' => "تم مسح {$deletedUploads} سجل لأمر العمل {$workOrder}. يمكنك إعادة رفع الصور الآن.",
    ], JSON_UNESCAPED_UNICODE);

} catch (\Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
