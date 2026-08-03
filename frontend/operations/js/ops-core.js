'use strict';
/* Operations Portal — shell.
   ===========================================================================
   Session, permissions, navigation, routing, keyboard shortcuts, global
   search, and the primitives (toast / modal / confirm) every module renders
   with. Nothing here touches Version 1's DOM: every id is `ops*`, every class
   is `ops-`, and the router only ever looks inside `.ops-section`.

   THE ONE IDEA WORTH KNOWING BEFORE READING ANY MODULE
   The portal is permission-driven, not role-driven. `/api/auth/me` returns the
   same `permissions` array that rbac.effective_permissions computes for the
   API's own `Depends(require(...))` gates, so the sidebar, the buttons and the
   grids are all built by asking opsCan('some.code'). That is why one workspace
   can serve a merchant operator, a ticketing admin, a finance clerk and a
   super admin without any per-role branching: each account simply sees the
   subset of modules its permissions reach. A role check would drift from the
   server the first time a per-user grant was added (users.permissions is a
   JSONB array an admin can be granted extras through); a permission check
   cannot.                                                                */

/* Absolute base in local dev, same-origin in production — the same rule
   Version 1 uses. Declared here because ops-api.js needs it in scope. */
const OPS_API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

const $ = id => document.getElementById(id);
const opsEl = (sel, root) => (root || document).querySelector(sel);
const opsAll = (sel, root) => [...(root || document).querySelectorAll(sel)];

/* ===========================================================================
   SESSION
   ===========================================================================
   LoginRequest.portal only accepts super_admin | admin | merchant, and each
   portal has its own localStorage namespace in auth.js that must never be
   merged (a login in one portal must not overwrite a session open in
   another). The Operations Portal is a fourth *interface*, not a fourth
   portal, so it does not invent a namespace: it records which of the three it
   is currently borrowing and reads that one.                              */

const OPS_PORTALS = ['super_admin', 'admin', 'merchant'];
const OPS_ACTIVE_KEY = 'ops_active_portal';

const OpsSession = {
  portal: null,      /* 'merchant' | 'admin' | 'super_admin' */
  user: null,        /* UserResponse from /api/auth/me — the authority */
  perms: new Set(),
};

function opsAccessKey(portal) {
  return portal === 'admin' ? 'jwt_access'
    : portal === 'merchant' ? PARTNER_KEYS.access
    : SA_KEYS.access;
}

/* Used by ops-api.js on every request. Reads the token at call time rather
   than caching it, so a silent refresh mid-session is picked up. */
function opsAuthHeaders() {
  const portal = OpsSession.portal || localStorage.getItem(OPS_ACTIVE_KEY);
  return { Authorization: `Bearer ${localStorage.getItem(opsAccessKey(portal))}` };
}

/* Which portal's session should this workspace adopt on arrival?
   Prefer the one it was last used with, then any other that has a token —
   so arriving here after signing into a Version 1 portal in the same browser
   just works, the same way the Classic merchant portal already behaves. */
function opsDetectPortal() {
  const remembered = localStorage.getItem(OPS_ACTIVE_KEY);
  if (remembered && localStorage.getItem(opsAccessKey(remembered))) return remembered;
  return OPS_PORTALS.find(p => localStorage.getItem(opsAccessKey(p))) || null;
}

function opsCan(...codes) {
  return codes.some(c => OpsSession.perms.has(c));
}
function opsCanAll(...codes) {
  return codes.every(c => OpsSession.perms.has(c));
}
/* Platform staff see every merchant's rows (rbac.assert_same_merchant and
   ticket_service.scoped_query both branch on this), which changes what a
   grid should show — a Merchant column is noise for a merchant and essential
   for an admin. */
function opsIsStaff() {
  return ['admin', 'super_admin'].includes(OpsSession.user?.role);
}
function opsMerchantId() {
  return OpsSession.user?.merchant_id ?? null;
}

/* ===========================================================================
   SMALL HELPERS
   =========================================================================== */

/* 'payment_pending' -> 'Payment Pending'. Used for enum values the backend
   has no label for; statuses go through opsStatusLabel instead. */
