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
const db = require('./database');
const config = require('./config');
const QRCode = require('qrcode');

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
                        .filter(c => c && c.isGroup && !c.isNewsletter && !c.isChannel)
                        .map(c => ({
                            id: c.id?._serialized,
                            name: c.name || c.formattedTitle || 'Unknown Group',
                            participant_count: c.participants?.length || 0,
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
    // 🖼 استعراض صورة مصغّرة
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

            if (!uploader.getThumbnail) {
                return res.status(501).send('Thumbnails not supported with current storage');
            }

            const thumbBuffer = await uploader.getThumbnail(upload.drive_id, req.query.size || 'medium');

            res.set({
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=3600',
                'X-Work-Order': upload.work_order,
            });
            res.send(thumbBuffer);
        } catch (e) {
            logger.warning(`Thumbnail proxy error: ${e.message}`);
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
                'Cache-Control': 'public, max-age=3600',
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
