/**
 * API Routes - كل نقاط API في Express
 * 
 * يدمج كل PHP APIs في ملف واحد:
 * - stats.php → GET /api/stats
 * - uploads.php → GET /api/uploads
 * - settings.php → GET/POST /api/settings
 * - reset-wo.php → POST /api/reset-wo
 * - move-images.php → POST /api/move-images
 * - api-proxy.php → (حُذف — الوصول مباشر)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const db = require('./database');
const config = require('./config');
const QRCode = require('qrcode');

const THUMB_CACHE_DIR = path.join(config.BASE_PATH, 'cache', 'thumbnails');
if (!fs.existsSync(THUMB_CACHE_DIR)) {
    try {
        fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });
    } catch (e) {}
}

function getThumbCachePath(driveId, size) {
    const hash = crypto.createHash('md5').update(`${driveId}_${size}`).digest('hex');
    return path.join(THUMB_CACHE_DIR, `${hash}.jpg`);
}

/**
 * تسجيل API routes
 * @param {express.Application} app
 * @param {import('./whatsapp-bot')} bot
 * @param {*} uploader
 * @param {import('./logger')} logger
 */
function register(app, bot, uploader, logger, emailReader) {

    // =============================================
    // 🔒 وسيط التحقق من الصلاحيات (Security Middleware)
    // =============================================
    const requireAuth = (req, res, next) => {
        const apiKey = req.headers['x-api-key'] || req.query.api_key;
        const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
        const isSameOrigin = req.headers['sec-fetch-site'] === 'same-origin' || 
                             (req.headers['referer'] && req.headers['referer'].includes(req.headers['host']));

        // السماح للطلبات الواردة من نفس المتصفح/اللوحة أو عند تطابق مفتاح الـ API
        if (isLocalhost || isSameOrigin || (apiKey && apiKey === config.API_KEY)) {
            return next();
        }

        // في بيئة التطوير، السماح للتجربة
        if (!config.API_KEY || config.APP_ENV === 'development') {
            return next();
        }

        return res.status(401).json({ success: false, message: 'غير مصرح: مفتاح API غير صحيح أو مفقود' });
    };

    // =============================================
    // ⚡ التحديثات اللحظية (Server-Sent Events)
    // GET /api/events
    // =============================================
    const sseClients = new Set();

    app.get('/api/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);

        sseClients.add(res);

        req.on('close', () => {
            sseClients.delete(res);
        });
    });

    const broadcastSSE = (eventType, data) => {
        const message = `data: ${JSON.stringify({ type: eventType, data, time: new Date().toISOString() })}\n\n`;
        for (const client of sseClients) {
            try {
                client.write(message);
            } catch (e) {
                sseClients.delete(client);
            }
        }
    };

    // ربط أحداث البوت بالبث اللحظي
    if (bot && typeof bot.on === 'function') {
        bot.on('upload', (data) => broadcastSSE('upload', data));
        bot.on('status', (data) => broadcastSSE('bot_status', data));
        bot.on('qr', (data) => broadcastSSE('qr', data));
    }

    // =============================================
    // 📊 إحصائيات
    // GET /api/stats
    // =============================================
    app.get('/api/stats', (req, res) => {
        try {
            const stats = db.getStats();
            const recentUploads = db.getUploads(20);

            res.json({
                success: true,
                stats,
                recent_uploads: recentUploads,
                bot_status: {
                    connected: true,
                    whatsapp_ready: bot.isClientReady,
                    has_qr: bot.qrCodeData !== null,
                    uptime: Math.floor((Date.now() - bot.stats.startTime) / 1000),
                    stats: bot.stats,
                    queue_size: bot.uploadQueue.length,
                    queue_processing: bot.isProcessing,
                    monitored_groups: bot.monitoredGroups,
                },
                server_time: new Date().toISOString().replace('T', ' ').substring(0, 19),
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 📤 قائمة الرفعات
    // GET /api/uploads?wo=123&status=completed&limit=50&offset=0
    // =============================================
    app.get('/api/uploads', (req, res) => {
        try {
            const woFilter = req.query.wo || null;
            const status = req.query.status || null;
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const offset = Math.max(parseInt(req.query.offset) || 0, 0);

            const uploads = db.getUploads(limit, offset, woFilter, status);

            res.json({
                success: true,
                uploads,
                count: uploads.length,
                limit,
                offset,
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 🔑 الإعدادات
    // GET  /api/settings
    // POST /api/settings
    // =============================================
    app.get('/api/settings', (req, res) => {
        try {
            const settings = db.getAllSettings();
            res.json({ success: true, settings });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    app.post('/api/settings', requireAuth, (req, res) => {
        try {
            const { key, value } = req.body || {};

            if (!key || value === undefined) {
                return res.status(400).json({ success: false, message: 'key and value required' });
            }

            const allowedKeys = ['bot_enabled', 'auto_reply', 'monitor_groups', 'await_timeout', 'email_whatsapp_target'];
            if (!allowedKeys.includes(key)) {
                return res.status(400).json({ success: false, message: 'Invalid setting key' });
            }

            db.setSetting(key, value);
            res.json({ success: true, message: `تم تحديث الإعداد: ${key}` });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 🔄 إعادة تعيين أمر عمل
    // POST /api/reset-wo
    // GET  /api/reset-wo?wo=262040204
    // =============================================
    const handleResetWO = (req, res) => {
        try {
            let workOrder = null;
            if (req.method === 'POST') {
                workOrder = req.body?.work_order;
            } else {
                workOrder = req.query.wo;
            }

            const woRegex = new RegExp(`^\\d{${config.WORK_ORDER_DIGITS}}$`);
            if (!workOrder || !woRegex.test(workOrder)) {
                return res.status(400).json({
                    success: false,
                    message: `رقم أمر العمل مطلوب (يجب أن يكون ${config.WORK_ORDER_DIGITS} أرقام)`,
                });
            }

            const result = db.resetWorkOrder(workOrder);

            logger.info(`Reset WO ${workOrder}: deleted ${result.deletedUploads} uploads, ${result.deletedFolders} folder cache, ${result.deletedQueue} queue items`);

            res.json({
                success: true,
                work_order: workOrder,
                deleted_uploads: result.deletedUploads,
                deleted_folders: result.deletedFolders,
                deleted_queue: result.deletedQueue,
                message: `تم مسح ${result.deletedUploads} سجل لأمر العمل ${workOrder}. يمكنك إعادة رفع الصور الآن.`,
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    };

    app.get('/api/reset-wo', requireAuth, handleResetWO);
    app.post('/api/reset-wo', requireAuth, handleResetWO);

    // =============================================
    // 📦 نقل صور بين أوامر عمل
    // POST /api/move-images
    // =============================================
    app.post('/api/move-images', requireAuth, async (req, res) => {
        const { from_wo, to_wo, count: rawCount } = req.body || {};
        const count = Math.max(1, Math.min(parseInt(rawCount) || 1, 50));

        if (!from_wo || !to_wo) {
            return res.status(400).json({ success: false, message: 'from_wo و to_wo مطلوبان' });
        }

        try {
            const images = db.getUploadsForMove(from_wo, count);

            if (images.length === 0) {
                return res.json({ success: false, message: `لا توجد صور في أمر العمل ${from_wo}` });
            }

            let moved = 0;
            const movedFiles = [];

            for (const img of images) {
                const targetSubFolder = img.group_id ? img.group_name : img.sender;
                const newFolder = await uploader.getOrCreateFolder(to_wo, targetSubFolder);
                
                let sourcePath = img.drive_id;
                if (!sourcePath) {
                    const oldFolder = await uploader.getOrCreateFolder(from_wo, targetSubFolder);
                    sourcePath = oldFolder + '/' + img.file_name;
                }

                let newDriveId = null;

                try {
                    if (uploader.moveFile) {
                        await uploader.moveFile(sourcePath, newFolder);
                        newDriveId = newFolder + '/' + img.file_name;
                    }
                } catch (e) {
                    logger.warning(`Could not move file ${img.file_name} on NAS: ${e.message}`);
                }

                db.updateUploadWorkOrder(img.id, to_wo, newDriveId);

                moved++;
                movedFiles.push(img.file_name);
            }

            logger.info(`Moved ${moved} images from WO ${from_wo} to WO ${to_wo}`);

            res.json({
                success: true,
                moved,
                from_wo,
                to_wo,
                files: movedFiles,
                message: `تم نقل ${moved} صورة من أمر العمل ${from_wo} إلى ${to_wo}`,
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 🤖 حالة البوت (مباشرة)
    // GET /api/bot-status  أو  GET /status
    // =============================================
    const botStatusHandler = (req, res) => {
        res.json({
            success: true,
            whatsapp_ready: bot.isClientReady,
            has_qr: bot.qrCodeData !== null,
            uptime: Math.floor((Date.now() - bot.stats.startTime) / 1000),
            stats: bot.stats,
            queue_size: bot.uploadQueue.length,
            queue_processing: bot.isProcessing,
            monitored_groups: bot.monitoredGroups,
        });
    };

    app.get('/api/bot-status', botStatusHandler);
    app.get('/status', botStatusHandler);

    // =============================================
    // 📱 QR Code للمصادقة
    // GET /api/qr
    // =============================================
    app.get('/api/qr', async (req, res) => {
        try {
            if (bot.isClientReady) {
                return res.json({ success: false, reason: 'connected', message: 'واتساب متصل بالفعل' });
            }

            if (!bot.qrCodeData) {
                return res.json({ success: false, reason: 'no_qr', message: 'لا يوجد QR Code حالياً — جاري التهيئة...' });
            }

            // تحويل بيانات QR الخام إلى صورة PNG base64
            const qrImageDataUrl = await QRCode.toDataURL(bot.qrCodeData, {
                width: 300,
                margin: 2,
                color: { dark: '#1a336b', light: '#ffffff' },
            });

            res.json({ success: true, qr: qrImageDataUrl });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 🔌 قطع اتصال واتساب
    // POST /api/disconnect
    // =============================================
    app.post('/api/disconnect', requireAuth, async (req, res) => {
        try {
            console.log('🔌 طلب قطع اتصال واتساب من لوحة التحكم...');
            bot.isClientReady = false;
            bot.manualDisconnect = true;

            // كتابة علامة مسح الجلسة — سيتم مسحها عند إعادة التشغيل
            const fs = require('fs');
            const flagPath = path.join(config.BASE_PATH, '.clear_session');
            fs.writeFileSync(flagPath, new Date().toISOString());
            console.log('📝 تم كتابة علامة مسح الجلسة');

            res.json({ success: true, message: 'جاري إعادة تشغيل النظام... الباركود سيظهر خلال 15 ثانية.' });

            // إغلاق العملية بعد ثانية واحدة — systemd أو PM2 سيعيد التشغيل
            setTimeout(() => {
                console.log('🔄 إعادة تشغيل العملية...');
                process.exit(0);
            }, 1000);

        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 📋 قائمة المجموعات (حل مشكلة عدم ظهور المجموعات)
    // GET /api/groups  أو  GET /groups
    // =============================================
    const groupsHandler = async (req, res) => {
        let liveGroups = [];

        // محاولة جلب المجموعات الحية بأمان عبر Puppeteer إذا كان الواتساب متصلاً
        if (bot.isClientReady && bot.client?.pupPage) {
            try {
                liveGroups = await bot.client.pupPage.evaluate(() => {
                    const ChatCollection = window.require?.('WAWebCollections')?.Chat;
                    if (!ChatCollection) return [];
                    return ChatCollection.getModelsArray()
                        .filter(c => {
                            if (!c || !c.id) return false;
                            const isGrp = (c.id._serialized && c.id._serialized.endsWith('@g.us')) || 
                                          c.id.server === 'g.us' || 
                                          Boolean(c.groupMetadata);
                            return isGrp && !c.isNewsletter && !c.isChannel;
                        })
                        .map(c => ({
                            id: c.id?._serialized,
                            name: c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || 'مجموعة بدون اسم',
                            participant_count: c.participants?.length || (c.groupMetadata?.participants?.length) || 0,
                        }))
                        .filter(g => g.id);
                });

                if (Array.isArray(liveGroups) && liveGroups.length > 0) {
                    for (const g of liveGroups) {
                        db.saveGroup(g.id, g.name, g.participant_count);
                    }
                }
            } catch (evalErr) {
                logger.warning(`Failed to fetch live WhatsApp groups: ${evalErr.message}`);
            }
        }

        // جلب جميع المجموعات المحفوظة من قاعدة البيانات (مع المزامنة من uploads)
        const cachedGroups = db.getAllCachedGroups();

        // دمج المجموعات المباشرة مع المخزنة مؤقتاً لضمان عدم فقدان أي مجموعة
        const groupMap = new Map();
        for (const g of cachedGroups) {
            groupMap.set(g.id, g);
        }
        for (const g of liveGroups) {
            groupMap.set(g.id, g);
        }

        const groups = Array.from(groupMap.values()).map(g => ({
            id: g.id,
            name: g.name,
            participant_count: g.participant_count || 0,
            last_active: g.last_active || null
        }));

        res.json({
            success: true,
            groups,
            count: groups.length,
            is_live: liveGroups.length > 0
        });
    };

    app.get('/api/groups', groupsHandler);
    app.get('/groups', groupsHandler);

    // =============================================
    // 📊 تصدير البيانات إلى Excel/CSV
    // GET /api/export-csv?wo=123&status=completed
    // =============================================
    app.get('/api/export-csv', (req, res) => {
        try {
            const woFilter = req.query.wo || null;
            const status = req.query.status || null;

            const uploads = db.getUploadsForExport(woFilter, status);

            // إضافة BOM لتوافق الأحرف العربية التام مع Excel
            let csv = '\uFEFF';
            csv += 'المعرف,أمر العمل,اسم الملف,المجموعة,المرسل,الكابشن,الحالة,تاريخ الرفع\n';

            const escapeCsv = (val) => {
                if (val === null || val === undefined) return '""';
                return `"${String(val).replace(/"/g, '""')}"`;
            };

            for (const row of uploads) {
                csv += [
                    row.id,
                    escapeCsv(row.work_order),
                    escapeCsv(row.file_name),
                    escapeCsv(row.group_name),
                    escapeCsv(row.sender),
                    escapeCsv(row.caption),
                    escapeCsv(row.status),
                    escapeCsv(row.uploaded_at)
                ].join(',') + '\n';
            }

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="whatstoot_export_${Date.now()}.csv"`);
            res.send(csv);

        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 📨 إرسال رسالة
    // POST /api/send-message  أو  POST /send-message
    // =============================================
    const sendMessageHandler = async (req, res) => {
        if (!bot.isClientReady) {
            return res.status(503).json({ success: false, message: 'واتساب غير جاهز' });
        }

        const { number, message, isGroup } = req.body || {};
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

            const response = await bot.client.sendMessage(chatId, message);
            res.json({ success: true, message: 'تم الإرسال!', responseId: response.id.id });
        } catch (e) {
            res.status(500).json({ success: false, message: e.toString() });
        }
    };

    app.post('/api/send-message', requireAuth, sendMessageHandler);
    app.post('/send-message', requireAuth, sendMessageHandler);

    // =============================================
    // 📝 سجل الأحداث
    // GET /api/logs?date=2026-06-03
    // =============================================
    app.get('/api/logs', (req, res) => {
        try {
            const date = req.query.date || null;
            const content = logger.readLogFile(date, 200);
            res.json({
                success: true,
                logs: content,
                date: date || new Date().toISOString().substring(0, 10),
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 📋 تحديث المجموعات المراقبة
    // POST /api/monitor-groups  أو  POST /monitor-groups
    // =============================================
    const monitorGroupsHandler = (req, res) => {
        const { groups } = req.body || {};
        if (groups === 'all' || (Array.isArray(groups) && groups.length > 0)) {
            bot.monitoredGroups = Array.isArray(groups) ? groups.join(',') : groups;
            console.log(`📋 تحديث المجموعات المراقبة: ${bot.monitoredGroups}`);
            res.json({ success: true, monitored_groups: bot.monitoredGroups });
        } else {
            res.status(400).json({ success: false, message: 'Invalid groups format' });
        }
    };

    app.post('/api/monitor-groups', monitorGroupsHandler);
    app.post('/monitor-groups', monitorGroupsHandler);

    // =============================================
    // 🔍 اختبار الاتصال بـ Storage
    // GET /api/test-storage
    // =============================================
    app.get('/api/test-storage', async (req, res) => {
        try {
            const result = await uploader.testConnection();
            res.json(result);
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    // =============================================
    // 📁 مستعرض أوامر العمل (Work Orders Explorer)
    // GET /api/work-orders?search=...&limit=100&offset=0&sync=1
    // =============================================
    let cachedSynologyFolders = null;
    let lastSynologySync = 0;

    app.get('/api/work-orders', async (req, res) => {
        try {
            const search = req.query.search || null;
            const limit = Math.min(parseInt(req.query.limit) || 200, 500);
            const offset = Math.max(parseInt(req.query.offset) || 0, 0);
            const forceSync = req.query.sync === '1' || req.query.sync === 'true';

            // 1. أوامر العمل المسجلة في قاعدة البيانات (فورية)
            const dbOrders = db.getWorkOrdersSummary(search, limit, offset);

            // 2. فحص سينولجي إذا كان متاحاً ومزامنة المجلدات
            let synologyOrders = [];
            const now = Date.now();
            if (uploader && uploader.listWorkOrderFolders && (forceSync || !cachedSynologyFolders || (now - lastSynologySync > 60000))) {
                try {
                    cachedSynologyFolders = await uploader.listWorkOrderFolders();
                    lastSynologySync = now;
                } catch (e) {
                    logger.warning(`Failed to sync folders from Synology: ${e.message}`);
                }
            }

            if (cachedSynologyFolders && Array.isArray(cachedSynologyFolders)) {
                synologyOrders = cachedSynologyFolders;
            }

            // دمج القائمتين لضمان ظهور كل أمر عمل سواء في قاعدة البيانات أو سينولجي
            const orderMap = new Map();
            for (const item of dbOrders) {
                orderMap.set(String(item.work_order), {
                    work_order: String(item.work_order),
                    file_count: item.file_count || 0,
                    last_activity: item.last_activity || null,
                    first_activity: item.first_activity || null,
                    preview_upload_id: item.preview_upload_id || null,
                    preview_file_name: item.preview_file_name || null,
                    source: 'database',
                });
            }

            for (const sItem of synologyOrders) {
                const woName = sItem.name;
                if (search && !woName.includes(search)) continue;

                if (orderMap.has(woName)) {
                    const existing = orderMap.get(woName);
                    existing.source = 'both';
                    existing.nas_path = sItem.path;
                } else {
                    orderMap.set(woName, {
                        work_order: woName,
                        file_count: 0,
                        last_activity: sItem.time ? new Date(sItem.time * 1000).toISOString().replace('T', ' ').substring(0, 19) : null,
                        first_activity: null,
                        preview_upload_id: null,
                        preview_file_name: null,
                        nas_path: sItem.path,
                        source: 'synology',
                    });
                }
            }

            const allOrders = Array.from(orderMap.values());
            allOrders.sort((a, b) => {
                const tA = a.last_activity ? new Date(a.last_activity).getTime() : 0;
                const tB = b.last_activity ? new Date(b.last_activity).getTime() : 0;
                return tB - tA;
            });

            res.json({
                success: true,
                work_orders: allOrders.slice(offset, offset + limit),
                total: allOrders.length,
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 📂 ملفات أمر عمل محدد
    // GET /api/work-orders/:wo
    // =============================================
    app.get('/api/work-orders/:wo', async (req, res) => {
        try {
            const wo = req.params.wo;
            if (!wo) return res.status(400).json({ success: false, message: 'Work order required' });

            const dbFiles = db.getFilesByWorkOrder(wo);
            const fileMap = new Map();

            for (const f of dbFiles) {
                fileMap.set(f.file_name, {
                    id: f.id,
                    file_name: f.file_name,
                    drive_id: f.drive_id,
                    thumb_url: `/api/image-thumb/${f.id}`,
                    full_url: `/api/image-full/${f.id}`,
                    download_url: `/api/synology/download?path=${encodeURIComponent(f.drive_id || '')}&name=${encodeURIComponent(f.file_name)}`,
                    group_name: f.group_name,
                    sender: f.sender,
                    caption: f.caption,
                    uploaded_at: f.uploaded_at,
                    source: 'database',
                });
            }

            // فحص سينولجي إذا لم تكن هناك سجلات أو لملفات إضافية
            if (uploader && uploader.listFiles) {
                try {
                    const nasFiles = await uploader.listFiles(wo);
                    for (const nf of nasFiles) {
                        if (!fileMap.has(nf.name)) {
                            fileMap.set(nf.name, {
                                id: null,
                                file_name: nf.name,
                                drive_id: nf.path,
                                thumb_url: `/api/synology/thumb?path=${encodeURIComponent(nf.path)}`,
                                full_url: `/api/synology/full?path=${encodeURIComponent(nf.path)}`,
                                download_url: `/api/synology/download?path=${encodeURIComponent(nf.path)}&name=${encodeURIComponent(nf.name)}`,
                                uploaded_at: nf.time ? new Date(nf.time * 1000).toISOString().replace('T', ' ').substring(0, 19) : null,
                                source: 'synology',
                            });
                        }
                    }
                } catch (nasErr) {
                    logger.warning(`Failed to list files from NAS for WO ${wo}: ${nasErr.message}`);
                }
            }

            const files = Array.from(fileMap.values());

            res.json({
                success: true,
                work_order: wo,
                count: files.length,
                files,
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // ⚡️ استعراض صورة مصغّرة مع تخزين مؤقت على القرص (سريع جداً جداً)
    // GET /api/image-thumb/:id
    // =============================================
    app.get('/api/image-thumb/:id', async (req, res) => {
        try {
            const uploadId = parseInt(req.params.id);
            if (!uploadId) return res.status(400).send('Invalid ID');

            const upload = db.getUploadById(uploadId);
            if (!upload || !upload.drive_id) {
                return res.status(404).send('Image not found');
            }

            const size = req.query.size || 'medium';
            const cacheFile = getThumbCachePath(upload.drive_id, size);

            // فحص الكاش المحلي أولاً — استجابة فورية بأجزاء من الثانية!
            if (fs.existsSync(cacheFile)) {
                res.set({
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': 'public, max-age=2592000, immutable',
                    'X-Work-Order': upload.work_order,
                    'X-Cache': 'HIT',
                });
                return res.sendFile(cacheFile);
            }

            if (!uploader.getThumbnail) {
                return res.status(501).send('Thumbnails not supported with current storage');
            }

            const thumbBuffer = await uploader.getThumbnail(upload.drive_id, size);

            // حفظ في الكاش المحلي للمرات القادمة
            fs.writeFile(cacheFile, thumbBuffer, () => {});

            res.set({
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=2592000, immutable',
                'X-Work-Order': upload.work_order,
                'X-Cache': 'MISS',
            });
            res.send(thumbBuffer);
        } catch (e) {
            logger.warning(`Thumbnail proxy error: ${e.message}`);
            res.status(500).send('Could not load thumbnail');
        }
    });

    // =============================================
    // ⚡️ استعراض مصغّر عبر مسار سينولجي مباشرة
    // GET /api/synology/thumb?path=...&size=medium
    // =============================================
    app.get('/api/synology/thumb', async (req, res) => {
        try {
            const filePath = req.query.path;
            const size = req.query.size || 'medium';
            if (!filePath) return res.status(400).send('Path required');

            const cacheFile = getThumbCachePath(filePath, size);
            if (fs.existsSync(cacheFile)) {
                res.set({
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': 'public, max-age=2592000, immutable',
                    'X-Cache': 'HIT',
                });
                return res.sendFile(cacheFile);
            }

            if (!uploader || !uploader.getThumbnail) {
                return res.status(501).send('Thumbnails not supported');
            }

            const thumbBuffer = await uploader.getThumbnail(filePath, size);
            fs.writeFile(cacheFile, thumbBuffer, () => {});

            res.set({
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=2592000, immutable',
                'X-Cache': 'MISS',
            });
            res.send(thumbBuffer);
        } catch (e) {
            res.status(500).send('Could not load thumbnail');
        }
    });

    // =============================================
    // 🖼 استعراض الصورة بالحجم الكامل
    // GET /api/image-full/:id
    // =============================================
    app.get('/api/image-full/:id', async (req, res) => {
        try {
            const uploadId = parseInt(req.params.id);
            if (!uploadId) return res.status(400).send('Invalid ID');

            const upload = db.getUploadById(uploadId);
            if (!upload || !upload.drive_id) {
                return res.status(404).send('Image not found');
            }

            if (!uploader.downloadFile) {
                return res.status(501).send('Download not supported with current storage');
            }

            const { buffer, contentType } = await uploader.downloadFile(upload.drive_id);

            res.set({
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=2592000, immutable',
                'X-Work-Order': upload.work_order,
                'X-File-Name': upload.file_name,
            });
            res.send(buffer);
        } catch (e) {
            logger.warning(`Image proxy error: ${e.message}`);
            res.status(500).send('Could not load image');
        }
    });

    // =============================================
    // 🖼 استعراض بالحجم الكامل عبر مسار سينولجي
    // GET /api/synology/full?path=...
    // =============================================
    app.get('/api/synology/full', async (req, res) => {
        try {
            const filePath = req.query.path;
            if (!filePath) return res.status(400).send('Path required');

            if (!uploader || !uploader.downloadFile) {
                return res.status(501).send('Download not supported');
            }

            const { buffer, contentType } = await uploader.downloadFile(filePath);
            res.set({
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=2592000, immutable',
            });
            res.send(buffer);
        } catch (e) {
            res.status(500).send('Could not load image');
        }
    });

    // =============================================
    // ⬇️ تحميل ملف فردي
    // GET /api/synology/download?path=...&name=...
    // =============================================
    app.get('/api/synology/download', async (req, res) => {
        try {
            const filePath = req.query.path;
            const fileName = req.query.name || path.basename(filePath);
            if (!filePath) return res.status(400).send('Path required');

            if (!uploader || !uploader.downloadFile) {
                return res.status(501).send('Download not supported');
            }

            const { buffer, contentType } = await uploader.downloadFile(filePath);
            res.set({
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
            });
            res.send(buffer);
        } catch (e) {
            res.status(500).send('Download error');
        }
    });

    // =============================================
    // 📦 تحميل كل الصور أو صور محددة كملف مضغوط (ZIP Streaming)
    // GET  /api/work-orders/:wo/zip
    // POST /api/work-orders/:wo/download-selected-zip
    // =============================================
    const handleDownloadZip = async (req, res) => {
        const wo = req.params.wo;
        const selectedIds = req.body?.ids || null;

        try {
            let files = db.getFilesByWorkOrder(wo);
            if (selectedIds && Array.isArray(selectedIds) && selectedIds.length > 0) {
                const idSet = new Set(selectedIds.map(Number));
                files = files.filter(f => idSet.has(f.id));
            }

            if (files.length === 0 && uploader && uploader.listFiles) {
                const nasFiles = await uploader.listFiles(wo);
                files = nasFiles.map(nf => ({
                    file_name: nf.name,
                    drive_id: nf.path,
                }));
            }

            if (files.length === 0) {
                return res.status(404).send('لا توجد ملفات لتحميلها');
            }

            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="WO_${wo}_images_${Date.now()}.zip"`);

            const archive = archiver('zip', {
                zlib: { level: 4 },
            });

            archive.on('error', (err) => {
                logger.warning(`Archive error for WO ${wo}: ${err.message}`);
                if (!res.headersSent) res.status(500).send('Archive error');
            });

            archive.pipe(res);

            for (const file of files) {
                if (!file.drive_id) continue;
                try {
                    const { buffer } = await uploader.downloadFile(file.drive_id);
                    archive.append(buffer, { name: file.file_name });
                } catch (err) {
                    logger.warning(`Failed to add file ${file.file_name} to zip: ${err.message}`);
                }
            }

            await archive.finalize();
        } catch (e) {
            logger.warning(`ZIP download failed: ${e.message}`);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: e.message });
            }
        }
    };

    app.get('/api/work-orders/:wo/zip', handleDownloadZip);
    app.post('/api/work-orders/:wo/download-selected-zip', handleDownloadZip);

    // =============================================
    // 🚚 نقل صور بين أوامر عمل (محددة أو الكل)
    // POST /api/work-orders/move
    // =============================================
    app.post('/api/work-orders/move', requireAuth, async (req, res) => {
        try {
            const { from_wo, to_wo, file_ids, all } = req.body || {};

            if (!from_wo || !to_wo) {
                return res.status(400).json({ success: false, message: 'from_wo و to_wo مطلوبان' });
            }

            let filesToMove = [];
            if (all) {
                filesToMove = db.getFilesByWorkOrder(from_wo);
            } else if (Array.isArray(file_ids) && file_ids.length > 0) {
                const allFiles = db.getFilesByWorkOrder(from_wo);
                const idSet = new Set(file_ids.map(Number));
                filesToMove = allFiles.filter(f => idSet.has(f.id));
            } else {
                return res.status(400).json({ success: false, message: 'file_ids أو all=true مطلوب' });
            }

            if (filesToMove.length === 0) {
                return res.json({ success: false, message: 'لا توجد ملفات لنقلها' });
            }

            let moved = 0;
            const newDriveIdsMap = {};

            for (const file of filesToMove) {
                const targetSubFolder = file.group_name || file.sender || null;
                const newFolder = await uploader.getOrCreateFolder(to_wo, targetSubFolder);
                const sourcePath = file.drive_id;

                if (sourcePath && uploader.moveFile) {
                    try {
                        await uploader.moveFile(sourcePath, newFolder);
                        newDriveIdsMap[file.id] = `${newFolder}/${file.file_name}`;
                    } catch (moveErr) {
                        logger.warning(`Synology move error for ${file.file_name}: ${moveErr.message}`);
                    }
                }
                moved++;
            }

            // تحديث قاعدة البيانات
            db.moveSelectedUploads(filesToMove.map(f => f.id), to_wo, newDriveIdsMap);

            logger.info(`Moved ${moved} files from WO ${from_wo} to WO ${to_wo}`);

            res.json({
                success: true,
                moved,
                from_wo,
                to_wo,
                message: `تم نقل ${moved} ملف بنجاح من أمر العمل ${from_wo} إلى ${to_wo}`,
            });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 📧 حالة قارئ البريد الإلكتروني
    // GET /api/email-status
    // =============================================
    app.get('/api/email-status', (req, res) => {
        try {
            if (!emailReader) {
                return res.json({ success: false, message: 'Email reader not initialized' });
            }
            res.json({ success: true, ...emailReader.getStatus() });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // =============================================
    // 📧 فحص البريد يدوياً
    // POST /api/check-email
    // =============================================
    app.post('/api/check-email', async (req, res) => {
        try {
            if (!emailReader) {
                return res.json({ success: false, message: 'Email reader not initialized' });
            }
            await emailReader.checkEmails();
            res.json({ success: true, message: 'تم فحص البريد بنجاح', stats: emailReader.stats });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });
}

module.exports = { register };
