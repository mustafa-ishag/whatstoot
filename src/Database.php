<?php

namespace WhatsToot;

/**
 * Database - إدارة قاعدة بيانات SQLite
 * 
 * يوفّر singleton للـ PDO ودوال مساعدة للعمليات الشائعة
 */
class Database
{
    private static ?Database $instance = null;
    private \PDO $pdo;

    public function __construct(?string $dbPath = null)
    {
        $dbPath = $dbPath ?? (defined('DB_PATH') ? DB_PATH : __DIR__ . '/../database/bot.sqlite');

        $dir = dirname($dbPath);
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        $this->pdo = new \PDO("sqlite:{$dbPath}", null, null, [
            \PDO::ATTR_ERRMODE            => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_TIMEOUT            => 10,
        ]);

        // تحسينات أداء SQLite
        $this->pdo->exec('PRAGMA journal_mode=WAL');
        $this->pdo->exec('PRAGMA synchronous=NORMAL');
        $this->pdo->exec('PRAGMA foreign_keys=ON');
    }

    /**
     * الحصول على instance واحد
     */
    public static function getInstance(?string $dbPath = null): self
    {
        if (self::$instance === null) {
            self::$instance = new self($dbPath);
        }
        return self::$instance;
    }

    /**
     * الحصول على PDO مباشرة
     */
    public function getPdo(): \PDO
    {
        return $this->pdo;
    }

    /**
     * تطبيق schema قاعدة البيانات
     */
    public function applySchema(string $schemaPath): void
    {
        $sql = file_get_contents($schemaPath);
        $this->pdo->exec($sql);
    }

    // =============================================
    // 📤 Uploads
    // =============================================