function opsLabel(s) {
  return (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
/* The spec's own wording, from lifecycle.SPEC_LABELS via ops-api.js. */
function opsStatusLabel(s) {
  return OPS_STATUS_LABEL[s] || opsLabel(s);
}

const OPS_TONE = {
  draft: '', submitted: 'info', pending_approval: 'warn', in_review: 'info',
  approved: 'info', payment_pending: 'warn', paid: 'ok', ticket_issued: 'ok',
  verified: 'ok', completed: 'ok', rejected: 'err', cancelled: 'err',
  /* payment_status_enum */
  pending: 'warn', processing: 'info', success: 'ok', failed: 'err',
  refunded: '', partially_refunded: 'warn',
  /* user_status_enum / merchant_status_enum */
  active: 'ok', inactive: '', blocked: 'err', suspended: 'err',
  /* priority_enum */
  low: '', normal: '', high: 'warn', urgent: 'err',
};
function opsTag(value, label) {
  if (value == null || value === '') return '<span class="ops-muted">—</span>';
  const tone = OPS_TONE[value];
  return `<span class="ops-tag${tone ? ` ops-tag-${tone}` : ''}">${escapeHtml(label || opsStatusLabel(value))}</span>`;
}

/* Every module's failure path comes through here so the user reads the
   backend's own `detail` string rather than a generic message. A 422 arrives
   as an array of ValidationError, which is worth unpacking — "field: reason"
   is actionable, "[object Object]" is not. */
function opsError(err, fallback) {
  const d = err?.response?.data?.detail;
  if (Array.isArray(d)) {
    return d.map(e => `${(e.loc || []).slice(1).join('.') || 'field'}: ${e.msg}`).join('; ');
  }
  if (typeof d === 'string') return d;
  return err?.message || fallback || 'Something went wrong.';
}

function opsMsg(el, text, kind) {
  if (!el) return;
  el.className = `ops-msg${text ? ` ops-msg-${kind || 'info'}` : ''}`;
  el.textContent = text || '';
}

function opsLoadingRow(cols, text) {
  return `<tr><td colspan="${cols}" class="ops-empty"><span class="ops-spin"></span> ${escapeHtml(text || 'Loading…')}</td></tr>`;
}
function opsEmptyRow(cols, text) {
  return `<tr><td colspan="${cols}" class="ops-empty">${escapeHtml(text)}</td></tr>`;
}
function opsSpinner(text) {
  return `<div class="ops-empty"><span class="ops-spin"></span> ${escapeHtml(text || 'Loading…')}</div>`;
}

/* ---------------------------------------------------------------------------
   CONTROLS WHOSE ENDPOINT DOES NOT EXIST YET
   ---------------------------------------------------------------------------
   Several screens in the brief describe actions this API has no route for:
   document upload/download (the `documents` module is listed in main.py's
   PENDING_MODULES), wallet top-up and withdrawal, settlement history, invoice
   generation, payment proof upload, per-merchant notification preferences
   (the only endpoint is admin-scoped), and GST/PAN/API keys (no columns and no
   route exist for them at all).

   Those controls are rendered in their final position and DISABLED, with the
   reason stated. The rule this follows, and the reason it is a rule:

     * never fabricate a success — a disabled button is honest, a fake
       "Saved!" toast is a lie the operator will act on;
     * never persist to localStorage as a stand-in for a server — data that
       survives one browser and no other looks like a working feature until
       the day it matters;
     * never invent an endpoint — a 404 in the console is worse than a
       control that says what it is waiting for.

   When the route lands, enabling one of these is deleting `disabled` and
   calling it. The layout does not move.                                    */

/* A one-line explanation under a disabled control. */
function opsPendingNote(text) {
  return `<p class="ops-pending-note">${escapeHtml(text)}</p>`;
}

/* A disabled action plus its reason. `wide` stretches it across a form grid. */
function opsPendingAction(label, reason, opts) {
  const o = opts || {};
  return `<div class="ops-pending${o.wide ? ' ops-pending-full' : ''}">
    <button type="button" class="ops-btn ops-btn-sm" disabled
            title="${escapeHtml(reason)}">${escapeHtml(label)}</button>
    ${opsPendingNote(reason)}
  </div>`;
}

/* A whole panel body standing in for a screen area with no endpoint behind
   it — Settlement history, Withdrawal history, API keys. */
function opsPendingPanel(title, reason, detail) {
  return `<div class="ops-panel">
    <div class="ops-panel-head">
      <h2>${escapeHtml(title)}</h2>
      <div class="ops-panel-tools"><span class="ops-tag">Pending</span></div>
    </div>
    <div class="ops-panel-body">
      <div class="ops-pending-block">
        <p><b>${escapeHtml(reason)}</b></p>
        ${detail ? `<p class="ops-muted">${escapeHtml(detail)}</p>` : ''}
      </div>
    </div>
  </div>`;
}
function opsToday() {
  return new Date().toISOString().slice(0, 10);
}
/* Dates arrive as ISO strings; compare on the calendar day, in local time,
   because "raised today" means the operator's today. */
function opsIsToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function opsSelectOptions(values, selected, labeller) {
  return values.map(v => {
    const val = typeof v === 'object' ? v.value : v;
    const lab = typeof v === 'object' ? v.label : (labeller || opsLabel)(v);
    return `<option value="${escapeHtml(String(val))}"${String(selected) === String(val) ? ' selected' : ''}>${escapeHtml(lab)}</option>`;
  }).join('');
}
function opsPassengerNames(r) {
  const list = (r.passengers || []).map(p => [p.first_name, p.last_name].filter(Boolean).join(' ')).filter(Boolean);
  return list.length ? list.join(', ') : '';
}
function opsSector(r) {
  const d = r.details || r.travel_details || {};
  const a = d.origin_city || d.origin;
  const b = d.destination_city || d.destination;
  return [a, b].filter(Boolean).join(' → ');
}

/* ===========================================================================
   TOAST / MODAL / CONFIRM
   ===========================================================================
   Deliberately not window.alert/confirm: a native dialog blocks the page,
   cannot be styled to match, and cannot be driven by a test harness.       */

function opsToast(text, kind) {
  const el = document.createElement('div');
  el.className = `ops-toast${kind ? ` ${kind}` : ''}`;
  el.textContent = text;
  $('opsToasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

let opsModalOnClose = null;

function opsOpenModal(title, bodyHtml, footHtml, opts = {}) {
  $('opsModalTitle').textContent = title;
  $('opsModalBody').innerHTML = bodyHtml;
  $('opsModalFoot').innerHTML = footHtml || '';
  $('opsModal').classList.toggle('wide', !!opts.wide);
  $('opsModalBack').classList.add('open');
  /* Autofocus the first field — this is a data-entry portal and a dialog that
     needs a click before it accepts typing costs a second every time. */
  setTimeout(() => {
    const first = opsEl('input:not([type=hidden]),select,textarea', $('opsModalBody'));
    (first || $('opsModalClose')).focus();
  }, 0);
  return $('opsModalBody');
}
function opsCloseModal() {
  $('opsModalBack').classList.remove('open');
  $('opsModalBody').innerHTML = '';
  $('opsModalFoot').innerHTML = '';
  const cb = opsModalOnClose;
  opsModalOnClose = null;
  cb?.();
}

function opsConfirm(message, confirmLabel, opts = {}) {
  return new Promise(resolve => {
    opsOpenModal(opts.title || 'Confirm',
      `<p style="margin:0;font-size:12.5px;">${escapeHtml(message)}</p>`,
      `<span class="ops-spacer"></span>
       <button type="button" class="ops-btn" data-ops-confirm="0">Cancel</button>
       <button type="button" class="ops-btn ${opts.danger ? 'ops-btn-danger' : 'ops-btn-primary'}" data-ops-confirm="1">${escapeHtml(confirmLabel || 'Confirm')}</button>`);
    let done = false;
    const finish = v => { if (done) return; done = true; opsModalOnClose = null; opsCloseModal(); resolve(v); };
    opsAll('[data-ops-confirm]', $('opsModalFoot')).forEach(b => {
      b.addEventListener('click', () => finish(b.dataset.opsConfirm === '1'));
    });
    opsModalOnClose = () => { done = true; resolve(false); };
  });
}

/* A one-field prompt, for the reasons the API demands (rejections 400 without
   one) and for notes it merely accepts. */
function opsPrompt({ title, label, placeholder, required, multiline, confirmLabel, danger }) {
  return new Promise(resolve => {
    const control = multiline
      ? `<textarea id="opsPromptField" rows="3" placeholder="${escapeHtml(placeholder || '')}"></textarea>`
      : `<input type="text" id="opsPromptField" placeholder="${escapeHtml(placeholder || '')}">`;
    opsOpenModal(title || 'Enter a value',
      `<div class="ops-form"><div class="ops-field ops-field-full">
         <label for="opsPromptField">${escapeHtml(label || '')}${required ? '<span class="ops-req">*</span>' : ''}</label>
         ${control}
       </div></div><div class="ops-msg" id="opsPromptMsg"></div>`,
      `<span class="ops-spacer"></span>
       <button type="button" class="ops-btn" data-ops-prompt="0">Cancel</button>
       <button type="button" class="ops-btn ${danger ? 'ops-btn-danger' : 'ops-btn-primary'}" data-ops-prompt="1">${escapeHtml(confirmLabel || 'Confirm')}</button>`);

    let done = false;
    const finish = v => { if (done) return; done = true; opsModalOnClose = null; opsCloseModal(); resolve(v); };
    const submit = () => {
      const v = $('opsPromptField').value.trim();
      if (required && !v) return opsMsg($('opsPromptMsg'), 'This is required.', 'err');
      finish(v);
    };
    opsAll('[data-ops-prompt]', $('opsModalFoot')).forEach(b => {
      b.addEventListener('click', () => (b.dataset.opsPrompt === '1' ? submit() : finish(null)));
    });
    if (!multiline) {
      $('opsPromptField').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    }
    opsModalOnClose = () => { done = true; resolve(null); };
  });
}

/* ===========================================================================
   NAVIGATION MODEL
   ===========================================================================
   One declarative table drives the sidebar, the router, the breadcrumb and
   the desk filter.

     any   — show the item if the session holds ANY of these permission codes
             (empty/absent = always visible)
     staff — additionally require platform staff
     desks — which desks this item belongs to, for the workspace switcher

   The brief's sidebar list is implemented item for item. Two entries were
   added because the endpoints and the Version 1 screens they mirror already
   exist and leaving them out would make V2 less capable than V1: `Approvals`
   (GET /api/admin/approval-queue — V1's Admin approval queue) and `Users`
   (GET /api/admin/users + /api/merchant/team + /api/super-admin/admins).   */
const OPS_NAV = [
  { group: 'Overview', items: [
    { id: 'dashboard', label: 'Dashboard', icon: '▦', desks: ['ticketing', 'finance', 'support', 'admin'] },
  ]},
  { group: 'Inventory', items: [
    { id: 'flights', label: 'Flights', icon: '✈', any: ['ticket.enquiry', 'ticket.view'], desks: ['ticketing'] },
    { id: 'hotels', label: 'Hotels', icon: '⌂', any: ['ticket.enquiry', 'ticket.view'], desks: ['ticketing'] },
    { id: 'cruises', label: 'Cruises', icon: '⚓', any: ['ticket.enquiry', 'ticket.view'], desks: ['ticketing'] },
    { id: 'packages', label: 'Packages', icon: '▣', any: ['ticket.enquiry', 'ticket.view'], desks: ['ticketing'] },
  ]},
  { group: 'Operations', items: [
    { id: 'bookings', label: 'Bookings', icon: '☰', any: ['ticket.view'], desks: ['ticketing', 'finance', 'support'] },
    { id: 'requests', label: 'Requests', icon: '⇄', any: ['ticket.view'], desks: ['ticketing', 'support'] },
    { id: 'approvals', label: 'Approvals', icon: '✓', any: ['ticket.approve', 'ticket.reject', 'merchant.approve', 'servicerequest.manage'], desks: ['ticketing', 'admin'] },
    /* Reachable from Requests and from Ctrl+N, not a sidebar entry of its own —
       it is a form you arrive at with a priced item, never a list. */
    { id: 'new-request', label: 'New Request', icon: '✎', any: ['ticket.request'], hidden: true },
  ]},
  { group: 'Finance', items: [
    { id: 'payments', label: 'Payments', icon: '₹', any: ['payment.view', 'payment.pay', 'payment.verify'], desks: ['finance'] },
    { id: 'wallet', label: 'Wallet', icon: '◫', any: ['ticket.view', 'merchant.view'], desks: ['finance'] },
  ]},
  { group: 'Directory', items: [
    { id: 'customers', label: 'Customers', icon: '☺', any: ['ticket.view'], desks: ['ticketing', 'support'] },
    { id: 'merchants', label: 'Merchants', icon: '⌸', any: ['merchant.view'], desks: ['admin', 'finance', 'support'] },
    { id: 'users', label: 'Users', icon: '⚇', any: ['merchant_user.manage', 'merchant_user.create', 'admin.view'], desks: ['admin'] },
  ]},
  { group: 'Insight', items: [
    { id: 'reports', label: 'Reports', icon: '▤', any: ['report.view', 'report.export'], desks: ['ticketing', 'finance', 'admin'] },
    { id: 'support', label: 'Support', icon: '☏', any: ['chat.view'], desks: ['support'] },
    { id: 'logs', label: 'System Logs', icon: '⧉', any: ['system.activity.view', 'audit.view'], desks: ['admin'] },
  ]},
  { group: 'Account', items: [
    /* Merchant-layout only. Platform staff keep editing their account from
       Settings exactly as before — adding a second door to the same screen for
       them would be a change with no gain, and every role holds
       `profile.manage`, so the permission gate alone would NOT have kept this
       out of their sidebar. Hence merchantOnly, honoured by opsNavGroups and
       opsItemInLayout below. */
    { id: 'profile', label: 'Profile', icon: '☴', any: ['profile.manage'], merchantOnly: true },
    { id: 'settings', label: 'Settings', icon: '⚙', desks: ['ticketing', 'finance', 'support', 'admin'] },
  ]},
];

/* ---------------------------------------------------------------------------
   THE MERCHANT LAYOUT
   ---------------------------------------------------------------------------
   Same item registry above, re-grouped and re-ordered into the sidebar a
   travel agent works down: the work they already own first (Bookings,
   Requests), then what they sell (Inventory), then money, then the rest.

   This is a VIEW, not a second set of items — each entry is an id resolved
   out of OPS_NAV, so an item's permissions, icon, loader and title are
   defined exactly once. Admin and super admin continue to render OPS_NAV in
   its original order, untouched.

   The admin-only modules (Approvals, Customers, Merchants, Users, System
   Logs) are simply not listed here. They were already unreachable for a
   merchant — every one is gated on a permission no merchant role holds — so
   leaving them out changes what is *rendered*, never what is *allowed*. The
   permission gate below still runs for every item.                        */
const OPS_NAV_MERCHANT = [
  { group: 'Overview',   items: ['dashboard'] },
  { group: 'Operations', items: ['bookings', 'requests'] },
  { group: 'Inventory',  items: ['flights', 'hotels', 'cruises', 'packages'] },
  { group: 'Finance',    items: ['payments', 'wallet'] },
  { group: 'Insight',    items: ['reports', 'support'] },
  { group: 'Account',    items: ['profile', 'settings'] },
];

/* Which sidebar layout this session gets. Role-shaped rather than
   permission-shaped on purpose: this decides PRESENTATION (order, grouping,
   which optional entries appear), and every one of those items is still
   permission-gated by opsItemAllowed before it renders. Access stays
   permission-driven; only the arrangement is chosen here. */
function opsIsMerchantWorkspace() {
  return !opsIsStaff() && !!opsMerchantId();
}

/* Is this item part of the layout this session is being shown at all? Separate
   from opsItemAllowed, which answers the different question of whether the
   PERMISSIONS reach it — an item can be permitted and still not belong here. */
function opsItemInLayout(item) {
  return !item.merchantOnly || opsIsMerchantWorkspace();
}

/* Both layouts normalised to [{ group, items: [itemObject] }] so opsRenderNav
   and opsFirstAllowedSection have one shape to walk. */
function opsNavGroups() {
  if (!opsIsMerchantWorkspace()) {
    /* Staff get OPS_NAV in its original order, minus anything merchant-only. */
    return OPS_NAV.map(g => ({ group: g.group, items: g.items.filter(opsItemInLayout) }));
  }
  return OPS_NAV_MERCHANT.map(g => ({
    group: g.group,
    items: g.items.map(opsNavItem).filter(Boolean),
  }));
}

/* The desks the workspace switcher offers. A desk is a saved view of the
   sidebar, not a permission — picking "Finance" never grants or removes
   access, it just stops a finance clerk scrolling past inventory all day. */
const OPS_DESKS = [
  { id: 'all', label: 'All modules' },
  { id: 'ticketing', label: 'Ticketing desk' },
  { id: 'finance', label: 'Finance desk' },
  { id: 'support', label: 'Support desk' },
  { id: 'admin', label: 'Administration' },
];

const OPS_TITLES = {};
OPS_NAV.forEach(g => g.items.forEach(i => { OPS_TITLES[i.id] = i.label; }));

function opsNavItem(id) {
  for (const g of OPS_NAV) for (const i of g.items) if (i.id === id) return i;
  return null;
}
function opsItemAllowed(item) {
  if (item.staff && !opsIsStaff()) return false;
  if (!item.any || !item.any.length) return true;
  return opsCan(...item.any);
}

function opsCurrentDesk() {
  return localStorage.getItem('ops_desk') || 'all';
}

function opsRenderNav() {
  /* Desks narrow a long staff sidebar. The merchant sidebar is thirteen items
     the agent uses all day, so it is never desk-filtered — for a merchant the
     workspace menu switches INTERFACE (Premium <-> Operations), which is what
     the switcher means on that side. */
  const desk = opsIsMerchantWorkspace() ? 'all' : opsCurrentDesk();
  const rail = $('opsRail');
  let html = '';
  opsNavGroups().forEach(group => {
    const items = group.items.filter(i =>
      !i.hidden && opsItemAllowed(i) && (desk === 'all' || (i.desks || []).includes(desk)));
    if (!items.length) return;
    html += `<div class="ops-rail-group">${escapeHtml(group.group)}</div>`;
    html += items.map(i => `
      <a href="#${i.id}" data-ops-nav="${i.id}" title="${escapeHtml(i.label)}">
        <span class="ops-rail-ico" aria-hidden="true">${i.icon}</span>
        <span class="ops-rail-label">${escapeHtml(i.label)}</span>
        <span class="ops-rail-count ops-hidden" data-ops-count="${i.id}"></span>
      </a>`).join('');
  });
  rail.innerHTML = html;
  opsAll('[data-ops-nav]', rail).forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); opsGo(a.dataset.opsNav); });
  });
  opsSyncNavActive(opsCurrentSection);
}

