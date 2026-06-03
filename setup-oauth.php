<?php
/**
 * WhatsToot Bot - Google OAuth 2.0 Setup
 * 
 * هذا السكريبت يُشغّل مرة واحدة فقط للحصول على refresh token
 * 
 * الخطوات:
 * 1. اذهب إلى Google Cloud Console → APIs & Services → Credentials
 * 2. أنشئ "OAuth 2.0 Client ID" من نوع "Web application"
 * 3. أضف Redirect URI: http://localhost/whatstoot/setup-oauth.php
 * 4. حمّل ملف JSON وضعه في: credentials/oauth-client.json
 * 5. افتح هذا الرابط في المتصفح: http://localhost/whatstoot/setup-oauth.php
 */

require_once __DIR__ . '/vendor/autoload.php';

session_start();

$credentialsPath = __DIR__ . '/credentials/oauth-client.json';
$tokenPath = __DIR__ . '/credentials/oauth-token.json';

// =============================================
// تصميم الصفحة
// =============================================
$css = '
<style>
    body { background: #0a0e1a; color: #f0f2f5; font-family: Tahoma, sans-serif; padding: 30px; max-width: 700px; margin: 0 auto; direction: rtl; }
    h1 { color: #25D366; font-size: 1.8rem; }
    h2 { color: #4285F4; font-size: 1.2rem; margin-top: 24px; }
    .box { background: #1a1f35; padding: 20px; border-radius: 12px; margin: 16px 0; border: 1px solid rgba(255,255,255,0.06); }
    .success { border-right: 4px solid #25D366; }
    .error { border-right: 4px solid #ef4444; }
    .warning { border-right: 4px solid #f59e0b; }
    .info { border-right: 4px solid #4285F4; }
    code { background: #111827; padding: 2px 8px; border-radius: 4px; font-size: 0.9em; direction: ltr; display: inline-block; }
    pre { background: #111827; padding: 14px; border-radius: 8px; overflow-x: auto; direction: ltr; text-align: left; font-size: 0.85em; line-height: 1.6; }
    a.btn { display: inline-block; padding: 12px 28px; background: linear-gradient(135deg, #25D366, #128C7E); color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 1rem; margin: 10px 0; transition: transform 0.2s; }
    a.btn:hover { transform: translateY(-2px); }
    .step { display: flex; gap: 12px; align-items: flex-start; margin: 12px 0; }
    .step-num { background: #4285F4; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.85rem; flex-shrink: 0; }
</style>';

echo "<!DOCTYPE html><html dir='rtl'><head><meta charset='utf-8'><title>WhatsToot - إعداد Google OAuth</title>{$css}</head><body>";
echo "<h1>🔑 WhatsToot — إعداد Google Drive OAuth 2.0</h1>";

// =============================================
// التحقق من ملف OAuth Client
// =============================================
if (!file_exists($credentialsPath)) {
    echo "<div class='box warning'>";
    echo "<h2>⚠️ ملف OAuth Client غير موجود</h2>";
    echo "<p>يجب إنشاء OAuth 2.0 Client ID أولاً:</p>";
    
    echo "<div class='step'><div class='step-num'>1</div><div>اذهب إلى <a href='https://console.cloud.google.com/apis/credentials' target='_blank' style='color:#4285F4'>Google Cloud Console → Credentials</a></div></div>";
    echo "<div class='step'><div class='step-num'>2</div><div>اضغط <strong>+ CREATE CREDENTIALS</strong> → <strong>OAuth client ID</strong></div></div>";
    echo "<div class='step'><div class='step-num'>3</div><div>Application type: <strong>Web application</strong></div></div>";
    echo "<div class='step'><div class='step-num'>4</div><div>أضف في Authorized redirect URIs:<br><code>http://localhost/whatstoot/setup-oauth.php</code></div></div>";
    echo "<div class='step'><div class='step-num'>5</div><div>اضغط <strong>DOWNLOAD JSON</strong> من الـ Client المنشأ</div></div>";
    echo "<div class='step'><div class='step-num'>6</div><div>سمّ الملف <code>oauth-client.json</code> وضعه في:<br><code>credentials/oauth-client.json</code></div></div>";
    echo "<div class='step'><div class='step-num'>7</div><div>ارجع وحدّث هذه الصفحة</div></div>";
    
    echo "</div>";
    echo "</body></html>";
    exit;
}

// =============================================
// إعداد Google Client
// =============================================
$client = new Google\Client();
$client->setAuthConfig($credentialsPath);
$client->addScope(Google\Service\Drive::DRIVE);
$client->setAccessType('offline');
$client->setPrompt('consent');
$client->setRedirectUri('http://localhost/whatstoot/setup-oauth.php');

// =============================================
// إذا كان Token موجود بالفعل
// =============================================
if (file_exists($tokenPath)) {
    $token = json_decode(file_get_contents($tokenPath), true);
    
    echo "<div class='box success'>";
    echo "<h2>✅ OAuth Token موجود ومحفوظ!</h2>";
    echo "<p>تم إعداد الاتصال بنجاح. البوت جاهز لرفع الصور إلى Google Drive.</p>";
    
    // اختبار الاتصال
    try {
        $client->setAccessToken($token);
        if ($client->isAccessTokenExpired()) {
            $newToken = $client->fetchAccessTokenWithRefreshToken($client->getRefreshToken());
            $newToken['refresh_token'] = $token['refresh_token']; // الحفاظ على refresh token
            file_put_contents($tokenPath, json_encode($newToken));
            $client->setAccessToken($newToken);
        }
        
        $drive = new Google\Service\Drive($client);
        $about = $drive->about->get(['fields' => 'user,storageQuota']);
        $user = $about->getUser();
        $quota = $about->getStorageQuota();
        
        echo "<p>📧 الحساب: <strong>{$user->getEmailAddress()}</strong></p>";
        if ($quota) {
            $usedGB = round(($quota->getUsage() ?? 0) / 1073741824, 2);
            $limitGB = round(($quota->getLimit() ?? 0) / 1073741824, 2);
            echo "<p>💾 المساحة: <strong>{$usedGB} GB</strong> من <strong>{$limitGB} GB</strong></p>";
        }
        echo "<p style='color:#25D366; font-weight:bold;'>✅ الاتصال يعمل بنجاح!</p>";
        
    } catch (Exception $e) {
        echo "<p style='color:#ef4444;'>❌ خطأ في الاتصال: " . htmlspecialchars($e->getMessage()) . "</p>";
        echo "<p><a href='?reset=1' class='btn' style='background:#ef4444;'>إعادة المصادقة</a></p>";
    }
    
    echo "</div>";
    
    // زر إعادة المصادقة
    if (isset($_GET['reset'])) {
        unlink($tokenPath);
        header('Location: setup-oauth.php');
        exit;
    }
    
    echo "<p><a href='?reset=1' style='color:#f59e0b; font-size:0.9rem;'>🔄 إعادة المصادقة</a></p>";
    echo "<div class='box info'><p>يمكنك الآن إغلاق هذه الصفحة وتشغيل البوت:<br><code>start-bot.bat</code></p></div>";
    echo "</body></html>";
    exit;
}

// =============================================
// معالجة Callback من Google
// =============================================
if (isset($_GET['code'])) {
    try {
        $token = $client->fetchAccessTokenWithAuthCode($_GET['code']);
        
        if (isset($token['error'])) {
            throw new Exception("OAuth Error: {$token['error']} - {$token['error_description']}");
        }
        
        // حفظ Token
        file_put_contents($tokenPath, json_encode($token));
        
        echo "<div class='box success'>";
        echo "<h2>✅ تمت المصادقة بنجاح!</h2>";
        echo "<p>تم حفظ Token في: <code>credentials/oauth-token.json</code></p>";
        echo "<p>البوت جاهز الآن لرفع الصور إلى Google Drive!</p>";
        echo "<p><a href='setup-oauth.php' class='btn'>✅ التحقق من الاتصال</a></p>";
        echo "</div>";
        
    } catch (Exception $e) {
        echo "<div class='box error'>";
        echo "<h2>❌ خطأ في المصادقة</h2>";
        echo "<p>" . htmlspecialchars($e->getMessage()) . "</p>";
        echo "<p><a href='setup-oauth.php' class='btn' style='background:#ef4444;'>حاول مرة أخرى</a></p>";
        echo "</div>";
    }
    
    echo "</body></html>";
    exit;
}

// =============================================
// عرض زر المصادقة
// =============================================
$authUrl = $client->createAuthUrl();

echo "<div class='box info'>";
echo "<h2>🔗 الخطوة الأخيرة — ربط حسابك</h2>";
echo "<p>اضغط الزر أدناه لتسجيل الدخول بحساب Google الخاص بك والسماح للبوت بالوصول إلى Google Drive:</p>";
echo "<a href='" . htmlspecialchars($authUrl) . "' class='btn'>🔑 تسجيل الدخول بحساب Google</a>";
echo "<p style='font-size:0.85rem; color:#9ca3af; margin-top:12px;'>سيتم حفظ بيانات الوصول محلياً ولن تُشارك مع أي جهة.</p>";
echo "</div>";

echo "</body></html>";
