/**
 * SynologyUploader - رفع الملفات إلى Synology NAS
 * 
 * يستخدم File Station API (REST) للمصادقة وإنشاء المجلدات ورفع الصور
 * بديل لـ src/SynologyUploader.php
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const db = require('./database');

class SynologyUploader {
    constructor(logger) {
        this.logger = logger;
        this.baseUrl = (config.SYNOLOGY_URL || '').replace(/\/+$/, '');
        this.basePath = config.SYNOLOGY_BASE_PATH || '/photo/work_orders';
        this.sid = null;
        this.initialized = false;
        this.loginAttempts = 0;
        this.MAX_LOGIN_RETRIES = 2;
    }

    /**
     * تهيئة الاتصال وتسجيل الدخول
     */
    async init() {
        if (this.initialized) return;

        if (!this.baseUrl) {
            throw new Error('Synology URL not configured. Set SYNOLOGY_URL in .env');
        }

        await this.login();
        this.initialized = true;
    }

    /**
     * تسجيل الدخول والحصول على Session ID
     */
    async login() {
        const account = config.SYNOLOGY_USER || '';
        const password = config.SYNOLOGY_PASS || '';

        if (!account || !password) {
            throw new Error('Synology credentials not configured in .env');
        }

        const response = await this.apiRequest('/webapi/entry.cgi', {
            api: 'SYNO.API.Auth',
            version: 7,
            method: 'login',
            account,
            passwd: password,
            session: 'FileStation',
            format: 'sid',
        });

        if (!response.success) {
            const code = response.error?.code || 'unknown';
            throw new Error(`Synology login failed (error code: ${code})`);
        }

        this.sid = response.data.sid;
        this.loginAttempts = 0;
        this.logger.info('Synology FileStation connected');
    }

    /**
     * تسجيل الخروج
     */
    async logout() {
        if (this.sid) {
            try {
                await this.apiRequest('/webapi/entry.cgi', {
                    api: 'SYNO.API.Auth',
                    version: 7,
                    method: 'logout',
                    session: 'FileStation',
                    _sid: this.sid,
                });
            } catch (e) {
                // تجاهل
            }
            this.sid = null;
            this.initialized = false;
        }
    }

    /**
     * إعادة تسجيل الدخول عند انتهاء الجلسة (خطأ 119)
     */
    async reLogin() {
        this.loginAttempts++;
        if (this.loginAttempts > this.MAX_LOGIN_RETRIES) {
            throw new Error('Synology re-login failed: max retries exceeded');
        }
        this.logger.warning(`Synology SID expired, re-authenticating... (attempt ${this.loginAttempts})`);
        this.sid = null;
        this.initialized = false;
        await this.sleep(2000);
        await this.login();
        this.initialized = true;
    }

    /**
     * الحصول على أو إنشاء مجلد لرقم أمر عمل
     * @returns {string} المسار الكامل للمجلد
     */
    async getOrCreateFolder(workOrder, subFolder = null) {
        await this.ensureInitialized();

        const folderPath = this.basePath + '/' + workOrder;

        // 1. البحث في قاعدة البيانات أولاً للمجلد الأساسي
        const cachedPath = db.getFolder(workOrder);
        if (!cachedPath) {
            // 2. محاولة إنشاء المجلد الأساسي
            try {
                await this.createFolder(this.basePath, workOrder);
            } catch (e) {
                if (e.message.includes('119')) {
                    await this.reLogin();
                    await this.createFolder(this.basePath, workOrder);
                } else {
                    throw e;
                }
            }
            db.saveFolder(workOrder, folderPath);
            this.logger.info(`Folder ready for WO ${workOrder}: ${folderPath}`);
        }

        if (subFolder) {
            const cleanSubFolder = subFolder.replace(/[\\/:*?"<>|]/g, '-').trim() || 'General';
            const subFolderPath = folderPath + '/' + cleanSubFolder;
            
            const cachedSub = db.getFolder(workOrder, cleanSubFolder);
            if (cachedSub) return cachedSub;

            try {
                await this.createFolder(folderPath, cleanSubFolder);
            } catch (e) {
                if (e.message.includes('119')) {
                    await this.reLogin();
                    await this.createFolder(folderPath, cleanSubFolder);
                } else {
                    throw e;
                }
            }
            db.saveFolder(workOrder, subFolderPath, cleanSubFolder);
            this.logger.info(`Subfolder ready for WO ${workOrder}/${cleanSubFolder}: ${subFolderPath}`);
            return subFolderPath;
        }

        return folderPath;
    }

    /**
     * رفع ملف إلى مجلد محدد
     * @returns {{ id: string, url: string }}
     */
    async upload(localPath, folderPath, fileName) {
        await this.ensureInitialized();

        if (!fs.existsSync(localPath)) {
            throw new Error(`File not found: ${localPath}`);
        }

        let response = await this.uploadFile(localPath, folderPath, fileName);

        if (!response.success) {
            const code = response.error?.code || 'unknown';

            if (code == 119) {
                await this.reLogin();
                response = await this.uploadFile(localPath, folderPath, fileName);
                if (!response.success) {
                    const code2 = response.error?.code || 'unknown';
                    throw new Error(`Synology upload failed after re-login (error code: ${code2})`);
                }
            } else {
                throw new Error(`Synology upload failed (error code: ${code})`);
            }
        }

        const filePath = folderPath + '/' + fileName;
        const url = this.baseUrl + '/d/f/' + encodeURIComponent(filePath);

        const fileSize = fs.statSync(localPath).size;
        this.logger.info(`Uploaded ${fileName} to Synology`, {
            path: filePath,
            folder: folderPath,
            size: fileSize,
        });

        return { id: filePath, url };
    }

    /**
     * نقل ملف من مجلد لآخر على NAS
     */
    async moveFile(sourcePath, destFolder) {
        await this.ensureInitialized();

        let response = await this.apiRequest('/webapi/entry.cgi', {
            api: 'SYNO.FileStation.CopyMove',
            version: 3,
            method: 'start',
            path: JSON.stringify([sourcePath]),
            dest_folder_path: destFolder,
            overwrite: 'false',
            remove_src: 'true',
            _sid: this.sid,
        });

        if (!response.success) {
            const code = response.error?.code || 'unknown';

            if (code == 119) {
                await this.reLogin();
                response = await this.apiRequest('/webapi/entry.cgi', {
                    api: 'SYNO.FileStation.CopyMove',
                    version: 3,
                    method: 'start',
                    path: JSON.stringify([sourcePath]),
                    dest_folder_path: destFolder,
                    overwrite: 'false',
                    remove_src: 'true',
                    _sid: this.sid,
                });
                if (!response.success) {
                    const code2 = response.error?.code || 'unknown';
                    throw new Error(`Failed to move file after re-login (error: ${code2})`);
                }
            } else {
                throw new Error(`Failed to move file (error: ${code})`);
            }
        }

        this.logger.info(`Moved file: ${sourcePath} → ${destFolder}`);
    }

    /**
     * بناء اسم ملف منظّم
     */
    buildFileName(workOrder, extension) {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[-:T]/g, '').substring(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2');
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        const rand = crypto.randomBytes(2).toString('hex');
        const ext = extension.replace(/^\./, '').toLowerCase();
        return `WO${workOrder}_${timestamp}_${ms}_${rand}.${ext}`;
    }

    /**
     * تحديد امتداد الملف من MIME type
     */
    getExtensionFromMime(mimeType) {
        const map = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp',
            'image/svg+xml': 'svg',
            'image/tiff': 'tiff',
            'video/mp4': 'mp4',
            'video/3gpp': '3gp',
            'application/pdf': 'pdf',
        };
        return map[mimeType] || 'jpg';
    }

    /**
     * اختبار الاتصال
     */
    async testConnection() {
        try {
            await this.ensureInitialized();

            await this.apiRequest('/webapi/entry.cgi', {
                api: 'SYNO.FileStation.List',
                version: 2,
                method: 'list',
                folder_path: path.dirname(this.basePath),
                _sid: this.sid,
            });

            return {
                success: true,
                nas_url: this.baseUrl,
                base_path: this.basePath,
                message: 'Connected to Synology NAS',
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // =============================================
    // Private Methods
    // =============================================

    /**
     * إنشاء مجلد جديد
     */
    async createFolder(parentPath, name) {
        const response = await this.apiRequest('/webapi/entry.cgi', {
            api: 'SYNO.FileStation.CreateFolder',
            version: 2,
            method: 'create',
            folder_path: JSON.stringify([parentPath]),
            name: JSON.stringify([name]),
            force_parent: 'true',
            _sid: this.sid,
        });

        if (!response.success) {
            const code = response.error?.code || 'unknown';
            // Code 1200 means folder already exists
            if (code != 1200) {
                throw new Error(`Failed to create folder ${name} in ${parentPath} (error: ${code})`);
            }
        }
    }

    /**
     * رفع ملف عبر multipart/form-data
     */
    async uploadFile(localPath, destPath, fileName) {
        const url = `${this.baseUrl}/webapi/entry.cgi?_sid=${encodeURIComponent(this.sid)}`;

        const form = new FormData(); // Native FormData in Node 18+
        form.append('api', 'SYNO.FileStation.Upload');
        form.append('version', '2');
        form.append('method', 'upload');
        form.append('path', destPath);
        form.append('create_parents', 'true');
        form.append('overwrite', 'false');
        
        const fileBuffer = fs.readFileSync(localPath);
        const blob = new Blob([fileBuffer], { type: this.getMimeType(localPath) });
        form.append('file', blob, fileName);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);

        try {
            const response = await fetch(url, {
                method: 'POST',
                body: form,
                // Do NOT set headers; native fetch automatically sets boundary for FormData
                signal: controller.signal,
            });

            const text = await response.text();
            const data = JSON.parse(text);
            return data;
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error('Synology upload timeout (120s)');
            }
            throw new Error(`Synology upload error: ${e.message}`);
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * طلب API عام (GET)
     */
    async apiRequest(endpoint, params) {
        const queryString = new URLSearchParams(params).toString();
        const url = `${this.baseUrl}${endpoint}?${queryString}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetch(url, {
                signal: controller.signal,
            });

            const text = await response.text();
            const data = JSON.parse(text);
            return data;
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error('Synology connection timeout');
            }
            throw new Error(`Synology connection error: ${e.message}`);
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * جلب صورة مصغّرة من Synology
     * @param {string} filePath المسار الكامل للملف على NAS
     * @param {'small'|'medium'|'large'} size حجم الصورة المصغّرة
     * @returns {Promise<Buffer>} بيانات الصورة
     */
    async getThumbnail(filePath, size = 'medium') {
        await this.ensureInitialized();

        const params = new URLSearchParams({
            api: 'SYNO.FileStation.Thumb',
            version: '2',
            method: 'get',
            path: filePath,
            size,
            _sid: this.sid,
        });

        const url = `${this.baseUrl}/webapi/entry.cgi?${params.toString()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
            const response = await fetch(url, { signal: controller.signal });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const contentType = response.headers.get('content-type') || '';
            // إذا أرجع JSON فهذا يعني خطأ
            if (contentType.includes('application/json')) {
                const data = await response.json();
                if (data.error?.code == 119) {
                    await this.reLogin();
                    return this.getThumbnail(filePath, size);
                }
                throw new Error(`Thumbnail error: ${JSON.stringify(data.error)}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            return buffer;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('Thumbnail fetch timeout');
            throw e;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * تحميل ملف كامل من Synology
     * @param {string} filePath المسار الكامل للملف على NAS
     * @returns {Promise<{buffer: Buffer, contentType: string}>}
     */
    async downloadFile(filePath) {
        await this.ensureInitialized();

        const params = new URLSearchParams({
            api: 'SYNO.FileStation.Download',
            version: '2',
            method: 'download',
            path: filePath,
            mode: 'download',
            _sid: this.sid,
        });

        const url = `${this.baseUrl}/webapi/entry.cgi?${params.toString()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await fetch(url, { signal: controller.signal });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await response.json();
                if (data.error?.code == 119) {
                    await this.reLogin();
                    return this.downloadFile(filePath);
                }
                throw new Error(`Download error: ${JSON.stringify(data.error)}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            return { buffer, contentType: contentType || this.getMimeType(filePath) };
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('Download timeout');
            throw e;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * التأكد من تهيئة الاتصال
     */
    async ensureInitialized() {
        if (!this.initialized) {
            await this.init();
        }
    }

    getMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const types = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.png': 'image/png', '.gif': 'image/gif',
            '.webp': 'image/webp', '.bmp': 'image/bmp',
            '.svg': 'image/svg+xml', '.tiff': 'image/tiff',
            '.mp4': 'video/mp4', '.3gp': 'video/3gpp',
            '.pdf': 'application/pdf',
        };
        return types[ext] || 'application/octet-stream';
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = SynologyUploader;
