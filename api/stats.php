<?php
/**
 * WhatsToot Bot - Stats API
 * 
 * GET /whatstoot/api/stats.php
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../config/app.php';

use WhatsToot\Database;

try {
    $db = Database::getInstance();
    $stats = $db->getStats();

    // جلب آخر 20 عملية رفع
    $recentUploads = $db->getUploads(20);

    // جلب حالة Node.js bot
    $botStatus = ['connected' => false];
    try {
        $ch = curl_init(NODE_BOT_URL . '/status');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 3);
        $result = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode === 200 && $result) {
            $botStatus = json_decode($result, true) ?? ['connected' => false];
            $botStatus['connected'] = true;
        }
    } catch (\Exception $e) {
        // Bot is offline
    }

    echo json_encode([
        'success'        => true,
        'stats'          => $stats,
        'recent_uploads' => $recentUploads,
        'bot_status'     => $botStatus,
        'server_time'    => date('Y-m-d H:i:s'),
    ], JSON_UNESCAPED_UNICODE);

} catch (\Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