/* A count badge next to a nav item — pending approvals, open chats. Set to a
   falsy value to hide it again. */
function opsSetNavCount(id, n) {
  opsAll(`[data-ops-count="${id}"]`).forEach(el => {
    el.textContent = n > 99 ? '99+' : String(n || '');
    el.classList.toggle('ops-hidden', !n);
  });
}

/* ===========================================================================
   ROUTER
   ===========================================================================
   Sections render on first visit and keep their state afterwards, so tabbing
   away from a half-filled form and back does not discard it. A module calls
   opsInvalidate() when it knows another section's data is now stale.      */

const OPS_LOADERS = {
  dashboard: () => opsInitDashboard(),
  flights: () => opsInitTravel('flights'),
  hotels: () => opsInitTravel('hotels'),
  cruises: () => opsInitTravel('cruises'),
  packages: () => opsInitTravel('packages'),
  bookings: () => opsInitBookings(),
  requests: () => opsInitRequests(),
  'new-request': () => opsInitNewRequest(),
  approvals: () => opsInitApprovals(),
  payments: () => opsInitPayments(),
  wallet: () => opsInitWallet(),
  customers: () => opsInitCustomers(),
  merchants: () => opsInitMerchants(),
  users: () => opsInitUsers(),
  reports: () => opsInitReports(),
  support: () => opsInitSupport(),
  logs: () => opsInitLogs(),
  profile: () => opsInitProfile(),
  settings: () => opsInitSettings(),
};

