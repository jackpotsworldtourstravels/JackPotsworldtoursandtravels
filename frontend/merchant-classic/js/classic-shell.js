'use strict';
/* Merchant Portal — shell: auth, routing, chrome, and the primitives every
   screen module renders with.
   ===========================================================================
   Shares the session with the platform's other portals.
   `storePortalTokens('merchant',…)` and `partnerAuthHeaders()` come from
   ../assets/js/auth.js and write the partner_jwt_* localStorage keys.

   Element ids are all `cl*`, classes all `cl-`, and the section router only
   ever looks inside `.cl-section`.

   WHAT THE REDESIGN CHANGED IN HERE
   - The global search box is GONE, along with clRunGlobalSearch and its
     client-side cache. It fetched one page of 100 requests and matched against
     them in the browser, which meant a merchant with 2,600 bookings was
     searching its hundred most recent and being told "No matches" about a
     booking that existed. My Requests and Booking History both search the
     SERVER, across every row, and can then filter, sort and page the result. A
     twelve-row dropdown that lies is worse than no dropdown.
   - The topbar gained a profile menu, today's date and the page title; the rail
     gained the signed-in company.
   - Booking History is a new destination (see classic-history.js) and the
     Support screen moved out to classic-support.js, which is now large enough
     to be its own module. */

/* Same rule as the other portals: absolute base in local dev, same-origin in
   production. Declared here because merchant-api.js needs it in scope. */
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

/* ---------------------------------------------------------------- helpers */

const $ = id => document.getElementById(id);

/* Turns 'payment_pending' into 'Payment Pending'. These strings come straight
   off request_status_enum. */
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
   shared/formatters.js — one implementation for every portal, so a merchant
   screen and an admin screen cannot render the same balance differently. */

function clMsg(el, text, kind) {
  if (!el) return;
  el.className = `cl-msg${text ? ` cl-msg-${kind || 'info'}` : ''}`;
  el.textContent = text || '';
}

/* Every module's error path funnels through here so the backend's `detail` is
   what the user sees, rather than a generic failure string. */
function clError(err, fallback) {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  /* A 422 from FastAPI carries `detail` as a LIST of validation objects, not a
     string — so this returned an array, the template coerced it, and the screen
     showed `[object Object]`. Rendered as its messages instead; the field name
     is dropped because a merchant has no use for `query -> status`. */
  if (Array.isArray(detail) && detail.length) {
    const messages = detail.map(d => d?.msg).filter(Boolean);
    if (messages.length) return messages.join('. ');
  }
  return err?.message || fallback || 'Something went wrong.';
}

/* ---- table states ----
   A skeleton, not a spinner: it holds the shape of the answer while the answer
   is on its way, so the table does not collapse to one line and then jump back
   open. Rows are inert — `aria-hidden` keeps a screen reader out of the
   placeholder, and the live region is the caption the caller writes after. */
function clLoadingRow(cols, text, rows = 4) {
  const widths = ['w80', 'w60', 'w40', 'w60', 'w80'];
  const skeleton = Array.from({ length: rows }, (_, r) =>
    `<tr class="cl-skel-row" aria-hidden="true">${Array.from({ length: cols }, (_, c) =>
      `<td><span class="cl-skel cl-skel-line ${widths[(r + c) % widths.length]}"></span></td>`).join('')}</tr>`).join('');
  return `<tr aria-hidden="true"><td colspan="${cols}" class="cl-empty" style="padding:16px 12px !important;">
      <span class="cl-spin"></span> ${escapeHtml(text || 'Loading…')}</td></tr>${skeleton}`;
}

/* An empty table says what to do next, not just that there is nothing. */
function clEmptyRow(cols, text, hint) {
  return `<tr><td colspan="${cols}" class="cl-empty">
    <b>${escapeHtml(text)}</b>${hint ? escapeHtml(hint) : ''}</td></tr>`;
}

/* ------------------------------------------------------------------ modal */

