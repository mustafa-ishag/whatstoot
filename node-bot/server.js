const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');

// =============================================
// ⚙️ إعدادات النظام
// =============================================

// تحميل إعدادات من .env يدوياً لعدم الاعتماد على مكتبات خارجية
let workOrderDigits = 9;
let envPHP_API_URL = null;
let envAPI_KEY = null;
let envMONITORED_GROUPS = null;
let envPORT = null;

try {
    const envPath = path.join(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');

        const matchDigits = envContent.match(/^WORK_ORDER_DIGITS\s*=\s*(\d+)/m);
        if (matchDigits) {
            workOrderDigits = parseInt(matchDigits[1], 10);
            console.log(`📋 تم تحميل عدد أرقام أمر العمل من .env: ${workOrderDigits}`);
        }

        const matchPHP = envContent.match(/^PHP_API_URL\s*=\s*(.+)/m);
        if (matchPHP) {
            envPHP_API_URL = matchPHP[1].trim();
            console.log(`🌐 PHP API URL: ${envPHP_API_URL}`);
        }

        const matchKey = envContent.match(/^NODE_BOT_API_KEY\s*=\s*(.+)/m);
        if (matchKey) {
            envAPI_KEY = matchKey[1].trim();
        }

        const matchGroups = envContent.match(/^MONITORED_GROUPS\s*=\s*(.+)/m);
        if (matchGroups) {
            envMONITORED_GROUPS = matchGroups[1].trim();
        }

        const matchPort = envContent.match(/^NODE_BOT_PORT\s*=\s*(\d+)/m);
        if (matchPort) {
            envPORT = parseInt(matchPort[1], 10);
        }
    }
} catch (e) {
    console.error('⚠️ فشل قراءة ملف .env:', e.message);
}

// تعبير نمطي مرن لاستخراج رقم أمر العمل
const woPattern = new RegExp(`(?<!\\d)\\d{${workOrderDigits}}(?!\\d)`);

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = envPORT || process.env.PORT || 3000;
const PHP_API_URL = envPHP_API_URL || process.env.PHP_API_URL || 'http://localhost/api';
const API_KEY = envAPI_KEY || process.env.API_KEY || 'whatstoot_bot_2026_secure_key';

// المجموعات المراقبة ('all' أو مصفوفة من IDs)
let monitoredGroups = envMONITORED_GROUPS || process.env.MONITORED_GROUPS || 'all';

// إحصائيات مباشرة
let stats = {
    messagesReceived: 0,
    imagesProcessed: 0,
    textProcessed: 0,
    errors: 0,
    startTime: Date.now()
};

// نظام تجميع الردود — تجميع صور أمر العمل الواحد وإرسال ملخص واحد فقط
const uploadBatches = new Map(); // key: groupId_workOrder → { count, files[], chatId, timer }
const BATCH_DELAY_MS = 30000; // 30 ثانية انتظار بعد آخر صورة قبل إرسال الملخص (زاد لاستيعاب الطابور)

// ذاكرة مؤقتة لحفظ آخر أمر عمل لكل مرسل
const recentWorkOrders = new Map(); // key: groupId_senderId → { workOrder, timestamp }

// =============================================
// 📦 نظام الطابور التتابعي — لمنع إغراق PHP/Synology
// =============================================

const uploadQueue = [];    // طابور الصور المنتظرة
let isProcessing = false;  // هل الطابور قيد المعالجة حالياً؟
const MAX_RETRIES = 3;     // أقصى عدد إعادة المحاولات
const RETRY_DELAY_MS = 5000; // 5 ثوان بين كل محاولة
const API_TIMEOUT_MS = 120000; // 120 ثانية timeout (بدلاً من 30)
const DELAY_BETWEEN_UPLOADS_MS = 1000; // ثانية واحدة بين كل رفع وآخر

/**
 * إضافة صورة للطابور بدلاً من إرسالها مباشرة
 */