const opsLoaded = new Set();
let opsCurrentSection = 'dashboard';

function opsSyncNavActive(section) {
  opsAll('[data-ops-nav]').forEach(a => a.classList.toggle('active', a.dataset.opsNav === section));
}

/* Landing on a section this account cannot reach — a stale bookmark, or a
   deep link shared by a colleague with more permissions — is a normal event,
   not an error. Fall back to the first section that IS reachable. */
function opsFirstAllowedSection() {
  for (const g of opsNavGroups()) for (const i of g.items) if (!i.hidden && opsItemAllowed(i)) return i.id;
  return 'settings';
}

function opsGo(section, afterLoad) {
  const item = opsNavItem(section);
  if (!item || !OPS_LOADERS[section] || !opsItemAllowed(item) || !opsItemInLayout(item)) {
    if (section && opsNavItem(section)) {
      opsToast(`${OPS_TITLES[section]} is not available for your account.`, 'err');
    }
    section = opsFirstAllowedSection();
  }
  opsCurrentSection = section;
  opsSyncNavActive(section);
  opsAll('.ops-section').forEach(s => s.classList.toggle('active', s.id === `ops-${section}`));
  $('opsCrumb').textContent = OPS_TITLES[section] || section;
  $('opsRail').classList.remove('open');
  if (location.hash.replace('#', '') !== section) location.hash = section;

  if (!opsLoaded.has(section)) {
    opsLoaded.add(section);
    Promise.resolve(OPS_LOADERS[section]())
      .then(() => afterLoad?.())
      .catch(err => {
        /* A renderer that throws must not leave a blank screen with no
           explanation — and must not stay "loaded", or retrying is impossible. */
        opsLoaded.delete(section);
        $(`ops-${section}`).innerHTML =
          `<div class="ops-panel"><div class="ops-panel-body"><div class="ops-msg ops-msg-err" style="margin:0">
             ${escapeHtml(opsError(err, 'This section failed to load.'))}
           </div></div></div>`;
      });
  } else {
    afterLoad?.();
  }
  window.scrollTo({ top: 0 });
}

function opsInvalidate(...sections) {
  sections.forEach(s => opsLoaded.delete(s));
}
/* Re-render a stale section that happens to be on screen right now —
   otherwise the operator watches a table that no longer matches what they
   just did. */
function opsRefreshIfVisible(...sections) {
  sections.forEach(s => {
    if ($(`ops-${s}`)?.classList.contains('active')) {
      opsLoaded.add(s);
      Promise.resolve(OPS_LOADERS[s]()).catch(() => {});
    }
  });
}
/* The usual "server state changed" fan-out: everything that counts requests,
   money or queue depth. */
function opsAfterWrite() {
  opsInvalidate('dashboard', 'bookings', 'requests', 'approvals', 'payments', 'wallet', 'reports', 'customers');
  opsRefreshIfVisible(opsCurrentSection);
  opsLoadBadges();
}