let clModalOnClose = null;
let clModalReturnFocus = null;

function clOpenModal(title, bodyHtml, footHtml, { wide = false } = {}) {
  clModalReturnFocus = document.activeElement;
  $('clModalTitle').textContent = title;
  $('clModalBody').innerHTML = bodyHtml;
  $('clModalFoot').innerHTML = footHtml || '';
  $('clModal').classList.toggle('cl-modal-wide', !!wide);
  $('clModalBack').classList.add('open');
  document.body.style.overflow = 'hidden';
  /* Focus the dialog itself rather than its first control: landing on "Cancel"
     is one Enter away from dismissing something the user has not read. */
  requestAnimationFrame(() => {
    const first = $('clModalBody').querySelector('input,select,textarea');
    (first || $('clModalClose'))?.focus();
  });
}

function clCloseModal() {
  $('clModalBack').classList.remove('open');
  $('clModalBody').innerHTML = '';
  $('clModalFoot').innerHTML = '';
  document.body.style.overflow = '';
  clModalOnClose?.();
  clModalOnClose = null;
  clModalReturnFocus?.focus?.();
  clModalReturnFocus = null;
}

/* A confirm that returns a promise, so destructive actions read linearly.
   Deliberately not window.confirm(): a native dialog blocks the page and
   cannot be driven by a test harness. */
function clConfirm(message, confirmLabel, { danger = false } = {}) {
  return new Promise(resolve => {
    clOpenModal('Please confirm',
      `<p style="margin:0;font-size:14px;line-height:1.65;color:var(--cl-text-2);">${escapeHtml(message)}</p>`,
      `<button type="button" class="cl-btn" data-cl-confirm="0">Cancel</button>
       <button type="button" class="cl-btn ${danger ? 'cl-btn-danger' : 'cl-btn-primary'}"
               data-cl-confirm="1">${escapeHtml(confirmLabel || 'Confirm')}</button>`);
    let done = false;
    const finish = v => { if (done) return; done = true; clModalOnClose = null; clCloseModal(); resolve(v); };
    $('clModalFoot').querySelectorAll('[data-cl-confirm]').forEach(b => {
      b.addEventListener('click', () => finish(b.dataset.clConfirm === '1'));
    });
    clModalOnClose = () => { done = true; resolve(false); };
  });
}

/* ----------------------------------------------------------------- router */

/* Title and the one line under it. The subtitle is what makes the topbar a
   place rather than a strip of controls — it names the screen's job, which is
   not always obvious from a two-word title. */
const CL_TITLES = {
  dashboard: 'Dashboard',
  enquiry: 'Booking Enquiry',
  'booking-request': 'Booking Request',
  /* Reached from a row action rather than the rail — "the booking you just
     clicked" is not a destination you navigate to cold. */
  'booking-detail': 'Booking Request Details',
  requests: 'My Requests',
  'booking-history': 'Booking History',
  approvals: 'Approvals',
  wallet: 'Wallet',
  payments: 'Payments',
  'service-request': 'Service Requests',
  reports: 'Reports',
  notifications: 'Notifications',
  profile: 'Profile & Settings',
  support: 'Support Center',
};

const CL_SUBTITLES = {
  dashboard: 'Account overview',
  enquiry: 'Ask us for a fare',
  'booking-request': 'Turn a quote into a booking',
  'booking-detail': 'Everything on one booking',
  requests: 'Work in progress',
  'booking-history': 'Closed and completed travel',
  approvals: 'Sign off your team’s bookings',
  wallet: 'Your running account',
  payments: 'Statement and settlement',
  'service-request': 'Changes to issued bookings',
  reports: 'Volume, value and mix',
  notifications: 'Everything we have told you',
  profile: 'Your details and security',
  support: 'Talk to the partner desk',
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
  'booking-history': () => clInitHistory(),
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
    const on = a.dataset.clNav === section;
    a.classList.toggle('active', on);
    if (a.closest('.cl-side')) a.setAttribute('aria-current', on ? 'page' : 'false');
  });
  document.querySelectorAll('.cl-section').forEach(s => {
    s.classList.toggle('active', s.id === `cl-${section}`);
  });

  const title = CL_TITLES[section] || section;
  $('clCrumb').textContent = title;
  $('clTopTitle').textContent = title;
  $('clTopSub').textContent = CL_SUBTITLES[section] || '';
  document.title = `${title} — JackPots Merchant Portal`;
  clCloseNav();
  clCloseProfileMenu();
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
   dashboard counters, My Requests, Booking History and Payments at once. */
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
  document.body.style.overflow = '';
}

