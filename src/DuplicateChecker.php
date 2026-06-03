<?php

namespace WhatsToot;

/**
 * DuplicateChecker - فحص تكرار الصور
 * 
 * يحسب SHA256 hash للصور ويفحص قاعدة البيانات
 */
class DuplicateChecker
{
    private Database $db;

    public function __construct(Database $db)
    {
        $this->db = $db;
    }

    /**
     * حساب hash لملف
     */
    public function hashFile(string $filePath): string
    {
        return hash_file('sha256', $filePath);
    }

    /**
     * حساب hash من بيانات binary
     */
    public function hashData(string $data): string
    {
        return hash('sha256', $data);
    }

    /**
     * فحص إذا كانت الصورة مكررة
     */
    public function isDuplicate(string $hash, ?string $workOrder = null): bool
    {
        return $this->db->isDuplicate($hash, $workOrder);
    }

    /**
     * فحص ملف إذا كان مكرراً
     */
    public function isFileDuplicate(string $filePath, ?string $workOrder = null): bool
    {
        $hash = $this->hashFile($filePath);
        return $this->isDuplicate($hash, $workOrder);
    }
}
