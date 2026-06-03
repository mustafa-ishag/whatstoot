<?php
/**
 * WhatsToot Bot - Installation Script
 * 
 * التشغيل: php install.php
 * أو عبر المتصفح: http://localhost/whatstoot/install.php
 */

$isCli = php_sapi_name() === 'cli';

function output(string $msg, string $type = 'info'): void
{
    global $isCli;
    if ($isCli) {
        $icons = ['info' => 'ℹ️', 'success' => '✅', 'warning' => '⚠️', 'error' => '❌', 'step' => '📌'];
        echo ($icons[$type] ?? '') . " {$msg}\n";
    } else {
        $colors = ['info' => '#3498db', 'success' => '#27ae60', 'warning' => '#f39c12', 'error' => '#e74c3c', 'step' => '#2c3e50'];
        echo "<div style='padding:5px 10px; margin:3px 0; color:{$colors[$type]};font-family:monospace;'>{$msg}</div>";
    }
}

if (!$isCli) {
    echo '<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>WhatsToot - التثبيت</title>';
    echo '<style>body{background:#1a1a2e;color:#eee;font-family:Tahoma,sans-serif;padding:20px;max-width:800px;margin:0 auto;}';
    echo 'h1{color:#25D366;} .box{background:#16213e;padding:20px;border-radius:10px;margin:10px 0;}</style>';
    echo '</head><body><h1>🤖 WhatsToot Bot — التثبيت</h1><div class="box">';
}

output('WhatsToot Bot - بدء التثبيت', 'step');
output('');

$basePath = __DIR__;
$errors = [];

// =============================================
// 1. فحص PHP Extensions
// =============================================
output('1. فحص متطلبات PHP...', 'step');

$requiredExtensions = ['pdo_sqlite', 'curl', 'json', 'mbstring', 'fileinfo'];
foreach ($requiredExtensions as $ext) {
    if (extension_loaded($ext)) {
        output("  ✓ {$ext} متوفر", 'success');
    } else {
        output("  ✗ {$ext} غير متوفر — يجب تفعيله في php.ini", 'error');
        $errors[] = "Missing PHP extension: {$ext}";
    }
}

$phpVersion = PHP_VERSION;
if (version_compare($phpVersion, '8.1', '>=')) {
    output("  ✓ PHP {$phpVersion}", 'success');
} else {
    output("  ✗ PHP {$phpVersion} — يجب 8.1 أو أعلى", 'error');
    $errors[] = "PHP version too old: {$phpVersion}";
}

// =============================================
// 2. إنشاء المجلدات
// =============================================
output('');
output('2. إنشاء المجلدات...', 'step');

$dirs = [
    $basePath . '/storage/temp',
    $basePath . '/storage/logs',
    $basePath . '/database',
    $basePath . '/credentials',
];

foreach ($dirs as $dir) {
    if (!is_dir($dir)) {
        if (mkdir($dir, 0755, true)) {
            output("  ✓ تم إنشاء: " . basename(dirname($dir)) . '/' . basename($dir), 'success');
        } else {
            output("  ✗ فشل إنشاء: {$dir}", 'error');
            $errors[] = "Cannot create directory: {$dir}";
        }
    } else {
        output("  ✓ موجود: " . basename(dirname($dir)) . '/' . basename($dir), 'info');
    }
}

// =============================================
// 3. إنشاء قاعدة البيانات
// =============================================
output('');
output('3. إعداد قاعدة البيانات SQLite...', 'step');

$dbPath = $basePath . '/database/bot.sqlite';
$schemaPath = $basePath . '/database/schema.sql';

try {
    $pdo = new PDO("sqlite:{$dbPath}");
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA journal_mode=WAL');

    if (file_exists($schemaPath)) {
        $schema = file_get_contents($schemaPath);
        $pdo->exec($schema);
        output('  ✓ تم تطبيق schema بنجاح', 'success');
    } else {
        output('  ✗ ملف schema.sql غير موجود', 'error');
        $errors[] = "schema.sql not found";
    }

    // التحقق من الجداول
    $tables = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
    output('  ✓ الجداول: ' . implode(', ', $tables), 'info');

} catch (PDOException $e) {
    output('  ✗ خطأ في قاعدة البيانات: ' . $e->getMessage(), 'error');
    $errors[] = "Database error: " . $e->getMessage();
}

