<?php
/**
 * WhatsToot Bot - Synology NAS Connection Tester
 * 
 * التشغيل: php test-synology.php
 * أو عبر المتصفح: http://localhost/whatstoot/test-synology.php
 */

header('Content-Type: text/html; charset=utf-8');

$isCli = php_sapi_name() === 'cli';

function output(string $msg, string $type = 'info'): void
{
    global $isCli;
    if ($isCli) {
        $icons = ['info' => 'ℹ️', 'success' => '✅', 'warning' => '⚠️', 'error' => '❌', 'step' => '📌'];
        // Remove HTML tags if any for CLI
        $cleanMsg = strip_tags($msg);
        echo ($icons[$type] ?? '') . " {$cleanMsg}\n";
    } else {
        $colors = [
            'info' => '#3498db', 
            'success' => '#2acc7d', 
            'warning' => '#f1c40f', 
            'error' => '#e74c3c', 
            'step' => '#9b59b6'
        ];
        $bgColor = [
            'info' => 'rgba(52, 152, 219, 0.1)', 
            'success' => 'rgba(42, 204, 125, 0.1)', 
            'warning' => 'rgba(241, 196, 15, 0.1)', 
            'error' => 'rgba(231, 76, 60, 0.1)', 
            'step' => 'rgba(155, 89, 182, 0.1)'
        ];
        echo "<div style='padding:12px 18px; margin:8px 0; color:{$colors[$type]}; background:{$bgColor[$type]}; border-right:4px solid {$colors[$type]}; font-family:system-ui, -apple-system, sans-serif; border-radius: 4px; line-height: 1.6;'>{$msg}</div>";
    }
}

