<?php

namespace WhatsToot;

/**
 * WorkOrderExtractor - استخراج أرقام أوامر العمل من النصوص
 */
class WorkOrderExtractor
{
    private string $pattern;
    private int $digits;

    public function __construct(?int $digits = null)
    {
        $this->digits = $digits ?? (defined('WORK_ORDER_DIGITS') ? WORK_ORDER_DIGITS : 9);
        $this->pattern = '/(?<!\d)(\d{' . $this->digits . '})(?!\d)/';
    }

    /**
     * استخراج رقم أمر عمل من نص
     * 
     * @param string $text النص للبحث فيه
     * @return string|null رقم أمر العمل أو null
     */
    public function extract(string $text): ?string
    {
        if (empty(trim($text))) {
            return null;
        }

        if (preg_match($this->pattern, $text, $matches)) {
            return $matches[1];
        }

        return null;
    }

    /**
     * استخراج جميع أرقام أوامر العمل من نص
     * 
     * @param string $text النص للبحث فيه
     * @return array قائمة الأرقام
     */
    public function extractAll(string $text): array
    {
        if (empty(trim($text))) {
            return [];
        }

        preg_match_all($this->pattern, $text, $matches);
        return array_unique($matches[1] ?? []);
    }

    /**
     * التحقق من أن النص يحتوي رقم أمر عمل
     */
    public function hasWorkOrder(string $text): bool
    {
        return $this->extract($text) !== null;
    }

    /**
     * التحقق من أن النص هو رقم أمر عمل فقط
     */
    public function isWorkOrderOnly(string $text): bool
    {
        $trimmed = trim($text);
        return preg_match('/^\d{' . $this->digits . '}$/', $trimmed) === 1;
    }
}
