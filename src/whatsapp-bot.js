/**
 * WhatsAppBot - بوت واتساب
 * 
 * استخراج وتحسين كود البوت من node-bot/server.js
 * يستدعي ImageProcessor مباشرة بدلاً من إرسال HTTP إلى PHP
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const config = require('./config');

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
        });

        this.client.on('authenticated', () => {
            console.log('✅ تمت المصادقة بنجاح!');
        });

        this.client.on('auth_failure', (msg) => {
            console.error('❌ فشل المصادقة:', msg);
        });

        this.client.on('disconnected', (reason) => {
            this.isClientReady = false;
            console.log('⚠️ تم قطع الاتصال:', reason);
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
            if (msg.fromMe) return;

            const chat = await msg.getChat();
            if (!chat.isGroup) return;

            const groupId = chat.id._serialized;
            const groupName = chat.name || 'Unknown Group';

            // فحص إذا كانت المجموعة مراقبة
            if (this.monitoredGroups !== 'all') {
                const groups = Array.isArray(this.monitoredGroups)
                    ? this.monitoredGroups
                    : this.monitoredGroups.split(',').map(g => g.trim());
                if (!groups.includes(groupId) && !groups.includes(groupName)) return;
            }

            const contact = await msg.getContact();
            const senderName = contact.pushname || contact.number || 'Unknown';
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

                if (!media.mimetype.startsWith('image/')) {
                    console.log(`⏩ تم تجاهل ميديا غير صورة: ${media.mimetype}`);
                    return;
                }

                this.stats.imagesProcessed++;

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
                    type: 'image',
                    image_base64: media.data,
                    mimetype: media.mimetype,
                    caption,
                    work_order: wo || '',
                    group_id: groupId,
                    group_name: groupName,
                    sender: senderId,
                    sender_name: senderName,
                    timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
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
            console.error('❌ خطأ في معالجة الرسالة:', error.message);
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
            const queueInfo = `📊 حالة البوت:\n📥 الطابور: ${this.uploadQueue.length} صورة\n⚙️ المعالجة: ${this.isProcessing ? 'نعم' : 'لا'}\n📸 صور معالجة: ${this.stats.imagesProcessed}\n❌ أخطاء: ${this.stats.errors}`;
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
                    const summary = batch.count === 1
                        ? `✅ تم رفع صورة واحدة بنجاح\n📁 أمر العمل: ${batch.workOrder}`
                        : `✅ تم رفع ${batch.count} صورة بنجاح\n📁 أمر العمل: ${batch.workOrder}`;

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

    _isRetryableError(msg) {
        const retryable = ['timeout', 'aborted', '500', '502', '503', 'ECONNREFUSED', 'ECONNRESET', '119'];
        return retryable.some(keyword => msg.toLowerCase().includes(keyword.toLowerCase()));
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = WhatsAppBot;