// =============================================
// 4. إنشاء ملف .env
// =============================================
output('');
output('4. إعداد ملف البيئة .env...', 'step');

$envPath = $basePath . '/.env';
$envExamplePath = $basePath . '/.env.example';

if (!file_exists($envPath)) {
    if (file_exists($envExamplePath)) {
        copy($envExamplePath, $envPath);
        output('  ✓ تم إنشاء .env من .env.example', 'success');
        output('  ⚠ يجب تعديل .env بإعداداتك الخاصة', 'warning');
    } else {
        output('  ✗ ملف .env.example غير موجود', 'error');
    }
} else {
    output('  ✓ ملف .env موجود', 'info');
}

// =============================================
// 5. فحص Google Credentials
// =============================================
output('');
output('5. فحص بيانات Google Drive...', 'step');

$credPath = $basePath . '/credentials/google-service-account.json';
if (file_exists($credPath)) {
    $creds = json_decode(file_get_contents($credPath), true);
    if ($creds && isset($creds['client_email'])) {
        output("  ✓ Service Account: {$creds['client_email']}", 'success');
    } else {
        output('  ✗ ملف credentials غير صالح', 'error');
        $errors[] = "Invalid Google credentials file";
    }
} else {
    output('  ⚠ ملف google-service-account.json غير موجود', 'warning');
    output('    → ضع الملف في: credentials/google-service-account.json', 'info');
    output('    → أنشئه من: https://console.cloud.google.com/', 'info');
}

// =============================================
// 6. فحص Composer
// =============================================
output('');
output('6. فحص تبعيات Composer...', 'step');

if (is_dir($basePath . '/vendor')) {
    output('  ✓ مجلد vendor موجود', 'success');
    if (file_exists($basePath . '/vendor/autoload.php')) {
        output('  ✓ autoload.php موجود', 'success');
    }
} else {
    output('  ⚠ يجب تشغيل: composer install', 'warning');
    $errors[] = "Run 'composer install' first";
}

// =============================================
// 7. فحص Node.js
// =============================================
output('');
output('7. فحص Node.js bot...', 'step');

$nodeModules = $basePath . '/node-bot/node_modules';
if (is_dir($nodeModules)) {
    output('  ✓ node_modules موجود', 'success');
} else {
    output('  ⚠ يجب تشغيل: cd node-bot && npm install', 'warning');
    $errors[] = "Run 'cd node-bot && npm install' first";
}

// =============================================
// النتيجة النهائية
// =============================================
output('');
output('═══════════════════════════════════════', 'info');

if (empty($errors)) {
    output('✅ التثبيت مكتمل بنجاح!', 'success');
    output('');
    output('الخطوات التالية:', 'step');
    output('1. عدّل ملف .env بإعداداتك', 'info');
    output('2. ضع ملف google-service-account.json في credentials/', 'info');

    if (PHP_OS_FAMILY === 'Windows') {
        output('3. شغّل start-bot.bat لتشغيل البوت', 'info');
        output('4. افتح http://localhost/whatstoot/public/ للوحة التحكم', 'info');
    } else {
        output('3. شغّل: bash start-bot.sh (تشغيل يدوي)', 'info');
        output('   أو استخدم systemd: sudo bash deploy/deploy.sh', 'info');
        output('4. راجع DEPLOY.md لدليل النشر الكامل', 'info');
    }
} else {
    output('⚠ التثبيت يحتاج إصلاح ' . count($errors) . ' مشاكل:', 'warning');
    foreach ($errors as $i => $err) {
        output('  ' . ($i + 1) . '. ' . $err, 'error');
    }
}

if (!$isCli) {
    echo '</div></body></html>';
}
