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
const EventEmitter = require('events');
const config = require('./config');
const { downloadMediaDirect } = require('./media-downloader');

class WhatsAppBot extends EventEmitter {
    constructor(imageProcessor, logger) {
        super();
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

        // إزالة أقفال Chromium القديمة لتجنب تعليق المتصفح على السيرفر
        this._removeChromiumLocks();

        // عميل واتساب
        this.client = new Client({
            authTimeoutMs: 120000,
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
        this.isReconnecting = false;
        this.isSyncingMessages = false;
        this.isDestroyed = false;
        this._reconnectTimeout = null;
        this._initRetryTimeout = null;
        this._unreadSyncTimeout = null;

        this._setupEvents();
    }

    /**
     * تهيئة أحداث عميل واتساب
     */
    _setupEvents() {
        this.client.on('loading_screen', (percent) => {
            this.isClientReady = false;
            console.log(`\n⏳ جاري تحميل واتساب ويب... ${percent}%`);
        });

        this.client.on('qr', async (qr) => {
            this.qrCodeData = qr;
            this.emit('qr', { qr });
            console.log('\n==================================================');
            console.log('📌 امسح هذا الباركود (QR Code) بجوالك:');
            console.log('==================================================\n');
            qrcode.generate(qr, { small: true });

            if (this.alertService) {
                try {
                    const qrcodeLib = require('qrcode');
                    const qrDataUrl = await qrcodeLib.toDataURL(qr);
                    this.alertService.sendQrAlert(qrDataUrl).catch(() => {});
                } catch (e) {
                    this.alertService.sendQrAlert().catch(() => {});
                }
            }
        });

        this.client.on('ready', async () => {
            this.isClientReady = true;
            this.qrCodeData = null;
            this.emit('status', { ready: true, has_qr: false });
            console.log('\n✅ واتساب جاهز! البوت يراقب المجموعات الآن...');
            console.log(`🌐 API: http://localhost:${config.PORT}\n`);
            
            // تطبيق إصلاحات Puppeteer للتعامل مع أخطاء واتساب ويب الداخلية
            await this._applyPuppeteerFixes();

            // معالجة الرسائل المعلقة التي وصلت أثناء إيقاف البوت
            if (this._unreadSyncTimeout) clearTimeout(this._unreadSyncTimeout);
            this._unreadSyncTimeout = setTimeout(() => {
                this._unreadSyncTimeout = null;
                this.processUnreadMessages();
            }, 5000);
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
            this.emit('status', { ready: false, reason });
            console.log('⚠️ تم قطع الاتصال:', reason);
            
            if (this.alertService && !this.manualDisconnect) {
                this.alertService.sendDisconnectAlert(reason).catch(() => {});
            }

            if (this.manualDisconnect) {
                console.log('🛑 قطع اتصال يدوي — لن يتم محاولة إعادة الاتصال هنا.');
                return;
            }

            if (this.isReconnecting) {
                console.log('⏳ عملية إعادة الاتصال جارية بالفعل، لن يتم جدولة محاولة مكررة.');
                return;
            }

            if (this._reconnectTimeout) clearTimeout(this._reconnectTimeout);
            console.log('🔄 جاري جدولة إعادة إنشاء عميل واتساب خلال 5 ثوانٍ...');
            this._reconnectTimeout = setTimeout(async () => {
                this._reconnectTimeout = null;
                try {
                    await this.recreateClient();
                    this.initialize();
                } catch (e) {
                    console.error('❌ فشل إعادة الاتصال:', e.message);
                }
            }, 5000);
        });

        this.client.on('message_create', (msg) => this._handleMessage(msg));
    }

    setAlertService(alertService) {
        this.alertService = alertService;
    }


    /**
     * إزالة ملفات قفل Chromium القديمة لتفادي تعليق Puppeteer بعد إعادة التشغيل
     */
    _removeChromiumLocks() {
        try {
            const sessionDir = path.join(config.BASE_PATH, '.wwebjs_auth', 'session');
            if (fs.existsSync(sessionDir)) {
                const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
                for (const lock of lockFiles) {
                    const lockPath = path.join(sessionDir, lock);
                    try {
                        if (fs.existsSync(lockPath) || fs.lstatSync(lockPath).isSymbolicLink()) {
                            fs.unlinkSync(lockPath);
                            console.log(`🔓 تم إزالة قفل الكروم القديم: ${lock}`);
                        }
                    } catch (e) {}
                }
            }
        } catch (err) {
            // صامت
        }
    }

    /**
     * تشغيل البوت
     */
    initialize() {
        if (!this.client) return;
        this._removeChromiumLocks();
        this.client.initialize().catch(err => {
            console.error('❌ خطأ أثناء تهيئة عميل واتساب:', err.message);
            if (this.manualDisconnect || this.isDestroyed) return;
            if (err.message && (err.message.includes('exceeded') || err.message.includes('timeout') || err.message.includes('Waiting failed'))) {
                if (this._initRetryTimeout) clearTimeout(this._initRetryTimeout);
                console.log('🔄 جاري إعادة محاولة تهيئة عميل واتساب بعد 10 ثوانٍ...');
                this._initRetryTimeout = setTimeout(async () => {
                    this._initRetryTimeout = null;
                    try {
                        await this.recreateClient();
                        this.initialize();
                    } catch (e) {
                        console.error('❌ فشل إعادة محاولة التهيئة:', e.message);
                    }
                }, 10000);
            }
        });
    }

    /**
     * إعادة إنشاء عميل واتساب من جديد (بعد قطع الاتصال)
     */
    async recreateClient() {
        if (this.isReconnecting) {
            console.log('⏳ عملية إعادة الاتصال جارية بالفعل — تم تجاهل الطلب المكرر.');
            return;
        }
        this.isReconnecting = true;
        this.isClientReady = false;

        // إلغاء أي مؤقتات نشطة
        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
            this._reconnectTimeout = null;
        }
        if (this._initRetryTimeout) {
            clearTimeout(this._initRetryTimeout);
            this._initRetryTimeout = null;
        }
        if (this._unreadSyncTimeout) {
            clearTimeout(this._unreadSyncTimeout);
            this._unreadSyncTimeout = null;
        }

        // إغلاق العميل القديم والمتصفح بشكل نظيف
        if (this.client) {
            try {
                console.log('🛑 جاري إغلاق عميل واتساب القديم ومتصفحه...');
                this.client.removeAllListeners();
                if (this.client.pupBrowser && typeof this.client.pupBrowser.close === 'function') {
                    await this.client.pupBrowser.close().catch(() => {});
                }
                if (typeof this.client.destroy === 'function') {
                    await this.client.destroy().catch(() => {});
                }
            } catch (destroyErr) {
                console.log('⚠️ خطأ أثناء تدمير العميل السابق:', destroyErr.message);
            }
            this.client = null;
        }

        this._removeChromiumLocks();

        this.client = new Client({
            authTimeoutMs: 120000,
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

        this.qrCodeData = null;
        this._setupEvents();
        this.isReconnecting = false;
        console.log('🔄 تم إنشاء عميل واتساب جديد ونظيف');
    }

    /**
     * تطبيق إصلاحات برمجية مباشرة داخل صفحة واتساب ويب لتفادي أخطاء المكتبة (مثل خطأ memoize id property و getChat و No LID وسياق التنفيذ)
     */
    async _applyPuppeteerFixes(retries = 2) {
        if (!this.client?.pupPage) return;
        try {
            // 1. التحقق من وجود كائن WWebJS ودواله الأساسية، وإعادة حقنه فوراً إن لم يكن متوفراً
            let needsInjection = true;
            try {
                needsInjection = await this.client.pupPage.evaluate(() => {
                    return typeof window.WWebJS === 'undefined' || typeof window.WWebJS.getChat !== 'function';
                });
            } catch (evalErr) {
                if (evalErr.message && (evalErr.message.includes('Execution context was destroyed') || evalErr.message.includes('Cannot find context')) && retries > 0) {
                    await new Promise(r => setTimeout(r, 1500));
                    return this._applyPuppeteerFixes(retries - 1);
                }
                needsInjection = true;
            }

            if (needsInjection) {
                const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
                await this.client.pupPage.evaluate(LoadUtils);
            }

            await this.client.pupPage.evaluate(() => {
                if (!window.WWebJS) return;

                // 1. إصلاح getChat لدعم الوصول الآمن للمحادثات ومنع خطأ Cannot read properties of undefined
                if (window.WWebJS.getChat && !window.WWebJS._origGetChat) {
                    window.WWebJS._origGetChat = window.WWebJS.getChat;
                    window.WWebJS.getChat = async function(chatId, options = {}) {
                        try {
                            const res = await window.WWebJS._origGetChat(chatId, options);
                            if (res) return res;
                        } catch (e) {
                            // متابعة إلى المحاولة الاحتياطية
                        }

                        try {
                            const WidFactory = window.require?.('WAWebWidFactory');
                            let chatWid = WidFactory ? WidFactory.createWid(chatId) : chatId;
                            const ChatCol = (window.require && window.require('WAWebCollections')?.Chat) || window.Store?.Chat;
                            let chat = ChatCol ? ChatCol.get(chatWid) : null;
                            if (!chat) {
                                // استعلام وجود الرقم على الخادم لتحميل الـ LID وجهة الاتصال في الذاكرة
                                const QueryExists = window.require?.('WAWebQueryExistsJob');
                                if (QueryExists && QueryExists.queryExists) {
                                    try {
                                        const qRes = await QueryExists.queryExists(chatWid);
                                        if (qRes && qRes.wid) chatWid = qRes.wid;
                                    } catch (qe) {}
                                }
                                const FindChat = window.require?.('WAWebFindChatAction');
                                if (FindChat) {
                                    chat = (await FindChat.findOrCreateLatestChat(chatWid))?.chat;
                                }
                            }
                            if (chat && options.getAsModel && window.WWebJS.getChatModel) {
                                return await window.WWebJS.getChatModel(chat, { isChannel: /@\w*newsletter\b/.test(chatId) });
                            }
                            return chat;
                        } catch (err) {
                            return null;
                        }
                    };
                }

                // 2. إصلاح getMessageModel: منع الخطأ إذا فشل serialize بسبب memoize getter
                if (window.WWebJS.getMessageModel && !window.WWebJS._origGetMessageModel) {
                    window.WWebJS._origGetMessageModel = window.WWebJS.getMessageModel;
                    window.WWebJS.getMessageModel = function(message) {
                        try {
                            return window.WWebJS._origGetMessageModel(message);
                        } catch (err) {
                            const msgId = message?.id?._serialized || message?.id?.id || 'msg_' + Date.now();
                            return {
                                id: {
                                    _serialized: typeof msgId === 'string' ? msgId : 'msg_' + Date.now(),
                                    id: typeof msgId === 'string' ? msgId : 'msg_' + Date.now(),
                                    fromMe: true,
                                    remote: message?.to?._serialized || message?.to || ''
                                },
                                ack: 1,
                                type: message?.type || 'document',
                                body: message?.body || message?.caption || '',
                                t: Math.floor(Date.now() / 1000)
                            };
                        }
                    };
                }

                // 3. إصلاح sendMessage الحاسم للوسائط والمستندات (PDF وغيرها):
                // يمنع مسح newMsgKey الناتج عن تمديد mediaOptions.toJSON() ويضمن وصول الملفات لواتساب
                if (window.WWebJS.sendMessage && !window.WWebJS._origSendMessage) {
                    window.WWebJS._origSendMessage = window.WWebJS.sendMessage;
                    window.WWebJS.sendMessage = async function(chat, content, options = {}) {
                        // إذا كانت الرسالة نصية فقط، نستخدم الدالة الأصلية
                        if (!options.media) {
                            return await window.WWebJS._origSendMessage(chat, content, options);
                        }

                        // عند إرسال وسائط ومستندات (PDF):
                        const mediaInfo = options.media;
                        const isDoc = !!options.sendMediaAsDocument;
                        const isSticker = !!options.sendMediaAsSticker;

                        let mediaOptions = {};
                        if (isSticker) {
                            mediaOptions = await window.WWebJS.processStickerData(mediaInfo);
                        } else {
                            mediaOptions = await window.WWebJS.processMediaData(mediaInfo, {
                                forceSticker: isSticker,
                                forceGif: !!options.sendVideoAsGif,
                                forceVoice: !!options.sendAudioAsVoice,
                                forceDocument: isDoc,
                                forceMediaHd: !!options.sendMediaAsHd,
                                sendToChannel: false,
                                sendToStatus: false,
                            });
                        }

                        // إزالة id و __x_id من كائن الوسائط لأنها تمسح newMsgKey وتتسبب في فشل الإرسال
                        const rawMediaData = mediaOptions.toJSON ? mediaOptions.toJSON() : { ...mediaOptions };
                        delete rawMediaData.id;
                        delete rawMediaData.__x_id;

                        const { getMaybeMePnUser, getMaybeMeLidUser } = window.require('WAWebUserPrefsMeUser');
                        const mePn = getMaybeMePnUser ? getMaybeMePnUser() : null;
                        const meLid = getMaybeMeLidUser ? getMaybeMeLidUser() : null;
                        const isChatLid = typeof chat.id?.isLid === 'function' && chat.id.isLid();
                        const from = (isChatLid && meLid) ? meLid : (mePn || meLid);

                        let participant;
                        if (typeof chat.id?.isGroup === 'function' && chat.id.isGroup()) {
                            const isLidMode = chat.groupMetadata && chat.groupMetadata.isLidAddressingMode;
                            const groupFrom = isLidMode && meLid ? meLid : (mePn || meLid);
                            participant = window.require('WAWebWidFactory').asUserWidOrThrow(groupFrom);
                        }

                        const newId = await window.require('WAWebMsgKey').newId();
                        const newMsgKey = new (window.require('WAWebMsgKey'))({
                            from: from,
                            to: chat.id,
                            id: newId,
                            participant: participant,
                            selfDir: 'out'
                        });

                        const ephemeralFields = window.require('WAWebGetEphemeralFieldsMsgActionsUtils')?.getEphemeralFields(chat) || {};

                        const cleanOptions = { ...options };
                        delete cleanOptions.media;
                        delete cleanOptions.sendMediaAsSticker;
                        delete cleanOptions.extraOptions;

                        const message = {
                            ...cleanOptions,
                            ack: 0,
                            body: options.caption || (isSticker ? undefined : mediaOptions.preview) || '',
                            caption: options.caption,
                            from: from,
                            to: chat.id,
                            local: true,
                            self: 'out',
                            t: parseInt(new Date().getTime() / 1000),
                            isNewMsg: true,
                            type: isDoc ? 'document' : (mediaOptions.type || 'image'),
                            ...ephemeralFields,
                            ...rawMediaData,
                            id: newMsgKey // تثبيت newMsgKey في النهاية بشكل صارم
                        };

                        const [msgPromise, sendMsgResultPromise] = window.require('WAWebSendMsgChatAction').addAndSendMsgToChat(chat, message);
                        await msgPromise;

                        if (options.waitUntilMsgSent && sendMsgResultPromise) {
                            try {
                                await sendMsgResultPromise;
                            } catch (e) {}
                        }

                        const MsgCollection = window.require('WAWebCollections').Msg;
                        const msgKeyStr = newMsgKey._serialized || newMsgKey.toString?.() || newMsgKey.id;
                        return (msgKeyStr ? MsgCollection.get(msgKeyStr) : null) || message;
                    };
                }

            });
            console.log('🛡️ تم تفعيل حماية Puppeteer ضد أخطاء WhatsApp Web memoize بنجاح');
        } catch (e) {
            if (e.message && (e.message.includes('Execution context was destroyed') || e.message.includes('Cannot find context')) && retries > 0) {
                await new Promise(r => setTimeout(r, 1500));
                return this._applyPuppeteerFixes(retries - 1);
            }
            console.error('⚠️ خطأ أثناء تطبيق حماية Puppeteer:', e.message);
        }
    }

    /**
     * إرسال رسالة نصية (يُستخدم من QueueWorker و EmailReader و API) مع إعادة المحاولة واستعادة سياق التنفيذ
     */
    async sendMessage(chatId, message, retries = 3) {
        if (!this.isClientReady) {
            // انتظار حتى 15 ثانية في حال كان العميل في طور إعادة الاتصال
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (this.isClientReady) break;
            }
            if (!this.isClientReady) {
                throw new Error('عميل واتساب غير متصل حالياً');
            }
        }

        let targetId = String(chatId).trim();
        if (!targetId.includes('@g.us') && !targetId.includes('@c.us') && !targetId.includes('@lid')) {
            let cleanNumber = targetId.replace(/[^0-9]/g, '');
            if (cleanNumber.startsWith('05') && cleanNumber.length === 10) {
                cleanNumber = '966' + cleanNumber.substring(1);
            } else if (cleanNumber.startsWith('5') && cleanNumber.length === 9) {
                cleanNumber = '966' + cleanNumber;
            }
            targetId = `${cleanNumber}@c.us`;
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await this.client.sendMessage(targetId, message);
            } catch (err) {
                const isRecoverable = err.message && (
                    err.message.includes('Execution context was destroyed') ||
                    err.message.includes('Cannot find context') ||
                    err.message.includes('id property') ||
                    err.message.includes('LID') ||
                    err.message.includes('getChat') ||
                    err.message.includes('Protocol error') ||
                    err.message.includes('WWebJS')
                );

                if (isRecoverable && attempt < retries) {
                    console.warn(`⚠️ محاولة إرسال رسالة ثانية (${attempt}/${retries}) بعد ثانيتين... السبب: ${err.message}`);
                    await this._applyPuppeteerFixes();
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                throw err;
            }
        }
    }

    /**
     * إرسال ملف مستند (PDF أو غيره) بأمان تام عبر واتساب مع حماية كاملة وإعادة المحاولة التلقائية
     */
    async sendMediaDocument(chatId, filePath, filename, retries = 3) {
        if (!this.isClientReady) {
            // انتظار حتى 15 ثانية في حال كان العميل في طور إعادة الاتصال
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (this.isClientReady) break;
            }
            if (!this.isClientReady) {
                throw new Error('عميل واتساب غير متصل حالياً');
            }
        }

        const { MessageMedia } = require('whatsapp-web.js');
        const fs = require('fs');

        if (!fs.existsSync(filePath)) {
            throw new Error(`الملف غير موجود: ${filePath}`);
        }

        // تنسيق وجهة الإرسال بدقة
        let targetId = chatId.trim();
        if (!targetId.includes('@g.us') && !targetId.includes('@c.us') && !targetId.includes('@lid')) {
            let cleanNumber = targetId.replace(/[^0-9]/g, '');
            if (cleanNumber.startsWith('05') && cleanNumber.length === 10) {
                cleanNumber = '966' + cleanNumber.substring(1);
            } else if (cleanNumber.startsWith('5') && cleanNumber.length === 9) {
                cleanNumber = '966' + cleanNumber;
            }
            targetId = `${cleanNumber}@c.us`;
        }

        const stats = fs.statSync(filePath);
        const media = MessageMedia.fromFilePath(filePath);
        if (filename) {
            media.filename = filename;
        }
        if (!media.mimetype) {
            media.mimetype = 'application/pdf';
        }

        console.log(`📤 جاري إرسال مستند إلى ${targetId}: ${filename || path.basename(filePath)} (${(stats.size / 1024).toFixed(1)} KB)`);

        // التأكد من تطبيق حماية Puppeteer قبل الإرسال
        await this._applyPuppeteerFixes();

        // إرسال الملف مع إعادة المحاولة وحماية سياق التنفيذ
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const res = await this.client.sendMessage(targetId, media, {
                    sendMediaAsDocument: true
                });
                console.log(`✅ تم تسليم المستند بنجاح إلى ${targetId}: ${filename || path.basename(filePath)}`);
                return res;
            } catch (err) {
                console.warn(`⚠️ محاولة إرسال مستند (${attempt}/${retries}) إلى ${targetId} فشلت: ${err.message}`);
                if (attempt < retries) {
                    await this._applyPuppeteerFixes();
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                    continue;
                }
                throw err;
            }
        }
    }

    /**
     * معالج الرسائل الرئيسي
     */
    async _handleMessage(msg) {
        try {
            this.stats.messagesReceived++;
            console.log(`📥 رسالة جديدة: من=${msg.from}, من_تلقائي=${msg.fromMe}, النوع=${msg.type}, النص=${msg.body ? msg.body.substring(0, 30) : ''}`);
            
            // تجاهل الرسائل التلقائية المرسلة بواسطة البوت نفسه لتفادي الحلقات التكرارية
            if (msg.fromMe) {
                const body = msg.body || '';
                if (
                    body.startsWith('✅ تم رفع') ||
                    body.startsWith('📎 تم ربط') ||
                    body.startsWith('📨 ملخص') ||
                    body.startsWith('▬▬▬▬') ||
                    body.includes('تم حفظ رقم أمر العمل')
                ) {
                    return;
                }
            }

            // تجاهل رسائل الحالة والمحادثات الفردية مبكراً لتجنب أخطاء Puppeteer (مثل خطأ r: r)
            if (!msg.from || !msg.from.includes('@g.us')) return;

            let groupId = msg.from;
            let groupName = 'Unknown Group';

            // محاولة جلب اسم المجموعة مباشرة من الذاكرة لتجنب استدعاء GroupMetadata.update المعطل في واتساب ويب
            let resolvedName = null;
            if (this.client?.pupPage) {
                try {
                    resolvedName = await this.client.pupPage.evaluate((cId) => {
                        const ChatCol = window.require?.('WAWebCollections')?.Chat || window.Store?.Chat;
                        const c = ChatCol ? ChatCol.get(cId) : null;
                        return c ? (c.name || c.formattedTitle) : null;
                    }, groupId);
                } catch (e) {}
            }

            if (resolvedName) {
                groupName = resolvedName;
            } else {
                // جلب الاسم من جدول المجموعات أو سجلات الرفع السابقة
                try {
                    const db = require('./database');
                    const groupRow = db.getInstance().prepare('SELECT name FROM groups WHERE id = ?').get(groupId);
                    if (groupRow && groupRow.name) {
                        groupName = groupRow.name;
                    } else {
                        const row = db.getInstance().prepare('SELECT group_name FROM uploads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1').get(groupId);
                        if (row && row.group_name) {
                            groupName = row.group_name;
                        } else {
                            // محاولة أخيرة هادئة بدون تحذير
                            const chat = await msg.getChat().catch(() => null);
                            if (chat && chat.name) groupName = chat.name;
                            else groupName = groupId.split('@')[0];
                        }
                    }
                } catch (dbErr) {
                    groupName = groupId.split('@')[0];
                }
            }

            // حفظ وتحديث المجموعة في قاعدة البيانات تلقائياً
            try {
                const db = require('./database');
                db.saveGroup(groupId, groupName);
            } catch (e) {}

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

                // حفظ الميديا مباشرة في القرص لتفريغ الذاكرة فوراً ومنع OOM
                const crypto = require('crypto');
                const ext = this.imageProcessor.uploader.getExtensionFromMime(media.mimetype || 'image/jpeg');
                const prefix = isPdf ? 'pdf' : (isVideo ? 'vid' : 'img');
                const tempExt = isPdf ? 'pdf' : ext;
                const tempName = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${tempExt}`;
                const tempPath = path.join(config.TEMP_PATH, tempName);
                
                const mediaBuffer = Buffer.from(media.data, 'base64');
                fs.writeFileSync(tempPath, mediaBuffer);
                const fileHash = this.imageProcessor.checker.hashData(mediaBuffer);

                const payload = {
                    type: isPdf ? 'pdf' : (isVideo ? 'video' : 'image'),
                    temp_path: tempPath,
                    file_hash: fileHash,
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

                    await this.sendMessage(batch.chatId, summary);
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

        // إطلاق حدث لحظي لتغذية لوحة التحكم الحية
        try {
            this.emit('upload', {
                action: result.action,
                work_order: result.work_order || payload.work_order,
                file_name: result.file_name,
                group_id: payload.group_id,
                group_name: payload.group_name,
                sender: payload.sender,
                sender_name: payload.sender_name,
                status: result.action === 'uploaded' ? 'completed' : (result.action === 'skipped' ? 'duplicate' : 'waiting'),
                timestamp: new Date().toISOString(),
            });
        } catch (e) {}
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
        if (this.isSyncingMessages) {
            console.log('⏳ مزامنة الرسائل غير المقروءة قيد التنفيذ بالفعل...');
            return;
        }
        if (!this.isClientReady || !this.client?.pupPage || this.client.pupPage.isClosed()) {
            console.log('⚠️ لا يمكن فحص الرسائل: عميل واتساب غير جاهز أو الصفحة مغلقة.');
            return;
        }

        this.isSyncingMessages = true;
        try {
            console.log('🔄 جاري فحص الرسائل غير المقروءة والرسائل الفائتة أثناء توقف البوت...');
            
            // الانتظار حتى تكتمل مزامنة المحادثات من خادم واتساب ويب
            let stats = { total: 0, unread: 0 };
            for (let i = 0; i < 6; i++) {
                if (!this.isClientReady || !this.client?.pupPage || this.client.pupPage.isClosed()) {
                    console.log('⚠️ توقف فحص المحادثات: انقطع اتصال واتساب.');
                    return;
                }

                try {
                    stats = await this.client.pupPage.evaluate(() => {
                        const ChatCollection = (window.require && window.require('WAWebCollections')?.Chat) || window.Store?.Chat;
                        if (!ChatCollection || typeof ChatCollection.getModelsArray !== 'function') return { total: 0, unread: 0 };
                        const chats = ChatCollection.getModelsArray();
                        const unread = chats.filter(c => c && c.unreadCount > 0).length;
                        return { total: chats.length, unread };
                    });
                } catch (evalErr) {
                    console.log(`⚠️ تعذر تقييم حالة المحادثات (${i + 1}/6):`, evalErr.message);
                    break;
                }
                
                console.log(`📊 فحص مزامنة المحادثات (${i + 1}/6): الإجمالي المحمل=${stats.total}, غير المقروءة=${stats.unread}`);
                
                if (stats.total > 0) {
                    console.log('⏳ تم رصد المحادثات. ننتظر 5 ثوانٍ إضافية لاكتمال مزامنة العدادات...');
                    await this._sleep(5000);
                    break;
                }
                await this._sleep(5000);
            }

            if (!this.isClientReady || !this.client?.pupPage || this.client.pupPage.isClosed()) {
                return;
            }

            // جلب كل المجموعات المراقبة النشطة في الحساب
            let groupsToSync = [];
            try {
                groupsToSync = await this.client.pupPage.evaluate((monitoredGroups) => {
                    const ChatCollection = (window.require && window.require('WAWebCollections')?.Chat) || window.Store?.Chat;
                    if (!ChatCollection || typeof ChatCollection.getModelsArray !== 'function') return [];
                    
                    return ChatCollection.getModelsArray()
                        .filter(c => {
                            if (!c || !c.id) return false;
                            const isGrp = (c.id._serialized && c.id._serialized.endsWith('@g.us')) ||
                                          c.id.server === 'g.us' ||
                                          Boolean(c.groupMetadata);
                            return isGrp && !c.isNewsletter && !c.isChannel;
                        })
                        .map(c => ({
                            id: c.id?._serialized || c.id,
                            name: c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || 'Unknown Group',
                            unreadCount: c.unreadCount || 0
                        }))
                        .filter(g => {
                            if (monitoredGroups === 'all') return true;
                            const groups = Array.isArray(monitoredGroups) ? monitoredGroups : monitoredGroups.split(',').map(name => name.trim());
                            return groups.includes(g.id) || groups.includes(g.name);
                        });
                }, this.monitoredGroups);
            } catch (grpListErr) {
                console.error('⚠️ خطأ أثناء جلب قائمة المجموعات:', grpListErr.message);
                return;
            }

            if (!groupsToSync || groupsToSync.length === 0) {
                console.log('📝 لا توجد مجموعات مراقبة للمزامنة.');
                return;
            }

            let totalProcessed = 0;
            const syncLimit = 100; // فحص آخر 100 رسالة في كل مجموعة
            const db = require('./database');
            const Message = require('whatsapp-web.js/src/structures/Message');

            for (const group of groupsToSync) {
                // التحقق قبل كل مجموعة: إذا انقطع الاتصال أو أُغلق المتصفح نتوقف فوراً!
                if (!this.isClientReady || !this.client?.pupPage || this.client.pupPage.isClosed()) {
                    console.log('⚠️ تم إيقاف مزامنة المجموعات: انقطع اتصال واتساب.');
                    break;
                }

                const groupId = group.id;
                const groupName = group.name;
                
                // حفظ المجموعة في قاعدة البيانات فوراً
                try {
                    db.saveGroup(groupId, groupName, group.unreadCount || 0);
                } catch (e) {}

                // نقوم بمزامنة المجموعة إذا كانت تحتوي رسائل غير مقروءة، أو نقوم بمزامنة آخر 100 رسالة بشكل عام للتحقق
                const limit = Math.max(syncLimit, group.unreadCount || 0);

                console.log(`🔄 جاري مزامنة وفحص آخر ${limit} رسالة في المجموعة: ${groupName}...`);
                
                try {
                    const rawMsgs = await this.client.pupPage.evaluate(async (chatId, limit) => {
                        const WidFactory = window.require?.('WAWebWidFactory');
                        const ChatCol = (window.require && window.require('WAWebCollections')?.Chat) || window.Store?.Chat;
                        const FindChat = window.require?.('WAWebFindChatAction');
                        const chatWid = WidFactory ? WidFactory.createWid(chatId) : chatId;
                        let chat = ChatCol ? ChatCol.get(chatWid) : null;
                        if (!chat && FindChat) {
                            chat = (await FindChat.findOrCreateLatestChat(chatWid))?.chat;
                        }
                        
                        if (!chat || !chat.msgs) return [];

                        const msgFilter = (m) => {
                            if (!m || m.isNotification) return false;
                            return true;
                        };

                        let msgs = chat.msgs.getModelsArray ? chat.msgs.getModelsArray().filter(msgFilter) : [];
                        
                        // تحميل الرسائل السابقة إذا لم تكن كافية
                        let attempts = 0;
                        const ChatLoad = window.require?.('WAWebChatLoadMessages');
                        while (msgs.length < limit && attempts < 5 && ChatLoad) {
                            attempts++;
                            const loadedMessages = await ChatLoad.loadEarlierMsgs({ chat });
                            if (!loadedMessages || !loadedMessages.length) break;
                            msgs = [...loadedMessages.filter(msgFilter), ...msgs];
                        }

                        const slicedMsgs = msgs.slice(-limit);
                        return slicedMsgs.map(m => {
                            try {
                                return window.WWebJS.getMessageModel(m);
                            } catch (e) {
                                return null;
                            }
                        }).filter(Boolean);
                    }, groupId, limit);

                    let groupProcessedCount = 0;
                    for (const rawMsg of rawMsgs) {
                        // تحقق أيضاً أثناء معالجة الرسائل
                        if (!this.isClientReady || !this.client?.pupPage || this.client.pupPage.isClosed()) {
                            console.log('⚠️ تم إيقاف معالجة الرسائل: انقطع اتصال واتساب.');
                            break;
                        }

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
                    if (group.unreadCount > 0 && this.isClientReady && this.client?.pupPage && !this.client.pupPage.isClosed()) {
                        await this.client.pupPage.evaluate(async (chatId) => {
                            return await window.WWebJS.sendSeen(chatId);
                        }, groupId).catch(() => {});
                    }

                } catch (grpErr) {
                    console.error(`❌ فشل مزامنة الرسائل للمجموعة ${groupName}:`, grpErr.message || grpErr);
                    // إذا كان الخطأ بسبب تدمير السياق أو قطع الاتصال، نوقف الدوران
                    if (grpErr.message && (grpErr.message.includes('destroyed') || grpErr.message.includes('Target closed') || grpErr.message.includes('Session closed'))) {
                        console.log('⚠️ انقطع سياق التصفح أثناء المزامنة — إيقاف الدوران.');
                        break;
                    }
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
        } finally {
            this.isSyncingMessages = false;
        }
    }

    /**
     * إغلاق البوت والعميل بشكل آمن
     */
    async destroy() {
        this.isDestroyed = true;
        this.isClientReady = false;
        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
            this._reconnectTimeout = null;
        }
        if (this._initRetryTimeout) {
            clearTimeout(this._initRetryTimeout);
            this._initRetryTimeout = null;
        }
        if (this._unreadSyncTimeout) {
            clearTimeout(this._unreadSyncTimeout);
            this._unreadSyncTimeout = null;
        }
        if (this.client) {
            try {
                this.client.removeAllListeners();
                if (this.client.pupBrowser && typeof this.client.pupBrowser.close === 'function') {
                    await this.client.pupBrowser.close().catch(() => {});
                }
                if (typeof this.client.destroy === 'function') {
                    await this.client.destroy().catch(() => {});
                }
            } catch (e) {}
            this.client = null;
        }
    }
}

module.exports = WhatsAppBot;
