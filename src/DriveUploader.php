<?php

namespace WhatsToot;

use Google\Client as GoogleClient;
use Google\Service\Drive as GoogleDrive;
use Google\Service\Drive\DriveFile;

/**
 * DriveUploader - رفع الملفات إلى Google Drive
 * 
 * يستخدم OAuth 2.0 للمصادقة (بحساب المستخدم الشخصي)
 * لأن Service Accounts لم يعد لديها مساحة تخزين
 */
class DriveUploader
{
    private GoogleDrive $drive;
    private Database $db;
    private Logger $logger;
    private string $rootFolderId;
    private bool $initialized = false;

    public function __construct(Database $db, Logger $logger)
    {
        $this->db = $db;
        $this->logger = $logger;
        $this->rootFolderId = defined('GDRIVE_ROOT_FOLDER_ID') ? GDRIVE_ROOT_FOLDER_ID : '';
    }

    /**
     * تهيئة Google Client
     * 
     * يدعم طريقتين:
     * 1. OAuth 2.0 (الأساسية) — باستخدام oauth-token.json + oauth-client.json
     * 2. Service Account (احتياطية) — باستخدام credentials file
     */
    public function init(?string $credentialsPath = null): void
    {
        if ($this->initialized) {
            return;
        }

        $basePath = defined('BASE_PATH') ? BASE_PATH : dirname(__DIR__);
        $tokenPath = $basePath . '/credentials/oauth-token.json';
        $oauthClientPath = $basePath . '/credentials/oauth-client.json';

        // =============================================
        // الطريقة 1: OAuth 2.0 (مفضّلة)
        // =============================================
        if (file_exists($tokenPath) && file_exists($oauthClientPath)) {
            $client = new GoogleClient();
            $client->setAuthConfig($oauthClientPath);
            $client->addScope(GoogleDrive::DRIVE);
            $client->setAccessType('offline');

            $token = json_decode(file_get_contents($tokenPath), true);
            $client->setAccessToken($token);

            // تجديد Token إذا انتهى
            if ($client->isAccessTokenExpired()) {
                $refreshToken = $token['refresh_token'] ?? null;
                if ($refreshToken) {
                    $newToken = $client->fetchAccessTokenWithRefreshToken($refreshToken);
                    $newToken['refresh_token'] = $refreshToken; // الحفاظ على refresh token
                    file_put_contents($tokenPath, json_encode($newToken));
                    $client->setAccessToken($newToken);
                    $this->logger->info('OAuth token refreshed');
                } else {
                    throw new \RuntimeException(
                        'OAuth refresh token missing. Run setup-oauth.php again: http://localhost/whatstoot/setup-oauth.php'
                    );
                }
            }

            $this->drive = new GoogleDrive($client);
            $this->initialized = true;
            $this->logger->info('Google Drive client initialized (OAuth 2.0)');
            return;
        }

        // =============================================
        // الطريقة 2: Service Account (احتياطية)
        // =============================================
        $credentialsPath = $credentialsPath ?? $basePath . '/' . (defined('GDRIVE_CREDENTIALS_PATH') ? GDRIVE_CREDENTIALS_PATH : 'credentials/google-service-account.json');

        if (file_exists($credentialsPath)) {
            $client = new GoogleClient();
            $client->setAuthConfig($credentialsPath);
            $client->addScope(GoogleDrive::DRIVE);

            $this->drive = new GoogleDrive($client);
            $this->initialized = true;
            $this->logger->info('Google Drive client initialized (Service Account)');
            return;
        }

        // لا توجد بيانات مصادقة
        throw new \RuntimeException(
            "Google Drive credentials not found.\n" .
            "Run the OAuth setup: http://localhost/whatstoot/setup-oauth.php\n" .
            "Or place service account JSON in: credentials/"
        );
    }

