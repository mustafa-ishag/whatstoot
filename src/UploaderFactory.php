<?php

namespace WhatsToot;

/**
 * UploaderFactory - ينشئ الـ uploader المناسب حسب STORAGE_ENGINE
 */
class UploaderFactory
{
    /**
     * إنشاء uploader حسب الإعدادات
     * 
     * @return SynologyUploader|DriveUploader
     */
    public static function create(Database $db, Logger $logger): object
    {
        $engine = defined('STORAGE_ENGINE') ? STORAGE_ENGINE : 'synology';

        if ($engine === 'synology') {
            return new SynologyUploader($db, $logger);
        }

        return new DriveUploader($db, $logger);
    }
}