function enqueueImage(payload, chatId) {
    uploadQueue.push({ payload, chatId, retries: 0 });
    console.log(`📥 صورة أُضيفت للطابور (الحجم: ${uploadQueue.length})`);
    processQueue(); // تحريك المعالجة إذا لم تكن قيد التشغيل
}

/**
 * معالجة الطابور واحدة تلو الأخرى
 */
async function processQueue() {
    if (isProcessing) return; // لا تشغّل إذا كان قيد المعالجة
    if (uploadQueue.length === 0) return;

    isProcessing = true;

    while (uploadQueue.length > 0) {
        const item = uploadQueue.shift();
        const { payload, chatId, retries } = item;

        try {
            const result = await sendToPhpApi(payload);

            if (result && result.success) {
                console.log(`✅ ${result.action}: ${result.message || ''}`);
                handleUploadResult(result, payload, chatId);
            } else {
                const errorMsg = result?.message || 'Unknown error';
                console.error(`❌ PHP API Error: ${errorMsg}`);

                // إعادة المحاولة إذا كان الخطأ مؤقتاً (timeout أو خطأ سيرفر)
                if (retries < MAX_RETRIES && isRetryableError(errorMsg)) {
                    console.log(`🔄 إعادة المحاولة ${retries + 1}/${MAX_RETRIES} بعد ${RETRY_DELAY_MS / 1000} ثوان...`);
                    await sleep(RETRY_DELAY_MS);
                    uploadQueue.unshift({ payload, chatId, retries: retries + 1 });
                } else {
                    stats.errors++;
                    console.error(`💀 فشل نهائي بعد ${retries} محاولة`);
                }
            }
        } catch (error) {
            console.error('❌ خطأ غير متوقع:', error.message);
            stats.errors++;
        }

        // انتظار بين كل عملية رفع لتقليل الضغط على Synology
        if (uploadQueue.length > 0) {
            await sleep(DELAY_BETWEEN_UPLOADS_MS);
        }
    }

    isProcessing = false;
}

/**
 * معالجة نتيجة الرفع الناجح
 */
function handleUploadResult(result, payload, chatId) {
    if (result.action === 'uploaded' && result.work_order) {
        const batchKey = `${payload.group_id}_${result.work_order}`;

        if (!uploadBatches.has(batchKey)) {
            uploadBatches.set(batchKey, {
                workOrder: result.work_order,
                count: 0,
                files: [],
                chatId: chatId,
                timer: null
            });
        }

        const batch = uploadBatches.get(batchKey);
        batch.count++;
        batch.files.push(result.file_name);

        // إلغاء المؤقت السابق وإعادة تشغيله
        if (batch.timer) clearTimeout(batch.timer);
        batch.timer = setTimeout(async () => {
            try {
                const summary = batch.count === 1
                    ? `✅ تم رفع صورة واحدة بنجاح\n📁 أمر العمل: ${batch.workOrder}`
                    : `✅ تم رفع ${batch.count} صورة بنجاح\n📁 أمر العمل: ${batch.workOrder}`;

                await client.sendMessage(batch.chatId, summary);
                console.log(`📨 ملخص مُرسل: ${batch.count} صورة لأمر العمل ${batch.workOrder}`);
            } catch (e) {
                console.error('❌ خطأ إرسال ملخص:', e.message);
            }
            uploadBatches.delete(batchKey);
        }, BATCH_DELAY_MS);

    } else if (result.action === 'queued') {
        console.log('⏳ الصورة في الطابور...');
    } else if (result.action === 'skipped') {
        console.log('⚠️ صورة مكررة — تم التخطي');
    }
}

/**
 * تحديد إذا كان الخطأ يستحق إعادة المحاولة
 */
function isRetryableError(msg) {
    const retryable = ['timeout', 'aborted', '500', '502', '503', 'ECONNREFUSED', 'ECONNRESET', '119'];
    return retryable.some(keyword => msg.toLowerCase().includes(keyword.toLowerCase()));
}

