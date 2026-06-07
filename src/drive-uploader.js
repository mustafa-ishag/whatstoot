/**
 * DriveUploader - رفع الملفات إلى Google Drive
 * 
 * يستخدم OAuth 2.0 أو Service Account
 * بديل لـ src/DriveUploader.php
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('./config');
const db = require('./database');

class DriveUploader {
    constructor(logger) {
        this.logger = logger;
        this.rootFolderId = config.GDRIVE_ROOT_FOLDER_ID || '';
        this.drive = null;
        this.initialized = false;
    }

    /**
     * تهيئة Google Client
     */
    async init(credentialsPath = null) {
        if (this.initialized) return;

        const basePath = config.BASE_PATH;
        const tokenPath = path.join(basePath, 'credentials', 'oauth-token.json');
        const oauthClientPath = path.join(basePath, 'credentials', 'oauth-client.json');

        // =============================================
        // الطريقة 1: OAuth 2.0 (مفضّلة)
        // =============================================
        if (fs.existsSync(tokenPath) && fs.existsSync(oauthClientPath)) {
            const clientConfig = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));
            const { client_id, client_secret, redirect_uris } = clientConfig.installed || clientConfig.web || {};

            const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
            const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
            auth.setCredentials(token);

            // تجديد Token إذا انتهى
            auth.on('tokens', (newTokens) => {
                const updatedToken = { ...token, ...newTokens };
                if (!updatedToken.refresh_token) updatedToken.refresh_token = token.refresh_token;
                fs.writeFileSync(tokenPath, JSON.stringify(updatedToken, null, 2));
                this.logger.info('OAuth token refreshed');
            });

            this.drive = google.drive({ version: 'v3', auth });
            this.initialized = true;
            this.logger.info('Google Drive client initialized (OAuth 2.0)');
            return;
        }

        // =============================================
        // الطريقة 2: Service Account (احتياطية)
        // =============================================
        credentialsPath = credentialsPath || path.join(basePath, config.GDRIVE_CREDENTIALS_PATH);

        if (fs.existsSync(credentialsPath)) {
            const auth = new google.auth.GoogleAuth({
                keyFile: credentialsPath,
                scopes: ['https://www.googleapis.com/auth/drive'],
            });

            this.drive = google.drive({ version: 'v3', auth });
            this.initialized = true;
            this.logger.info('Google Drive client initialized (Service Account)');
            return;
        }

        throw new Error(
            'Google Drive credentials not found.\n' +
            'Place OAuth or Service Account JSON in: credentials/'
        );
    }

    /**
     * الحصول على أو إنشاء مجلد لرقم أمر عمل
     */
    async getOrCreateFolder(workOrder, subFolder = null) {
        await this.ensureInitialized();

        let folderId = null;

        // 1. البحث في قاعدة البيانات أولاً للمجلد الأساسي
        const cachedId = db.getFolder(workOrder);
        if (cachedId) {
            try {
                const res = await this.drive.files.get({
                    fileId: cachedId,
                    fields: 'id,trashed',
                });
                if (!res.data.trashed) {
                    folderId = cachedId;
                } else {
                    this.logger.warning(`Folder ${cachedId} for WO ${workOrder} is trashed, recreating...`);
                }
            } catch (e) {
                this.logger.warning(`Cached folder ${cachedId} for WO ${workOrder} inaccessible, searching...`);
            }
        }

        // 2. البحث في Drive أو إنشاء المجلد الأساسي
        if (!folderId) {
            folderId = await this.findFolderByName(workOrder, this.rootFolderId);
            if (folderId) {
                this.logger.info(`Found existing folder for WO ${workOrder}: ${folderId}`);
            } else {
                folderId = await this.createFolder(workOrder, this.rootFolderId);
                this.logger.info(`Created new folder for WO ${workOrder}: ${folderId}`);
            }
            db.saveFolder(workOrder, folderId);
        }

        // 3. التعامل مع المجلد الفرعي إن وجد
        if (subFolder) {
            const cleanSubFolder = subFolder.replace(/[\\/:*?"<>|]/g, '-').trim() || 'General';
            let subFolderId = null;

            const cachedSubId = db.getFolder(workOrder, cleanSubFolder);
            if (cachedSubId) {
                try {
                    const res = await this.drive.files.get({
                        fileId: cachedSubId,
                        fields: 'id,trashed',
                    });
                    if (!res.data.trashed) subFolderId = cachedSubId;
                } catch (e) { }
            }

            if (!subFolderId) {
                subFolderId = await this.findFolderByName(cleanSubFolder, folderId);
                if (!subFolderId) {
                    subFolderId = await this.createFolder(cleanSubFolder, folderId);
                    this.logger.info(`Created new subfolder for WO ${workOrder}/${cleanSubFolder}: ${subFolderId}`);
                }
                db.saveFolder(workOrder, subFolderId, cleanSubFolder);
            }
            return subFolderId;
        }

        return folderId;
    }

    /**
     * رفع ملف إلى مجلد محدد
     * @returns {{ id: string, url: string }}
     */
    async upload(localPath, folderId, fileName) {
        await this.ensureInitialized();

        if (!fs.existsSync(localPath)) {
            throw new Error(`File not found: ${localPath}`);
        }

        const mimeType = this.getMimeTypeFromPath(localPath);

        const res = await this.drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId],
            },
            media: {
                mimeType,
                body: fs.createReadStream(localPath),
            },
            fields: 'id, webViewLink, webContentLink',
        });

        const result = {
            id: res.data.id,
            url: res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}/view`,
        };

        this.logger.info(`Uploaded ${fileName} to Drive`, {
            drive_id: res.data.id,
            folder: folderId,
            size: fs.statSync(localPath).size,
        });

        return result;
    }

    /**
     * بناء اسم ملف منظّم
     */
    buildFileName(workOrder, extension) {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[-:T]/g, '').substring(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2');
        const ext = extension.replace(/^\./, '').toLowerCase();
        return `WO${workOrder}_${timestamp}.${ext}`;
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
        };
        return map[mimeType] || 'jpg';
    }

    /**
     * اختبار الاتصال
     */
    async testConnection() {
        await this.ensureInitialized();

        try {
            const about = await this.drive.about.get({ fields: 'user' });
            const email = about.data.user.emailAddress;

            if (this.rootFolderId) {
                const folder = await this.drive.files.get({
                    fileId: this.rootFolderId,
                    fields: 'id,name',
                });
                return {
                    success: true,
                    email,
                    folder_name: folder.data.name,
                    folder_id: folder.data.id,
                };
            }

            return {
                success: true,
                email,
                message: 'Connected but no root folder ID configured',
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // =============================================
    // Private Methods
    // =============================================

    async findFolderByName(name, parentId) {
        const query = `name = '${name}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

        const res = await this.drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive',
        });

        return res.data.files.length > 0 ? res.data.files[0].id : null;
    }

    async createFolder(name, parentId) {
        const res = await this.drive.files.create({
            requestBody: {
                name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId],
            },
            fields: 'id',
        });

        return res.data.id;
    }

    async ensureInitialized() {
        if (!this.initialized) {
            await this.init();
        }
    }

    getMimeTypeFromPath(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const types = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.png': 'image/png', '.gif': 'image/gif',
            '.webp': 'image/webp', '.bmp': 'image/bmp',
            '.svg': 'image/svg+xml', '.tiff': 'image/tiff',
            '.mp4': 'video/mp4', '.3gp': 'video/3gpp',
        };
        return types[ext] || 'application/octet-stream';
    }
}

module.exports = DriveUploader;