if (!$isCli) {
    echo '<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>WhatsToot - فحص اتصال Synology NAS</title>';
    echo '<style>
        body { background:#0f172a; color:#f1f5f9; font-family: system-ui, -apple-system, sans-serif; padding:40px 20px; max-width:800px; margin:0 auto; }
        h1 { color:#2acc7d; font-weight: 700; font-size: 2rem; margin-bottom: 20px; }
        .box { background:#1e293b; padding:30px; border-radius:12px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); border: 1px solid #334155; }
        .card { background:#0f172a; border-radius:8px; padding:15px; margin:15px 0; border-left: 4px solid #3b82f6; }
        .card-title { font-weight:bold; margin-bottom: 5px; color: #3b82f6; }
        .card-value { font-family: monospace; word-break: break-all; }
        hr { border: 0; border-top: 1px solid #334155; margin: 25px 0; }
        .btn { background: #2acc7d; color: #0f172a; border: 0; padding: 10px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; text-decoration: none; display: inline-block; }
        .btn:hover { background: #22c55e; }
    </style>';
    echo '</head><body><h1>🖥️ WhatsToot — فحص اتصال Synology NAS</h1><div class="box">';
}

output('بدء فحص الاتصال بـ Synology NAS...', 'step');

// Load autoload and config
$basePath = __DIR__;
if (!file_exists($basePath . '/vendor/autoload.php')) {
    output('مجلد vendor غير موجود! يرجى تشغيل command: <code style="background:#0f172a; padding: 2px 5px; border-radius: 4px; color:#e74c3c;">composer install</code> أولاً.', 'error');
    if (!$isCli) echo '</div></body></html>';
    exit;
}

require_once $basePath . '/vendor/autoload.php';
require_once $basePath . '/config/app.php';

use WhatsToot\Database;
use WhatsToot\Logger;
use WhatsToot\SynologyUploader;

// Check placeholder settings
$url = defined('SYNOLOGY_URL') ? SYNOLOGY_URL : '';
$user = defined('SYNOLOGY_USER') ? SYNOLOGY_USER : '';
$pass = defined('SYNOLOGY_PASS') ? SYNOLOGY_PASS : '';
$basePathFolder = defined('SYNOLOGY_BASE_PATH') ? SYNOLOGY_BASE_PATH : '';

if (!$isCli) {
    echo '<div style="margin: 15px 0;">';
    echo '<div class="card"><div class="card-title">رابط الاتصال (QuickConnect)</div><div class="card-value">' . htmlspecialchars($url) . '</div></div>';
    echo '<div class="card"><div class="card-title">اسم المستخدم</div><div class="card-value">' . htmlspecialchars($user) . '</div></div>';
    echo '<div class="card"><div class="card-title">المسار المطلوب على NAS</div><div class="card-value">' . htmlspecialchars($basePathFolder) . '</div></div>';
    echo '</div>';
} else {
    output("بيانات الاتصال الحالية:", "info");
    output("- رابط الاتصال: {$url}", "info");
    output("- اسم المستخدم: {$user}", "info");
    output("- مسار التخزين: {$basePathFolder}", "info");
}

if ($user === 'YOUR_USERNAME' || $pass === 'YOUR_PASSWORD' || empty($user) || empty($pass)) {
    output('⚠️ <strong>انتباه:</strong> لم تقم بتحديث اسم المستخدم أو كلمة المرور في ملف <code style="background:#0f172a; padding: 2px 5px; border-radius: 4px; color:#f1c40f;">.env</code> بعد!', 'warning');
    output('الرجاء فتح ملف <code style="background:#0f172a; padding: 2px 5px; border-radius: 4px; color:#fff;">.env</code> وتعديل البيانات التالية:<br>
    <code>SYNOLOGY_USER=<strong>اسم_المستخدم_الحقيقي</strong></code><br>
    <code>SYNOLOGY_PASS=<strong>كلمة_المرور_الحقيقية</strong></code>', 'info');
    if (!$isCli) echo '</div></body></html>';
    exit;
}

try {
    output('جاري محاولة الاتصال وتسجيل الدخول إلى NAS...', 'info');
    
    $db = Database::getInstance();
    $logger = new Logger(null, $db->getPdo());
    
    $uploader = new SynologyUploader($db, $logger);
    
    // Test Connection
    $result = $uploader->testConnection();
    
    if ($result['success']) {
        output('🎉 <strong>تم الاتصال بنجاح!</strong>', 'success');
        output("استجاب الـ NAS بنجاح وتم التحقق من وجود مسار المجلد الأساسي:<br><code>{$result['base_path']}</code>", 'success');
        
        output('<strong>كل شيء جاهز للعمل!</strong> يمكنك الآن تشغيل البوت عبر <code>start-bot.bat</code> وسيتم رفع الصور مباشرة إلى هذا المجلد.', 'success');
    } else {
        output('❌ <strong>فشل الاتصال بالـ NAS!</strong>', 'error');
        output('سبب الخطأ: ' . htmlspecialchars($result['error']), 'error');
        
        if (strpos($result['error'], '407') !== false) {
            output('⚠️ <strong>السبب الرئيسي: حظر عنوان الـ IP الخاص بك (Blocked IP)!</strong>', 'warning');
            output('استجاب الـ NAS بالرمز <code>407</code>، وهو ما يعني في أنظمة Synology أن <strong>عنوان الـ IP الخاص بجهازك قد تم حظره تلقائياً</strong> بواسطة جدار الحماية/نظام الحظر التلقائي (Auto Block) الخاص بالـ NAS. يحدث هذا عادةً لحماية الـ NAS بعد إرسال محاولات دخول خاطئة متعددة متتالية (مثل المحاولات ببيانات <code>YOUR_USERNAME</code> الافتراضية السابقة).<br><br>
            💡 <strong>طريقة فك الحظر والحل بسهولة:</strong><br>
            1. افتح متصفحك وسجل الدخول إلى واجهة Synology DSM يدوياً (كأدمن).<br>
            2. انتقل إلى <strong>لوحة التحكم (Control Panel) > الأمان (Security) > الحماية (Protection)</strong>.<br>
            3. في قسم <strong>الحظر التلقائي (Auto Block)</strong>، اضغط على زر <strong>قائمة السماح/الحظر (Allow/Block List)</strong>.<br>
            4. افتح تبويب <strong>قائمة الحظر (Block List)</strong>، وابحث عن عنوان الـ IP الخاص بجهازك وقم <strong>بإزالته (Remove)</strong>.<br>
            5. لمنع حدوث الحظر مجدداً أثناء التطوير، يمكنك الانتقال لتبويب <strong>قائمة السماح (Allow List)</strong> وإضافة الـ IP الخاص بجهازك هناك ليتم استثناؤه دائماً.<br>
            6. بمجرد إزالة الحظر، قم بإعادة فحص الاتصال هنا وسيعمل بنجاح تام! 🎉', 'info');
        } else {
            output('💡 <strong>نصائح للمساعدة في حل المشكلة:</strong><br>
            1. <strong>اسم المستخدم وكلمة المرور:</strong> تأكد تماماً منهما، وجرب الدخول بهما يدوياً لـ Synology DSM.<br>
            2. <strong>صلاحيات المستخدم:</strong> تأكد من أن المستخدم لديه صلاحيات القراءة والكتابة (Read/Write) على المجلد المشترك المعين.<br>
            3. <strong>تفعيل File Station:</strong> تأكد أن خدمة "File Station" مفعلة للمستخدم في لوحة تحكم Synology.<br>
            4. <strong>رابط QuickConnect:</strong> تأكد من كتابة الرابط بشكل كامل وصحيح: <code>https://toot-sa.sg4.quickconnect.to</code>', 'info');
        }
    }
    
} catch (\Exception $e) {
    output('حدث خطأ غير متوقع أثناء الفحص: ' . htmlspecialchars($e->getMessage()), 'error');
}

if (!$isCli) {
    echo '<hr>';
    echo '<div style="text-align: center;"><a href="public/" class="btn">الذهاب إلى لوحة التحكم 📊</a></div>';
    echo '</div></body></html>';
}
