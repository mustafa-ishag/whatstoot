/**
 * WhatsToot Dashboard — JavaScript
 * 
 * Auto-refresh, filtering, search, and toast notifications
 */

// =============================================
// Configuration
// =============================================
const API_BASE = '/api';
const REFRESH_INTERVAL = 10000; // 10 seconds

let currentFilter = 'all';
let lastUploadId = 0;
let refreshTimer = null;

// =============================================
// Initialization
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    refreshData();
    startAutoRefresh();
    setupSearch();
    setupFilterTabs();
});

// =============================================
// Data Fetching
// =============================================

async function refreshData() {
    try {
        await Promise.all([
            loadStats(),
            loadUploads(),
            loadBotStatus()
        ]);
    } catch (error) {
        console.error('Refresh error:', error);
    }
}

async function loadStats() {
    try {
        const res = await fetch(`${API_BASE}/stats`);
        const data = await res.json();

        if (data.success) {
            animateNumber('todayUploads', data.stats.today_uploads);
            animateNumber('totalUploads', data.stats.total_uploads);
            animateNumber('uniqueWO', data.stats.unique_wo);
            animateNumber('pendingCount', data.stats.pending);
            animateNumber('unsortedCount', data.stats.unsorted);
            animateNumber('duplicateCount', data.stats.duplicates);
        }
    } catch (e) {
        console.error('Stats error:', e);
    }
}

async function loadUploads() {
    try {
        const searchVal = document.getElementById('searchInput')?.value || '';
        let url = `${API_BASE}/uploads?limit=50`;

        if (searchVal) url += `&wo=${encodeURIComponent(searchVal)}`;
        if (currentFilter !== 'all') url += `&status=${currentFilter}`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.success) {
            renderUploads(data.uploads);

            // Check for new uploads
            if (data.uploads.length > 0 && data.uploads[0].id > lastUploadId && lastUploadId > 0) {
                showToast(`📸 رفع جديد: ${data.uploads[0].file_name}`, 'success');
            }
            if (data.uploads.length > 0) {
                lastUploadId = data.uploads[0].id;
            }
        }
    } catch (e) {
        console.error('Uploads error:', e);
    }
}

let wasDisconnected = false; // track state changes

async function loadBotStatus() {
    try {
        const res = await fetch(`${API_BASE}/bot-status`);
        const data = await res.json();

        const badge = document.getElementById('botStatusBadge');
        const dot = badge.querySelector('.status-dot');
        const text = badge.querySelector('.status-text');

        // Banner elements
        const bannerConnected = document.getElementById('waBannerConnected');
        const bannerQR = document.getElementById('waBannerQR');
        const bannerOffline = document.getElementById('waBannerOffline');

        // Hide all banners first
        bannerConnected.style.display = 'none';
        bannerQR.style.display = 'none';
        bannerOffline.style.display = 'none';

        if (data.success && data.whatsapp_ready) {
            // ✅ متصل
            dot.className = 'status-dot online';
            text.textContent = 'متصل';
            bannerConnected.style.display = 'flex';

            // إذا كان غير متصل سابقاً، أظهر إشعار نجاح
            if (wasDisconnected) {
                showToast('✅ تم الاتصال بواتساب بنجاح!', 'success');
                wasDisconnected = false;
            }

            // إخفاء بانر النجاح بعد 5 ثوانٍ
            setTimeout(() => {
                bannerConnected.style.display = 'none';
            }, 5000);

            // إعادة سرعة التحديث للعادية
            setRefreshSpeed('normal');

        } else if (data.success && data.has_qr) {
            // 📱 بانتظار QR
            dot.className = 'status-dot offline';
            text.textContent = 'بانتظار QR';
            wasDisconnected = true;

            // جلب صورة QR
            try {
                const qrRes = await fetch(`${API_BASE}/qr`);
                const qrData = await qrRes.json();

                if (qrData.success && qrData.qr) {
                    document.getElementById('waQrImage').src = qrData.qr;
                    bannerQR.style.display = 'block';
                }
            } catch (e) {
                console.error('QR fetch error:', e);
            }

            // تسريع التحديث لجلب QR الجديد بسرعة
            setRefreshSpeed('fast');

        } else {
            // ❌ غير متصل
            dot.className = 'status-dot offline';
            text.textContent = 'غير متصل';
            bannerOffline.style.display = 'flex';
            wasDisconnected = true;

            // تسريع التحديث
            setRefreshSpeed('fast');
        }
    } catch (e) {
        const badge = document.getElementById('botStatusBadge');
        const dot = badge.querySelector('.status-dot');
        const text = badge.querySelector('.status-text');
        dot.className = 'status-dot offline';
        text.textContent = 'غير متصل';

        document.getElementById('waBannerConnected').style.display = 'none';
        document.getElementById('waBannerQR').style.display = 'none';
        document.getElementById('waBannerOffline').style.display = 'flex';
        wasDisconnected = true;
        setRefreshSpeed('fast');
    }
}