/* ===========================================================================
   SIGNING IN HAPPENS SOMEWHERE ELSE
   ===========================================================================
   This workspace deliberately has NO login UI. There is one authentication
   system in the project and it lives on the public site — the login modal on
   ../index.html running Login -> Password -> OTP, with forgot-password,
   reset-password and register beside it. Reimplementing any of that here would
   mean two login forms, two OTP boxes and two password-reset flows to keep in
   step, for no gain: the tokens are already shared.

   So when there is no usable session this file REDIRECTS to the existing
   login instead of drawing one.

   WHERE IT SENDS PEOPLE, AND WHY IT DIFFERS
   If the session merely expired we know which portal it belonged to, so we
   return them to their own front door — a merchant to the Partner login, staff
   to theirs.

   With no session at all we do not know who is arriving, and the answer is the
   Partner login. This workspace is where a MERCHANT lands after signing in, so
   a merchant is who turns up here with a cold bookmark. Staff are not stranded
   by that choice: their portals are at their own URLs, which is the only place
   they are named now.

   ../portal-login.html is NOT the answer for the unknown case, and no longer
   could be: it was a public directory of the internal portals, and it now just
   redirects here.                                                           */

const OPS_SIGNIN = {
  /* The merchant's canonical sign-in is now its own page rather than the public
     site's modal. That modal became the CUSTOMER (B2C) login when the two
     audiences were split, so sending a merchant to ../index.html#login would
     land them on a login their credentials do not open. */
  merchant: '../partner-login.html',
  admin: '../admin/index.html',
  super_admin: '../super-admin/index.html',
  unknown: '../partner-login.html',
};

/* Leaves the workspace for the existing login. `reason` is carried in the URL
   so the destination can explain itself rather than the operator wondering why
   they were bounced. */
function opsRequireSignIn(portal, reason) {
  OpsSession.user = null;
  OpsSession.perms = new Set();
  $('opsApp').classList.remove('active');
  opsStopHeartbeat();
  opsLoaded.clear();

  const target = OPS_SIGNIN[portal] || OPS_SIGNIN.unknown;
  const url = reason
    ? (target.includes('#')
        ? target.replace('#', `?ops_reason=${encodeURIComponent(reason)}#`)
        : `${target}?ops_reason=${encodeURIComponent(reason)}`)
    : target;
  location.replace(url);
}

/* Fetch identity, then build everything that depends on it. Called after a
   fresh sign-in and on every arrival with an existing token — the local
   snapshot from storePortalTokens() is a convenience, never the authority,
   because permissions can have changed server-side since it was written.

   Deliberately does NOT rely on the shared axios interceptor's 401 handling
   for this first call: handlePortalUnauthorized (auth.js, shared with every
   other portal and not a file this build touches) skips its retry for any
   URL containing '/api/auth/' — a rule aimed at the login/OTP endpoints,
   which legitimately 401 without meaning "your session expired". /api/auth/me
   matches that same prefix, so an access token that has merely expired while
   the browser tab sat open comes back here as a 401 with no retry, even
   though a valid refresh token exists. Rather than loosen that shared rule
   for every portal, one explicit refresh-and-retry is done locally, entirely
   inside this file. */
async function opsStartSession(portal) {
  OpsSession.portal = portal;
  localStorage.setItem(OPS_ACTIVE_KEY, portal);
  let user;
  try {
    user = await OpsApi.me();
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    const newToken = await tryRefreshPortalSession(portal);
    if (!newToken) throw err;
    user = await OpsApi.me();
  }
  OpsSession.user = user;
  OpsSession.perms = new Set(user.permissions || []);

  /* -----------------------------------------------------------------------
     MERCHANTS DO NOT USE THIS WORKSPACE.
     The merchant UI is the Classic portal; Operations stays in service for
     platform staff only. This gate is on the ROLE that /api/auth/me returned,
     not on the localStorage namespace the tokens happen to sit in, so a
     merchant cannot land here by arriving with a session opened elsewhere.

     It runs before `.active` is added, so a merchant never sees a frame of
     this UI. Admin and super admin fall straight through, unchanged.

     Nothing here was deleted — remove this block to let merchants back in.
     ----------------------------------------------------------------------- */
  if (!opsIsStaff()) {
    location.replace('../merchant-classic/');
    return;
  }

  $('opsApp').classList.add('active');

  $('opsUserName').textContent = user.full_name || user.email;
  $('opsUserOrg').textContent = user.merchant_name ? ` · ${user.merchant_name}` : '';
  $('opsUserMenuHead').textContent = user.email;
  $('opsCrumbRole').textContent = [opsLabel(user.role), user.merchant_role ? opsLabel(user.merchant_role) : null]
    .filter(Boolean).join(' · ');
  $('opsCrumbDate').textContent = new Date().toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
  /* The workspace switcher's V1 link goes to this account's own V1 portal.
     Same session, so it is a plain link rather than a second sign-in. */
  $('opsV1Link').href = portal === 'merchant' ? '../merchant/index.html'
    : portal === 'admin' ? '../admin/index.html'
    : '../super-admin/index.html';
  if (portal === 'merchant') $('opsV1Link').textContent = 'Premium Travel Workspace →';

  /* The account menu's shortcut should land on whichever screen this session
     actually edits its account from — Profile for a merchant, Settings for
     staff (who have no Profile entry). Read at click time by the handler
     below, so retargeting the attribute is enough. */
  const accountBtn = opsEl('[data-ops-nav]', $('opsUserMenu'));
  if (accountBtn && opsIsMerchantWorkspace()) {
    accountBtn.dataset.opsNav = 'profile';
    accountBtn.textContent = 'Profile';
  }

  opsRenderDeskMenu();
  opsRenderNav();
  opsApplyDensity();

  /* Deep links survive a reload: #payments lands on Payments. */
  opsGo((location.hash || '').replace('#', '') || 'dashboard');
  opsLoadBadges();
  opsStartHeartbeat();
}

async function opsSignOut() {
  if (!await opsConfirm('Sign out of the Operations workspace?', 'Sign out')) return;
  const portal = OpsSession.portal;
  /* Revokes the session server-side and clears that portal's keys — which
     also signs this browser out of the matching Version 1 portal, because it
     is genuinely the same session. */
  await logoutPortalSession(portal).catch(() => {});
  localStorage.removeItem(OPS_ACTIVE_KEY);
  /* Back to the public site rather than a local sign-in box: after a
     deliberate sign-out the session is gone everywhere, so the front door is
     the honest destination. */
  opsRequireSignIn(portal, 'signed-out');
}

/* One silent refresh before giving up, then out to the existing login — the
   same policy every Version 1 portal uses, so all interfaces expire together
   instead of one of them appearing to work with a dead token. */
axios.interceptors.response.use(
  res => res,
  async err => {
    if (err.response?.status === 401 && OpsSession.portal) {
      const retried = await handlePortalUnauthorized(OpsSession.portal, err);
      if (retried) return retried;
      opsRequireSignIn(OpsSession.portal, 'session-expired');
    }
    return Promise.reject(err);
  }
);

/* ===========================================================================
   HEARTBEAT
   ===========================================================================
   Feeds `is_online` in the Users grid (session_service.online_user_ids). Every
   two minutes, and never awaited — a failed heartbeat must not surface as an
   error to someone who is just working.                                    */
