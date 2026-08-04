'use strict';
/* Classic Merchant Portal — shell: auth, routing, and the primitives every
   module renders with.
   ===========================================================================
   Shares the session with the Premium portal. `storePortalTokens('merchant',…)`
   and `partnerAuthHeaders()` come from ../assets/js/auth.js and write the same
   partner_jwt_* localStorage keys Premium reads, so signing in on either
   interface signs you into both and "Premium view" in the toolbar is a plain
   link, not a re-login.

   Nothing here touches Premium's DOM. Element ids are all `cl*`, classes all
   `cl-`, and the section router only ever looks inside `.cl-section`. */

/* Same rule as partner-shared.js: absolute base in local dev, same-origin in
   production. Declared here because merchant-api.js needs it in scope. */
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

/* ---------------------------------------------------------------- helpers */

const $ = id => document.getElementById(id);

/* Turns 'payment_pending' into 'Payment Pending'. Same transform Premium uses,
   because these strings come straight off request_status_enum. */
function clLabel(s) {
  return (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* Status -> tag colour. Kept in one place so a status never renders green on
   one screen and grey on another. */
const CL_STATUS_TONE = {
  draft: '', pending_approval: 'warn', in_review: 'warn', approved: 'info',
  payment_pending: 'warn', paid: 'ok', ticket_issued: 'ok', ticketed: 'ok',
  completed: 'ok', cancelled: 'err', rejected: 'err',
};
/* `label` is the server's own wording when it has one. It matters on the
   Classic Tours track (CR-2), where `pending_approval` means "Pending Manager
   Approval" and `approved` means "Manager Approved" — deriving the text from
   the enum value here would tell the merchant the wrong thing about who is
   holding its booking. */
function clTag(status, label) {
  const tone = CL_STATUS_TONE[status];
  return `<span class="cl-tag${tone ? ` cl-tag-${tone}` : ''}">${escapeHtml(label || clLabel(status))}</span>`;
}

/* Money that came from finance_service is formatted by `moneyStr()` in
   shared/formatters.js — one implementation for every portal, so the Classic
   merchant screen and the Admin screen cannot render the same balance
   differently. There is deliberately no `cl`-prefixed copy of it here. */

function clMsg(el, text, kind) {
  if (!el) return;
  el.className = `cl-msg${text ? ` cl-msg-${kind || 'info'}` : ''}`;
  el.textContent = text || '';
}

/* Every module's error path funnels through here so the backend's `detail`
   is what the user sees, rather than a generic failure string. */
function clError(err, fallback) {
  return err?.response?.data?.detail || err?.message || fallback || 'Something went wrong.';
}

function clLoadingRow(cols, text) {
  return `<tr><td colspan="${cols}" class="cl-empty"><span class="cl-spin"></span> ${escapeHtml(text || 'Loading…')}</td></tr>`;
}
function clEmptyRow(cols, text) {
  return `<tr><td colspan="${cols}" class="cl-empty">${escapeHtml(text)}</td></tr>`;
}

/* ------------------------------------------------------------------ modal */

let clModalOnClose = null;

function clOpenModal(title, bodyHtml, footHtml) {
  $('clModalTitle').textContent = title;
  $('clModalBody').innerHTML = bodyHtml;
  $('clModalFoot').innerHTML = footHtml || '';
  $('clModalBack').classList.add('open');
}
function clCloseModal() {
  $('clModalBack').classList.remove('open');
  $('clModalBody').innerHTML = '';
  $('clModalFoot').innerHTML = '';
  clModalOnClose?.();
  clModalOnClose = null;
}

/* A confirm that returns a promise, so destructive actions read linearly.
   Deliberately not window.confirm(): a native dialog blocks the page and
   cannot be driven by a test harness. */
function clConfirm(message, confirmLabel) {
  return new Promise(resolve => {
    clOpenModal('Confirm', `<p style="margin:0;font-size:12.5px;">${escapeHtml(message)}</p>`,
      `<button type="button" class="cl-btn" data-cl-confirm="0">Cancel</button>
       <button type="button" class="cl-btn cl-btn-primary" data-cl-confirm="1">${escapeHtml(confirmLabel || 'Confirm')}</button>`);
    let done = false;
    const finish = v => { if (done) return; done = true; clModalOnClose = null; clCloseModal(); resolve(v); };
    $('clModalFoot').querySelectorAll('[data-cl-confirm]').forEach(b => {
      b.addEventListener('click', () => finish(b.dataset.clConfirm === '1'));
    });
    clModalOnClose = () => { done = true; resolve(false); };
  });
}

/* ----------------------------------------------------------------- router */

const CL_TITLES = {
  dashboard: 'Dashboard', enquiry: 'Booking Enquiry', 'booking-request': 'Booking Request',
  /* Reached from a row action rather than the sidebar — there is no nav item
     for it, because "the booking you just clicked" is not a destination you
     navigate to cold. */
  'booking-detail': 'Booking Request Details',
  requests: 'My Requests', approvals: 'Approvals',
  wallet: 'Wallet', payments: 'Payments', 'service-request': 'Service Requests',
  reports: 'Reports', notifications: 'Notifications', profile: 'Profile & Settings',
  support: 'Support',
};

/* Each section renders on first visit and then keeps its state, so tabbing
   away and back does not throw away a half-filled form. Modules call
   clInvalidate() when they know another section's data is now stale. */
const clLoaded = new Set();

const CL_LOADERS = {
  dashboard: () => clInitDashboard(),
  enquiry: () => clInitEnquiry(),
  'booking-request': () => clInitBookingRequest(),
  'booking-detail': () => clInitBookingDetail(),
  requests: () => clInitRequests(),
  approvals: () => clInitApprovals(),
  wallet: () => clInitWallet(),
  payments: () => clInitPayments(),
  'service-request': () => clInitServiceRequest(),
  reports: () => clInitReports(),
  notifications: () => clInitNotifications(),
  profile: () => clInitProfile(),
  support: () => clInitSupport(),
};

function clGo(section, afterLoad) {
  if (!CL_LOADERS[section]) section = 'dashboard';
  document.querySelectorAll('[data-cl-nav]').forEach(a => {
    a.classList.toggle('active', a.dataset.clNav === section);
  });
  document.querySelectorAll('.cl-section').forEach(s => {
    s.classList.toggle('active', s.id === `cl-${section}`);
  });
  $('clCrumb').textContent = CL_TITLES[section] || section;
  $('clSide').classList.remove('open');
  location.hash = section;

  if (!clLoaded.has(section)) {
    clLoaded.add(section);
    Promise.resolve(CL_LOADERS[section]()).then(() => afterLoad?.());
  } else {
    afterLoad?.();
  }
  window.scrollTo({ top: 0 });
}

/* Marks sections stale so they re-render next time they are opened. Called
   after anything that changes server state — raising a request changes the
   dashboard counters, My Requests, and Payments all at once. */
function clInvalidate(...sections) {
  sections.forEach(s => clLoaded.delete(s));
}

/* Re-render a section that is stale AND currently on screen; otherwise the
   user watches a table that no longer matches what they just did. */
function clRefreshIfVisible(section) {
  if ($(`cl-${section}`)?.classList.contains('active')) {
    clLoaded.add(section);
    CL_LOADERS[section]();
  }
}

/* ------------------------------------------------------------------- auth */

let clChallengeToken = '';

function clShowAuth() {
  $('clAuth').style.display = 'flex';
  $('clApp').classList.remove('active');
}
/* ---------------------------------------------------------------------------
   Who is signed in, and as what.

   The topbar shows the ROLE beside the name. Two role fields exist on the
   session: `merchant_role` (Manager / Supervisor / Operator / Finance / Data
   Operator — the job inside the company) and `role` (merchant_admin /
   merchant_user — the portal-level one). The merchant role is the one that
   decides what this person may do day to day, so it wins when present.

   Operator and Data Operator are the same role by the business's decision
   (see rbac.py::_MERCHANT_OPERATOR), so both print as "Operator" rather than
   showing two names for one job.
   --------------------------------------------------------------------------- */
const CL_MERCHANT_ROLE_LABELS = {
  manager: 'Manager', supervisor: 'Supervisor', operator: 'Operator',
  finance: 'Finance', data_operator: 'Operator',
};
const CL_PORTAL_ROLE_LABELS = {
  merchant_admin: 'Merchant Admin', merchant_user: 'Merchant User',
};

/* The signed-in user, as the login stored it. Null on a session created before
   `merchant_user_json` existed — clRefreshRole() repairs that from /api/profile. */
function clSessionUser() {
  try { return getPortalUser('merchant'); } catch { return null; }
}

function clRoleLabel(user) {
  if (!user) return '';
  return CL_MERCHANT_ROLE_LABELS[user.merchant_role]
    || CL_PORTAL_ROLE_LABELS[user.role]
    || clLabel(user.merchant_role || user.role || '');
}

/* Whether this account may sign off its own company's service requests.
   Mirrors the server's rule in change_request_service._is_manager. */
function clIsManager(user = clSessionUser()) {
  return !!user && (user.merchant_role === 'manager' || user.role === 'merchant_admin');
}

/* A session stored before the role was needed carries no role at all, and the
   topbar would sit on a dash forever. /api/profile returns the same shape the
   login did, so one call repairs it — and it is the same call Profile &
   Settings already makes, so nothing new is being asked of the backend. */
async function clRefreshRole() {
  if (clRoleLabel(clSessionUser())) return;
  try {
    const me = await MerchantApi.getProfile();
    localStorage.setItem('merchant_user_json', JSON.stringify(me));
    $('clUserRole').textContent = clRoleLabel(me) || '—';
  } catch { /* the topbar keeps the name; the role stays blank */ }
}

function clShowApp() {
  $('clAuth').style.display = 'none';
  $('clApp').classList.add('active');

  const name = localStorage.getItem(PARTNER_KEYS.fullName) || 'Merchant';
  $('clUserName').textContent = name;
  $('clUserRole').textContent = clRoleLabel(clSessionUser()) || '—';
  clRefreshRole();
  $('clDate').textContent = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  /* CR-3 — Approvals is only a destination for the merchant's approvers. Hiding
     it is presentation only; the endpoints behind it are permission-gated
     server-side, so a hidden link is not what keeps anyone out. */
  const canApprove = clCanApprove();
  $('clNavApprovals').style.display = canApprove ? '' : 'none';

  /* Deep links survive a reload: #payments lands on Payments. A user without
     the permission who follows #approvals would otherwise render an empty
     section with no way back. */
  let target = (location.hash || '').replace('#', '') || 'dashboard';
  if (target === 'approvals' && !canApprove) target = 'dashboard';
  clGo(target);
  clLoadUnreadCount();
}

/* Identical contract to Premium's partner-auth.js — same helpers from auth.js,
   same portal string, same two steps. */
async function clLogin() {
  const email = $('clEmail').value.trim();
  const password = $('clPassword').value;
  const msg = $('clAuthMsg1');
  if (!email || !password) return clMsg(msg, 'Enter your email and password.', 'err');

  const btn = $('clLoginBtn');
  btn.disabled = true;
  clMsg(msg, 'Signing in…', 'muted');
  try {
    const challenge = await startPortalLogin('merchant', email, password);
    clChallengeToken = challenge.challenge_token;
    $('clOtpSub').textContent = challenge.dev_otp
      ? `Dev mode — code: ${challenge.dev_otp}`
      : `Enter the 6-digit code sent to ${email}.`;
    clMsg(msg, '');
    document.querySelectorAll('.cl-auth-step').forEach(s => s.classList.remove('active'));
    $('clAuthStep2').classList.add('active');
    $('clOtp').focus();
  } catch (err) {
    clMsg(msg, clError(err, 'Invalid email or password.'), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function clVerifyOtp() {
  const code = $('clOtp').value.trim();
  const msg = $('clAuthMsg2');
  if (code.length < 4) return clMsg(msg, 'Enter the code sent to your email.', 'err');

  const btn = $('clVerifyBtn');
  btn.disabled = true;
  clMsg(msg, 'Verifying…', 'muted');
  try {
    const data = await verifyPortalOtp(clChallengeToken, code);
    storePortalTokens('merchant', data);       // same keys Premium reads
    clChallengeToken = '';
    ['clEmail', 'clPassword', 'clOtp'].forEach(id => { $(id).value = ''; });
    clMsg(msg, '');
    clShowApp();
  } catch (err) {
    clMsg(msg, clError(err, 'Incorrect or expired code.'), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function clResendOtp() {
  const msg = $('clAuthMsg2');
  try {
    const challenge = await resendPortalOtp(clChallengeToken);
    clChallengeToken = challenge.challenge_token;
    clMsg(msg, challenge.dev_otp ? `Dev mode — new code: ${challenge.dev_otp}` : 'A new code has been sent.', 'ok');
  } catch (err) {
    clMsg(msg, clError(err, 'Could not resend the code.'), 'err');
  }
}

/* A 401 anywhere means the session is gone. One silent refresh attempt first
   (auth.js::handlePortalUnauthorized), and only then back to the sign-in box —
   same policy as Premium, so the two interfaces expire together. */
axios.interceptors.response.use(
  res => res,
  async err => {
    if (err.response?.status === 401) {
      const retried = await handlePortalUnauthorized('merchant', err);
      if (retried) return retried;
      clearPartnerSession();
      clLoaded.clear();
      clShowAuth();
    }
    return Promise.reject(err);
  }
);

/* ---------------------------------------------------------- notifications */

async function clLoadUnreadCount() {
  try {
    const data = await MerchantApi.unreadCount();
    const n = Number(data.unread_count ?? data.count ?? 0);
    $('clBellCount').textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
  } catch {
    /* A failed badge must never block the portal — leave it blank. */
    $('clBellCount').textContent = '';
  }
}

async function clOpenDrawer() {
  $('clDrawer').classList.add('open');
  $('clDrawerBack').classList.add('open');
  const list = $('clDrawerList');
  list.innerHTML = '<div class="cl-note"><span class="cl-spin"></span> Loading…</div>';
  try {
    const data = await MerchantApi.listNotifications(30);
    const items = data.items || [];
    list.innerHTML = items.length
      ? items.map(clNoteHtml).join('')
      : '<div class="cl-note" style="cursor:default">No notifications.</div>';
    list.querySelectorAll('[data-cl-note]').forEach(el => {
      el.addEventListener('click', async () => {
        if (!el.classList.contains('unread')) return;
        el.classList.remove('unread');
        try { await MerchantApi.markNotificationRead(el.dataset.clNote); await clLoadUnreadCount(); } catch { /* visual only */ }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="cl-note" style="cursor:default">${escapeHtml(clError(err, 'Could not load notifications.'))}</div>`;
  }
}
function clCloseDrawer() {
  $('clDrawer').classList.remove('open');
  $('clDrawerBack').classList.remove('open');
}

function clNoteHtml(n) {
  const unread = !(n.is_read ?? n.read ?? false);
  return `<div class="cl-note${unread ? ' unread' : ''}" data-cl-note="${escapeHtml(String(n.id))}">
    <b>${escapeHtml(n.title || n.subject || 'Notification')}</b>
    ${escapeHtml(n.message || n.body || '')}
    <time>${escapeHtml(fmtDateTime(n.created_at))}</time>
  </div>`;
}

/* --------------------------------------------------------- global search */

/* Client-side over the request list — there is no search endpoint. Matches the
   fields a merchant actually knows: request number, PNR/ticket number, title,
   and passenger names. */
let clSearchCache = null;
let clSearchTimer = null;

async function clRunGlobalSearch(term) {
  const box = $('clSearchResults');
  const q = term.trim().toLowerCase();
  if (q.length < 2) { box.classList.remove('open'); return; }

  if (!clSearchCache) {
    try {
      const data = await MerchantApi.listRequests({ page_size: 100 });
      clSearchCache = data.items || [];
    } catch {
      box.classList.remove('open');
      return;
    }
  }

  const hits = clSearchCache.filter(r => {
    const hay = [
      r.request_number, r.title, r.status, r.pnr, r.ticket_number,
      ...(r.passengers || []).map(p => `${p.first_name || ''} ${p.last_name || ''}`),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }).slice(0, 12);

  box.innerHTML = hits.length
    ? hits.map(r => `<a href="#" data-cl-hit="${r.id}">${escapeHtml(r.request_number || '')}
        <small>${escapeHtml(r.title || '')} · ${escapeHtml(clLabel(r.status))}</small></a>`).join('')
    : '<a href="#" style="cursor:default;color:var(--cl-ink-faint)">No matches</a>';
  box.classList.add('open');

  box.querySelectorAll('[data-cl-hit]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      box.classList.remove('open');
      $('clSearch').value = '';
      clGo('requests', () => clOpenRequestDetail(a.dataset.clHit));
    });
  });
}

/* -------------------------------------------------------------- support */

function clInitSupport() {
  const company = localStorage.getItem(PARTNER_KEYS.companyName) || '—';
  $('cl-support').innerHTML = `
    <div class="cl-page-head"><div>
      <h1>Support</h1>
      <p>Reach the partner desk. Response targets are business hours, Mon–Sat.</p>
    </div></div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Contact channels</h2></div>
      <div class="cl-panel-body">
        <dl class="cl-dl">
          <div><dt>Partner desk</dt><dd><a href="tel:+914035000000">+91 40 3500 0000</a></dd></div>
          <div><dt>Email</dt><dd><a href="mailto:partners@jackpotsworldtours.com">partners@jackpotsworldtours.com</a></dd></div>
          <div><dt>Escalation</dt><dd><a href="mailto:escalations@jackpotsworldtours.com">escalations@jackpotsworldtours.com</a></dd></div>
          <div><dt>Hours</dt><dd>09:00 – 19:00 IST, Mon–Sat</dd></div>
          <div><dt>Registered account</dt><dd>${escapeHtml(company)}</dd></div>
        </dl>
      </div>
      <div class="cl-panel-note">
        Ticketing, date changes, cancellations and ancillaries are raised through
        <a href="#" data-cl-nav-inline="service-request">Service Requests</a> so they are tracked
        against the booking — email is for anything that has no request behind it. Every one of
        them goes to your own manager first, then to our desk.
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Reference</h2></div>
      <div class="cl-panel-body">
        <table class="cl-table">
          <thead><tr><th>Topic</th><th>Where it is handled</th></tr></thead>
          <tbody>
            <tr><td>Booking not yet approved</td><td>My Requests — the status column shows the current stage</td></tr>
            <tr><td>Payment not reflecting</td><td>Payments — submitted payments sit in "awaiting verification"</td></tr>
            <tr><td>Change a traveller's date</td><td>Service Requests → Date change</td></tr>
            <tr><td>Cancel a booking</td><td>Service Requests → Cancellation</td></tr>
            <tr><td>Refund status</td><td>The refund is quoted on the cancellation that earned it</td></tr>
            <tr><td>Baggage, meal or seat</td><td>Service Requests → the matching tab</td></tr>
            <tr><td>A request stuck "Under Manager Approval"</td><td>Your own manager — it has not reached us yet</td></tr>
            <tr><td>Wallet balance</td><td>Dashboard, then the partner desk</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  $('cl-support').querySelector('[data-cl-nav-inline]')?.addEventListener('click', e => {
    e.preventDefault();
    clGo('service-request');
  });
}

/* ------------------------------------------------------------------ boot */

/* ---------------------------------------------------------------------------
   Theme (light / dark / system).

   The same control the Admin Portal carries, implemented the same way: the
   choice is stored, the RESOLVED value is written to :root[data-theme], and
   "system" keeps tracking the OS setting after the fact. Its own storage key,
   so choosing dark here does not change Admin's theme or vice versa — they are
   separate interfaces that happen to look alike.
   --------------------------------------------------------------------------- */
function clInitTheme() {
  const KEY = 'classic_ui_theme';
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const resolved = choice => (choice === 'system' ? (systemDark.matches ? 'dark' : 'light') : choice);

  function apply(choice) {
    document.documentElement.setAttribute('data-theme', resolved(choice));
    document.querySelectorAll('[data-cl-theme]').forEach(b =>
      b.classList.toggle('active', b.dataset.clTheme === choice));
  }

  apply(localStorage.getItem(KEY) || 'light');
  document.querySelectorAll('[data-cl-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      localStorage.setItem(KEY, btn.dataset.clTheme);
      apply(btn.dataset.clTheme);
    });
  });
  /* Only follow the OS while "system" is the active choice. */
  systemDark.addEventListener('change', () => {
    if (localStorage.getItem(KEY) === 'system') apply('system');
  });
}

function clBoot() {
  clInitTheme();

  /* auth */
  $('clLoginBtn').addEventListener('click', clLogin);
  $('clVerifyBtn').addEventListener('click', clVerifyOtp);
  $('clResendBtn').addEventListener('click', clResendOtp);
  $('clBackBtn').addEventListener('click', () => {
    clChallengeToken = '';
    document.querySelectorAll('.cl-auth-step').forEach(s => s.classList.remove('active'));
    $('clAuthStep1').classList.add('active');
  });
  /* Enter submits, on both steps — this is a data-entry UI. */
  ['clEmail', 'clPassword'].forEach(id => $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') clLogin();
  }));
  $('clOtp').addEventListener('keydown', e => { if (e.key === 'Enter') clVerifyOtp(); });

  /* nav */
  document.querySelectorAll('[data-cl-nav]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); clGo(a.dataset.clNav); });
  });
  $('clBurger').addEventListener('click', () => $('clSide').classList.toggle('open'));

  $('clSignOutBtn').addEventListener('click', async () => {
    if (!await clConfirm('Sign out of the Classic portal?', 'Sign out')) return;
    await logoutPortalSession('merchant').catch(() => {});
    clearPartnerSession();
    clLoaded.clear();
    clSearchCache = null;
    clShowAuth();
  });

  /* modal */
  $('clModalClose').addEventListener('click', clCloseModal);
  $('clModalBack').addEventListener('click', e => { if (e.target === $('clModalBack')) clCloseModal(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('clModalBack').classList.contains('open')) clCloseModal();
    else if ($('clDrawer').classList.contains('open')) clCloseDrawer();
  });

  /* notifications */
  $('clBellBtn').addEventListener('click', clOpenDrawer);
  $('clDrawerClose').addEventListener('click', clCloseDrawer);
  $('clDrawerBack').addEventListener('click', clCloseDrawer);
  $('clMarkAllBtn').addEventListener('click', async () => {
    try {
      await MerchantApi.markAllNotificationsRead();
      $('clDrawerList').querySelectorAll('.cl-note').forEach(n => n.classList.remove('unread'));
      await clLoadUnreadCount();
      clInvalidate('notifications');
      clRefreshIfVisible('notifications');
    } catch { /* the badge stays as it was */ }
  });

  /* global search — debounced so typing doesn't fire a request per keystroke */
  $('clSearch').addEventListener('input', e => {
    clearTimeout(clSearchTimer);
    const v = e.target.value;
    clSearchTimer = setTimeout(() => clRunGlobalSearch(v), 220);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.cl-top-search')) $('clSearchResults').classList.remove('open');
  });

  window.addEventListener('hashchange', () => {
    const s = (location.hash || '').replace('#', '');
    if (s && CL_LOADERS[s] && !$(`cl-${s}`).classList.contains('active')) clGo(s);
  });

  if (isPartnerLoggedIn()) clShowApp(); else clShowAuth();
}
