<?php
/**
 * WhatsToot Bot - Dashboard (API Proxy)
 * 
 * وسيط للتواصل مع Node.js bot من لوحة التحكم
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../config/app.php';

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'bot-status':
        proxyGet(NODE_BOT_URL . '/status');
        break;

    case 'groups':
        proxyGet(NODE_BOT_URL . '/groups');
        break;

    case 'send-message':
        $input = json_decode(file_get_contents('php://input'), true);
        proxyPost(NODE_BOT_URL . '/send-message', $input);
        break;

    case 'logs':
        $logger = new \WhatsToot\Logger(LOGS_PATH);
        $date = $_GET['date'] ?? null;
        $content = $logger->readLogFile($date, 200);
        echo json_encode([
            'success' => true,
            'logs'    => $content,
            'date'    => $date ?? date('Y-m-d'),
        ], JSON_UNESCAPED_UNICODE);
        break;

    case 'test-drive':
        try {
            $db = \WhatsToot\Database::getInstance();
            $driveLogger = new \WhatsToot\Logger(LOGS_PATH, $db->getPdo());
            $drive = new \WhatsToot\DriveUploader($db, $driveLogger);
            $result = $drive->testConnection();
            echo json_encode($result, JSON_UNESCAPED_UNICODE);
        } catch (\Exception $e) {
            echo json_encode(['success' => false, 'error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
        }
        break;

    default:
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Unknown action'], JSON_UNESCAPED_UNICODE);
}

function proxyGet(string $url): void
{
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 5);
    $result = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($result && $code === 200) {
        echo $result;
    } else {
        echo json_encode(['success' => false, 'message' => 'Cannot reach Node.js bot', 'http_code' => $code], JSON_UNESCAPED_UNICODE);
    }
}

function proxyPost(string $url, ?array $data): void
{
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    $result = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($result) {
        echo $result;
    } else {
        echo json_encode(['success' => false, 'message' => 'Cannot reach Node.js bot'], JSON_UNESCAPED_UNICODE);
    }
}
