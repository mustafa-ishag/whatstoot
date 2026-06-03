<?php

namespace WhatsToot;

/**
 * SynologyUploader - رفع الملفات إلى Synology NAS
 * 
 * يستخدم File Station API (REST) للمصادقة وإنشاء المجلدات ورفع الصور
 */
class SynologyUploader
{
    private Database $db;
    private Logger $logger;
    private string $baseUrl;
    private string $basePath;
    private ?string $sid = null;
    private bool $initialized = false;
    private int $loginAttempts = 0;
    private const MAX_LOGIN_RETRIES = 2;

    public function __construct(Database $db, Logger $logger)
    {
        $this->db = $db;
        $this->logger = $logger;
        $this->baseUrl = rtrim(defined('SYNOLOGY_URL') ? SYNOLOGY_URL : '', '/');
        $this->basePath = defined('SYNOLOGY_BASE_PATH') ? SYNOLOGY_BASE_PATH : '/photo/work_orders';
    }

    /**
     * تهيئة الاتصال وتسجيل الدخول
     */
    public function init(): void
    {
        if ($this->initialized) {
            return;
        }

        if (empty($this->baseUrl)) {
            throw new \RuntimeException(
                "Synology URL not configured. Set SYNOLOGY_URL in .env"
            );
        }

        $this->login();
        $this->initialized = true;
    }

    /**
     * تسجيل الدخول والحصول على Session ID
     */
    private function login(): void
    {
        $account = defined('SYNOLOGY_USER') ? SYNOLOGY_USER : '';
        $password = defined('SYNOLOGY_PASS') ? SYNOLOGY_PASS : '';

        if (empty($account) || empty($password)) {
            throw new \RuntimeException('Synology credentials not configured in .env');
        }

        $response = $this->apiRequest('/webapi/entry.cgi', [
            'api'     => 'SYNO.API.Auth',
            'version' => 7,
            'method'  => 'login',
            'account' => $account,
            'passwd'  => $password,
            'session' => 'FileStation',
            'format'  => 'sid',
        ]);

        if (!$response['success']) {
            $code = $response['error']['code'] ?? 'unknown';
            throw new \RuntimeException("Synology login failed (error code: {$code})");
        }

        $this->sid = $response['data']['sid'];
        $this->loginAttempts = 0;
        $this->logger->info('Synology FileStation connected');
    }

    /**
     * تسجيل الخروج
     */
    public function logout(): void
    {
        if ($this->sid) {
            $this->apiRequest('/webapi/entry.cgi', [
                'api'     => 'SYNO.API.Auth',
                'version' => 7,
                'method'  => 'logout',
                'session' => 'FileStation',
                '_sid'    => $this->sid,
            ]);
            $this->sid = null;
            $this->initialized = false;
        }
    }

    /**
     * إعادة تسجيل الدخول عند انتهاء الجلسة (خطأ 119)
     */
    private function reLogin(): void
    {
        $this->loginAttempts++;
        if ($this->loginAttempts > self::MAX_LOGIN_RETRIES) {
            throw new \RuntimeException('Synology re-login failed: max retries exceeded');
        }
        $this->logger->warning('Synology SID expired, re-authenticating... (attempt ' . $this->loginAttempts . ')');
        $this->sid = null;
        $this->initialized = false;
        sleep(2); // انتظار ثانيتين قبل إعادة المحاولة
        $this->login();
        $this->initialized = true;
    }

    /**
     * الحصول على أو إنشاء مجلد لرقم أمر عمل
     * 
     * @return string المسار الكامل للمجلد
     */
    public function getOrCreateFolder(string $workOrder): string
    {
        $this->ensureInitialized();

        $folderPath = $this->basePath . '/' . $workOrder;

        // 1. البحث في قاعدة البيانات أولاً — الثقة بالكاش لتجنب API calls زائدة
        $cachedPath = $this->db->getFolder($workOrder);
        if ($cachedPath) {
            return $cachedPath;
        }

        // 2. محاولة إنشاء المجلد (force_parent=true يضمن إنشاءه حتى لو موجود)
        try {
            $this->createFolder($workOrder);
        } catch (\RuntimeException $e) {
            // إذا كان خطأ 119 (جلسة منتهية) → إعادة تسجيل الدخول والمحاولة
            if (strpos($e->getMessage(), '119') !== false) {
                $this->reLogin();
                $this->createFolder($workOrder);
            } else {
                throw $e;
            }
        }

        $this->db->saveFolder($workOrder, $folderPath);
        $this->logger->info("Folder ready for WO {$workOrder}: {$folderPath}");

        return $folderPath;
    }

