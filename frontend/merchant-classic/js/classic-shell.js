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

/* ---- shared input behaviours ----
   Two of them: `clPickerOnly` for the travel dates, `clDigitsOnly` for the
   contact numbers and the two halves of a time. They live here rather than in
   either module because a rule about how a date or a phone number is entered
   must not be able to differ between two screens that ask for the same thing —
   the enquiry form and the Booking Request screen both use them. */

/* A DATE THAT CAN ONLY BE PICKED, NEVER TYPED.
   ===========================================================================
   A native `input[type=date]` opens its calendar only from the small indicator
   at the right edge; a click anywhere else lands in the segmented text and
   invites typing, which is the reported "I chose a date and the field did not
   update" — the merchant was editing one segment of a partly-typed value and
   the box never reached a complete date.

   So: every click on the field opens the picker, and the keyboard cannot write
   into it. Navigation keys stay live (Tab, Escape, and the arrows the platform
   uses to step a highlighted segment), because taking those away would leave
   the control unreachable without a mouse — Enter and Space open the picker
   instead.

   `showPicker()` throws if it is called outside a user gesture or twice in a
   row; both are harmless here and both are swallowed. Where the browser has no
   `showPicker` (older WebKit) the field simply keeps its native behaviour, and
   the typing block still holds. */
