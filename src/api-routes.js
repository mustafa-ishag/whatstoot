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
const db = require('./database');
const config = require('./config');

/**
 * تسجيل API routes
 * @param {express.Application} app
 * @param {import('./whatsapp-bot')} bot
 * @param {*} uploader
 * @param {import('./logger')} logger
 */
function register(app, bot, uploader, logger) {

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

    app.post('/api/settings', (req, res) => {
        try {
            const { key, value } = req.body || {};

            if (!key || value === undefined) {
                return res.status(400).json({ success: false, message: 'key and value required' });
            }

            const allowedKeys = ['bot_enabled', 'auto_reply', 'monitor_groups', 'await_timeout'];
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

    app.get('/api/reset-wo', handleResetWO);
    app.post('/api/reset-wo', handleResetWO);

    // =============================================
    // 📦 نقل صور بين أوامر عمل
    // POST /api/move-images
    // =============================================
    app.post('/api/move-images', async (req, res) => {
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
    // 📋 قائمة المجموعات
    // GET /api/groups  أو  GET /groups
    // =============================================
    const groupsHandler = async (req, res) => {
        if (!bot.isClientReady) {
            return res.status(503).json({ success: false, message: 'واتساب غير جاهز' });
        }
        try {
            const chats = await bot.client.getChats();
            const groups = chats.filter(c => c.isGroup).map(g => ({
                id: g.id._serialized,
                name: g.name,
                participant_count: g.participants?.length || 0,
            }));
            res.json({ success: true, groups });
        } catch (e) {
            res.status(500).json({ success: false, message: e.toString() });
        }
    };

    app.get('/api/groups', groupsHandler);
    app.get('/groups', groupsHandler);

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

    app.post('/api/send-message', sendMessageHandler);
    app.post('/send-message', sendMessageHandler);

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
}

module.exports = { register };