    /**
     * رفع ملف إلى مجلد محدد
     * 
     * @return array ['id' => path, 'url' => webUrl]
     */
    public function upload(string $localPath, string $folderPath, string $fileName): array
    {
        $this->ensureInitialized();

        if (!file_exists($localPath)) {
            throw new \RuntimeException("File not found: {$localPath}");
        }

        $response = $this->uploadFile($localPath, $folderPath, $fileName);

        if (!$response['success']) {
            $code = $response['error']['code'] ?? 'unknown';

            // خطأ 119 = جلسة منتهية → إعادة تسجيل الدخول والمحاولة
            if ($code == 119) {
                $this->reLogin();
                $response = $this->uploadFile($localPath, $folderPath, $fileName);
                if (!$response['success']) {
                    $code = $response['error']['code'] ?? 'unknown';
                    throw new \RuntimeException("Synology upload failed after re-login (error code: {$code})");
                }
            } else {
                throw new \RuntimeException("Synology upload failed (error code: {$code})");
            }
        }

        $filePath = $folderPath . '/' . $fileName;

        // بناء رابط مباشر للملف
        $url = $this->baseUrl . '/d/f/' . urlencode($filePath);

        $this->logger->info("Uploaded {$fileName} to Synology", [
            'path'   => $filePath,
            'folder' => $folderPath,
            'size'   => filesize($localPath),
        ]);

        return [
            'id'  => $filePath,
            'url' => $url,
        ];
    }

    /**
     * نقل ملف من مجلد لآخر على NAS
     */
    public function moveFile(string $sourcePath, string $destFolder): void
    {
        $this->ensureInitialized();

        $response = $this->apiRequest('/webapi/entry.cgi', [
            'api'         => 'SYNO.FileStation.CopyMove',
            'version'     => 3,
            'method'      => 'start',
            'path'        => json_encode([$sourcePath]),
            'dest_folder_path' => $destFolder,
            'overwrite'   => 'false',
            'remove_src'  => 'true',
            '_sid'        => $this->sid,
        ]);

        if (!$response['success']) {
            $code = $response['error']['code'] ?? 'unknown';
            
            // خطأ 119 = جلسة منتهية → إعادة تسجيل الدخول والمحاولة
            if ($code == 119) {
                $this->reLogin();
                $response = $this->apiRequest('/webapi/entry.cgi', [
                    'api'         => 'SYNO.FileStation.CopyMove',
                    'version'     => 3,
                    'method'      => 'start',
                    'path'        => json_encode([$sourcePath]),
                    'dest_folder_path' => $destFolder,
                    'overwrite'   => 'false',
                    'remove_src'  => 'true',
                    '_sid'        => $this->sid,
                ]);
                if (!$response['success']) {
                    $code = $response['error']['code'] ?? 'unknown';
                    throw new \RuntimeException("Failed to move file after re-login (error: {$code})");
                }
            } else {
                throw new \RuntimeException("Failed to move file (error: {$code})");
            }
        }

        $this->logger->info("Moved file: {$sourcePath} → {$destFolder}");
    }

    /**
     * بناء اسم ملف منظّم
     */
    public function buildFileName(string $workOrder, string $extension): string
    {
        // دقة الميلي ثانية + رمز عشوائي لضمان عدم تكرار الاسم أبداً
        $timestamp = date('Ymd_His');
        $ms = sprintf('%03d', (int)(microtime(true) * 1000) % 1000);
        $rand = substr(bin2hex(random_bytes(2)), 0, 4);
        $ext = ltrim(strtolower($extension), '.');
        return "WO{$workOrder}_{$timestamp}_{$ms}_{$rand}.{$ext}";
    }