const CL_DATE_NAV_KEYS = ['Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

function clPickerOnly(input) {
  if (!input) return;
  const open = () => {
    try {
      if (typeof input.showPicker === 'function') input.showPicker();
    } catch { /* not a user gesture, or already open — nothing to report */ }
  };
  input.addEventListener('mousedown', e => { e.preventDefault(); input.focus(); open(); });
  input.addEventListener('click', open);
  input.addEventListener('keydown', e => {
    if (CL_DATE_NAV_KEYS.includes(e.key) || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (e.key === 'Enter' || e.key === ' ') open();
  });
  return input;
}

/* Digits and nothing else, capped at `max` of them. Applied on `input` so a
   pasted "+91 (900) 000-0000" is cleaned the moment it lands rather than
   rejected at submit, and the caret is put back where it was — rewriting
   `.value` otherwise sends it to the end mid-edit.

   `max` MAY BE A FUNCTION, and the phone fields need it to be: their cap is the
   selected country's number length, which changes under the field every time
   the merchant picks a different code. Read at event time rather than closed
   over at bind time, so a picker change takes effect on the very next keystroke
   without rebinding the listener (rebinding would stack a second one). */
function clDigitsOnly(input, max) {
  if (!input) return;
  input.addEventListener('input', () => {
    const cap = typeof max === 'function' ? max() : max;
    const before = input.value;
    const caret = input.selectionStart ?? before.length;
    const cleaned = before.replace(/\D+/g, '').slice(0, cap);
    if (cleaned === before) return;
    /* Digits are the fixed point across the rewrite: count how many stood
       before the caret, and put it back after that many in the cleaned value.
       Anything discarded from before the caret shifts it left by itself. */
    const digitsBefore = before.slice(0, caret).replace(/\D+/g, '').length;
    input.value = cleaned;
    const at = Math.min(cleaned.length, digitsBefore);
    input.setSelectionRange(at, at);
  });
  return input;
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

/* ------------------------------------------------------------ filter chips
   The primary facet of a table, as a row of chips instead of a dropdown.

   THE <select> STAYS. It is moved off-screen and out of the accessibility tree,
   and it remains the single source of truth for the value — every module still
   reads `$('clReqStatus').value`, the reset handlers still write `''` to it,
   and clBindKpiNav still deep-links into it from a dashboard tile. The chips
   are a second face on one control, not a second control: clicking a chip
   writes to the select and dispatches `change`, which is the event every screen
   was already listening for. Nothing downstream of the filter had to learn a
   new contract, which is the only reason this could be done to six screens at
   once without re-testing each one's loader.

   `data-cl-chip-tone` on an <option> paints the chip's dot in the same tone the
   status carries as a table badge. */
function clChipsHtml(select, label) {
  const options = [...select.options];
  return `<div class="cl-chipbar">
    <span class="cl-chipbar-label" id="${select.id}Lbl">${escapeHtml(label)}</span>
    <div class="cl-chips" role="radiogroup" aria-labelledby="${select.id}Lbl"
         data-cl-chips-for="${select.id}">
      ${options.map(o => {
        const tone = o.dataset.clChipTone || '';
        return `<button type="button" class="cl-chip" role="radio"
                        data-cl-chip="${escapeHtml(o.value)}"
                        aria-checked="${o.value === select.value ? 'true' : 'false'}"
                        tabindex="${o.value === select.value ? '0' : '-1'}">
          ${tone ? `<span class="cl-chip-dot ${escapeHtml(tone)}"></span>` : ''}
          ${escapeHtml(o.textContent.trim())}
        </button>`;
      }).join('')}
    </div>
  </div>`;
}

/* Turns the <select> with this id into a chip row, in place. Call once, after
   the screen's markup is in the DOM. */
function clChips(selectId, label) {
  const select = $(selectId);
  if (!select || select.dataset.clChipped) return;
  select.dataset.clChipped = '1';

  const host = document.createElement('div');
  host.innerHTML = clChipsHtml(select, label);
  const bar = host.firstElementChild;

  /* The select keeps working and keeps its label association; it is simply not
     the thing on screen any more. aria-hidden + tabindex=-1 so a keyboard or
     screen-reader user meets the chips once, not the same filter twice. */
  const field = select.closest('.cl-field') || select;
  field.setAttribute('aria-hidden', 'true');
  field.style.position = 'absolute';
  field.style.width = '1px';
  field.style.height = '1px';
  field.style.overflow = 'hidden';
  field.style.clipPath = 'inset(50%)';
  field.style.margin = '-1px';
  select.tabIndex = -1;
  field.parentNode.insertBefore(bar, field);

  const chips = () => [...bar.querySelectorAll('[data-cl-chip]')];

  const pick = (value, { focus = false } = {}) => {
    if (select.value === value) {
      /* Re-clicking the active chip is not a no-op worth a round trip, but the
         roving tabindex still has to follow the pointer. */
      clSyncChips(selectId);
      return;
    }
    select.value = value;
    clSyncChips(selectId);
    if (focus) bar.querySelector('[aria-checked="true"]')?.focus();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  bar.addEventListener('click', e => {
    const chip = e.target.closest('[data-cl-chip]');
    if (chip) pick(chip.dataset.clChip);
  });

  /* Arrow keys move within the group and select as they go — the WAI-ARIA
     radiogroup pattern, which is what this is. */
  bar.addEventListener('keydown', e => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const all = chips();
    const at = all.findIndex(c => c.getAttribute('aria-checked') === 'true');
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    else next = ((at < 0 ? 0 : at) + (forward ? 1 : -1) + all.length) % all.length;
    e.preventDefault();
    pick(all[next].dataset.clChip, { focus: true });
  });

  /* Anything that sets the select and dispatches change — clBindKpiNav's
     deep link from a dashboard tile, most of all — repaints the chips here. */
  select.addEventListener('change', () => clSyncChips(selectId));
}

/* Repaint the chips from the select. Needed after code that writes `.value`
   WITHOUT dispatching change, which is what every "Reset filters" button does. */
function clSyncChips(selectId) {
  const select = $(selectId);
  const bar = document.querySelector(`[data-cl-chips-for="${selectId}"]`);
  if (!select || !bar) return;
  bar.querySelectorAll('[data-cl-chip]').forEach(chip => {
    const on = chip.dataset.clChip === select.value;
    chip.setAttribute('aria-checked', on ? 'true' : 'false');
    chip.tabIndex = on ? 0 : -1;
  });
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

/* The screen's name, and nothing under it. The standing one-line descriptions
   that used to sit beneath every title were removed on request: a merchant who
   has been in the portal twice does not need "Ask us for a fare" under
   "Booking Enquiry", and thirteen of them made every screen open with a
   paragraph before it showed any data. */
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
  payments: 'Payment Management',
  'service-request': 'Service Requests',
  reports: 'Reports',
  notifications: 'Notifications',
  profile: 'Profile & Settings',
  support: 'Support Center',
};

/* THE DASHBOARD'S TOPBAR TITLE IS THE GREETING, NOT THE WORD "DASHBOARD".
   The rail, the breadcrumb and the browser tab all already say which screen
   this is, so the one slot at the top of the page is spent on the only line on
   that screen that is not a figure. Everything else that identifies the section
   keeps the section name — see clGo. */
function clGreeting({ short = false } = {}) {
  const name = (localStorage.getItem(PARTNER_KEYS.fullName) || '').split(' ')[0];
  const h = new Date().getHours();
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  if (!name) return 'Welcome back 👋';
  return short ? `Hi ${name} 👋` : `Good ${part}, ${name} 👋`;
}

/* THE GREETING HAS TO FIT, OR IT IS WORSE THAN THE TITLE IT REPLACED.
   `#clTopTitle` is nowrap + ellipsis, and on a 375px phone the slot is about
   154px — "Good evening, Rohan 👋" renders there as "Good Evening, Ro…", which
   cuts the merchant's own name off the one line that exists to greet them by
   it. That is the whole reason `.cl-top-title{display:none}` came out of the
   760px block, so leaving it truncated would undo the point of unhiding it.

   MEASURED, NOT BREAKPOINTED. A media query would have to guess a width, and
   the real limit depends on how long the merchant's first name is — "Al" fits
   where "Bhavanishankar" does not. Writing the full form and asking the element
   whether it overflowed costs one reflow on a paint that already happens, and
   is right for every name at every width. */
function clPaintTopTitle(section) {
  const el = $('clTopTitle');
  /* No section yet means nothing has navigated — the resize listener is live
     from script load, so a merchant who resizes the window while still on the
     sign-in screen would otherwise have the topbar written to the string
     "null" the moment they got in. */
  if (!el || !section) return;
  if (section !== 'dashboard') {
    el.textContent = CL_TITLES[section] || section;
    return;
  }
  el.textContent = clGreeting();
  if (el.scrollWidth > el.clientWidth + 1) el.textContent = clGreeting({ short: true });
}

/* Rotating a phone or dragging a desktop window changes that fit in both
   directions, and the title is only written on navigation — without this a
   merchant who opens the Dashboard in portrait keeps the short form after
   turning the phone, and one who narrows a window keeps the truncated long
   one. Repaint is a no-op on every screen except the Dashboard. */
let clCurrentSection = null;
window.addEventListener('resize', () => clPaintTopTitle(clCurrentSection));

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
  clCurrentSection = section;
  $('clCrumb').textContent = title;
  clPaintTopTitle(section);
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

/* ---------------------------------------------------------------------------
   ONE PORTAL, ONE LAYOUT — PERMISSIONS MOVE BUTTONS, NOT PAGES.

   Every merchant account holds the same READ codes (`_MERCHANT_READ` in
   backend/app/auth/rbac.py), so every screen in this portal renders the same
   way for a Data Operator as for a Manager: same greeting, same eight KPI
   cards, same charts, same tables and filters. What a sub-role changes is which
   ACTIONS are available, and that is what this helper is for.

   `clCan` is the only thing any screen should ask. Two rules for callers:

   1. Gate the CONTROL, never the container. Disabling "Top up" is right;
      hiding the Wallet panel it sits in is what split this portal in two.
   2. Prefer `clActionAttrs()` (below) to hiding. A disabled control with a
      reason still tells the user the feature exists and who to ask; a control
      that vanishes reads as a broken build.

   This is presentation only. Every endpoint behind every one of these keeps its
   own `require()` server-side — a button that is merely hidden has never been
   what stops anyone.
   --------------------------------------------------------------------------- */
function clCan(code) {
  const user = clSessionUser();
  return Array.isArray(user?.permissions) && user.permissions.includes(code);
}

/* Attributes for an action control the session may not use: disabled, plus the
   reason on hover and for a screen reader. Spread into a <button> tag.

   `aria-disabled` as well as `disabled`, because a plain `disabled` button is
   skipped by the tab order and a keyboard user then never learns the control is
   there — which is the same disappearance this whole change is undoing.

   CALLERS MUST NOT ALSO WRITE `title` ON THE SAME TAG. Two `title` attributes on
   one element is not an error the browser reports; it silently keeps the FIRST
   and drops the second, so whichever the author wrote second is the one that
   goes missing. Where a control already explains itself on hover, branch on
   clCan() in the template and write one title or the other. */
function clActionAttrs(code, why) {
  if (clCan(code)) return '';
  return ` disabled aria-disabled="true" title="${escapeHtml(why || CL_NO_PERMISSION)}"`;
}

/* One wording per action, so the same refusal does not appear as three
   different sentences on three screens. They name the job that does hold the
   permission — "ask a Manager" is actionable, "permission denied" is not. */
const CL_NO_PERMISSION = 'Your role does not allow this action.';
const CL_NO_ENQUIRY = 'Your role cannot raise booking enquiries. Ask a Manager or Supervisor.';
const CL_NO_BOOKING = 'Your role cannot raise or change bookings. Ask a Manager or Supervisor.';
const CL_NO_PAY = 'Your role cannot make payments. Ask a Manager or your Finance team.';
const CL_NO_EXPORT = 'Your role cannot export reports. Ask a Manager or Supervisor.';
const CL_NO_SERVICE = 'Your role cannot raise service requests. Ask a Manager or Supervisor.';
const CL_NO_CHAT = 'Your role cannot write to the partner desk. Ask a Manager or Supervisor.';
/* There is deliberately no constant for the manager sign-off. Approve / Reject
   are ROW actions on a table that can run to fifty pending requests, and a
   disabled pair on every row is noise rather than information — so
   clSrRowActions omits them for a non-approver, and the note above the table
   says who the request goes to instead. Hiding is the right answer when the
   control would repeat per row; disabling is the right answer for the one
   button at the top of a screen. */

/* Whether this account may sign off its own company's service requests.
   Mirrors the server's rule in change_request_service._is_manager, which reads
   the PERMISSION rather than the role name — so this asks for the permission
   too. It used to test `merchant_role === 'manager' || role === 'merchant_admin'`
   and that answered a different question: a merchant_admin whose sub-role was
   Finance was offered a sign-off the server then refused. */
function clIsManager(user = clSessionUser()) {
  return !!user && Array.isArray(user.permissions)
    && user.permissions.includes('servicerequest.approve');
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
   Settings already makes, so nothing new is being asked of the backend.

   IT NOW REPAIRS A MISSING `permissions` ARRAY TOO, and that second condition
   is the load-bearing one. clCan() answers false for a code it cannot find, so
   a snapshot without the array does not degrade — it disables every action in
   the portal at once, on an account that is entitled to all of them. Refetching
   is the difference between a stale session and an unusable one. */
async function clRefreshRole() {
  const user = clSessionUser();
  if (clRoleLabel(user) && Array.isArray(user?.permissions)) return;
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
  /* The collapsed rail's stand-in for the company name. */
  $('clSideBadge').textContent = company ? clInitials(company) : clInitials(name);
  $('clSideBadge').title = company || name;
}

/* AWAITS THE ROLE REFRESH, and the order is the point. Every permission-driven
   decision below this line — the Approvals rail item, and then every button the
   first screen renders — reads the session snapshot synchronously. Firing the
   repair off and routing anyway would paint the whole portal from the snapshot
   this function was called to fix. For a healthy session clRefreshRole returns
   on its first line and this costs a microtask; only a snapshot that is
   actually missing something waits for the network, which is the one case where
   waiting is right. */
async function clShowApp() {
  $('clAuth').style.display = 'none';
  $('clApp').classList.add('active');

  clPaintIdentity();
  await clRefreshRole();
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
      /* The session is genuinely gone — expired or revoked — so this is a
         sign-out the user did not ask for, and it ends where sign-out ends.
         Showing the in-page card here used to strand them on a screen that
         still had the portal chrome behind it.

         A REJECTED PASSWORD IS NOT THAT. `/api/auth/login` also answers 401,
         and someone mistyping one is already on the sign-in card and must stay
         there — see auth.js::isSessionEndingUnauthorized. */
      if (isSessionEndingUnauthorized(err)) {
        clearPartnerSession();
        clLoaded.clear();
        redirectToPortalLogin();
      }
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

/* ---- rail width ----
   Expanded or icon-only, remembered per browser. The choice is a desktop one:
   the CSS only honours `cl-rail-mini` above 900px, because below that the rail
   is an off-canvas drawer and a permanently-narrow strip of icons would cover
   the page it is there to navigate.

   The class goes on `.cl-app`, not on the rail — it re-points `--cl-rail-w`,
   which is the shell grid's first column, so the main area reflows with it.

   The visible tooltip is `title`, set here and removed on expand. It is not a
   CSS ::after: the rail scrolls vertically, and a box that scrolls on one axis
   clips the other, so a pseudo-element tooltip is sliced off at the rail's
   edge. The label itself is never removed from the DOM — the CSS clips it — so
   the accessible name survives and this title is not doing that job. */
const CL_RAIL_KEY = 'classic_rail_mini';

/* THE TOGGLE BUTTON IS GONE FROM THE MARKUP; THIS CODE IS NOT.
   Removing `#clRailToggle` from index.html would have thrown here on the
   next-to-last line and on the listener below, taking the whole boot with it.
   Both are now optional. The collapse STATE is kept deliberately rather than
   deleted: a merchant whose rail was already collapsed has a '1' in
   localStorage, and if this simply ignored it their rail would stay narrow
   with no control to widen it. Reading it and forcing false clears that. */
function clApplyRail(mini) {
  const app = $('clApp');
  const btn = $('clRailToggle');
  app.classList.toggle('cl-rail-mini', mini);

  if (btn) {
    btn.setAttribute('aria-expanded', mini ? 'false' : 'true');
    btn.setAttribute('aria-label', mini ? 'Expand navigation' : 'Collapse navigation');
    btn.title = mini ? 'Expand navigation' : '';
    const txt = $('clRailToggleText');
    if (txt) txt.textContent = mini ? 'Expand' : 'Collapse';
  }

  $('clSide').querySelectorAll('a[data-cl-nav]').forEach(a => {
    const label = a.querySelector('.cl-side-label')?.textContent.trim() || '';
    if (mini) a.title = label; else a.removeAttribute('title');
  });
}

function clInitRail() {
  const btn = $('clRailToggle');
  /* No control => never collapsed, and the stale preference is cleared so it
     cannot resurrect if the button is ever restored. */
  if (!btn) {
    localStorage.removeItem(CL_RAIL_KEY);
    clApplyRail(false);
    return;
  }
  clApplyRail(localStorage.getItem(CL_RAIL_KEY) === '1');
  btn.addEventListener('click', () => {
    const mini = !$('clApp').classList.contains('cl-rail-mini');
    localStorage.setItem(CL_RAIL_KEY, mini ? '1' : '0');
    clApplyRail(mini);
  });
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
  clInitRail();

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
    /* logoutPortalSession revokes the session, clears the keys and leaves for
       the public partner login. `clearPartnerSession` stays as a belt-and-braces
       local clear in case the network call throws before it gets that far. */
    await logoutPortalSession('merchant', { redirect: false }).catch(() => {});
    clearPartnerSession();
    clLoaded.clear();
    redirectToPortalLogin();
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

  /* Back after signing out must not restore this portal — see
     auth.js::guardPortalSession. A deliberate visit with no session still gets
     the sign-in card below. */
  guardPortalSession(isPartnerLoggedIn);

  if (isPartnerLoggedIn()) clShowApp(); else clShowAuth();
}
