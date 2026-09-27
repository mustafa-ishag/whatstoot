/**
 * MediaDownloader - تحميل وفك تشفير ميديا واتساب مباشرة
 * 
 * يعمل كبديل لـ msg.downloadMedia() عند تعطل دوال Puppeteer الداخلية
 * يقوم بتحميل الملف المشفر من CDN واتساب وفكه باستخدام Node.js crypto
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// مفاتيح التوسيع حسب نوع الميديا (HKDF info)
const MEDIA_HKDF_INFO = {
    'image':    'WhatsApp Image Keys',
    'video':    'WhatsApp Video Keys',
    'audio':    'WhatsApp Audio Keys',
    'ptt':      'WhatsApp Audio Keys',
    'document': 'WhatsApp Document Keys',
    'sticker':  'WhatsApp Image Keys',
};

/**
 * HKDF - Key Derivation Function (RFC 5869)
 */
function hkdf(key, length, info) {
    const salt = Buffer.alloc(32, 0);
    const prk = crypto.createHmac('sha256', salt).update(key).digest();

    let t = Buffer.alloc(0);
    let okm = Buffer.alloc(0);
    let i = 0;

    while (okm.length < length) {
        i++;
        const input = Buffer.concat([t, Buffer.from(info, 'utf8'), Buffer.from([i])]);
        t = crypto.createHmac('sha256', prk).update(input).digest();
        okm = Buffer.concat([okm, t]);
    }

    return okm.slice(0, length);
}

/**
 * تحميل ملف من URL
 */
function downloadFromUrl(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const request = client.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return downloadFromUrl(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        request.on('error', reject);
        request.on('timeout', () => {
            request.destroy();
            reject(new Error('Download timeout'));
        });
    });
}

/**
 * فك تشفير ميديا واتساب
 * 
 * @param {Buffer} encData - البيانات المشفرة
 * @param {any} mediaKeyRaw - مفتاح الميديا (غير موسّع)
 * @param {string} mediaType - نوع الميديا (image, video, audio, document, sticker, ptt)
 * @returns {Buffer|null} البيانات المفكوكة أو null عند الفشل
 */
function decryptMedia(encData, mediaKeyRaw, mediaType) {
    try {
        if (!encData || !Buffer.isBuffer(encData) || encData.length <= 10) {
            return null;
        }

        const info = MEDIA_HKDF_INFO[mediaType] || MEDIA_HKDF_INFO['image'];

        // تحويل مفتاح الميديا إلى Buffer صالح (32 بايت)
        let keyBuf = null;
        if (Buffer.isBuffer(mediaKeyRaw)) {
            keyBuf = mediaKeyRaw;
        } else if (typeof mediaKeyRaw === 'string') {
            keyBuf = Buffer.from(mediaKeyRaw, 'base64');
        } else if (mediaKeyRaw && typeof mediaKeyRaw._base64 === 'string') {
            keyBuf = Buffer.from(mediaKeyRaw._base64, 'base64');
        } else if (mediaKeyRaw && Array.isArray(mediaKeyRaw.data)) {
            keyBuf = Buffer.from(mediaKeyRaw.data);
        } else if (mediaKeyRaw instanceof Uint8Array) {
            keyBuf = Buffer.from(mediaKeyRaw);
        }

        if (!keyBuf || keyBuf.length < 16) {
            return null;
        }

        // توسيع المفتاح باستخدام HKDF المدمج في Node.js إذا توفر
        let expandedKey;
        if (typeof crypto.hkdfSync === 'function') {
            expandedKey = crypto.hkdfSync('sha256', keyBuf, Buffer.alloc(32, 0), Buffer.from(info, 'utf8'), 112);
        } else {
            expandedKey = hkdf(keyBuf, 112, info);
        }

        const iv = expandedKey.slice(0, 16);
        const cipherKey = expandedKey.slice(16, 48);

        // فصل البيانات عن MAC (آخر 10 بايت)
        const file = encData.slice(0, encData.length - 10);

        // فك التشفير AES-256-CBC
        const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
        decipher.setAutoPadding(true);

        return Buffer.concat([decipher.update(file), decipher.final()]);
    } catch (e) {
        return null;
    }
}

/**
 * تحميل وفك تشفير ميديا واتساب من بيانات الرسالة الخام
 * 
 * @param {object} msgData - بيانات الرسالة الخام (msg._data)
 * @returns {Promise<{data: string, mimetype: string, filename: string|null, filesize: number}|null>}
 */
async function downloadMediaDirect(msgData) {
    try {
        if (!msgData) return null;

        const mediaKey = msgData.mediaKey;
        const directPath = msgData.directPath;
        const mimetype = msgData.mimetype;
        const type = msgData.type || 'image';
        const filename = msgData.filename || null;

        if (!mediaKey || !directPath) {
            return null;
        }

        // بناء URL التحميل
        const url = `https://mmg.whatsapp.net${directPath}`;

        // تحميل الملف المشفر مع مهلة أقصاها 15 ثانية
        const encData = await downloadFromUrl(url);
        if (!encData || encData.length <= 10) {
            return null;
        }

        // فك التشفير بأمان
        const decrypted = decryptMedia(encData, mediaKey, type);
        if (!decrypted || decrypted.length === 0) {
            return null;
        }

        return {
            data: decrypted.toString('base64'),
            mimetype: mimetype || 'image/jpeg',
            filename: filename,
            filesize: decrypted.length,
        };
    } catch (e) {
        return null;
    }
}

module.exports = { downloadMediaDirect, decryptMedia };