let opsHeartbeatTimer = null;
function opsStartHeartbeat() {
  opsStopHeartbeat();
  if (!opsCan('profile.manage')) return;
  const beat = () => OpsApi.heartbeat(`operations#${opsCurrentSection}`).catch(() => {});
  beat();
  opsHeartbeatTimer = setInterval(beat, 120000);
}
function opsStopHeartbeat() {
  if (opsHeartbeatTimer) clearInterval(opsHeartbeatTimer);
  opsHeartbeatTimer = null;
}

/* ===========================================================================
   BADGES — notification bell, plus nav counts for the queues that matter
   =========================================================================== */
async function opsLoadBadges() {
  if (opsCan('notification.view')) {
    try {
      const d = await OpsApi.notificationUnreadCount();
      const n = Number(d.count ?? d.unread_count ?? 0);
      $('opsBellCount').textContent = n > 99 ? '99+' : String(n);
      $('opsBellCount').classList.toggle('ops-hidden', !n);
    } catch { $('opsBellCount').classList.add('ops-hidden'); }
  } else {
    $('opsBellBtn').classList.add('ops-hidden');
  }

  if (opsCan('chat.view')) {
    try {
      const d = await OpsApi.chatUnreadCount();
      opsSetNavCount('support', Number(d.count || 0));
    } catch { /* a badge is never worth an error message */ }
  }
  if (opsCan('ticket.approve', 'merchant.approve', 'servicerequest.manage')) {
    try {
      const d = await OpsApi.approvalQueue({ page_size: 1 });
      opsSetNavCount('approvals', Number(d.total || 0));
    } catch { /* ditto */ }
  }
}

/* ===========================================================================
   NOTIFICATION DRAWER
   =========================================================================== */
