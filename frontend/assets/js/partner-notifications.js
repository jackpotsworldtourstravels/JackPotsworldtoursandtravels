'use strict';
/* Notification centre — polls GET /api/notifications (API_CONTRACT.md §6.4; no WebSocket
   backend exists yet, so this is the explicit polling fallback).
   ---------------------------------------------------------------------------
   Presented as a right-hand DRAWER grouped by day rather than the old 340px
   dropdown. Three endpoints, unchanged and in the same shapes:
     GET   /api/notifications?page_size=
     GET   /api/notifications/unread-count
     PATCH /api/notifications/{id}/read
     POST  /api/notifications/read-all

   The element ids (#notifBellBtn, #notifDropdown, #notifBadge) are the ones this
   file has always bound; only their markup and position in the document changed
   — the panel is now a <body> child, because .mh-header sets backdrop-filter and
   that makes it a containing block for position:fixed descendants, which would
   have pinned the drawer to the header instead of the viewport. */

const NOTIF_POLL_MS = 20000;
let notifPollTimer = null;

/* Icon and tone come off the title, which is the only signal the payload gives —
   NotificationOut has no category field. */
function notifIconFor(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('approved') || t.includes('issued') || t.includes('paid')) return { glyph: '✓', tone: 'ok' };
  if (t.includes('rejected') || t.includes('cancel') || t.includes('failed')) return { glyph: '✕', tone: 'bad' };
  if (t.includes('pending') || t.includes('await') || t.includes('review')) return { glyph: '⏳', tone: 'wait' };
  if (t.includes('refund')) return { glyph: '₹', tone: 'wait' };
  if (t.includes('payment')) return { glyph: '₹', tone: '' };
  return { glyph: '•', tone: '' };
}

function notifRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return fmtDateTime(iso);
}

/* "Today" / "Yesterday" / an absolute date. Compared on local calendar days, not
   on a 24-hour window: something sent at 23:50 must read as "Yesterday" the next
   morning, not "Today". */
function notifDayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const startOf = t => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString('en-IN', { weekday: 'long' });
  return fmtDate(iso);
}

/* Preserves the order the API returned (newest first) while collecting each day's
   items together. */
function notifGroupByDay(items) {
  const groups = [];
  const index = new Map();
  items.forEach(n => {
    const label = notifDayLabel(n.created_at);
    if (!index.has(label)) {
      index.set(label, { label, items: [] });
      groups.push(index.get(label));
    }
    index.get(label).items.push(n);
  });
  return groups;
}

function notifItemHtml(n) {
  const { glyph, tone } = notifIconFor(n.title);
  return `
    <button type="button" class="mh-nd-item${n.is_read ? '' : ' unread'}" data-id="${n.id}"
            ${n.is_read ? 'aria-label="Notification"' : 'aria-label="Unread notification"'}>
      <span class="mh-nd-ico${tone ? ` mh-nd-ico-${tone}` : ''}" aria-hidden="true">${glyph}</span>
      <span class="mh-nd-body">
        <span class="mh-nd-title">${escapeHtml(n.title)}</span>
        <span class="mh-nd-msg">${escapeHtml(n.message)}</span>
        <span class="mh-nd-time">${escapeHtml(notifRelativeTime(n.created_at))}</span>
      </span>
      ${n.is_read ? '' : '<span class="mh-nd-dot" aria-hidden="true"></span>'}
    </button>`;
}

function notifShellHtml(unread, inner, hasItems) {
  return `
    <div class="mh-nd-head">
      <h2>Notifications</h2>
      ${unread > 0 ? `<span class="mh-nd-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
      <button type="button" class="mh-nd-close" id="notifCloseBtn" aria-label="Close notifications">✕</button>
    </div>
    ${hasItems ? `<div class="mh-nd-tools">
      <button type="button" class="mh-nd-markall" id="notifMarkAllBtn"${unread === 0 ? ' disabled' : ''}>
        Mark all as read</button>
    </div>` : ''}
    <div class="mh-nd-list">${inner}</div>`;
}

async function fetchAndRenderNotifications() {
  const drawer = document.getElementById('notifDropdown');
  const badge = document.getElementById('notifBadge');
  if (!drawer) return;
  try {
    const [{ data: page }, { data: unread }] = await Promise.all([
      axios.get(`${API_BASE}/api/notifications`, { headers: partnerAuthHeaders(), params: { page_size: 30 } }),
      axios.get(`${API_BASE}/api/notifications/unread-count`, { headers: partnerAuthHeaders() }),
    ]);
    if (unread.count > 0) {
      badge.textContent = unread.count > 9 ? '9+' : String(unread.count);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }

    if (!page.items.length) {
      drawer.innerHTML = notifShellHtml(0, `
        <div class="mh-nd-empty">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          <b>You're all caught up</b>
          <span>Approvals, payment updates and ticket confirmations will appear here.</span>
        </div>`, false);
    } else {
      drawer.innerHTML = notifShellHtml(unread.count, notifGroupByDay(page.items).map(g => `
        <div class="mh-nd-day">${escapeHtml(g.label)}</div>
        ${g.items.map(notifItemHtml).join('')}`).join(''), true);
    }

    document.getElementById('notifCloseBtn')?.addEventListener('click', closeNotifications);
    document.getElementById('notifMarkAllBtn')?.addEventListener('click', async () => {
      await axios.post(`${API_BASE}/api/notifications/read-all`, {}, { headers: partnerAuthHeaders() });
      fetchAndRenderNotifications();
    });
    drawer.querySelectorAll('.mh-nd-item.unread').forEach(el => {
      el.addEventListener('click', async () => {
        await axios.patch(`${API_BASE}/api/notifications/${el.dataset.id}/read`, {}, { headers: partnerAuthHeaders() });
        fetchAndRenderNotifications();
      });
    });
  } catch (err) { /* silent — the drawer just won't update this cycle */ }
}

function openNotifications() {
  const drawer = document.getElementById('notifDropdown');
  const backdrop = document.getElementById('notifBackdrop');
  const bell = document.getElementById('notifBellBtn');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  backdrop?.classList.add('open');
  bell?.setAttribute('aria-expanded', 'true');
  document.body.classList.add('mh-noscroll');
  fetchAndRenderNotifications();
  /* Focus lands inside the drawer so keyboard users aren't left behind the
     backdrop; Close is the first control, matching the reading order. */
  setTimeout(() => document.getElementById('notifCloseBtn')?.focus(), 60);
}

function closeNotifications() {
  const drawer = document.getElementById('notifDropdown');
  const backdrop = document.getElementById('notifBackdrop');
  const bell = document.getElementById('notifBellBtn');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  backdrop?.classList.remove('open');
  bell?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('mh-noscroll');
  bell?.focus();
}

function initNotifications() {
  const bellBtn = document.getElementById('notifBellBtn');
  const drawer = document.getElementById('notifDropdown');
  if (!bellBtn || bellBtn.dataset.wired) return;
  bellBtn.dataset.wired = '1';

  bellBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (drawer.classList.contains('open')) closeNotifications(); else openNotifications();
  });
  document.getElementById('notifBackdrop')?.addEventListener('click', closeNotifications);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) closeNotifications();
  });

  /* Renders once up front so the unread badge is correct before the drawer is
     ever opened, then keeps polling. */
  fetchAndRenderNotifications();
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = setInterval(fetchAndRenderNotifications, NOTIF_POLL_MS);
}
