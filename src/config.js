/**
 * WhatsToot Bot - Application Configuration
 * 
 * يقرأ الإعدادات من ملف .env ويوفر ثوابت وقيم افتراضية
 * بديل لـ config/app.php
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = (key, defaultValue = '') => process.env[key] || defaultValue;
const envInt = (key, defaultValue = 0) => parseInt(process.env[key], 10) || defaultValue;
const envBool = (key, defaultValue = false) => {
    const val = process.env[key];
    if (val === undefined || val === '') return defaultValue;
    return val === 'true' || val === '1';
};

// =============================================
// Paths
// =============================================
const BASE_PATH = path.join(__dirname, '..');
const STORAGE_PATH = path.join(BASE_PATH, 'storage');
const TEMP_PATH = path.join(STORAGE_PATH, 'temp');
const LOGS_PATH = path.join(STORAGE_PATH, 'logs');
const DB_PATH = path.join(BASE_PATH, 'database', 'bot.sqlite');
const CREDENTIALS_PATH = path.join(BASE_PATH, 'credentials');

// =============================================
// Storage Engine (synology or gdrive)
// =============================================
const STORAGE_ENGINE = env('STORAGE_ENGINE', 'synology');

// Synology NAS Settings
const SYNOLOGY_URL = env('SYNOLOGY_URL');
const SYNOLOGY_USER = env('SYNOLOGY_USER');
const SYNOLOGY_PASS = env('SYNOLOGY_PASS');
const SYNOLOGY_BASE_PATH = env('SYNOLOGY_BASE_PATH', '/photo/work_orders');

// Google Drive Settings
const GDRIVE_CREDENTIALS_PATH = env('GDRIVE_CREDENTIALS_PATH', 'credentials/google-service-account.json');
const GDRIVE_ROOT_FOLDER_ID = env('GDRIVE_ROOT_FOLDER_ID', '');

// =============================================
// Work Order Settings
// =============================================
const WORK_ORDER_DIGITS = envInt('WORK_ORDER_DIGITS', 9);
const WORK_ORDER_REGEX = new RegExp(`(?<!\\d)(\\d{${WORK_ORDER_DIGITS}})(?!\\d)`);

// =============================================
// Timing Settings
// =============================================
const AWAIT_TIMEOUT_SECONDS = envInt('AWAIT_TIMEOUT_SECONDS', 90);

// =============================================
// App Settings
// =============================================
const APP_ENV = env('APP_ENV', 'production');
const APP_URL = env('APP_URL', 'http://localhost');
const APP_DEBUG = envBool('APP_DEBUG', false);
const APP_TIMEZONE = env('APP_TIMEZONE', 'Asia/Riyadh');
const AUTO_REPLY_ENABLED = envBool('AUTO_REPLY_ENABLED', true);

// =============================================
// Server Settings
// =============================================
const PORT = envInt('PORT', 3000);
const API_KEY = env('API_KEY', 'whatstoot_bot_2026_secure_key');

// =============================================
// Monitored Groups
// =============================================
const MONITORED_GROUPS_RAW = env('MONITORED_GROUPS', 'all');
const MONITORED_GROUPS = MONITORED_GROUPS_RAW === 'all' 
    ? 'all' 
    : MONITORED_GROUPS_RAW.split(',').map(g => g.trim());

module.exports = {
    // Paths
    BASE_PATH, STORAGE_PATH, TEMP_PATH, LOGS_PATH, DB_PATH, CREDENTIALS_PATH,
    // Storage
    STORAGE_ENGINE, 
    SYNOLOGY_URL, SYNOLOGY_USER, SYNOLOGY_PASS, SYNOLOGY_BASE_PATH,
    GDRIVE_CREDENTIALS_PATH, GDRIVE_ROOT_FOLDER_ID,
    // Work Order
    WORK_ORDER_DIGITS, WORK_ORDER_REGEX, AWAIT_TIMEOUT_SECONDS,
    // App
    APP_ENV, APP_URL, APP_DEBUG, APP_TIMEZONE, AUTO_REPLY_ENABLED,
    // Server
    PORT, API_KEY,
    // Groups
    MONITORED_GROUPS,
};