    /**
     * تحديد امتداد الملف من MIME type
     */
    public function getExtensionFromMime(string $mimeType): string
    {
        $map = [
            'image/jpeg'    => 'jpg',
            'image/png'     => 'png',
            'image/gif'     => 'gif',
            'image/webp'    => 'webp',
            'image/bmp'     => 'bmp',
            'image/svg+xml' => 'svg',
            'image/tiff'    => 'tiff',
            'video/mp4'     => 'mp4',
            'video/3gpp'    => '3gp',
        ];

        return $map[$mimeType] ?? 'jpg';
    }

    /**
     * اختبار الاتصال
     */
    public function testConnection(): array
    {
        try {
            $this->ensureInitialized();

            // فحص المجلد الجذري
            $response = $this->apiRequest('/webapi/entry.cgi', [
                'api'     => 'SYNO.FileStation.List',
                'version' => 2,
                'method'  => 'list',
                'folder_path' => dirname($this->basePath),
                '_sid'    => $this->sid,
            ]);

            return [
                'success'    => true,
                'nas_url'    => $this->baseUrl,
                'base_path'  => $this->basePath,
                'message'    => 'Connected to Synology NAS',
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error'   => $e->getMessage(),
            ];
        }
    }

    // =============================================
    // Private Methods
    // =============================================

    /**
     * التحقق من وجود مجلد
     */
    private function folderExists(string $path): bool
    {
        $response = $this->apiRequest('/webapi/entry.cgi', [
            'api'         => 'SYNO.FileStation.List',
            'version'     => 2,
            'method'      => 'getinfo',
            'path'        => json_encode([$path]),
            '_sid'        => $this->sid,
        ]);

        return $response['success'] && !empty($response['data']['files']);
    }

    /**
     * إنشاء مجلد جديد
     */
    private function createFolder(string $name): void
    {
        $response = $this->apiRequest('/webapi/entry.cgi', [
            'api'         => 'SYNO.FileStation.CreateFolder',
            'version'     => 2,
            'method'      => 'create',
            'folder_path' => json_encode([$this->basePath]),
            'name'        => json_encode([$name]),
            'force_parent' => 'true',
            '_sid'        => $this->sid,
        ]);

        if (!$response['success']) {
            $code = $response['error']['code'] ?? 'unknown';
            throw new \RuntimeException("Failed to create folder {$name} (error: {$code})");
        }
    }

    /**
     * رفع ملف عبر multipart/form-data
     */
    private function uploadFile(string $localPath, string $destPath, string $fileName): array
    {
        // Pass _sid as URL parameter for QuickConnect compatibility
        $url = $this->baseUrl . '/webapi/entry.cgi?_sid=' . urlencode($this->sid);

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 120,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => false,
            CURLOPT_POSTFIELDS     => [
                'api'            => 'SYNO.FileStation.Upload',
                'version'        => 2,
                'method'         => 'upload',
                'path'           => $destPath,
                'create_parents' => 'true',
                'overwrite'      => 'false',
                'file'           => new \CURLFile($localPath, mime_content_type($localPath) ?: 'application/octet-stream', $fileName),
            ],
        ]);

        $result = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

        if (curl_errno($ch)) {
            $error = curl_error($ch);
            curl_close($ch);
            throw new \RuntimeException("Synology cURL error: {$error}");
        }

        curl_close($ch);

        $data = json_decode($result, true);

        if ($data === null) {
            throw new \RuntimeException("Synology returned invalid JSON (HTTP {$httpCode})");
        }

        return $data;
    }

    /**
     * طلب API عام (GET)
     */
    private function apiRequest(string $endpoint, array $params): array
    {
        $url = $this->baseUrl . $endpoint . '?' . http_build_query($params);

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => false,
        ]);

        $result = curl_exec($ch);

        if (curl_errno($ch)) {
            $error = curl_error($ch);
            curl_close($ch);
            throw new \RuntimeException("Synology connection error: {$error}");
        }

        curl_close($ch);

        $data = json_decode($result, true);

        if ($data === null) {
            throw new \RuntimeException("Synology returned invalid response");
        }

        return $data;
    }

    /**
     * التأكد من تهيئة الاتصال
     */
    private function ensureInitialized(): void
    {
        if (!$this->initialized) {
            $this->init();
        }
    }

    public function __destruct()
    {
        $this->logout();
    }
}