/**
 * تأخير بسيط
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================
// 🤖 تهيئة عميل واتساب
// =============================================

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

let isClientReady = false;
let qrCodeData = null;

// =============================================
// 📡 أحداث عميل واتساب
// =============================================

client.on('loading_screen', (percent, message) => {
    console.log(`\n⏳ جاري تحميل واتساب ويب... ${percent}%`);
});

client.on('qr', (qr) => {
    qrCodeData = qr;
    console.log('\n==================================================');
    console.log('📌 امسح هذا الباركود (QR Code) بجوالك:');
    console.log('==================================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    isClientReady = true;
    qrCodeData = null;
    console.log('\n✅ واتساب جاهز! البوت يراقب المجموعات الآن...');
    console.log(`🌐 API: http://localhost:${PORT}`);
    console.log(`📡 PHP API: ${PHP_API_URL}\n`);
});

client.on('authenticated', () => {
    console.log('✅ تمت المصادقة بنجاح!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ فشل المصادقة:', msg);
});

client.on('disconnected', (reason) => {
    isClientReady = false;
    console.log('⚠️ تم قطع الاتصال:', reason);
});

// =============================================
// 📨 معالج الرسائل الرئيسي
// =============================================

client.on('message', async (msg) => {
    try {
        stats.messagesReceived++;

        // تجاهل رسائلنا
        if (msg.fromMe) return;

        const chat = await msg.getChat();

        // معالجة رسائل المجموعات فقط
        if (!chat.isGroup) return;

        const groupId = chat.id._serialized;
        const groupName = chat.name || 'Unknown Group';

        // فحص إذا كانت المجموعة مراقبة
        if (monitoredGroups !== 'all') {
            const groups = monitoredGroups.split(',').map(g => g.trim());
            if (!groups.includes(groupId) && !groups.includes(groupName)) {
                return;
            }
        }

        const contact = await msg.getContact();
        const senderName = contact.pushname || contact.number || 'Unknown';
        // استخدام msg.author (رقم الجوال) كمعرّف ثابت وليس الاسم المعروض
        const senderId = msg.author || msg.from;

        // =============================================
        // 🖼 معالجة الصور
        // =============================================
        if (msg.hasMedia) {
            console.log(`\n🖼 صورة وردت من ${senderName} (${senderId}) في ${groupName}`);

            const media = await msg.downloadMedia();
            if (!media) {
                console.log('⚠️ فشل تحميل الميديا');
                return;
            }

            // تصفية — فقط الصور
            if (!media.mimetype.startsWith('image/')) {
                console.log(`⏩ تم تجاهل ميديا غير صورة: ${media.mimetype}`);
                return;
            }

            stats.imagesProcessed++;

            const caption = msg.body || '';
            let wo = null;
            const match = caption.match(woPattern);
            const senderKey = `${groupId}_${senderId}`;

            if (match) {
                wo = match[0];
                recentWorkOrders.set(senderKey, { workOrder: wo, timestamp: Date.now() });
                console.log(`🎯 تم استخراج رقم أمر العمل من الكابشن: ${wo}`);
            } else {
                // محاولة استرجاع من الذاكرة المؤقتة (صالح لـ 5 دقائق)
                const cached = recentWorkOrders.get(senderKey);
                if (cached && (Date.now() - cached.timestamp < 300000)) {
                    wo = cached.workOrder;
                    console.log(`🧠 تم استرجاع رقم أمر العمل من الذاكرة المؤقتة للمرسل: ${wo}`);
                }
            }

            const payload = {
                type: 'image',
                image_base64: media.data,
                mimetype: media.mimetype,
                caption: caption,
                work_order: wo || '',
                group_id: groupId,
                group_name: groupName,
                sender: senderId,
                sender_name: senderName,
                timestamp: msg.timestamp || Math.floor(Date.now() / 1000)
            };

            // ✨ إضافة للطابور بدلاً من الإرسال المباشر
            enqueueImage(payload, msg.from);
            return;
        }

        // =============================================
        // 💬 معالجة النصوص
        // =============================================
        const text = msg.body?.trim();
        if (!text) return;

        // =============================================
        // 🔧 أوامر البوت
        // =============================================

        // أمر إعادة تعيين: !reset 262040204
        const resetMatch = text.match(/^!reset\s+(\d+)$/i);
        if (resetMatch) {
            const wo = resetMatch[1];
            console.log(`\n🔄 أمر إعادة تعيين من ${senderName}: WO ${wo}`);
            try {
                const response = await fetch(`${PHP_API_URL}/reset-wo.php`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ work_order: wo }),
                    signal: AbortSignal.timeout(10000)
                });
                const result = await response.json();
                if (result.success) {
                    await msg.reply(`🔄 تم إعادة تعيين أمر العمل ${wo}\n🗑️ تم حذف ${result.deleted_uploads} سجل\n✅ يمكنك الآن إعادة رفع الصور`);
                } else {
                    await msg.reply(`❌ فشل: ${result.message}`);
                }
            } catch (e) {
                await msg.reply(`❌ خطأ: ${e.message}`);
            }
            return;
        }

        // أمر حالة الطابور: !status
        if (text === '!status') {
            const queueInfo = `📊 حالة البوت:\n📥 الطابور: ${uploadQueue.length} صورة\n⚙️ المعالجة: ${isProcessing ? 'نعم' : 'لا'}\n📸 صور معالجة: ${stats.imagesProcessed}\n❌ أخطاء: ${stats.errors}`;
            await msg.reply(queueInfo);
            return;
        }

        // أمر نقل صور: !move 262040204 123456789 3
        // ينقل آخر 3 صور من أمر العمل الأول إلى الثاني
        const moveMatch = text.match(/^!move\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/i);
        if (moveMatch) {
            const fromWO = moveMatch[1];
            const toWO = moveMatch[2];
            const count = parseInt(moveMatch[3] || '1', 10);
            console.log(`\n📦 أمر نقل من ${senderName}: ${count} صورة من WO ${fromWO} إلى WO ${toWO}`);
            try {
                const response = await fetch(`${PHP_API_URL}/move-images.php`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ from_wo: fromWO, to_wo: toWO, count }),
                    signal: AbortSignal.timeout(30000)
                });
                const result = await response.json();
                if (result.success) {
                    await msg.reply(`📦 تم نقل ${result.moved} صورة\n📤 من: ${fromWO}\n📥 إلى: ${toWO}`);
                } else {
                    await msg.reply(`❌ فشل: ${result.message}`);
                }
            } catch (e) {
                await msg.reply(`❌ خطأ: ${e.message}`);
            }
            return;
        }

        // أمر المساعدة: !help
        if (text === '!help') {
            const help = `🤖 أوامر البوت:\n\n` +
                `📋 *!status* — حالة البوت والطابور\n` +
                `🔄 *!reset 262040204* — مسح سجلات أمر عمل لإعادة الرفع\n` +
                `📦 *!move 111111111 222222222 3* — نقل آخر 3 صور من أمر عمل لآخر\n` +
                `❓ *!help* — عرض هذه الأوامر`;
            await msg.reply(help);
            return;
        }

        // فحص إذا كان النص يحتوي رقم أمر عمل
        if (!woPattern.test(text)) return;

        const textMatch = text.match(woPattern);
        if (textMatch) {
            const wo = textMatch[0];
            const senderKey = `${groupId}_${senderId}`;
            recentWorkOrders.set(senderKey, { workOrder: wo, timestamp: Date.now() });
            console.log(`🎯 تم حفظ رقم أمر العمل من الرسالة النصية للمرسل: ${wo}`);
        }

        stats.textProcessed++;
        console.log(`\n💬 نص يحتوي رقم أمر عمل من ${senderName} (${senderId}) في ${groupName}: ${text}`);

        const payload = {
            type: 'text',
            body: text,
            group_id: groupId,
            group_name: groupName,
            sender: senderId,
            sender_name: senderName,
            timestamp: msg.timestamp || Math.floor(Date.now() / 1000)
        };

        const result = await sendToPhpApi(payload);

        if (result && result.success && result.work_order) {
            console.log(`✅ رقم أمر العمل: ${result.work_order}`);

            if (result.queued_images_updated > 0) {
                console.log(`📎 تم ربط ${result.queued_images_updated} صورة معلّقة`);
                await msg.reply(`📎 تم ربط ${result.queued_images_updated} صورة بأمر العمل ${result.work_order}`);
            }
        }

    } catch (error) {
        console.error('❌ خطأ في معالجة الرسالة:', error.message);
        stats.errors++;
    }
});

// =============================================
// 🔗 إرسال البيانات لـ PHP API
// =============================================

async function sendToPhpApi(payload) {
    try {
        const response = await fetch(`${PHP_API_URL}/process-image.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(API_TIMEOUT_MS) // 120 ثانية
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ PHP API HTTP ${response.status}:`, errorText.substring(0, 200));
            return { success: false, message: `HTTP ${response.status}: ${errorText.substring(0, 100)}` };
        }

        return await response.json();

    } catch (error) {
        console.error('❌ خطأ في الاتصال بـ PHP API:', error.message);
        return { success: false, message: error.message };
    }
}

// =============================================
// 🌐 Express API Endpoints
// =============================================

// حالة البوت
app.get('/status', (req, res) => {
    res.json({
        success: true,
        whatsapp_ready: isClientReady,
        has_qr: qrCodeData !== null,
        uptime: Math.floor((Date.now() - stats.startTime) / 1000),
        stats: stats,
        queue_size: uploadQueue.length,
        queue_processing: isProcessing,
        monitored_groups: monitoredGroups,
        php_api_url: PHP_API_URL
    });
});

// قائمة المجموعات
app.get('/groups', async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({ success: false, message: 'واتساب غير جاهز' });
    }
    try {
        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup).map(g => ({
            id: g.id._serialized,
            name: g.name,
            participant_count: g.participants?.length || 0
        }));
        res.json({ success: true, groups });
    } catch (error) {
        res.status(500).json({ success: false, message: error.toString() });
    }
});

// إرسال رسالة
app.post('/send-message', async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({ success: false, message: 'واتساب غير جاهز' });
    }

    const { number, message, isGroup } = req.body;
    if (!number || !message) {
        return res.status(400).json({ success: false, message: 'number and message required' });
    }

    try {
        let chatId = '';
        if (isGroup || number.endsWith('@g.us')) {
            chatId = number.includes('@g.us') ? number : `${number}@g.us`;
        } else {
            let clean = number.replace(/[^0-9]/g, '');
            if (clean.startsWith('05')) {
                clean = '966' + clean.substring(1);
            }
            chatId = `${clean}@c.us`;
        }

        const response = await client.sendMessage(chatId, message);
        res.json({ success: true, message: 'تم الإرسال!', responseId: response.id.id });
    } catch (error) {
        res.status(500).json({ success: false, message: error.toString() });
    }
});

// تحديث المجموعات المراقبة
app.post('/monitor-groups', (req, res) => {
    const { groups } = req.body;
    if (groups === 'all' || (Array.isArray(groups) && groups.length > 0)) {
        monitoredGroups = Array.isArray(groups) ? groups.join(',') : groups;
        console.log(`📋 تحديث المجموعات المراقبة: ${monitoredGroups}`);
        res.json({ success: true, monitored_groups: monitoredGroups });
    } else {
        res.status(400).json({ success: false, message: 'Invalid groups format' });
    }
});

// =============================================
// 🚀 تشغيل الخادم
// =============================================

app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     🤖 WhatsToot Bot - Starting...       ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`📡 API Server: http://localhost:${PORT}`);
    console.log('⏳ جاري تهيئة واتساب...\n');
    console.log('📋 Endpoints:');
    console.log(`   GET  /status          - حالة البوت`);
    console.log(`   GET  /groups          - قائمة المجموعات`);
    console.log(`   POST /send-message    - إرسال رسالة`);
    console.log(`   POST /monitor-groups  - تحديث المجموعات\n`);
});

client.initialize();