/* ---------------------------------------------------------------------------
   Who is signed in, and as what.

   Two role fields exist on the session: `merchant_role` (Manager / Supervisor /
   Operator / Finance / Data Operator — the job inside the company) and `role`
   (merchant_admin / merchant_user — the portal-level one). The merchant role is
   the one that decides what this person may do day to day, so it wins when
   present.

   Operator and Data Operator are the same role by the business's decision (see
   rbac.py::_MERCHANT_OPERATOR), so both print as "Operator" rather than showing
   two names for one job.
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

/* Two letters from the name, for the avatar. A single-word name gives its
   first two letters rather than one lonely capital in a 34px circle. */
function clInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* A session stored before the role was needed carries no role at all, and the
   header would sit on a dash forever. /api/profile returns the same shape the
   login did, so one call repairs it — and it is the same call Profile &
   Settings already makes, so nothing new is being asked of the backend. */
async function clRefreshRole() {
  if (clRoleLabel(clSessionUser())) return;
  try {
    const me = await MerchantApi.getProfile();
    localStorage.setItem('merchant_user_json', JSON.stringify(me));
    clPaintIdentity();
  } catch { /* the header keeps the name; the role stays blank */ }
}

/* One function owns every place the signed-in identity appears, so the header,
   the menu and the rail cannot disagree about who is looking at the screen. */
function clPaintIdentity() {
  const name = localStorage.getItem(PARTNER_KEYS.fullName) || 'Merchant';
  const role = clRoleLabel(clSessionUser()) || 'Merchant User';
  const company = localStorage.getItem(PARTNER_KEYS.companyName) || '';
  const initials = clInitials(name);

  $('clUserName').textContent = name;
  $('clUserRole').textContent = role;
  $('clMenuName').textContent = name;
  $('clMenuRole').textContent = role;
  $('clMenuCompany').textContent = company;
  $('clAvatar').textContent = initials;
  $('clMenuAvatar').textContent = initials;
  $('clSideCompany').textContent = company || 'Merchant account';
  $('clSideCode').textContent = company ? 'Signed in' : '';
}

function clShowApp() {
  $('clAuth').style.display = 'none';
  $('clApp').classList.add('active');

  clPaintIdentity();
  clRefreshRole();
  $('clDateText').textContent = new Date().toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
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
  clLoadSupportBadge();
}

/* Identical contract to the other portals' auth — same helpers from auth.js,
   same portal string, same two steps. */
async function clLogin() {
  const email = $('clEmail').value.trim();
  const password = $('clPassword').value;
  const msg = $('clAuthMsg1');
  if (!email || !password) return clMsg(msg, 'Enter your email and password.', 'err');

  const btn = $('clLoginBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  clMsg(msg, '');
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
    btn.classList.remove('loading');
  }
}

