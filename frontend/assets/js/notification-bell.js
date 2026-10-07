'use strict';
/* ===========================================================================
   notification-bell.js — the header bell: unread badge + dropdown.
   ===========================================================================
   The notifications themselves are the server's (customer_notifications, written
   by the booking / payment / account code that causes them). This file only
   reads them through the existing /api/customer/notifications endpoints:

       GET   /api/customer/notifications/unread-count   -> {unread: n}
       GET   /api/customer/notifications                -> newest first
       PATCH /api/customer/notifications/{id}/read
       PATCH /api/customer/notifications/read-all

   There is no push channel in this application (the only sockets are live chat
   and calls), so the badge is kept fresh by a light poll while the tab is
   visible, plus a refresh on focus and each time the panel opens.

   It owns every `[data-nav-acct="notifications"]` button. The click is taken in
   the capture phase so the header's own handler (which opens the Account Center)
   does not also fire; "View all" still opens that panel. Signed out, it does
   nothing and the header behaves exactly as before.
   =========================================================================== */

const JPNotifications = (function () {
  const SEL = '[data-nav-acct="notifications"]';
  const POLL_MS = 60000;
  const SHOW = 8;                      // newest N in the dropdown; "View all" for the rest

  let items = [];
  let unread = 0;
  let panel = null;
  let anchor = null;
  let timer = null;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function token() {
    try { return (typeof getCustomerAuth === 'function' && getCustomerAuth().access) || ''; }
    catch { return ''; }
  }
  const signedIn = () => !!token();

  async function api(method, path) {
    const base = (typeof API_BASE === 'string') ? API_BASE : '';
    const res = await fetch(base + '/api/customer/notifications' + path, {
      method, headers: { Authorization: 'Bearer ' + token() },
    });
    if (!res.ok) throw new Error(String(res.status));
    return res.status === 204 ? null : res.json();
  }

  /* ---- styles --------------------------------------------------------- */
  function injectCss() {
    if (document.getElementById('jpNbCss')) return;
    const st = document.createElement('style');
    st.id = 'jpNbCss';
    st.textContent = `
${SEL}{position:relative}
.jp-nb-badge{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;
  background:#C0392B;color:#fff;font:700 11px/18px 'Montserrat',system-ui,sans-serif;text-align:center;
  box-shadow:0 0 0 2px #0A2540;pointer-events:none}
.jp-nb-panel{position:fixed;z-index:10000;width:380px;max-width:calc(100vw - 24px);max-height:min(540px,calc(100vh - 90px));
  display:flex;flex-direction:column;background:#fff;color:#0A2540;border-radius:14px;overflow:hidden;
  box-shadow:0 18px 50px rgba(10,37,64,.28);border:1px solid rgba(10,37,64,.1);font-family:'Montserrat',system-ui,sans-serif}
.jp-nb-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(10,37,64,.1)}
.jp-nb-head h3{margin:0;font-size:15px;font-weight:800}
.jp-nb-link{background:none;border:0;padding:4px 2px;font:600 12.5px 'Montserrat',system-ui,sans-serif;color:#9A7424;cursor:pointer}
.jp-nb-link:hover{text-decoration:underline}.jp-nb-link:disabled{opacity:.4;cursor:default;text-decoration:none}
.jp-nb-list{overflow-y:auto;flex:1}
.jp-nb-item{display:flex;gap:12px;width:100%;text-align:left;padding:12px 16px;background:#fff;border:0;
  border-bottom:1px solid rgba(10,37,64,.07);cursor:pointer;color:inherit;font:inherit}
.jp-nb-item:hover,.jp-nb-item:focus-visible{background:#F6F8FB;outline:none}
.jp-nb-item.is-unread{background:#FBF6EC;box-shadow:inset 3px 0 0 #D9A32C}
.jp-nb-item.is-unread:hover,.jp-nb-item.is-unread:focus-visible{background:#F8EFD9}
.jp-nb-ic{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#0A2540;color:#E8C777}
.jp-nb-ic svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.jp-nb-ic.is-bad{background:#7a1d16;color:#fff}.jp-nb-ic.is-ok{background:#1E6B45;color:#fff}
.jp-nb-main{flex:1;min-width:0}
.jp-nb-t{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:700}
.jp-nb-dot{width:8px;height:8px;border-radius:50%;background:#D9A32C;flex:none}
.jp-nb-m{margin:2px 0 0;font-size:12.5px;line-height:1.4;color:#44566E;overflow-wrap:anywhere}
.jp-nb-time{margin-top:4px;font-size:11.5px;color:#7A8AA0}
.jp-nb-empty{padding:34px 20px;text-align:center}
.jp-nb-empty b{display:block;font-size:14px}.jp-nb-empty span{font-size:12.5px;color:#7A8AA0}
.jp-nb-foot{padding:10px 16px;border-top:1px solid rgba(10,37,64,.1);text-align:center}
@media (max-width:480px){.jp-nb-panel{left:12px!important;right:12px!important;width:auto}}`;
    document.head.appendChild(st);
  }

  /* ---- badge ---------------------------------------------------------- */
  function paintBadge() {
    document.querySelectorAll(SEL).forEach(btn => {
      let b = btn.querySelector('.jp-nb-badge');
      if (!signedIn() || unread <= 0) { if (b) b.remove(); btn.removeAttribute('data-unread'); return; }
      if (!b) { b = document.createElement('span'); b.className = 'jp-nb-badge'; b.setAttribute('aria-hidden', 'true'); btn.appendChild(b); }
      const txt = unread > 99 ? '99+' : String(unread);
      if (b.textContent !== txt) b.textContent = txt;
      btn.setAttribute('data-unread', String(unread));
      btn.setAttribute('aria-label', 'Notifications, ' + unread + ' unread');
    });
    if (!unread) document.querySelectorAll(SEL).forEach(btn => btn.setAttribute('aria-label', 'Notifications'));
  }

  async function refreshCount() {
    if (!signedIn()) { unread = 0; paintBadge(); return; }
    try { unread = (await api('GET', '/unread-count')).unread | 0; paintBadge(); }
    catch { /* offline or signed out elsewhere: keep what is shown */ }
  }

  /* ---- time ----------------------------------------------------------- */
  function ago(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'Just now';
    const m = Math.floor(s / 60); if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    const h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    const d = Math.floor(h / 24); if (d < 7) return d + (d === 1 ? ' day ago' : ' days ago');
    return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  const ICONS = {
    booking_created: '<path d="M4 7h16v12H4z"/><path d="M9 7V5h6v2M4 12h16"/>',
    booking_confirmed: '<path d="M20 6 9 17l-5-5"/>',
    booking_cancelled: '<path d="M18 6 6 18M6 6l12 12"/>',
    booking_payment: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
    general: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  };

  /* ---- panel ---------------------------------------------------------- */
  function itemHtml(n) {
    const tone = n.notification_type === 'booking_cancelled' ? ' is-bad'
      : (n.notification_type === 'booking_confirmed' || n.notification_type === 'booking_payment') ? ' is-ok' : '';
    return `<button type="button" class="jp-nb-item${n.is_read ? '' : ' is-unread'}" data-nb-id="${n.id}" role="menuitem">
      <span class="jp-nb-ic${tone}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n.notification_type] || ICONS.general}</svg></span>
      <span class="jp-nb-main">
        <span class="jp-nb-t">${esc(n.title)}${n.is_read ? '' : '<i class="jp-nb-dot" aria-label="Unread"></i>'}</span>
        <p class="jp-nb-m">${esc(n.message)}</p>
        <span class="jp-nb-time">${esc(ago(n.created_at))}</span>
      </span></button>`;
  }

  function paintPanel() {
    if (!panel) return;
    const shown = items.slice(0, SHOW);
    panel.innerHTML = `
      <div class="jp-nb-head"><h3>Notifications</h3>
        <button type="button" class="jp-nb-link" data-nb-all ${unread ? '' : 'disabled'}>Mark all as read</button></div>
      <div class="jp-nb-list" role="menu">${shown.length ? shown.map(itemHtml).join('')
        : '<div class="jp-nb-empty"><b>No notifications yet</b><span>You’re all caught up.</span></div>'}</div>
      ${items.length ? '<div class="jp-nb-foot"><button type="button" class="jp-nb-link" data-nb-viewall>View all notifications</button></div>' : ''}`;
  }

  function place() {
    if (!panel || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(380, window.innerWidth - 24);
    panel.style.top = Math.round(r.bottom + 10) + 'px';
    panel.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w)) + 'px';
  }

  async function load() {
    try { items = await api('GET', ''); } catch { items = items || []; }
    unread = items.filter(n => !n.is_read).length;
    paintBadge(); paintPanel();
  }

  function open(btn) {
    anchor = btn;
    panel = document.createElement('div');
    panel.className = 'jp-nb-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(panel);
    btn.setAttribute('aria-expanded', 'true');
    paintPanel(); place();
    load();
  }

  function close(returnFocus) {
    if (!panel) return;
    panel.remove(); panel = null;
    if (anchor) { anchor.setAttribute('aria-expanded', 'false'); if (returnFocus) anchor.focus(); }
    anchor = null;
  }

  async function markRead(n) {
    if (n.is_read) return;
    n.is_read = true; unread = Math.max(0, unread - 1); paintBadge(); paintPanel();   // immediate
    try { await api('PATCH', '/' + n.id + '/read'); }
    catch { n.is_read = false; unread += 1; paintBadge(); paintPanel(); }
  }

  async function markAll() {
    const was = items.map(n => n.is_read), prev = unread;
    items.forEach(n => { n.is_read = true; }); unread = 0; paintBadge(); paintPanel();
    try { await api('PATCH', '/read-all'); }
    catch { items.forEach((n, i) => { n.is_read = was[i]; }); unread = prev; paintBadge(); paintPanel(); }
  }

  /** Where a booking notification goes: My Bookings, on that booking. */
  function target(n) {
    return n.related_ref ? 'my-bookings.html?open=' + encodeURIComponent(n.related_ref) : '';
  }

  function openAccountPanel() {
    if (typeof AccountCenter !== 'undefined' && AccountCenter.open) AccountCenter.open('notifications');
    else window.location.href = 'index.html?account=notifications';
  }

  /* ---- events --------------------------------------------------------- */
  document.addEventListener('click', e => {
    const bell = e.target.closest(SEL);
    if (bell && signedIn()) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (panel && anchor === bell) close(); else { close(); open(bell); }
      return;
    }
    if (!panel) return;
    if (!panel.contains(e.target)) { close(); return; }

    if (e.target.closest('[data-nb-all]')) { markAll(); return; }
    if (e.target.closest('[data-nb-viewall]')) { close(); openAccountPanel(); return; }
    const row = e.target.closest('[data-nb-id]');
    if (row) {
      const n = items.find(x => String(x.id) === row.dataset.nbId);
      if (!n) return;
      const dest = target(n);
      /* Marked before leaving, so the read state is on the server by the time
         the next page asks for its count. */
      markRead(n).finally(() => { if (dest) window.location.href = dest; });
      if (!dest) return;
      e.preventDefault();
    }
  }, true);

  document.addEventListener('keydown', e => {
    if (!panel) return;
    if (e.key === 'Escape') { close(true); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const els = [...panel.querySelectorAll('button:not([disabled])')];
      if (!els.length) return;
      e.preventDefault();
      const i = els.indexOf(document.activeElement);
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length].focus();
    }
  });

  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);

  /* Focus, visibility and the poll can all fire together; one request per 15s is plenty. */
  let lastTick = 0;
  function tick() {
    if (document.hidden || Date.now() - lastTick < 15000) return;
    lastTick = Date.now();
    refreshCount();
  }
  function start() {
    injectCss();
    refreshCount();
    if (!timer) timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    /* The header can be (re)built after this file runs, and sign-in/out happens
       without a reload; keep the badge on whatever bell buttons exist. */
    window.addEventListener('storage', e => { if (e.key && e.key.indexOf('jpc_') === 0) { close(); refreshCount(); } });
    new MutationObserver(() => paintBadge()).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  return { refresh: refreshCount };
})();