// ── Adaptive Refresh Speed ──
let currentSpeed = 'normal';

function setRefreshSpeed(speed) {
    if (speed === currentSpeed) return;
    currentSpeed = speed;
    clearInterval(refreshTimer);
    const interval = speed === 'fast' ? 3000 : REFRESH_INTERVAL;
    refreshTimer = setInterval(refreshData, interval);
}

async function loadLogs() {
    try {
        const res = await fetch(`${API_BASE}/logs`);
        const data = await res.json();

        const logsEl = document.getElementById('logsContent');
        if (data.success && data.logs) {
            logsEl.textContent = data.logs || 'لا توجد سجلات';
            // Auto-scroll to bottom
            logsEl.scrollTop = logsEl.scrollHeight;
        } else {
            logsEl.textContent = 'لا توجد سجلات';
        }
    } catch (e) {
        document.getElementById('logsContent').textContent = 'خطأ في تحميل السجلات';
    }
}

// =============================================
// Rendering
// =============================================

function renderUploads(uploads) {
    const tbody = document.getElementById('uploadsBody');
    const countEl = document.getElementById('tableCount');

    countEl.textContent = `${uploads.length} نتيجة`;

    if (uploads.length === 0) {
        tbody.innerHTML = `
            <tr class="empty-row">
                <td colspan="8">
                    <div class="empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                            <polyline points="13 2 13 9 20 9"></polyline>
                        </svg>
                        <p>لا توجد نتائج</p>
                    </div>
                </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = uploads.map(u => {
        const statusMap = {
            'completed': { label: 'مكتمل', class: 'badge-completed' },
            'pending':   { label: 'معلّق', class: 'badge-pending' },
            'waiting':   { label: 'بانتظار', class: 'badge-waiting' },
            'duplicate': { label: 'مكرر', class: 'badge-duplicate' },
            'failed':    { label: 'فشل', class: 'badge-failed' },
        };

        const status = statusMap[u.status] || { label: u.status, class: '' };
        const time = formatTime(u.uploaded_at);
        const driveLink = u.drive_url
            ? `<a href="${escapeHtml(u.drive_url)}" target="_blank" class="drive-link">فتح ↗</a>`
            : '<span style="color:var(--text-muted)">—</span>';

        const isImage = u.status === 'completed' && u.drive_id;
        const isVideoFile = isImage && /\.(mp4|3gp|mov|avi|mkv|webm)$/i.test(u.file_name);
        let thumbHtml;
        if (isImage) {
            if (isVideoFile) {
                thumbHtml = `<div class="thumb-cell thumb-video" onclick="openLightbox(${u.id}, '${escapeHtml(u.work_order)}', '${escapeHtml(u.file_name)}', true)"><div class="thumb-play">▶</div></div>`;
            } else {
                thumbHtml = `<div class="thumb-cell" onclick="openLightbox(${u.id}, '${escapeHtml(u.work_order)}', '${escapeHtml(u.file_name)}', false)"><img src="/api/image-thumb/${u.id}?size=small" alt="معاينة" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\'thumb-placeholder\'>🖼</span>'"></div>`;
            }
        } else {
            thumbHtml = '<span class="thumb-placeholder">—</span>';
        }

        return `
            <tr>
                <td>${thumbHtml}</td>
                <td><span class="wo-number">${escapeHtml(u.work_order)}</span></td>
                <td><span class="file-name" title="${escapeHtml(u.file_name)}">${escapeHtml(u.file_name)}</span></td>
                <td><span class="group-name" title="${escapeHtml(u.group_name || '')}">${escapeHtml(u.group_name || '—')}</span></td>
                <td>${escapeHtml(u.sender || '—')}</td>
                <td><span class="badge ${status.class}">${status.label}</span></td>
                <td class="time-cell">${time}</td>
                <td>${driveLink}</td>
            </tr>`;
    }).join('');
}