async function clVerifyOtp() {
  const code = $('clOtp').value.trim();
  const msg = $('clAuthMsg2');
  if (code.length < 4) return clMsg(msg, 'Enter the code sent to your email.', 'err');

  const btn = $('clVerifyBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  clMsg(msg, '');
  try {
    const data = await verifyPortalOtp(clChallengeToken, code);
    storePortalTokens('merchant', data);
    clChallengeToken = '';
    ['clEmail', 'clPassword', 'clOtp'].forEach(id => { $(id).value = ''; });
    clMsg(msg, '');
    clShowApp();
  } catch (err) {
    clMsg(msg, clError(err, 'Incorrect or expired code.'), 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
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
   (auth.js::handlePortalUnauthorized), and only then back to the sign-in box. */
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
    const text = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
    $('clBellCount').textContent = text;
    $('clNavNotesCount').textContent = text;
    $('clBellBtn').classList.toggle('has-unread', n > 0);
    $('clBellBtn').setAttribute('aria-label',
      n > 0 ? `Notifications, ${n} unread` : 'Notifications');
  } catch {
    /* A failed badge must never block the portal — leave it blank. */
    $('clBellCount').textContent = '';
    $('clNavNotesCount').textContent = '';
  }
}

/* Open support conversations, on the Support Center's rail item. Same
   read-only badge contract as the bell: a failure leaves it blank. */
async function clLoadSupportBadge() {
  try {
    const data = await MerchantApi.supportUnreadCount();
    const n = Number(data.count ?? 0);
    $('clNavSupportCount').textContent = n > 0 ? String(n) : '';
  } catch {
    $('clNavSupportCount').textContent = '';
  }
}

async function clOpenDrawer() {
  $('clDrawer').classList.add('open');
  $('clDrawerBack').classList.add('open');
  const list = $('clDrawerList');
  list.innerHTML = `<div class="cl-note" style="cursor:default">
    <span class="cl-skel cl-skel-line w60"></span>
    <span class="cl-skel cl-skel-line w80"></span></div>`.repeat(4);
  try {
    const data = await MerchantApi.listNotifications(30);
    const items = data.items || [];
    list.innerHTML = items.length
      ? items.map(clNoteHtml).join('')
      : `<div class="cl-blank"><span class="cl-blank-ico">${clIco('bell', { size: 26 })}</span>
           <b>You are all caught up</b><p>Approvals, payment reminders and ticketing updates land here.</p></div>`;
    list.querySelectorAll('[data-cl-note]').forEach(el => {
      el.addEventListener('click', async () => {
        if (!el.classList.contains('unread')) return;
        el.classList.remove('unread');
        try { await MerchantApi.markNotificationRead(el.dataset.clNote); await clLoadUnreadCount(); } catch { /* visual only */ }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="cl-msg cl-msg-err" style="margin:8px">${escapeHtml(clError(err, 'Could not load notifications.'))}</div>`;
  }
}

function clCloseDrawer() {
  $('clDrawer').classList.remove('open');
  $('clDrawerBack').classList.remove('open');
}

function clNoteHtml(n) {
  const unread = !(n.is_read ?? n.read ?? false);
  return `<div class="cl-note${unread ? ' unread' : ''}" data-cl-note="${escapeHtml(String(n.id))}"
               role="button" tabindex="0">
    <b>${escapeHtml(n.title || n.subject || 'Notification')}</b>
    ${escapeHtml(n.message || n.body || '')}
    <time>${escapeHtml(fmtDateTime(n.created_at))}</time>
  </div>`;
}

/* ------------------------------------------------------------ nav & menus */

function clOpenNav() {
  $('clSide').classList.add('open');
  $('clBurger').setAttribute('aria-expanded', 'true');
}
function clCloseNav() {
  $('clSide').classList.remove('open');
  $('clBurger').setAttribute('aria-expanded', 'false');
}
function clCloseProfileMenu() {
  $('clProfileMenu').classList.remove('open');
  $('clProfileBtn').setAttribute('aria-expanded', 'false');
}
function clToggleProfileMenu() {
  const open = $('clProfileMenu').classList.toggle('open');
  $('clProfileBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

/* ------------------------------------------------------------------ theme */

/* Light / dark / system. The CHOICE is stored, the RESOLVED value is written to
   :root[data-theme], and "system" keeps tracking the OS setting after the fact.
   Its own storage key, so choosing dark here does not change another portal's
   theme — they are separate interfaces that happen to share a designer.

   Two control groups exist (the topbar's, and the profile menu's for phone
   width where the topbar's is hidden). Both are driven from one place, so they
   can never show different active states. */
function clInitTheme() {
  const KEY = 'classic_ui_theme';
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const resolved = choice => (choice === 'system' ? (systemDark.matches ? 'dark' : 'light') : choice);

  function apply(choice) {
    document.documentElement.setAttribute('data-theme', resolved(choice));
    document.querySelectorAll('[data-cl-theme]').forEach(b => {
      const on = b.dataset.clTheme === choice;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
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

/* ------------------------------------------------------------------ boot */

function clBoot() {
  clInitTheme();

  /* ---- auth ---- */
  $('clLoginBtn').addEventListener('click', clLogin);
  $('clVerifyBtn').addEventListener('click', clVerifyOtp);
  $('clResendBtn').addEventListener('click', clResendOtp);
  $('clBackBtn').addEventListener('click', () => {
    clChallengeToken = '';
    document.querySelectorAll('.cl-auth-step').forEach(s => s.classList.remove('active'));
    $('clAuthStep1').classList.add('active');
    $('clEmail').focus();
  });
  /* Enter submits, on both steps — this is a data-entry UI. */
  ['clEmail', 'clPassword'].forEach(id => $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') clLogin();
  }));
  $('clOtp').addEventListener('keydown', e => { if (e.key === 'Enter') clVerifyOtp(); });

  /* ---- navigation ---- */
  document.querySelectorAll('[data-cl-nav]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); clGo(a.dataset.clNav); });
  });
  $('clBurger').addEventListener('click', () => {
    $('clSide').classList.contains('open') ? clCloseNav() : clOpenNav();
  });
  /* Tapping the page behind an open rail closes it — the expected gesture for
     an off-canvas drawer, and the rail has no scrim of its own to click. */
  $('clMain').addEventListener('click', () => {
    if (window.innerWidth <= 900) clCloseNav();
  });

  /* ---- profile menu ---- */
  $('clProfileBtn').addEventListener('click', e => { e.stopPropagation(); clToggleProfileMenu(); });
  document.addEventListener('click', e => {
    if (!e.target.closest('#clProfile')) clCloseProfileMenu();
  });

  $('clSignOutBtn').addEventListener('click', async () => {
    clCloseProfileMenu();
    if (!await clConfirm('Sign out of the merchant portal?', 'Sign out', { danger: true })) return;
    await logoutPortalSession('merchant').catch(() => {});
    clearPartnerSession();
    clLoaded.clear();
    clShowAuth();
  });

  /* ---- modal ---- */
  $('clModalClose').addEventListener('click', clCloseModal);
  $('clModalBack').addEventListener('click', e => { if (e.target === $('clModalBack')) clCloseModal(); });

  /* ---- notifications ---- */
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

  /* ---- keyboard ----
     Escape unwinds one layer at a time, innermost first, so a modal opened over
     the drawer does not close both. */
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const note = e.target.closest?.('[data-cl-note]');
      if (note) { e.preventDefault(); note.click(); }
      return;
    }
    if (e.key !== 'Escape') return;
    if ($('clModalBack').classList.contains('open')) clCloseModal();
    else if ($('clDrawer').classList.contains('open')) clCloseDrawer();
    else if ($('clProfileMenu').classList.contains('open')) { clCloseProfileMenu(); $('clProfileBtn').focus(); }
    else if ($('clSide').classList.contains('open')) clCloseNav();
  });

  window.addEventListener('hashchange', () => {
    const s = (location.hash || '').replace('#', '');
    if (s && CL_LOADERS[s] && !$(`cl-${s}`).classList.contains('active')) clGo(s);
  });

  if (isPartnerLoggedIn()) clShowApp(); else clShowAuth();
}
