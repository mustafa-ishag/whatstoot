/**
 * WhatsAppBot - بوت واتساب
 * 
 * استخراج وتحسين كود البوت من node-bot/server.js
 * يستدعي ImageProcessor مباشرة بدلاً من إرسال HTTP إلى PHP
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { downloadMediaDirect } = require('./media-downloader');

class WhatsAppBot {
    constructor(imageProcessor, logger) {
        this.imageProcessor = imageProcessor;
        this.logger = logger;

        // تعبير نمطي مرن لاستخراج رقم أمر العمل
        this.woPattern = new RegExp(`(?<!\\d)\\d{${config.WORK_ORDER_DIGITS}}(?!\\d)`);

        // إحصائيات مباشرة
        this.stats = {
            messagesReceived: 0,
            imagesProcessed: 0,
            videosProcessed: 0,
            textProcessed: 0,
            errors: 0,
            startTime: Date.now(),
        };

        // نظام تجميع الردود
        this.uploadBatches = new Map();
        this.BATCH_DELAY_MS = 30000;

        // ذاكرة مؤقتة لحفظ آخر أمر عمل لكل مرسل
        this.recentWorkOrders = new Map();

        // نظام الطابور التتابعي
        this.uploadQueue = [];
        this.isProcessing = false;
        this.MAX_RETRIES = 3;
        this.RETRY_DELAY_MS = 5000;
        this.DELAY_BETWEEN_UPLOADS_MS = 1000;

        // المجموعات المراقبة
        this.monitoredGroups = config.MONITORED_GROUPS;

        // عميل واتساب
        this.client = new Client({
            authStrategy: new LocalAuth({
                dataPath: path.join(config.BASE_PATH, '.wwebjs_auth'),
            }),
            webVersionCache: {
                type: 'none',
            },
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-crash-reporter',
                ],
            },
        });

        this.isClientReady = false;
        this.qrCodeData = null;

        this._setupEvents();
    }

    /**
     * تهيئة أحداث عميل واتساب
     */
    _setupEvents() {
        this.client.on('loading_screen', (percent) => {
            console.log(`\n⏳ جاري تحميل واتساب ويب... ${percent}%`);
        });

        this.client.on('qr', (qr) => {
            this.qrCodeData = qr;
            console.log('\n==================================================');
            console.log('📌 امسح هذا الباركود (QR Code) بجوالك:');
            console.log('==================================================\n');
            qrcode.generate(qr, { small: true });
        });

        this.client.on('ready', () => {
            this.isClientReady = true;
            this.qrCodeData = null;
            console.log('\n✅ واتساب جاهز! البوت يراقب المجموعات الآن...');
            console.log(`🌐 API: http://localhost:${config.PORT}\n`);
            
            // معالجة الرسائل المعلقة التي وصلت أثناء إيقاف البوت
            setTimeout(() => {
                this.processUnreadMessages();
            }, 3000);
        });

        let authLogged = false;
        this.client.on('authenticated', () => {
            if (!authLogged) {
                console.log('✅ تمت المصادقة بنجاح!');
                authLogged = true;
                setTimeout(() => authLogged = false, 5000);
            }
        });

        this.client.on('auth_failure', (msg) => {
            console.error('❌ فشل المصادقة:', msg);
        });

        this.client.on('disconnected', (reason) => {
            this.isClientReady = false;
            console.log('⚠️ تم قطع الاتصال:', reason);
            
            if (this.manualDisconnect) {
                console.log('🛑 قطع اتصال يدوي — لن يتم محاولة إعادة الاتصال هنا.');
                return;
            }

            console.log('🔄 جاري محاولة إعادة الاتصال خلال 5 ثوانٍ...');
            setTimeout(() => {
                try {
                    this.client.initialize();
                } catch (e) {
                    console.error('❌ فشل إعادة الاتصال:', e.message);
                }
            }, 5000);
        });

        this.client.on('message', (msg) => this._handleMessage(msg));
    }

    /**
     * تشغيل البوت
     */
    initialize() {
        this.client.initialize();
    }

    /**
     * إعادة إنشاء عميل واتساب من جديد (بعد قطع الاتصال)
     */
    recreateClient() {
        this.client = new Client({
            authStrategy: new LocalAuth({
                dataPath: path.join(config.BASE_PATH, '.wwebjs_auth'),
            }),
            webVersionCache: {
                type: 'none',
            },
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-crash-reporter',
                ],
            },
        });

        this.isClientReady = false;
        this.qrCodeData = null;
        this._setupEvents();
        console.log('🔄 تم إنشاء عميل واتساب جديد');
    }

    /**
     * إرسال رسالة (يُستخدم من QueueWorker)
     */
    async sendMessage(chatId, message) {
        if (!this.isClientReady) return;
        const id = chatId.includes('@g.us') ? chatId : `${chatId}@g.us`;
        await this.client.sendMessage(id, message);
    }

    /**
     * معالج الرسائل الرئيسي
     */
    async _handleMessage(msg) {
        try {
            this.stats.messagesReceived++;
            console.log(`📥 رسالة جديدة مستلمة: من=${msg.from}, من_تلقائي=${msg.fromMe}, النوع=${msg.type}, النص=${msg.body ? msg.body.substring(0, 30) : ''}`);
            if (msg.fromMe) return;

            // تجاهل رسائل الحالة والمحادثات الفردية مبكراً لتجنب أخطاء Puppeteer (مثل خطأ r: r)
            if (!msg.from || !msg.from.includes('@g.us')) return;

            let groupId = msg.from;
            let groupName = 'Unknown Group';
            let chat;

            try {
                chat = await msg.getChat();
                if (!chat.isGroup) return;
                groupId = chat.id._serialized;
                groupName = chat.name || 'Unknown Group';
            } catch (err) {
                // إذا فشل getChat بسبب مشاكل Puppeteer/WhatsApp Web، نسترد الاسم من قاعدة البيانات أو المعرّف
                try {
                    const db = require('./database');
                    const row = db.getInstance().prepare('SELECT group_name FROM uploads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1').get(groupId);
                    if (row && row.group_name) {
                        groupName = row.group_name;
                    } else {
                        groupName = groupId.split('@')[0];
                    }
                } catch (dbErr) {
                    groupName = groupId.split('@')[0];
                }
                console.log(`⚠️ تعذر جلب تفاصيل المجموعة (${groupId}) بسبب خطأ الواتساب. سنستمر باستخدام الاسم: ${groupName}`);
            }

            // فحص إذا كانت المجموعة مراقبة
            if (this.monitoredGroups !== 'all') {
                const groups = Array.isArray(this.monitoredGroups)
                    ? this.monitoredGroups
                    : this.monitoredGroups.split(',').map(g => g.trim());
                if (!groups.includes(groupId) && !groups.includes(groupName)) return;
            }

            let senderName = 'Unknown';
            let senderId = msg.author || msg.from || 'Unknown';
            try {
                const contact = await msg.getContact();
                senderName = contact.pushname || contact.number || 'Unknown';
            } catch (err) {
                if (senderId) {
                    senderName = senderId.split('@')[0];
                }
            }

            // =============================================
            // 🖼 معالجة الميديا (صور + فيديو + PDF)
            // =============================================
            if (msg.hasMedia) {
                const media = await this._downloadMediaWithRetry(msg, 3, 3000);
                if (!media) {
                    console.log('⚠️ فشل تحميل الميديا بعد عدة محاولات');
                    this.stats.errors++;
                    return;
                }

                const isImage = media.mimetype.startsWith('image/');
                const isVideo = media.mimetype.startsWith('video/');
                const isPdf = media.mimetype === 'application/pdf';

                if (!isImage && !isVideo && !isPdf) {
                    console.log(`⏩ تم تجاهل ميديا غير مدعومة: ${media.mimetype}`);
                    return;
                }

                const mediaIcon = isPdf ? '📄' : (isVideo ? '🎬' : '🖼');
                const mediaType = isPdf ? 'PDF' : (isVideo ? 'فيديو' : 'صورة');
                console.log(`\n${mediaIcon} ${mediaType} ورد من ${senderName} (${senderId}) في ${groupName}`);

                if (isImage) this.stats.imagesProcessed++;
                if (isVideo) this.stats.videosProcessed++;

                const caption = msg.body || '';
                let wo = null;
                const match = caption.match(this.woPattern);
                const senderKey = `${groupId}_${senderId}`;

                if (match) {
                    wo = match[0];
                    this.recentWorkOrders.set(senderKey, { workOrder: wo, timestamp: Date.now() });
                    console.log(`🎯 تم استخراج رقم أمر العمل من الكابشن: ${wo}`);
                } else {
                    const cached = this.recentWorkOrders.get(senderKey);
                    if (cached && (Date.now() - cached.timestamp < 300000)) {
                        wo = cached.workOrder;
                        console.log(`🧠 تم استرجاع رقم أمر العمل من الذاكرة المؤقتة: ${wo}`);
                    }
                }

                const payload = {
                    type: isPdf ? 'pdf' : (isVideo ? 'video' : 'image'),
                    image_base64: media.data,
                    mimetype: media.mimetype,
                    original_filename: media.filename || null,
                    caption,
                    work_order: wo || '',
                    group_id: groupId,
                    group_name: groupName,
                    sender: senderId,
                    sender_name: senderName,
                    timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
                    message_id: msg.id._serialized,
                };

                this._enqueueImage(payload, msg.from);
                return;
            }

            // =============================================
            // 💬 معالجة النصوص
            // =============================================
            const text = msg.body?.trim();
            if (!text) return;

            // أوامر البوت
            if (await this._handleBotCommands(text, msg, groupId, senderName, senderId)) return;

            // فحص إذا كان النص يحتوي رقم أمر عمل
            if (!this.woPattern.test(text)) return;

            const textMatch = text.match(this.woPattern);
            if (textMatch) {
                const wo = textMatch[0];
                const senderKey = `${groupId}_${senderId}`;
                this.recentWorkOrders.set(senderKey, { workOrder: wo, timestamp: Date.now() });
                console.log(`🎯 تم حفظ رقم أمر العمل من الرسالة النصية: ${wo}`);
            }

            this.stats.textProcessed++;
            console.log(`\n💬 نص يحتوي رقم أمر عمل من ${senderName} في ${groupName}: ${text}`);

            const result = this.imageProcessor.processText({
                body: text,
                group_id: groupId,
                group_name: groupName,
                sender: senderId,
                sender_name: senderName,
            });

            if (result?.success && result.work_order) {
                console.log(`✅ رقم أمر العمل: ${result.work_order}`);
                if (result.queued_images_updated > 0) {
                    console.log(`📎 تم ربط ${result.queued_images_updated} صورة معلّقة`);
                    await msg.reply(`📎 تم ربط ${result.queued_images_updated} صورة بأمر العمل ${result.work_order}`);
                }
            }

        } catch (error) {
            console.error('❌ خطأ في معالجة الرسالة:', error instanceof Error ? (error.stack || error.message) : error);
            this.stats.errors++;
        }
    }

    /**
     * معالجة أوامر البوت
     * @returns {boolean} true إذا تمت معالجة أمر
     */
    async _handleBotCommands(text, msg, groupId, senderName, senderId) {
        const db = require('./database');

        // أمر إعادة تعيين: !reset 262040204
        const resetMatch = text.match(/^!reset\s+(\d+)$/i);
        if (resetMatch) {
            const wo = resetMatch[1];
            console.log(`\n🔄 أمر إعادة تعيين من ${senderName}: WO ${wo}`);
            try {
                const result = db.resetWorkOrder(wo);
                await msg.reply(`🔄 تم إعادة تعيين أمر العمل ${wo}\n🗑️ تم حذف ${result.deletedUploads} سجل\n✅ يمكنك الآن إعادة رفع الصور`);
            } catch (e) {
                await msg.reply(`❌ خطأ: ${e.message}`);
            }
            return true;
        }

        // أمر حالة الطابور: !status
        if (text === '!status') {
            const queueInfo = `📊 حالة البوت:\n📥 الطابور: ${this.uploadQueue.length} ملف\n⚙️ المعالجة: ${this.isProcessing ? 'نعم' : 'لا'}\n📸 صور: ${this.stats.imagesProcessed}\n🎬 فيديوهات: ${this.stats.videosProcessed}\n❌ أخطاء: ${this.stats.errors}`;
            await msg.reply(queueInfo);
            return true;
        }

        // أمر نقل صور: !move 262040204 123456789 3
        const moveMatch = text.match(/^!move\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/i);
        if (moveMatch) {
            const fromWO = moveMatch[1];
            const toWO = moveMatch[2];
            const count = parseInt(moveMatch[3] || '1', 10);
            console.log(`\n📦 أمر نقل من ${senderName}: ${count} صورة من WO ${fromWO} إلى WO ${toWO}`);
            try {
                const SynologyUploader = require('./synology-uploader');
                const images = db.getUploadsForMove(fromWO, count);
                if (images.length === 0) {
                    await msg.reply(`❌ لا توجد صور في أمر العمل ${fromWO}`);
                    return true;
                }
                const newFolder = await this.imageProcessor.uploader.getOrCreateFolder(toWO);
                const oldFolder = await this.imageProcessor.uploader.getOrCreateFolder(fromWO);

                let moved = 0;
                for (const img of images) {
                    db.updateUploadWorkOrder(img.id, toWO);
                    try {
                        if (this.imageProcessor.uploader.moveFile) {
                            await this.imageProcessor.uploader.moveFile(oldFolder + '/' + img.file_name, newFolder);
                        }
                    } catch (e) {
                        this.logger.warning(`Could not move file ${img.file_name} on NAS: ${e.message}`);
                    }
                    moved++;
                }
                await msg.reply(`📦 تم نقل ${moved} صورة\n📤 من: ${fromWO}\n📥 إلى: ${toWO}`);
            } catch (e) {
                await msg.reply(`❌ خطأ: ${e.message}`);
            }
            return true;
        }

        // أمر المساعدة: !help
        if (text === '!help') {
            const help = `🤖 أوامر البوت:\n\n` +
                `📋 *!status* — حالة البوت والطابور\n` +
                `🔄 *!reset 262040204* — مسح سجلات أمر عمل لإعادة الرفع\n` +
                `📦 *!move 111111111 222222222 3* — نقل آخر 3 صور من أمر عمل لآخر\n` +
                `❓ *!help* — عرض هذه الأوامر`;
            await msg.reply(help);
            return true;
        }

        return false;
    }

    // =============================================
    // 📦 نظام الطابور التتابعي
    // =============================================

    _enqueueImage(payload, chatId) {
        this.uploadQueue.push({ payload, chatId, retries: 0 });
        console.log(`📥 صورة أُضيفت للطابور (الحجم: ${this.uploadQueue.length})`);
        this._processQueue();
    }

    async _processQueue() {
        if (this.isProcessing) return;
        if (this.uploadQueue.length === 0) return;

        this.isProcessing = true;

        while (this.uploadQueue.length > 0) {
            const item = this.uploadQueue.shift();
            const { payload, chatId, retries } = item;

            try {
                // ✨ استدعاء مباشر بدلاً من HTTP
                const result = await this.imageProcessor.processImage(payload);

                if (result && result.success) {
                    console.log(`✅ ${result.action}: ${result.message || ''}`);
                    this._handleUploadResult(result, payload, chatId);
                } else {
                    const errorMsg = result?.message || 'Unknown error';
                    console.error(`❌ Processing Error: ${errorMsg}`);

                    if (retries < this.MAX_RETRIES && this._isRetryableError(errorMsg)) {
                        console.log(`🔄 إعادة المحاولة ${retries + 1}/${this.MAX_RETRIES}...`);
                        await this._sleep(this.RETRY_DELAY_MS);
                        this.uploadQueue.unshift({ payload, chatId, retries: retries + 1 });
                    } else {
                        this.stats.errors++;
                        console.error(`💀 فشل نهائي بعد ${retries} محاولة`);
                    }
                }
            } catch (error) {
                console.error('❌ خطأ غير متوقع:', error.message);
                this.stats.errors++;
            }

            if (this.uploadQueue.length > 0) {
                await this._sleep(this.DELAY_BETWEEN_UPLOADS_MS);
            }
        }

        this.isProcessing = false;
    }

    _handleUploadResult(result, payload, chatId) {
        if (result.action === 'uploaded' && result.work_order) {
            const batchKey = `${payload.group_id}_${result.work_order}`;

            if (!this.uploadBatches.has(batchKey)) {
                this.uploadBatches.set(batchKey, {
                    workOrder: result.work_order,
                    count: 0,
                    files: [],
                    chatId,
                    timer: null,
                });
            }

            const batch = this.uploadBatches.get(batchKey);
            batch.count++;
            batch.files.push(result.file_name);

            if (batch.timer) clearTimeout(batch.timer);
            batch.timer = setTimeout(async () => {
                try {
                    const mediaWord = batch.count === 1 ? 'ملف' : 'ملفات';
                    const summary = batch.count === 1
                        ? `✅ تم رفع ملف واحد بنجاح\n📁 أمر العمل: ${batch.workOrder}`
                        : `✅ تم رفع ${batch.count} ${mediaWord} بنجاح\n📁 أمر العمل: ${batch.workOrder}`;

                    await this.client.sendMessage(batch.chatId, summary);
                    console.log(`📨 ملخص مُرسل: ${batch.count} صورة لأمر العمل ${batch.workOrder}`);
                } catch (e) {
                    console.error('❌ خطأ إرسال ملخص:', e.message);
                }
                this.uploadBatches.delete(batchKey);
            }, this.BATCH_DELAY_MS);

        } else if (result.action === 'queued') {
            console.log('⏳ الصورة في الطابور...');
        } else if (result.action === 'skipped') {
            console.log('⚠️ صورة مكررة — تم التخطي');
        }
    }

    /**
     * تحميل الميديا مع إعادة محاولة وتأخير وطريقة بديلة
     */
    async _downloadMediaWithRetry(msg, maxRetries = 3, delayMs = 3000) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // المحاولة بالطريقة العادية أولاً
                const media = await msg.downloadMedia();
                if (media) return media;
                console.log(`⚠️ محاولة ${attempt}/${maxRetries}: downloadMedia أعاد null`);
            } catch (err) {
                console.log(`⚠️ محاولة ${attempt}/${maxRetries}: خطأ في طريقة downloadMedia العادية: ${err.message || err}`);
            }

            // إذا فشلت الطريقة العادية، نجرب الطريقة البديلة المباشرة (فك التشفير اليدوي)
            try {
                if (msg._data) {
                    console.log(`🔄 محاولة ${attempt}/${maxRetries}: جاري تحميل الميديا بالطريقة المباشرة البديلة...`);
                    const mediaDirect = await downloadMediaDirect(msg._data);
                    if (mediaDirect) {
                        console.log(`✅ تم تحميل الميديا وتفكيكها بنجاح عبر الطريقة البديلة!`);
                        return mediaDirect;
                    }
                }
            } catch (directErr) {
                console.log(`❌ محاولة ${attempt}/${maxRetries}: فشلت الطريقة البديلة أيضاً: ${directErr.message || directErr}`);
            }

            if (attempt < maxRetries) {
                await this._sleep(delayMs);
            }
        }
        return null;
    }

    _isRetryableError(msg) {
        const retryable = ['timeout', 'aborted', '500', '502', '503', 'ECONNREFUSED', 'ECONNRESET', '119'];
        return retryable.some(keyword => msg.toLowerCase().includes(keyword.toLowerCase()));
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * جلب ومعالجة الرسائل غير المقروءة عند بدء تشغيل البوت لتلافي فترة التوقف
     */
    async processUnreadMessages() {
        try {
            console.log('🔄 جاري فحص الرسائل غير المقروءة والرسائل الفائتة أثناء توقف البوت...');
            
            // الانتظار حتى تكتمل مزامنة المحادثات من خادم واتساب ويب
            let stats = { total: 0, unread: 0 };
            for (let i = 0; i < 6; i++) {
                stats = await this.client.pupPage.evaluate(() => {
                    const ChatCollection = window.require('WAWebCollections').Chat;
                    if (!ChatCollection) return { total: 0, unread: 0 };
                    const chats = ChatCollection.getModelsArray();
                    const unread = chats.filter(c => c.unreadCount > 0).length;
                    return { total: chats.length, unread };
                });
                
                console.log(`📊 فحص مزامنة المحادثات (${i + 1}/6): الإجمالي المحمل=${stats.total}, غير المقروءة=${stats.unread}`);
                
                if (stats.total > 0) {
                    console.log('⏳ تم رصد المحادثات. ننتظر 5 ثوانٍ إضافية لاكتمال مزامنة العدادات...');
                    await this._sleep(5000);
                    break;
                }
                await this._sleep(5000);
            }

            // جلب كل المجموعات المراقبة النشطة في الحساب
            const groupsToSync = await this.client.pupPage.evaluate((monitoredGroups) => {
                const ChatCollection = window.require('WAWebCollections').Chat;
                if (!ChatCollection) return [];
                
                return ChatCollection.getModelsArray()
                    .filter(c => c.isGroup)
                    .map(c => ({
                        id: c.id._serialized,
                        name: c.name || c.formattedTitle || 'Unknown Group',
                        unreadCount: c.unreadCount
                    }))
                    .filter(g => {
                        if (monitoredGroups === 'all') return true;
                        const groups = Array.isArray(monitoredGroups) ? monitoredGroups : monitoredGroups.split(',').map(name => name.trim());
                        return groups.includes(g.id) || groups.includes(g.name);
                    });
            }, this.monitoredGroups);

            if (!groupsToSync || groupsToSync.length === 0) {
                console.log('📝 لا توجد مجموعات مراقبة للمزامنة.');
                return;
            }

            let totalProcessed = 0;
            const syncLimit = 100; // فحص آخر 100 رسالة في كل مجموعة
            const db = require('./database');
            const Message = require('whatsapp-web.js/src/structures/Message');

            for (const group of groupsToSync) {
                const groupId = group.id;
                const groupName = group.name;
                
                // نقوم بمزامنة المجموعة إذا كانت تحتوي رسائل غير مقروءة، أو نقوم بمزامنة آخر 100 رسالة بشكل عام للتحقق
                const limit = Math.max(syncLimit, group.unreadCount || 0);

                console.log(`🔄 جاري مزامنة وفحص آخر ${limit} رسالة في المجموعة: ${groupName}...`);
                
                try {
                    const rawMsgs = await this.client.pupPage.evaluate(async (chatId, limit) => {
                        const chatWid = window.require('WAWebWidFactory').createWid(chatId);
                        const chat = window.require('WAWebCollections').Chat.get(chatWid) ||
                            (await window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid))?.chat;
                        
                        if (!chat) return [];

                        const msgFilter = (m) => {
                            if (m.isNotification) return false;
                            return true;
                        };

                        let msgs = chat.msgs.getModelsArray().filter(msgFilter);
                        
                        // تحميل الرسائل السابقة إذا لم تكن كافية
                        let attempts = 0;
                        while (msgs.length < limit && attempts < 5) {
                            attempts++;
                            const loadedMessages = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
                            if (!loadedMessages || !loadedMessages.length) break;
                            msgs = [...loadedMessages.filter(msgFilter), ...msgs];
                        }

                        const slicedMsgs = msgs.slice(-limit);
                        return slicedMsgs.map(m => window.WWebJS.getMessageModel(m));
                    }, groupId, limit);

                    let groupProcessedCount = 0;
                    for (const rawMsg of rawMsgs) {
                        const msgId = rawMsg.id._serialized;
                        
                        // تخطي الرسالة إذا تم معالجتها مسبقاً وتخزينها في قاعدة البيانات
                        if (db.isMessageProcessed(msgId)) {
                            continue;
                        }

                        try {
                            const msg = new Message(this.client, rawMsg);
                            await this._handleMessage(msg);
                            groupProcessedCount++;
                            totalProcessed++;
                        } catch (msgErr) {
                            console.error(`❌ خطأ أثناء معالجة رسالة سابقة:`, msgErr.message || msgErr);
                        }
                    }

                    if (groupProcessedCount > 0) {
                        console.log(`✅ تم معالجة وأرشفة ${groupProcessedCount} رسالة/صورة فائتة في المجموعة: ${groupName}`);
                    }

                    // وضع علامة مقروءة للمجموعة
                    if (group.unreadCount > 0) {
                        await this.client.pupPage.evaluate(async (chatId) => {
                            return await window.WWebJS.sendSeen(chatId);
                        }, groupId);
                    }

                } catch (grpErr) {
                    console.error(`❌ فشل مزامنة الرسائل للمجموعة ${groupName}:`, grpErr.message || grpErr);
                }
            }

            if (totalProcessed > 0) {
                console.log(`✅ تم الانتهاء من فحص ومزامنة المجموعات. إجمالي ما تم معالجته وأرشفته: ${totalProcessed} رسالة/ملف.`);
            } else {
                console.log('📝 تم فحص المجموعات، ولم يتم العثور على أي رسائل أو ميديا فائتة غير مؤرشفة.');
            }
        } catch (error) {
            console.error('❌ خطأ أثناء فحص الرسائل غير المقروءة:');
            console.error(error instanceof Error ? (error.stack || error.message) : error);
        }
    }
}

module.exports = WhatsAppBot;