// =============================================
// Search & Filters
// =============================================

function setupSearch() {
    const input = document.getElementById('searchInput');
    let debounceTimer;

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            loadUploads();
        }, 400);
    });
}

function setupFilterTabs() {
    const tabs = document.querySelectorAll('.tab');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentFilter = tab.dataset.filter;
            loadUploads();
        });
    });
}

// =============================================
// Auto Refresh
// =============================================

function startAutoRefresh() {
    refreshTimer = setInterval(refreshData, REFRESH_INTERVAL);
}

function stopAutoRefresh() {
    clearInterval(refreshTimer);
}

// =============================================
// Utilities
// =============================================

function animateNumber(elementId, target) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const current = parseInt(el.textContent) || 0;
    if (current === target) return;

    const duration = 600;
    const steps = 30;
    const stepTime = duration / steps;
    const increment = (target - current) / steps;
    let step = 0;

    el.classList.add('counting');

    const timer = setInterval(() => {
        step++;
        if (step >= steps) {
            el.textContent = target.toLocaleString('ar-SA');
            el.classList.remove('counting');
            clearInterval(timer);
        } else {
            el.textContent = Math.round(current + (increment * step)).toLocaleString('ar-SA');
        }
    }, stepTime);
}

function formatTime(dateStr) {
    if (!dateStr) return '—';

    try {
        const date = new Date(dateStr.replace(' ', 'T'));
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);

        if (diffMins < 1) return 'الآن';
        if (diffMins < 60) return `${diffMins} دقيقة`;
        if (diffHours < 24) return `${diffHours} ساعة`;

        return date.toLocaleDateString('ar-SA', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return dateStr;
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// =============================================
// Toast Notifications
// =============================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOutRight 0.3s forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// =============================================
// Settings Modal Logic
// =============================================

async function openSettingsModal() {
    document.getElementById('settingsModal').classList.add('active');
    
    // Fetch current settings
    try {
        const res = await fetch(`${API_BASE}/settings`);
        const data = await res.json();
        
        let currentTarget = '';
        if (data.success && data.settings && data.settings.email_whatsapp_target) {
            currentTarget = data.settings.email_whatsapp_target;
        }

        // Fetch groups
        const groupsRes = await fetch(`${API_BASE}/groups`);
        const groupsData = await groupsRes.json();
        
        const groupSelect = document.getElementById('emailTargetGroup');
        groupSelect.innerHTML = '<option value="">-- اختر مجموعة --</option>';
        
        if (groupsData.success && groupsData.groups) {
            groupsData.groups.forEach(g => {
                const option = document.createElement('option');
                option.value = g.id;
                option.textContent = g.name;
                groupSelect.appendChild(option);
            });
        } else {
            groupSelect.innerHTML = '<option value="">لم يتم العثور على مجموعات أو البوت غير متصل</option>';
        }

        // Set initial values
        if (currentTarget.includes('@g.us')) {
            // It's a group
            document.querySelector('input[name="emailTargetType"][value="group"]').checked = true;
            toggleEmailTargetType();
            groupSelect.value = currentTarget;
        } else {
            // It's a number
            document.querySelector('input[name="emailTargetType"][value="number"]').checked = true;
            toggleEmailTargetType();
            document.getElementById('emailTargetNumber').value = currentTarget;
        }
        
    } catch (e) {
        showToast('خطأ في تحميل الإعدادات', 'error');
        console.error(e);
    }
}

function closeSettingsModal() {
    document.getElementById('settingsModal').classList.remove('active');
}

function toggleEmailTargetType() {
    const type = document.querySelector('input[name="emailTargetType"]:checked').value;
    if (type === 'number') {
        document.getElementById('emailTargetNumberContainer').style.display = 'block';
        document.getElementById('emailTargetGroupContainer').style.display = 'none';
    } else {
        document.getElementById('emailTargetNumberContainer').style.display = 'none';
        document.getElementById('emailTargetGroupContainer').style.display = 'block';
    }
}

async function saveSettings() {
    const type = document.querySelector('input[name="emailTargetType"]:checked').value;
    let target = '';
    
    if (type === 'number') {
        target = document.getElementById('emailTargetNumber').value.trim();
        if (!target) {
            showToast('الرجاء إدخال رقم الهاتف', 'error');
            return;
        }
    } else {
        target = document.getElementById('emailTargetGroup').value;
        if (!target) {
            showToast('الرجاء اختيار مجموعة', 'error');
            return;
        }
    }

    try {
        const res = await fetch(`${API_BASE}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'email_whatsapp_target', value: target })
        });
        
        const data = await res.json();
        if (data.success) {
            showToast('تم حفظ الإعدادات بنجاح', 'success');
            closeSettingsModal();
        } else {
            showToast(data.message || 'فشل حفظ الإعدادات', 'error');
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالخادم', 'error');
        console.error(e);
    }
}

// =============================================
// Lightbox
// =============================================

function openLightbox(uploadId, workOrder, fileName, isVideo = false) {
    const overlay = document.getElementById('lightboxOverlay');
    const img = document.getElementById('lightboxImage');
    const spinner = document.getElementById('lightboxSpinner');
    const info = document.getElementById('lightboxInfo');
    const content = document.querySelector('.lightbox-content');

    // Remove any existing video
    const existingVideo = document.getElementById('lightboxVideo');
    if (existingVideo) existingVideo.remove();

    // Reset state
    spinner.style.display = 'flex';

    // Show overlay
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    if (isVideo) {
        img.style.display = 'none';
        const video = document.createElement('video');
        video.id = 'lightboxVideo';
        video.controls = true;
        video.autoplay = true;
        video.style.maxWidth = '90vw';
        video.style.maxHeight = '80vh';
        video.style.borderRadius = 'var(--radius)';
        video.style.boxShadow = '0 8px 40px rgba(0,0,0,0.5)';
        video.style.opacity = '0';
        video.style.transition = 'opacity 0.4s ease';
        video.src = `/api/image-full/${uploadId}`;
        video.onloadeddata = () => {
            spinner.style.display = 'none';
            video.style.opacity = '1';
        };
        video.onerror = () => {
            spinner.innerHTML = '<span style="color:var(--red)">❌ فشل تحميل الفيديو</span>';
        };
        content.insertBefore(video, info);
    } else {
        img.style.display = 'block';
        img.style.opacity = '0';
        img.src = `/api/image-full/${uploadId}`;
    }

    const icon = isVideo ? '🎬' : '🖼';
    info.innerHTML = `<span class="lightbox-wo">أمر عمل: ${escapeHtml(workOrder)}</span> <span class="lightbox-file">${icon} ${escapeHtml(fileName)}</span>`;
}

function closeLightbox() {
    const overlay = document.getElementById('lightboxOverlay');
    const img = document.getElementById('lightboxImage');
    const video = document.getElementById('lightboxVideo');

    overlay.classList.remove('active');
    document.body.style.overflow = '';

    // Cleanup after animation
    setTimeout(() => {
        img.src = '';
        img.style.display = 'block';
        if (video) {
            video.pause();
            video.remove();
        }
    }, 300);
}

// Close on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
});