    /**
     * الحصول على أو إنشاء مجلد لرقم أمر عمل
     */
    public function getOrCreateFolder(string $workOrder): string
    {
        $this->ensureInitialized();

        // 1. البحث في قاعدة البيانات أولاً
        $cachedId = $this->db->getFolder($workOrder);
        if ($cachedId) {
            // التحقق من وجود المجلد فعلاً على Drive وأنه غير محذوف
            try {
                $folder = $this->drive->files->get($cachedId, ['fields' => 'id,trashed']);
                if (!$folder->getTrashed()) {
                    return $cachedId;
                }
                $this->logger->warning("Folder {$cachedId} for WO {$workOrder} is trashed, recreating...");
            } catch (\Exception $e) {
                // المجلد لم يعد موجوداً أو لا صلاحية للوصول
                $this->logger->warning("Cached folder {$cachedId} for WO {$workOrder} inaccessible, searching...");
            }
        }

        // 2. البحث في Drive
        $folderId = $this->findFolderByName($workOrder, $this->rootFolderId);

        if ($folderId) {
            $this->db->saveFolder($workOrder, $folderId);
            $this->logger->info("Found existing folder for WO {$workOrder}: {$folderId}");
            return $folderId;
        }

        // 3. إنشاء مجلد جديد
        $folderId = $this->createFolder($workOrder, $this->rootFolderId);
        $this->db->saveFolder($workOrder, $folderId);
        $this->logger->info("Created new folder for WO {$workOrder}: {$folderId}");

        return $folderId;
    }

    /**
     * رفع ملف إلى مجلد محدد
     * 
     * @return array ['id' => driveFileId, 'url' => webViewLink]
     */
    public function upload(string $localPath, string $folderId, string $fileName): array
    {
        $this->ensureInitialized();

        if (!file_exists($localPath)) {
            throw new \RuntimeException("File not found: {$localPath}");
        }

        $mimeType = mime_content_type($localPath) ?: 'application/octet-stream';

        $fileMetadata = new DriveFile([
            'name'    => $fileName,
            'parents' => [$folderId],
        ]);

        $content = file_get_contents($localPath);

        $file = $this->drive->files->create($fileMetadata, [
            'data'       => $content,
            'mimeType'   => $mimeType,
            'uploadType' => 'multipart',
            'fields'     => 'id, webViewLink, webContentLink',
        ]);

        $result = [
            'id'  => $file->id,
            'url' => $file->webViewLink ?? "https://drive.google.com/file/d/{$file->id}/view",
        ];

        $this->logger->info("Uploaded {$fileName} to Drive", [
            'drive_id' => $file->id,
            'folder'   => $folderId,
            'size'     => filesize($localPath),
        ]);

        return $result;
    }

    /**
     * بناء اسم ملف منظّم
     * 
     * @return string مثال: WO123456789_20240601_143022.jpg
     */
    public function buildFileName(string $workOrder, string $extension): string
    {
        $timestamp = date('Ymd_His');
        $ext = ltrim(strtolower($extension), '.');
        return "WO{$workOrder}_{$timestamp}.{$ext}";
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
     * اختبار الاتصال بـ Google Drive
     */
    public function testConnection(): array
    {
        $this->ensureInitialized();

        try {
            $about = $this->drive->about->get(['fields' => 'user']);
            $user = $about->getUser();

            // التحقق من الوصول للمجلد الجذر
            if (!empty($this->rootFolderId)) {
                $folder = $this->drive->files->get($this->rootFolderId, ['fields' => 'id,name']);
                return [
                    'success'     => true,
                    'email'       => $user->getEmailAddress(),
                    'folder_name' => $folder->getName(),
                    'folder_id'   => $folder->getId(),
                ];
            }

            return [
                'success' => true,
                'email'   => $user->getEmailAddress(),
                'message' => 'Connected but no root folder ID configured',
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error'   => $e->getMessage(),
            ];
        }
    }

    /**
     * البحث عن مجلد بالاسم داخل مجلد أب
     */
    private function findFolderByName(string $name, string $parentId): ?string
    {
        $query = sprintf(
            "name = '%s' and '%s' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            addslashes($name),
            addslashes($parentId)
        );

        $results = $this->drive->files->listFiles([
            'q'      => $query,
            'fields' => 'files(id, name)',
            'spaces' => 'drive',
        ]);

        $files = $results->getFiles();
        return count($files) > 0 ? $files[0]->getId() : null;
    }

    /**
     * إنشاء مجلد جديد
     */
    private function createFolder(string $name, string $parentId): string
    {
        $folderMetadata = new DriveFile([
            'name'     => $name,
            'mimeType' => 'application/vnd.google-apps.folder',
            'parents'  => [$parentId],
        ]);

        $folder = $this->drive->files->create($folderMetadata, [
            'fields' => 'id',
        ]);

        return $folder->getId();
    }

    /**
     * التأكد من تهيئة العميل
     */
    private function ensureInitialized(): void
    {
        if (!$this->initialized) {
            $this->init();
        }
    }
}