async function opsOpenDrawer() {
  $('opsDrawer').classList.add('open');
  $('opsDrawerBack').classList.add('open');
  const list = $('opsDrawerList');
  list.innerHTML = opsSpinner();
  try {
    const data = await OpsApi.listNotifications({ page_size: 40 });
    const items = data.items || [];
    list.innerHTML = items.length
      ? items.map(n => `
          <div class="ops-note${n.is_read ? '' : ' unread'}" data-ops-note="${escapeHtml(String(n.id))}">
            <b>${escapeHtml(n.title || 'Notification')}</b>
            ${escapeHtml(n.message || '')}
            <time>${escapeHtml(fmtDateTime(n.created_at))}</time>
          </div>`).join('')
      : '<div class="ops-empty">No notifications.</div>';
    opsAll('[data-ops-note]', list).forEach(el => {
      el.addEventListener('click', async () => {
        if (!el.classList.contains('unread')) return;
        el.classList.remove('unread');
        try { await OpsApi.markNotificationRead(el.dataset.opsNote); await opsLoadBadges(); } catch { /* visual only */ }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="ops-empty">${escapeHtml(opsError(err, 'Could not load notifications.'))}</div>`;
  }
}
function opsCloseDrawer() {
  $('opsDrawer').classList.remove('open');
  $('opsDrawerBack').classList.remove('open');
}

/* ===========================================================================
   GLOBAL SEARCH
   ===========================================================================
   Fans out across every searchable endpoint this account may call, in
   parallel, and groups the hits. What each endpoint can actually match was
   read out of its service function, not assumed:

     /api/requests?search=        pnr, request_number, booking_reference,
                                  ticket_number, title, destination city, and a
                                  subquery over passenger first/last name and
                                  passport number  (ticket_service.list_requests)
     /api/admin/merchants?search= company_name, merchant_name, merchant_code,
                                  email            (merchant_service.list_merchants)
     /api/admin/users?search=     full_name, email (account_service.list_all_users)
     /api/catalog/search?q=       flight / hotel / cruise / package inventory

   PHONE IS NOT SERVER-SEARCHABLE — neither users nor merchants include phone
   in their ilike. Rather than silently returning nothing for a phone number,
   a mostly-numeric query additionally pulls one page of contacts and matches
   phone client-side, and the group heading says exactly how far that reach
   goes. Inventing a phone filter the API does not have would be the only
   dishonest option here.                                                  */

let opsSearchTimer = null;
let opsSearchSeq = 0;

function opsIsPhoneish(q) {
  const digits = q.replace(/[^\d]/g, '');
  return digits.length >= 6 && digits.length / q.length > 0.6;
}

async function opsRunGlobalSearch(term) {
  const box = $('opsSearchResults');
  const q = term.trim();
  if (q.length < 2) { box.classList.remove('open'); return; }

  const seq = ++opsSearchSeq;
  box.innerHTML = opsSpinner('Searching…');
  box.classList.add('open');

  const jobs = [];
  const push = (label, promise, render) => jobs.push({ label, promise, render });

  if (opsCan('ticket.view')) {
    push('Bookings & requests', OpsApi.listRequests({ search: q, page_size: 8 }), d =>
      (d.items || []).map(r => ({
        key: r.request_number,
        text: [r.title, r.pnr && `PNR ${r.pnr}`, opsPassengerNames(r), opsStatusLabel(r.status)]
          .filter(Boolean).join(' · '),
        go: () => opsGo('bookings', () => opsOpenRequest(r.id)),
      })));
  }
  if (opsCan('merchant.view')) {
    push('Merchants', OpsApi.listMerchants({ search: q, page_size: 6 }), d =>
      (d.items || []).map(m => ({
        key: m.merchant_code,
        text: [m.company_name, m.email, opsStatusLabel(m.status)].filter(Boolean).join(' · '),
        go: () => opsGo('merchants', () => opsOpenMerchant(m.id)),
      })));
  }
  if (opsCan('merchant_user.manage')) {
    push('People', OpsApi.listUsers({ search: q, page_size: 6 }), d =>
      (d.items || []).map(u => ({
        key: u.email,
        text: [u.full_name, opsLabel(u.role), u.phone].filter(Boolean).join(' · '),
        go: () => opsGo('users'),
      })));
  }
  if (opsCan('ticket.enquiry')) {
    push('Inventory', OpsApi.searchCatalog({ q, page_size: 6 }), d =>
      (d.items || []).map(i => ({
        key: i.travel_type ? opsLabel(i.travel_type) : 'Item',
        text: [i.title, fmtDate(i.travel_date), money(i.total_amount)].filter(Boolean).join(' · '),
        go: () => opsGo(`${i.travel_type || 'flight'}s`),
      })));
  }
  /* The phone fallback described above. */
  if (opsIsPhoneish(q) && opsCan('merchant_user.manage')) {
    push('Contacts (phone match, most recent 100 accounts)',
      OpsApi.listUsers({ page_size: 100 }), d => {
        const digits = q.replace(/[^\d]/g, '');
        return (d.items || [])
          .filter(u => (u.phone || '').replace(/[^\d]/g, '').includes(digits))
          .slice(0, 6)
          .map(u => ({
            key: u.phone,
            text: [u.full_name, u.email, opsLabel(u.role)].filter(Boolean).join(' · '),
            go: () => opsGo('users'),
          }));
      });
  }

  const settled = await Promise.allSettled(jobs.map(j => j.promise));
  if (seq !== opsSearchSeq) return;   /* a newer keystroke already won */

  const groups = [];
  settled.forEach((res, i) => {
    if (res.status !== 'fulfilled') return;
    let rows = [];
    try { rows = jobs[i].render(res.value) || []; } catch { rows = []; }
    if (rows.length) groups.push({ label: jobs[i].label, rows });
  });

  if (!groups.length) {
    box.innerHTML = `<div class="ops-gs-note">No matches for “${escapeHtml(q)}”.</div>`;
    return;
  }

  opsSearchHits = [];
  box.innerHTML = groups.map(g => {
    const rows = g.rows.map(r => {
      const idx = opsSearchHits.push(r) - 1;
      return `<a href="#" data-ops-hit="${idx}" role="option">
                <b>${escapeHtml(r.key || '')}</b><small>${escapeHtml(r.text || '')}</small>
              </a>`;
    }).join('');
    return `<div class="ops-gs-group">${escapeHtml(g.label)}</div>${rows}`;
  }).join('');

  opsAll('[data-ops-hit]', box).forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      /* Read the hit BEFORE closing the search box — opsCloseSearch() resets
         opsSearchHits to [], so looking it up afterwards silently no-ops on
         undefined and the click does nothing. */
      const hit = opsSearchHits[Number(a.dataset.opsHit)];
      opsCloseSearch();
      hit?.go();
    });
  });
}

let opsSearchHits = [];

function opsCloseSearch() {
  $('opsSearchResults').classList.remove('open');
  $('opsSearch').value = '';
  opsSearchHits = [];
}

/* Arrow keys + Enter through the result list, so a search never needs the
   mouse. */
function opsSearchKeydown(e) {
  const box = $('opsSearchResults');
  if (!box.classList.contains('open')) return;
  const links = opsAll('[data-ops-hit]', box);
  if (!links.length) return;
  const cur = links.findIndex(l => l.classList.contains('cursor'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown'
      ? Math.min(cur + 1, links.length - 1)
      : Math.max(cur - 1, 0);
    links.forEach(l => l.classList.remove('cursor'));
    links[next].classList.add('cursor');
    links[next].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && cur >= 0) {
    e.preventDefault();
    links[cur].click();
  }
}

/* ===========================================================================
   WORKSPACE SWITCHER / DENSITY
   =========================================================================== */
function opsRenderDeskMenu() {
  /* A merchant's switcher is about which INTERFACE they work in, not which
     desk of a staff sidebar — so the desk list collapses to a single current
     entry and the Premium link below it does the real work. */
  if (opsIsMerchantWorkspace()) {
    $('opsDeskList').innerHTML =
      '<button type="button" class="on" disabled>Merchant Operations (this workspace)</button>';
    $('opsWorkspaceLabel').textContent = 'Operations';
    return;
  }
  const desk = opsCurrentDesk();
  $('opsDeskList').innerHTML = OPS_DESKS.map(d =>
    `<button type="button" data-ops-desk="${d.id}" class="${d.id === desk ? 'on' : ''}">${escapeHtml(d.label)}</button>`
  ).join('');
  $('opsWorkspaceLabel').textContent = (OPS_DESKS.find(d => d.id === desk) || OPS_DESKS[0]).label;
  opsAll('[data-ops-desk]').forEach(b => {
    b.addEventListener('click', () => {
      localStorage.setItem('ops_desk', b.dataset.opsDesk);
      $('opsWorkspaceMenu').classList.remove('open');
      opsRenderDeskMenu();
      opsRenderNav();
      /* Narrowing the desk must never strand the operator on a section the
         new desk no longer lists. */
      if (!opsAll(`[data-ops-nav="${opsCurrentSection}"]`).length) opsGo(opsFirstAllowedSection());
    });
  });
}

function opsApplyDensity() {
  document.documentElement.dataset.opsDensity = localStorage.getItem('ops_density') || 'compact';
}

/* ===========================================================================
   KEYBOARD SHORTCUTS
   ===========================================================================
   The five from the brief, plus a help dialog. Ctrl+F and Ctrl+S deliberately
   override the browser's own: an operator's "find" is this portal's search,
   and their "save" is the form in front of them.

   Ctrl+S dispatches an `ops:save` event that the visible section listens for,
   so the shortcut works on whichever form is on screen without the shell
   needing to know anything about it.                                       */
function opsRegisterShortcuts() {
  document.addEventListener('keydown', e => {
    const key = (e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    if (key === 'escape') {
      if ($('opsModalBack').classList.contains('open')) return opsCloseModal();
      if ($('opsDrawer').classList.contains('open')) return opsCloseDrawer();
      if ($('opsSearchResults').classList.contains('open')) return opsCloseSearch();
      opsAll('.ops-menu.open,.ops-colmenu.open').forEach(m => m.classList.remove('open'));
      return;
    }
    if (!mod) {
      /* `?` opens the shortcut list, but only when the user is not typing. */
      if (key === '?' && !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) {
        e.preventDefault();
        opsShowShortcuts();
      }
      return;
    }
    if (!$('opsApp').classList.contains('active')) return;

    /* Ctrl+K is the command-palette convention operators arrive with; Ctrl+F
       is kept alongside it because the brief lists both "Ctrl+K global search"
       and "Ctrl+F search", and they mean the same box here. */
    if (key === 'k' || key === 'f') {
      e.preventDefault();
      $('opsSearch').focus();
      $('opsSearch').select();
    } else if (key === 'n') {
      e.preventDefault();
      if (opsCan('ticket.request')) opsGo('new-request');
      else opsToast('Your account cannot raise requests.', 'err');
    } else if (key === 's') {
      e.preventDefault();
      const target = $(`ops-${opsCurrentSection}`);
      const handled = !target.dispatchEvent(new CustomEvent('ops:save', { cancelable: true }));
      if (!handled) opsToast('Nothing to save on this screen.');
    }
  });
}

function opsShowShortcuts() {
  opsOpenModal('Keyboard shortcuts', `
    <dl class="ops-dl ops-dl-rows">
      <div><dt><span class="ops-kbd">Ctrl</span> + <span class="ops-kbd">K</span></dt><dd>Focus global search</dd></div>
      <div><dt><span class="ops-kbd">Ctrl</span> + <span class="ops-kbd">F</span></dt><dd>Focus global search (same box)</dd></div>
      <div><dt><span class="ops-kbd">Ctrl</span> + <span class="ops-kbd">N</span></dt><dd>New request</dd></div>
      <div><dt><span class="ops-kbd">Ctrl</span> + <span class="ops-kbd">S</span></dt><dd>Save the form on screen</dd></div>
      <div><dt><span class="ops-kbd">Enter</span></dt><dd>Run the search / submit the form you are in</dd></div>
      <div><dt><span class="ops-kbd">Esc</span></dt><dd>Close dialog, drawer, menu or search</dd></div>
      <div><dt><span class="ops-kbd">↑</span> <span class="ops-kbd">↓</span> <span class="ops-kbd">Enter</span></dt><dd>Move through global-search results</dd></div>
      <div><dt><span class="ops-kbd">?</span></dt><dd>This list</dd></div>
    </dl>
    <p class="ops-panel-note" style="margin-top:10px;border-radius:3px;border:1px solid var(--ops-line-soft)">
      Ctrl+F and Ctrl+S replace the browser's find and save while this workspace has focus.
    </p>`,
    '<span class="ops-spacer"></span><button type="button" class="ops-btn ops-btn-primary" id="opsShortcutsClose">Close</button>');
  $('opsShortcutsClose').addEventListener('click', opsCloseModal);
}

/* A menu button that toggles the panel next to it and closes on outside
   click — used by the workspace, account and column menus. */
function opsWireMenu(btnId, menuId) {
  $(btnId).addEventListener('click', e => {
    e.stopPropagation();
    const menu = $(menuId);
    const wasOpen = menu.classList.contains('open');
    opsAll('.ops-menu.open').forEach(m => m.classList.remove('open'));
    menu.classList.toggle('open', !wasOpen);
  });
}

/* ===========================================================================
   CHANGE PASSWORD (toolbar, available to every account)
   =========================================================================== */
function opsChangePasswordDialog() {
  opsOpenModal('Change password', `
    <div class="ops-form ops-form-2">
      <div class="ops-field ops-field-full">
        <label for="opsCpCur">Current password<span class="ops-req">*</span></label>
        <input type="password" id="opsCpCur" autocomplete="current-password">
      </div>
      <div class="ops-field">
        <label for="opsCpNew">New password<span class="ops-req">*</span></label>
        <input type="password" id="opsCpNew" autocomplete="new-password">
        <span class="ops-field-hint">8–72 characters.</span>
      </div>
      <div class="ops-field">
        <label for="opsCpNew2">Confirm new password<span class="ops-req">*</span></label>
        <input type="password" id="opsCpNew2" autocomplete="new-password">
      </div>
    </div>
    <div class="ops-msg" id="opsCpMsg"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsCpCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-primary" id="opsCpSave">Change password</button>`);

  $('opsCpCancel').addEventListener('click', opsCloseModal);
  $('opsCpSave').addEventListener('click', async () => {
    const cur = $('opsCpCur').value;
    const a = $('opsCpNew').value;
    const b = $('opsCpNew2').value;
    const msg = $('opsCpMsg');
    if (!cur || !a) return opsMsg(msg, 'Fill in both password fields.', 'err');
    if (a !== b) return opsMsg(msg, 'The new passwords do not match.', 'err');
    if (a.length < 8) return opsMsg(msg, 'The new password must be at least 8 characters.', 'err');
    $('opsCpSave').disabled = true;
    try {
      await OpsApi.changePassword(cur, a);
      opsCloseModal();
      opsToast('Password changed.', 'ok');
    } catch (err) {
      opsMsg(msg, opsError(err, 'Could not change the password.'), 'err');
    } finally {
      $('opsCpSave').disabled = false;
    }
  });
}

/* ===========================================================================
   BOOT
   =========================================================================== */
function opsBoot() {
  /* No auth wiring: there is no login form on this page. See opsRequireSignIn. */

  /* chrome */
  $('opsRailToggle').addEventListener('click', () => {
    /* Narrow viewports get an overlay rail; wide ones get an icon rail. */
    if (window.matchMedia('(max-width:900px)').matches) $('opsRail').classList.toggle('open');
    else $('opsApp').classList.toggle('rail-collapsed');
  });
  opsWireMenu('opsWorkspaceBtn', 'opsWorkspaceMenu');
  opsWireMenu('opsUserBtn', 'opsUserMenu');
  $('opsHelpBtn').addEventListener('click', opsShowShortcuts);
  $('opsChangePwBtn').addEventListener('click', () => {
    $('opsUserMenu').classList.remove('open');
    opsChangePasswordDialog();
  });
  $('opsSignOutBtn').addEventListener('click', () => {
    $('opsUserMenu').classList.remove('open');
    opsSignOut();
  });
  opsAll('[data-ops-nav]', $('opsUserMenu')).forEach(b =>
    b.addEventListener('click', () => {
      $('opsUserMenu').classList.remove('open');
      opsGo(b.dataset.opsNav);
    }));

  /* modal / drawer */
  $('opsModalClose').addEventListener('click', opsCloseModal);
  $('opsModalBack').addEventListener('click', e => { if (e.target === $('opsModalBack')) opsCloseModal(); });
  $('opsBellBtn').addEventListener('click', opsOpenDrawer);
  $('opsDrawerClose').addEventListener('click', opsCloseDrawer);
  $('opsDrawerBack').addEventListener('click', opsCloseDrawer);
  $('opsMarkAllBtn').addEventListener('click', async () => {
    try {
      await OpsApi.markAllNotificationsRead();
      opsAll('.ops-note', $('opsDrawerList')).forEach(n => n.classList.remove('unread'));
      await opsLoadBadges();
    } catch (err) { opsToast(opsError(err, 'Could not mark all read.'), 'err'); }
  });

  /* global search — debounced so typing does not fire a fan-out per keystroke */
  $('opsSearch').addEventListener('input', e => {
    clearTimeout(opsSearchTimer);
    const v = e.target.value;
    opsSearchTimer = setTimeout(() => opsRunGlobalSearch(v), 260);
  });
  $('opsSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !opsAll('[data-ops-hit].cursor').length) {
      clearTimeout(opsSearchTimer);
      opsRunGlobalSearch(e.target.value);
      return;
    }
    opsSearchKeydown(e);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.ops-top-search')) $('opsSearchResults').classList.remove('open');
    if (!e.target.closest('.ops-menu-wrap')) opsAll('.ops-menu.open').forEach(m => m.classList.remove('open'));
    if (!e.target.closest('.ops-colwrap')) opsAll('.ops-colmenu.open').forEach(m => m.classList.remove('open'));
  });

  opsRegisterShortcuts();

  window.addEventListener('hashchange', () => {
    const s = (location.hash || '').replace('#', '');
    if (s && OPS_LOADERS[s] && s !== opsCurrentSection) opsGo(s);
  });

  opsApplyDensity();

  /* Adopt an existing session if there is one, and prove it is still alive
     with /api/auth/me before showing the workspace — a token in localStorage
     is not evidence of a valid session. No token at all means whoever this is
     has not signed in yet, and signing in happens on the public site. */
  const portal = opsDetectPortal();
  if (!portal) return opsRequireSignIn(null, 'sign-in-required');
  opsStartSession(portal).catch(() => {
    /* Expired or revoked: for a 401 the interceptor has already started the
       redirect, and location.replace twice is harmless. Anything else
       (network, CORS) lands here too and deserves the same exit. */
    opsRequireSignIn(portal, 'session-expired');
  });
}
