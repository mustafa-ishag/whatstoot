<?php

namespace WhatsToot;

/**
 * Logger - نظام تسجيل الأحداث
 * 
 * يسجل في ملفات يومية + قاعدة البيانات
 */
class Logger
{
    private string $logsPath;
    private ?\PDO $db;

    public function __construct(string $logsPath = null, ?\PDO $db = null)
    {
        $this->logsPath = $logsPath ?? (defined('LOGS_PATH') ? LOGS_PATH : __DIR__ . '/../storage/logs');
        $this->db = $db;

        if (!is_dir($this->logsPath)) {
            mkdir($this->logsPath, 0755, true);
        }
    }

    public function debug(string $message, array $context = []): void
    {
        $this->log('debug', $message, $context);
    }

    public function info(string $message, array $context = []): void
    {
        $this->log('info', $message, $context);
    }

    public function warning(string $message, array $context = []): void
    {
        $this->log('warning', $message, $context);
    }

    public function error(string $message, array $context = []): void
    {
        $this->log('error', $message, $context);
    }

    /**
     * تسجيل حدث
     */
    private function log(string $level, string $message, array $context = []): void
    {
        $timestamp = date('Y-m-d H:i:s');
        $levelUpper = strtoupper($level);
        $contextStr = !empty($context) ? ' ' . json_encode($context, JSON_UNESCAPED_UNICODE) : '';

        // كتابة في ملف يومي
        $logLine = "[{$timestamp}] [{$levelUpper}] {$message}{$contextStr}" . PHP_EOL;
        $logFile = $this->logsPath . '/' . date('Y-m-d') . '.log';
        file_put_contents($logFile, $logLine, FILE_APPEND | LOCK_EX);

        // كتابة في قاعدة البيانات
        if ($this->db) {
            try {
                $stmt = $this->db->prepare(
                    'INSERT INTO activity_log (level, message, context) VALUES (?, ?, ?)'
                );
                $stmt->execute([$level, $message, $contextStr ?: null]);
            } catch (\PDOException $e) {
                // تجاهل أخطاء DB في اللوجر لتجنب حلقة لا نهائية
            }
        }

        // طباعة في الـ console إذا كان debug mode
        if (defined('APP_DEBUG') && APP_DEBUG && php_sapi_name() === 'cli') {
            $colors = [
                'debug'   => "\033[90m",  // رمادي
                'info'    => "\033[36m",   // أزرق فاتح
                'warning' => "\033[33m",   // أصفر
                'error'   => "\033[31m",   // أحمر
            ];
            $color = $colors[$level] ?? "\033[0m";
            echo "{$color}[{$levelUpper}] {$message}\033[0m" . PHP_EOL;
        }
    }

    /**
     * جلب آخر الأحداث من قاعدة البيانات
     */
    public function getRecentLogs(int $limit = 100, ?string $level = null): array
    {
        if (!$this->db) {
            return [];
        }

        $sql = 'SELECT * FROM activity_log';
        $params = [];

        if ($level) {
            $sql .= ' WHERE level = ?';
            $params[] = $level;
        }

        $sql .= ' ORDER BY created_at DESC LIMIT ?';
        $params[] = $limit;

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll(\PDO::FETCH_ASSOC);
    }

    /**
     * قراءة ملف لوق يومي
     */
    public function readLogFile(?string $date = null, int $lines = 100): string
    {
        $date = $date ?? date('Y-m-d');
        $logFile = $this->logsPath . '/' . $date . '.log';

        if (!file_exists($logFile)) {
            return '';
        }

        // قراءة آخر N سطر
        $content = file_get_contents($logFile);
        $allLines = explode(PHP_EOL, trim($content));
        $lastLines = array_slice($allLines, -$lines);
        return implode(PHP_EOL, $lastLines);
    }
}
