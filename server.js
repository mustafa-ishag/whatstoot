/**
 * WhatsToot Bot - نقطة الدخول الرئيسية
 * 
 * تطبيق Node.js واحد يجمع:
 * 1. WhatsApp Bot (whatsapp-web.js)
 * 2. Image Processing (كان PHP)
 * 3. Queue Worker (كان worker.php)
 * 4. REST API (كان PHP APIs)
 * 5. Dashboard (كان PHP index)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

// =============================================
// 1. تحميل الإعدادات
// =============================================
const config = require('./src/config');

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   🤖 WhatsToot Bot v2.0 — Node.js       ║');
console.log('╚══════════════════════════════════════════╝');
console.log('');

// =============================================
// تنظيف الجلسة عند الطلب (flag file من disconnect API)
// =============================================
const clearFlagPath = path.join(config.BASE_PATH, '.clear_session');
const sessionAuthPath = path.join(config.BASE_PATH, '.wwebjs_auth');

if (fs.existsSync(clearFlagPath)) {
    console.log('🗑️ وُجدت علامة مسح الجلسة — جاري مسح الجلسة القديمة...');
    try {
        if (fs.existsSync(sessionAuthPath)) {
            fs.rmSync(sessionAuthPath, { recursive: true, force: true });
            console.log('🗑️ ✅ تم مسح ملفات الجلسة القديمة بنجاح');
        }
    } catch (err) {
        console.error('🗑️ ⚠️ فشل المسح العادي، جاري المحاولة بأمر rm -rf...');
        try {
            require('child_process').execSync(`rm -rf "${sessionAuthPath}"`);
            console.log('🗑️ ✅ تم مسح ملفات الجلسة (rm -rf)');
        } catch (e) {
            console.error('🗑️ ❌ فشل مسح الجلسة نهائياً:', e.message);
        }
    }
    // حذف علامة المسح
    try { fs.unlinkSync(clearFlagPath); } catch(e) {}
}

// =============================================
// 2. إنشاء المجلدات المطلوبة
// =============================================
const dirs = [config.TEMP_PATH, config.LOGS_PATH, path.dirname(config.DB_PATH)];
for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
    }
}

// =============================================
// 3. تهيئة قاعدة البيانات
// =============================================
const db = require('./src/database');
db.getInstance(); // Initialize connection

const schemaPath = path.join(config.BASE_PATH, 'database', 'schema.sql');
if (fs.existsSync(schemaPath)) {
    db.applySchema(schemaPath);
    console.log('✅ Database schema applied');
}

// =============================================
// 4. تهيئة الخدمات
// =============================================
const Logger = require('./src/logger');
const logger = new Logger(config.LOGS_PATH, db.getInstance());

const UploaderFactory = require('./src/uploader-factory');
const uploader = UploaderFactory.create(logger);

const ImageProcessor = require('./src/image-processor');
const imageProcessor = new ImageProcessor(uploader, logger);

console.log(`📦 Storage Engine: ${config.STORAGE_ENGINE}`);
console.log(`📋 Work Order Digits: ${config.WORK_ORDER_DIGITS}`);

// =============================================
// 5. تهيئة Express
// =============================================
const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// خدمة الملفات الثابتة (Dashboard)
app.use(express.static(path.join(config.BASE_PATH, 'public')));

// =============================================
// 6. تهيئة WhatsApp Bot
// =============================================
const WhatsAppBot = require('./src/whatsapp-bot');
const bot = new WhatsAppBot(imageProcessor, logger);

// =============================================
// 7. تهيئة قارئ البريد الإلكتروني
// =============================================
const EmailReader = require('./src/email-reader');
const emailReader = new EmailReader(bot, logger);

// =============================================
// 8. تسجيل API Routes
// =============================================
const apiRoutes = require('./src/api-routes');
apiRoutes.register(app, bot, uploader, logger, emailReader);

// Dashboard route (fallback)
app.get('/', (req, res) => {
    res.sendFile(path.join(config.BASE_PATH, 'public', 'index.html'));
});

// =============================================
// 9. تشغيل Queue Worker
// =============================================
const QueueWorker = require('./src/queue-worker');
const worker = new QueueWorker(uploader, logger, (chatId, message) => {
    return bot.sendMessage(chatId, message);
});

// =============================================
// 9. بدء التشغيل — مع حجز البورت إجبارياً
// =============================================
const { execSync } = require('child_process');

function forceKillPort(port) {
    const myPid = String(process.pid);
    try {
        if (process.platform === 'win32') {
            const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' });
            const lines = result.trim().split('\n');
            for (const line of lines) {
                const pid = line.trim().split(/\s+/).pop();
                if (pid && pid !== '0' && pid !== myPid) {
                    try { execSync(`taskkill /F /PID ${pid}`); } catch(e) {}
                    console.log(`🔪 تم قتل العملية ${pid} على البورت ${port}`);
                }
            }
        } else {
            const result = execSync(`lsof -t -i :${port}`, { encoding: 'utf8' });
            const pids = result.trim().split('\n').filter(Boolean);
            for (const pid of pids) {
                if (pid !== myPid) {
                    try { execSync(`kill -9 ${pid}`); } catch(e) {}
                    console.log(`🔪 تم قتل العملية ${pid} على البورت ${port}`);
                } else {
                    console.log(`⏭️ تم تجاهل العملية الحالية (PID ${myPid})`);
                }
            }
        }
    } catch (e) {
        // لا توجد عملية على البورت — ممتاز
        console.log(`✅ البورت ${port} متاح`);
    }
}

// حجز البورت إجبارياً
console.log(`🔒 جاري حجز البورت ${config.PORT} إجبارياً...`);
forceKillPort(config.PORT);

// انتظار قصير حتى يتحرر البورت ثم التشغيل
setTimeout(() => {

const server = app.listen(config.PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   ✅ WhatsToot Bot — Ready!              ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║   🌐 Dashboard: http://localhost:${config.PORT}     ║`);
    console.log(`║   📡 API:       http://localhost:${config.PORT}/api ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('📋 API Endpoints:');
    console.log(`   GET  /api/stats          — إحصائيات`);
    console.log(`   GET  /api/uploads        — قائمة الرفعات`);
    console.log(`   GET  /api/settings       — الإعدادات`);
    console.log(`   POST /api/settings       — تحديث إعداد`);
    console.log(`   POST /api/reset-wo       — إعادة تعيين أمر عمل`);
    console.log(`   POST /api/move-images    — نقل صور`);
    console.log(`   GET  /api/bot-status     — حالة البوت`);
    console.log(`   GET  /api/groups         — المجموعات`);
    console.log(`   POST /api/send-message   — إرسال رسالة`);
    console.log(`   GET  /api/logs           — سجل الأحداث`);
    console.log(`   GET  /api/test-storage   — اختبار التخزين`);
    console.log(`   GET  /api/email-status   — حالة قارئ البريد`);
    console.log(`   POST /api/check-email    — فحص البريد يدوياً`);
    console.log('');

    // بدء WhatsApp Bot
    console.log('⏳ جاري تهيئة واتساب...\n');
    bot.initialize();

    // بدء Queue Worker (بعد 3 ثوان)
    setTimeout(() => {
        worker.start(5000);
    }, 3000);

    // بدء قارئ البريد (بعد 10 ثوان — ليعطي واتساب وقتاً للاتصال)
    if (config.EMAIL_ENABLED) {
        setTimeout(() => {
            console.log('📧 جاري تفعيل قارئ البريد الإلكتروني...');
            emailReader.start();
        }, 10000);
    } else {
        console.log('📧 قارئ البريد معطّل (EMAIL_ENABLED=false)');
    }
});

// معالجة خطأ البورت المحجوز — محاولة واحدة فقط
let retryCount = 0;
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retryCount < 1) {
        retryCount++;
        console.error(`❌ البورت ${config.PORT} محجوز! جاري المحاولة مرة أخيرة...`);
        forceKillPort(config.PORT);
        setTimeout(() => {
            server.listen(config.PORT);
        }, 3000);
    } else if (err.code === 'EADDRINUSE') {
        console.error(`❌ فشل حجز البورت ${config.PORT} نهائياً. أوقف العملية المحجوزة يدوياً:`);
        console.error(`   sudo lsof -i :${config.PORT}`);
        console.error(`   sudo kill -9 <PID>`);
        process.exit(1);
    } else {
        console.error('❌ خطأ في السيرفر:', err.message);
        process.exit(1);
    }
});

}, 1000); // نهاية setTimeout للانتظار بعد قتل العملية

// =============================================
// معالجة إيقاف التطبيق
// =============================================
process.on('SIGINT', async () => {
    console.log('\n⏹️ إيقاف البوت...');
    worker.stop();
    emailReader.stop();
    logger.info('Bot shutting down');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n⏹️ إيقاف البوت...');
    worker.stop();
    emailReader.stop();
    logger.info('Bot shutting down');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
    logger.error('Uncaught Exception: ' + err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
    logger.error('Unhandled Rejection: ' + String(reason));
});
