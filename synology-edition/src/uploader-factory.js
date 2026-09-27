/**
 * UploaderFactory - ينشئ الـ uploader المناسب حسب STORAGE_ENGINE
 * بديل لـ src/UploaderFactory.php
 */

const config = require('./config');
const SynologyUploader = require('./synology-uploader');
const DriveUploader = require('./drive-uploader');

/**
 * إنشاء uploader حسب الإعدادات
 * @param {import('./logger')} logger
 * @returns {SynologyUploader|DriveUploader}
 */
function create(logger) {
    if (config.STORAGE_ENGINE === 'synology') {
        return new SynologyUploader(logger);
    }
    return new DriveUploader(logger);
}

module.exports = { create };
