<?php
/**
 * WhatsToot Bot - Application Configuration
 * 
 * يقرأ الإعدادات من ملف .env ويوفر ثوابت وقيم افتراضية
 */

// Load .env file
$envPath = dirname(__DIR__);
if (file_exists($envPath . '/.env')) {
    $dotenv = \Dotenv\Dotenv::createImmutable($envPath);
    $dotenv->load();
}

// =============================================
// Storage Engine (synology or gdrive)
// =============================================
define('STORAGE_ENGINE', $_ENV['STORAGE_ENGINE'] ?? 'synology');

// Synology NAS Settings
define('SYNOLOGY_URL', $_ENV['SYNOLOGY_URL'] ?? '');
define('SYNOLOGY_USER', $_ENV['SYNOLOGY_USER'] ?? '');
define('SYNOLOGY_PASS', $_ENV['SYNOLOGY_PASS'] ?? '');
define('SYNOLOGY_BASE_PATH', $_ENV['SYNOLOGY_BASE_PATH'] ?? '/photo/work_orders');

// Google Drive Settings (fallback)
define('GDRIVE_CREDENTIALS_PATH', $_ENV['GDRIVE_CREDENTIALS_PATH'] ?? 'credentials/google-service-account.json');
define('GDRIVE_ROOT_FOLDER_ID', $_ENV['GDRIVE_ROOT_FOLDER_ID'] ?? '');

// =============================================
// Node.js Bot Settings
// =============================================
define('NODE_BOT_URL', $_ENV['NODE_BOT_URL'] ?? 'http://localhost:3000');
define('NODE_BOT_API_KEY', $_ENV['NODE_BOT_API_KEY'] ?? 'whatstoot_bot_2026_secure_key');

// =============================================
// Work Order Settings
// =============================================
$digits = (int) ($_ENV['WORK_ORDER_DIGITS'] ?? 9);
define('WORK_ORDER_DIGITS', $digits);
define('WORK_ORDER_REGEX', '/(?<!\d)(\d{' . $digits . '})(?!\d)/');

// =============================================
// Timing Settings
// =============================================
define('AWAIT_TIMEOUT_SECONDS', (int) ($_ENV['AWAIT_TIMEOUT_SECONDS'] ?? 90));

// =============================================
// App Settings
// =============================================
define('APP_ENV', $_ENV['APP_ENV'] ?? 'production');
define('APP_URL', $_ENV['APP_URL'] ?? 'http://localhost');
define('APP_DEBUG', filter_var($_ENV['APP_DEBUG'] ?? 'false', FILTER_VALIDATE_BOOLEAN));
define('APP_TIMEZONE', $_ENV['APP_TIMEZONE'] ?? 'Asia/Riyadh');
define('AUTO_REPLY_ENABLED', filter_var($_ENV['AUTO_REPLY_ENABLED'] ?? 'true', FILTER_VALIDATE_BOOLEAN));

// =============================================
// Monitored Groups
// =============================================
$groups = $_ENV['MONITORED_GROUPS'] ?? 'all';
define('MONITORED_GROUPS', $groups === 'all' ? 'all' : array_map('trim', explode(',', $groups)));

// =============================================
// Paths
// =============================================
define('BASE_PATH', dirname(__DIR__));
define('STORAGE_PATH', BASE_PATH . '/storage');
define('TEMP_PATH', STORAGE_PATH . '/temp');
define('LOGS_PATH', STORAGE_PATH . '/logs');
define('DB_PATH', BASE_PATH . '/database/bot.sqlite');

// Set timezone
date_default_timezone_set(APP_TIMEZONE);
