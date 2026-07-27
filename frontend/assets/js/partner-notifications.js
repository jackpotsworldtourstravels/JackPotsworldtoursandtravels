'use strict';
/* Notification bell — polls GET /api/partner/notifications (no WebSocket
   backend exists yet, so this is the explicit polling fallback). */

const NOTIF_POLL_MS = 20000;
let notifPollTimer = null;

function notifIconFor(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('approved')) return '✓';
  if (t.includes('rejected')) return '✕';
  if (t.includes('pending')) return '…';
  if (t.includes('cancel')) return '⊘';
  if (t.includes('refund')) return '₹';
  return '•';
}
function notifRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return fmtDate(iso);
}

async function fetchAndRenderNotifications() {
  const dropdown = document.getElementById('notifDropdown');
  const badge = document.getElementById('notifBadge');
  if (!dropdown) return;
  try {
    const { data } = await axios.get(`${API_BASE}/api/partner/notifications`, { headers: partnerAuthHeaders() });
    if (data.unread_count > 0) {
      badge.textContent = data.unread_count > 9 ? '9+' : String(data.unread_count);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
    if (!data.notifications.length) {
      dropdown.innerHTML = `<div class="notif-head"><span>Notifications</span></div>
        <div class="empty-state" style="padding:28px 16px;">
          <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          No notifications yet
        </div>`;
      return;
    }
    dropdown.innerHTML = `
      <div class="notif-head">
        <span>Notifications</span>
        <button type="button" id="notifMarkAllBtn" ${data.unread_count === 0 ? 'disabled' : ''}>Mark all as read</button>
      </div>
      <div class="notif-list">
        ${data.notifications.map(n => `
          <div class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${n.notification_id}">
            <span class="notif-item-icon">${notifIconFor(n.title)}</span>
            <div class="notif-item-body">
              <div class="notif-item-title">${escapeHtml(n.title)}</div>
              <div class="notif-item-msg">${escapeHtml(n.message)}</div>
              <div class="notif-item-time">${notifRelativeTime(n.created_at)}</div>
            </div>
            ${n.is_read ? '' : '<span class="notif-dot"></span>'}
          </div>`).join('')}
      </div>`;
    document.getElementById('notifMarkAllBtn')?.addEventListener('click', async () => {
      await axios.post(`${API_BASE}/api/partner/notifications/mark-all-read`, {}, { headers: partnerAuthHeaders() });
      fetchAndRenderNotifications();
    });
    dropdown.querySelectorAll('.notif-item.unread').forEach(el => {
      el.addEventListener('click', async () => {
        await axios.post(`${API_BASE}/api/partner/notifications/${el.dataset.id}/read`, {}, { headers: partnerAuthHeaders() });
        fetchAndRenderNotifications();
      });
    });
  } catch (err) { /* silent — bell just won't update this cycle */ }
}

function initNotifications() {
  const bellBtn = document.getElementById('notifBellBtn');
  const dropdown = document.getElementById('notifDropdown');
  if (!bellBtn || bellBtn.dataset.wired) return;
  bellBtn.dataset.wired = '1';
  bellBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = dropdown.classList.toggle('open');
    if (open) fetchAndRenderNotifications();
  });
  document.addEventListener('click', e => {
    if (!dropdown.contains(e.target) && e.target !== bellBtn) dropdown.classList.remove('open');
  });
  fetchAndRenderNotifications();
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = setInterval(fetchAndRenderNotifications, NOTIF_POLL_MS);
}