    /**
     * تسجيل عملية رفع
     */
    public function logUpload(array $data): int
    {
        $stmt = $this->pdo->prepare('
            INSERT INTO uploads (work_order, file_name, file_hash, drive_id, drive_url, group_id, group_name, sender, caption, status)
            VALUES (:work_order, :file_name, :file_hash, :drive_id, :drive_url, :group_id, :group_name, :sender, :caption, :status)
        ');

        $stmt->execute([
            ':work_order' => $data['work_order'],
            ':file_name'  => $data['file_name'],
            ':file_hash'  => $data['file_hash'] ?? null,
            ':drive_id'   => $data['drive_id'] ?? null,
            ':drive_url'  => $data['drive_url'] ?? null,
            ':group_id'   => $data['group_id'] ?? null,
            ':group_name' => $data['group_name'] ?? null,
            ':sender'     => $data['sender'] ?? null,
            ':caption'    => $data['caption'] ?? null,
            ':status'     => $data['status'] ?? 'completed',
        ]);

        return (int) $this->pdo->lastInsertId();
    }

    /**
     * جلب قائمة الرفعات
     */
    public function getUploads(int $limit = 50, int $offset = 0, ?string $woFilter = null, ?string $status = null): array
    {
        $sql = 'SELECT * FROM uploads WHERE 1=1';
        $params = [];

        if ($woFilter) {
            $sql .= ' AND work_order LIKE ?';
            $params[] = "%{$woFilter}%";
        }
        if ($status) {
            $sql .= ' AND status = ?';
            $params[] = $status;
        }

        $sql .= ' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?';
        $params[] = $limit;
        $params[] = $offset;

        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    // =============================================
    // 📁 Folders
    // =============================================

    /**
     * جلب معرّف مجلد Drive لرقم أمر عمل
     */
    public function getFolder(string $workOrder): ?string
    {
        $stmt = $this->pdo->prepare('SELECT drive_id FROM folders WHERE work_order = ?');
        $stmt->execute([$workOrder]);
        $row = $stmt->fetch();
        return $row ? $row['drive_id'] : null;
    }

    /**
     * حفظ مجلد Drive جديد
     */
    public function saveFolder(string $workOrder, string $driveId): void
    {
        $stmt = $this->pdo->prepare('
            INSERT OR REPLACE INTO folders (work_order, drive_id) VALUES (?, ?)
        ');
        $stmt->execute([$workOrder, $driveId]);
    }

    // =============================================
    // 💬 Message Context
    // =============================================

    /**
     * حفظ سياق رسالة (رقم أمر عمل)
     */
    public function saveContext(string $groupId, string $workOrder, ?string $sender = null, int $ttlSeconds = 300): void
    {
        $expiresAt = date('Y-m-d H:i:s', time() + $ttlSeconds);

        $stmt = $this->pdo->prepare('
            INSERT INTO message_context (group_id, work_order, sender, expires_at)
            VALUES (?, ?, ?, ?)
        ');
        $stmt->execute([$groupId, $workOrder, $sender, $expiresAt]);
    }

    /**
     * جلب آخر رقم أمر عمل في مجموعة لمرسل محدد
     * 
     * @param string $groupId معرّف المجموعة
     * @param string|null $sender المرسل — يجب أن يطابق نفس الشخص
     */
    public function getRecentContext(string $groupId, ?string $sender = null): ?string
    {
        $now = date('Y-m-d H:i:s');

        if ($sender) {
            // البحث بسياق نفس المرسل فقط
            $stmt = $this->pdo->prepare('
                SELECT work_order FROM message_context
                WHERE group_id = ? AND sender = ? AND expires_at > ?
                ORDER BY created_at DESC LIMIT 1
            ');
            $stmt->execute([$groupId, $sender, $now]);
        } else {
            $stmt = $this->pdo->prepare('
                SELECT work_order FROM message_context
                WHERE group_id = ? AND expires_at > ?
                ORDER BY created_at DESC LIMIT 1
            ');
            $stmt->execute([$groupId, $now]);
        }

        $row = $stmt->fetch();
        return $row ? $row['work_order'] : null;
    }

    /**
     * تنظيف السياقات المنتهية
     */
    public function cleanExpiredContexts(): int
    {
        $stmt = $this->pdo->prepare('DELETE FROM message_context WHERE expires_at < ?');
        $stmt->execute([date('Y-m-d H:i:s')]);
        return $stmt->rowCount();
    }

    // =============================================
    // 📋 Queue
    // =============================================

    /**
     * إضافة صورة للطابور
     */
    public function enqueue(array $data): int
    {
        $timeoutAt = date('Y-m-d H:i:s', time() + (defined('AWAIT_TIMEOUT_SECONDS') ? AWAIT_TIMEOUT_SECONDS : 90));

        $stmt = $this->pdo->prepare('
            INSERT INTO queue (image_path, file_hash, group_id, group_name, sender, caption, work_order, status, timeout_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ');

        $stmt->execute([
            $data['image_path'],
            $data['file_hash'] ?? null,
            $data['group_id'] ?? null,
            $data['group_name'] ?? null,
            $data['sender'] ?? null,
            $data['caption'] ?? null,
            $data['work_order'] ?? null,
            $data['status'] ?? 'waiting',
            $timeoutAt,
        ]);

        return (int) $this->pdo->lastInsertId();
    }

    /**
     * جلب عناصر الطابور المنتهية المهلة
     */
    public function getExpiredQueue(): array
    {
        $now = date('Y-m-d H:i:s');
        $stmt = $this->pdo->prepare('
            SELECT * FROM queue WHERE status = ? AND timeout_at <= ?
        ');
        $stmt->execute(['waiting', $now]);
        return $stmt->fetchAll();
    }

    /**
     * جلب صور تنتظر في مجموعة محددة لمرسل محدد
     * 
     * @param string $groupId معرّف المجموعة
     * @param string|null $sender المرسل — فقط صور نفس الشخص
     */
    public function getWaitingImages(string $groupId, ?string $sender = null): array
    {
        if ($sender) {
            // فقط صور نفس المرسل
            $stmt = $this->pdo->prepare('
                SELECT * FROM queue WHERE group_id = ? AND sender = ? AND status = ?
            ');
            $stmt->execute([$groupId, $sender, 'waiting']);
        } else {
            $stmt = $this->pdo->prepare('
                SELECT * FROM queue WHERE group_id = ? AND status = ?
            ');
            $stmt->execute([$groupId, 'waiting']);
        }
        return $stmt->fetchAll();
    }

    /**
     * تحديث حالة عنصر في الطابور
     */
    public function updateQueueStatus(int $id, string $status, ?string $workOrder = null): void
    {
        $sql = 'UPDATE queue SET status = ?, processed_at = CURRENT_TIMESTAMP';
        $params = [$status];

        if ($workOrder !== null) {
            $sql .= ', work_order = ?';
            $params[] = $workOrder;
        }

        $sql .= ' WHERE id = ?';
        $params[] = $id;

        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
    }

    /**
     * زيادة محاولات عنصر في الطابور
     */
    public function incrementQueueAttempts(int $id): void
    {
        $stmt = $this->pdo->prepare('UPDATE queue SET attempts = attempts + 1 WHERE id = ?');
        $stmt->execute([$id]);
    }

    // =============================================
    // 🔑 Settings
    // =============================================

    /**
     * جلب إعداد
     */
    public function getSetting(string $key, ?string $default = null): ?string
    {
        $stmt = $this->pdo->prepare('SELECT value FROM settings WHERE key = ?');
        $stmt->execute([$key]);
        $row = $stmt->fetch();
        return $row ? $row['value'] : $default;
    }

    /**
     * حفظ إعداد
     */
    public function setSetting(string $key, string $value): void
    {
        $stmt = $this->pdo->prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        $stmt->execute([$key, $value]);
    }

    /**
     * جلب كل الإعدادات
     */
    public function getAllSettings(): array
    {
        $stmt = $this->pdo->query('SELECT key, value FROM settings');
        $settings = [];
        foreach ($stmt->fetchAll() as $row) {
            $settings[$row['key']] = $row['value'];
        }
        return $settings;
    }

    // =============================================
    // 📊 Statistics
    // =============================================

    /**
     * جلب الإحصائيات
     */
    public function getStats(): array
    {
        $today = date('Y-m-d');

        // إجمالي الرفعات
        $totalUploads = $this->pdo->query('SELECT COUNT(*) FROM uploads WHERE status = "completed"')->fetchColumn();

        // رفعات اليوم
        $todayUploads = $this->pdo->prepare('SELECT COUNT(*) FROM uploads WHERE status = "completed" AND DATE(uploaded_at) = ?');
        $todayUploads->execute([$today]);
        $todayUploads = $todayUploads->fetchColumn();

        // عدد أوامر العمل الفريدة
        $uniqueWO = $this->pdo->query('SELECT COUNT(DISTINCT work_order) FROM uploads WHERE work_order != "UNSORTED" AND status = "completed"')->fetchColumn();

        // صور في UNSORTED
        $unsorted = $this->pdo->query('SELECT COUNT(*) FROM uploads WHERE work_order = "UNSORTED" AND status = "completed"')->fetchColumn();

        // في الطابور
        $pending = $this->pdo->query('SELECT COUNT(*) FROM queue WHERE status = "waiting"')->fetchColumn();

        // مكررات
        $duplicates = $this->pdo->query('SELECT COUNT(*) FROM uploads WHERE status = "duplicate"')->fetchColumn();

        // فشل
        $failed = $this->pdo->query('SELECT COUNT(*) FROM uploads WHERE status = "failed"')->fetchColumn();

        // رفعات هذا الأسبوع
        $weekStart = date('Y-m-d', strtotime('monday this week'));
        $weekUploads = $this->pdo->prepare('SELECT COUNT(*) FROM uploads WHERE status = "completed" AND DATE(uploaded_at) >= ?');
        $weekUploads->execute([$weekStart]);
        $weekUploads = $weekUploads->fetchColumn();

        return [
            'total_uploads'   => (int) $totalUploads,
            'today_uploads'   => (int) $todayUploads,
            'week_uploads'    => (int) $weekUploads,
            'unique_wo'       => (int) $uniqueWO,
            'unsorted'        => (int) $unsorted,
            'pending'         => (int) $pending,
            'duplicates'      => (int) $duplicates,
            'failed'          => (int) $failed,
        ];
    }

    // =============================================
    // 🔍 Duplicate Check
    // =============================================

    /**
     * فحص تكرار صورة
     */
    public function isDuplicate(string $hash, ?string $workOrder = null): bool
    {
        if ($workOrder) {
            $stmt = $this->pdo->prepare('SELECT COUNT(*) FROM uploads WHERE file_hash = ? AND work_order = ? AND status = "completed"');
            $stmt->execute([$hash, $workOrder]);
        } else {
            $stmt = $this->pdo->prepare('SELECT COUNT(*) FROM uploads WHERE file_hash = ? AND status = "completed"');
            $stmt->execute([$hash]);
        }
        return $stmt->fetchColumn() > 0;
    }
}
