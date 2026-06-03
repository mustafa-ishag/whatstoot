<?php
/**
 * WhatsToot Bot - Settings API
 * 
 * GET  /whatstoot/api/settings.php         — جلب كل الإعدادات
 * POST /whatstoot/api/settings.php         — تحديث إعداد
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../config/app.php';

use WhatsToot\Database;

try {
    $db = Database::getInstance();

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $settings = $db->getAllSettings();
        echo json_encode(['success' => true, 'settings' => $settings], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $input = json_decode(file_get_contents('php://input'), true);

        if (!$input || !isset($input['key']) || !isset($input['value'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'key and value required'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        // قائمة الإعدادات المسموحة
        $allowedKeys = ['bot_enabled', 'auto_reply', 'monitor_groups', 'await_timeout'];
        if (!in_array($input['key'], $allowedKeys)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid setting key'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $db->setSetting($input['key'], $input['value']);

        echo json_encode([
            'success' => true,
            'message' => "تم تحديث الإعداد: {$input['key']}",
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed'], JSON_UNESCAPED_UNICODE);

} catch (\Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
