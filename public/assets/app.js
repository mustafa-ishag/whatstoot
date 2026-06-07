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

async function loadBotStatus() {
    try {
        const res = await fetch(`${API_BASE}/bot-status`);
        const data = await res.json();

        const badge = document.getElementById('botStatusBadge');
        const dot = badge.querySelector('.status-dot');
        const text = badge.querySelector('.status-text');

        if (data.success && data.whatsapp_ready) {
            dot.className = 'status-dot online';
            text.textContent = 'متصل';
        } else if (data.success && data.has_qr) {
            dot.className = 'status-dot offline';
            text.textContent = 'بانتظار QR';
        } else {
            dot.className = 'status-dot offline';
            text.textContent = 'غير متصل';
        }
    } catch (e) {
        const badge = document.getElementById('botStatusBadge');
        const dot = badge.querySelector('.status-dot');
        const text = badge.querySelector('.status-text');
        dot.className = 'status-dot offline';
        text.textContent = 'غير متصل';
    }
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
        const thumbHtml = isImage
            ? `<div class="thumb-cell" onclick="openLightbox(${u.id}, '${escapeHtml(u.work_order)}', '${escapeHtml(u.file_name)}')"><img src="/api/image-thumb/${u.id}?size=small" alt="معاينة" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\'thumb-placeholder\'>🖼</span>'"></div>`
            : '<span class="thumb-placeholder">—</span>';

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
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Auto remove after 4 seconds
    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// =============================================
// Lightbox
// =============================================

function openLightbox(uploadId, workOrder, fileName) {
    const overlay = document.getElementById('lightboxOverlay');
    const img = document.getElementById('lightboxImage');
    const spinner = document.getElementById('lightboxSpinner');
    const info = document.getElementById('lightboxInfo');

    // Reset state
    img.style.opacity = '0';
    img.src = '';
    spinner.style.display = 'flex';

    // Show overlay
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Load full image
    img.src = `/api/image-full/${uploadId}`;
    info.innerHTML = `<span class="lightbox-wo">أمر عمل: ${escapeHtml(workOrder)}</span> <span class="lightbox-file">${escapeHtml(fileName)}</span>`;
}

function closeLightbox() {
    const overlay = document.getElementById('lightboxOverlay');
    const img = document.getElementById('lightboxImage');

    overlay.classList.remove('active');
    document.body.style.overflow = '';

    // Cleanup after animation
    setTimeout(() => {
        img.src = '';
    }, 300);
}

// Close on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
});
