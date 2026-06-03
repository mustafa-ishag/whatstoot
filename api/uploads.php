<?php
/**
 * WhatsToot Bot - Uploads API
 * 
 * GET /whatstoot/api/uploads.php?wo=123456789&status=completed&limit=50&offset=0
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../config/app.php';

use WhatsToot\Database;

try {
    $db = Database::getInstance();

    $woFilter = $_GET['wo'] ?? null;
    $status   = $_GET['status'] ?? null;
    $limit    = min((int) ($_GET['limit'] ?? 50), 200);
    $offset   = max((int) ($_GET['offset'] ?? 0), 0);

    $uploads = $db->getUploads($limit, $offset, $woFilter, $status);

    echo json_encode([
        'success' => true,
        'uploads' => $uploads,
        'count'   => count($uploads),
        'limit'   => $limit,
        'offset'  => $offset,
    ], JSON_UNESCAPED_UNICODE);

} catch (\Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
