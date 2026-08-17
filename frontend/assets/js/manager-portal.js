'use strict';
/* Manager Portal (CR-2) — approval of submitted Booking Requests.
   ===========================================================================
   Three sections — the approval queue, notifications, and the manager's own
   profile — plus a read-only review modal with two decisions on it. Small
   enough to stay one file; the router below is nine lines rather than a shell
   module of its own.

   READ-ONLY BY CONSTRUCTION
   The review modal renders `<dl>`s and a table. It contains no form input for
   any booking field, so there is no code path here that could edit a passenger
   or an itinerary even if the API allowed it — the Manager verifies what the
   merchant submitted, and "verify" means read.

   ONE CALL PER SCREEN
   GET /api/manager/bookings/{id} already returns the request, its timeline and
   the actions this manager may take. The modal is a renderer over that payload
   and invents no endpoint of its own. */

const MGR_API = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

const $mg = id => document.getElementById(id);

/* Tabs, in the order a manager works: what is waiting, then what was decided.
   `id` is the server's own bucket name — the API resolves the status set, so
   the row count, the page count and the badge are all counting the same thing.
   Filtering a page client-side got this wrong: 170 results, 10 rows, and a
   "page 4 of 9" that rendered empty. */
const MGR_TABS = [
  { id: 'awaiting', label: 'Awaiting approval' },
  { id: 'approved', label: 'Approved' },
  { id: 'returned', label: 'Returned for correction' },
  { id: 'ticketed', label: 'Ticketed' },
];

const MGR_STATUS_BADGE = {
  pending_approval: 'pending', in_review: 'pending', approved: 'confirmed',
  ticket_issued: 'confirmed', completed: 'confirmed', draft: 'read',
  rejected: 'cancelled', cancelled: 'cancelled',
};

let mgrTab = 'awaiting';
let mgrPage = 1;
let mgrSearch = '';
let mgrSearchTimer = null;
let mgrOpenId = null;
/* Returned by trapFocus() while the review modal is open; calling it restores
   focus to whatever opened the modal. */
let mgrReleaseFocus = null;

const MGR_TITLES = {
  queue: ['Booking Requests', 'Verify passenger details, then approve for ticketing or return for correction.'],
  notifications: ['Notifications', 'Booking requests submitted for your approval.'],
  profile: ['Profile & Security', 'Your details and password.'],
};

/* 24-hour preferred time, the same clock the merchant entered it on and the
   Admin screens render it in. Preferred times only — record timestamps keep
   whatever format their own formatter gives them. */
function mgTime(hhmm) {
  if (!hhmm) return '—';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return String(hhmm);
  return `${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
}

function mgrErr(err, fallback) {
  return err?.response?.data?.detail || err?.message || fallback || 'Something went wrong.';
}

/* ------------------------------------------------------------------ auth */

let mgrChallengeToken = '';

function mgrShowStep(id) {
  document.querySelectorAll('#mgrAuthShell .auth-step').forEach(s => s.classList.remove('active'));
  $mg(id).classList.add('active');
  const active = { mgrAuthStep1: 1, mgrAuthStep2: 2 }[id];
  document.querySelectorAll('#mgrAuthStepper .auth-step-dot').forEach(d => {
    const n = Number(d.dataset.stepDot);
    d.classList.toggle('active', n === active);
    d.classList.toggle('done', active && n < active);
  });
}

function mgrShowAuth() {
  $mg('mgrAuthShell').style.display = 'flex';
  $mg('mgrLayout').style.display = 'none';
}

function mgrShowApp() {
  $mg('mgrAuthShell').style.display = 'none';
  $mg('mgrLayout').style.display = '';
  const user = getPortalUser('manager') || {};
  const name = user.full_name || localStorage.getItem(MGR_KEYS.fullName) || 'Manager';
  $mg('mgrUserName').textContent = name;
  $mg('mgrAvatar').textContent = (name.trim()[0] || 'M').toUpperCase();
  mgrRenderTabs();
  mgrGo((location.hash || '').replace('#', '') || 'queue');
  mgrLoadUnread();
}

/* ---------------------------------------------------------------- router */

function mgrGo(section) {
  if (!MGR_TITLES[section]) section = 'queue';
  document.querySelectorAll('[data-mg-nav]').forEach(a =>
    a.classList.toggle('active', a.dataset.mgNav === section));
  document.querySelectorAll('.section').forEach(s =>
    s.classList.toggle('active', s.id === `mgr-${section}`));
  const [title, sub] = MGR_TITLES[section];
  $mg('mgrCrumb').textContent = title;
  document.querySelector('.topbar .current-date').textContent = sub;
  location.hash = section;
  document.querySelector('.sidebar')?.classList.remove('open');

  if (section === 'queue') mgrLoadQueue();
  if (section === 'notifications') mgrLoadNotificationPage();
  if (section === 'profile') mgrLoadProfile();
  window.scrollTo({ top: 0 });
}

$mg('mgrLoginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $mg('mgrLoginMsg');
  const email = $mg('mgrEmail').value.trim();
  const password = $mg('mgrPassword').value;
  msg.className = 'msg'; msg.textContent = '';
  if (!email || !password) {
    msg.className = 'msg error';
    msg.textContent = 'Enter your email and password.';
    return;
  }
  try {
    const challenge = await startPortalLogin('manager', email, password);
    mgrChallengeToken = challenge.challenge_token;
    $mg('mgrAuthStep2Sub').textContent = challenge.dev_otp
      ? `Dev mode — code: ${challenge.dev_otp}`
      : `Enter the 6-digit code sent to ${email}`;
    mgrShowStep('mgrAuthStep2');
    $mg('mgrOtp').focus();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = mgrErr(err, 'Invalid email or password.');
  }
});

$mg('mgrVerifyOtpBtn').addEventListener('click', async () => {
  const msg = $mg('mgrAuthStep2Msg');
  const code = $mg('mgrOtp').value.trim();
  if (code.length < 4) {
    msg.className = 'msg error';
    msg.textContent = 'Enter the code sent to your email.';
    return;
  }
  const btn = $mg('mgrVerifyOtpBtn');
  btn.disabled = true;
  try {
    const data = await verifyPortalOtp(mgrChallengeToken, code);
    storePortalTokens('manager', data);
    mgrChallengeToken = '';
    ['mgrEmail', 'mgrPassword', 'mgrOtp'].forEach(id => { $mg(id).value = ''; });
    msg.textContent = '';
    mgrShowStep('mgrAuthStep1');
    mgrShowApp();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = mgrErr(err, 'Incorrect or expired code.');
  } finally {
    btn.disabled = false;
  }
});

$mg('mgrResendOtpBtn').addEventListener('click', async () => {
  const msg = $mg('mgrAuthStep2Msg');
  try {
    const challenge = await resendPortalOtp(mgrChallengeToken);
    mgrChallengeToken = challenge.challenge_token;
    msg.className = 'msg success';
    msg.textContent = challenge.dev_otp ? `Dev mode — new code: ${challenge.dev_otp}` : 'A new code has been sent.';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = mgrErr(err, 'Could not resend the code.');
  }
});

$mg('mgrBackToCredsBtn').addEventListener('click', () => {
  mgrChallengeToken = '';
  mgrShowStep('mgrAuthStep1');
});

$mg('mgrSignOutBtn').addEventListener('click', async e => {
  e.preventDefault();
  await logoutPortalSession('manager', { redirect: false }).catch(() => {});
  clearManagerSession();
  redirectToPortalLogin();
});

/* Same policy as every other portal: one silent refresh, and then out to the
   public partner login — an expired session is a sign-out nobody asked for. A
   deliberate visit to /manager/ with no session still gets the card below. */
axios.interceptors.response.use(
  res => res,
  async err => {
    if (err.response?.status === 401) {
      const retried = await handlePortalUnauthorized('manager', err);
      if (retried) return retried;
      // Not on a rejected password — that leaves them on this portal's card.
      if (isSessionEndingUnauthorized(err)) {
        clearManagerSession();
        redirectToPortalLogin();
      }
    }
    return Promise.reject(err);
  }
);

/* Back after signing out must not restore this portal — auth.js. */
guardPortalSession(isManagerLoggedIn);

/* ----------------------------------------------------------------- queue */

function mgrRenderTabs(counts) {
  $mg('mgrTabs').innerHTML = MGR_TABS.map(t => {
    const n = counts ? Number(counts[t.id] || 0) : null;
    return `<button type="button" class="mg-tab${t.id === mgrTab ? ' active' : ''}"
              role="tab" aria-selected="${t.id === mgrTab}" data-mg-tab="${t.id}">
              ${escapeHtml(t.label)}
              ${n ? `<span class="mg-tab-count">${n}</span>` : ''}
            </button>`;
  }).join('');
  $mg('mgrTabs').querySelectorAll('[data-mg-tab]').forEach(b => {
    b.addEventListener('click', () => {
      mgrTab = b.dataset.mgTab;
      mgrPage = 1;
      mgrLoadQueue();
    });
  });
}

async function mgrLoadCounts() {
  try {
    const { data } = await axios.get(`${MGR_API}/api/manager/bookings/counts`, { headers: managerAuthHeaders() });
    mgrRenderTabs(data);
    const badge = $mg('mgrNavBadge');
    const awaiting = Number(data.awaiting || 0);
    badge.textContent = awaiting > 99 ? '99+' : String(awaiting);
    badge.hidden = awaiting === 0;
  } catch {
    /* A failed badge must never block the queue. */
  }
}

async function mgrLoadQueue() {
  const body = $mg('mgrTable').querySelector('tbody');
  body.innerHTML = `<tr><td colspan="7" class="mg-empty">Loading…</td></tr>`;
  mgrRenderTabs();
  mgrLoadCounts();

  const tab = MGR_TABS.find(t => t.id === mgrTab) || MGR_TABS[0];
  const params = new URLSearchParams({ bucket: tab.id, page: mgrPage, page_size: '20' });
  if (mgrSearch) params.set('search', mgrSearch);

  try {
    const { data } = await axios.get(`${MGR_API}/api/manager/bookings?${params}`, { headers: managerAuthHeaders() });
    const rows = data.items || [];
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="mg-empty">${
        mgrSearch ? 'No booking requests match that search.' : 'Nothing here right now.'}</td></tr>`;
    } else {
      body.innerHTML = rows.map(r => `
        <tr>
          <td>
            <div class="mg-ref"><strong>${escapeHtml(r.request_number)}</strong></div>
            ${r.enquiry_reference ? `<div style="font-size:11.5px;color:var(--text-muted);">from ${escapeHtml(r.enquiry_reference)}</div>` : ''}
          </td>
          <td>${escapeHtml(r.merchant_name || '—')}
            ${r.raised_by ? `<div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(r.raised_by)}</div>` : ''}</td>
          <td>${escapeHtml([r.origin, r.destination].filter(Boolean).join(' → ') || r.title || '—')}
            ${r.international ? '<div style="font-size:11.5px;color:var(--text-muted);">International</div>' : ''}</td>
          <td>${escapeHtml(fmtDate(r.travel_date))}</td>
          <td>${r.passenger_count}</td>
          <td><span class="badge ${MGR_STATUS_BADGE[r.status] || ''}">${escapeHtml(r.status_label)}</span>
            ${r.reviewer_name && r.status === 'in_review'
              ? `<div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(r.reviewer_name)}</div>` : ''}</td>
          <td><button type="button" class="btn btn-navy btn-sm" data-mg-open="${r.id}">Review</button></td>
        </tr>`).join('');
      body.querySelectorAll('[data-mg-open]').forEach(b => {
        b.addEventListener('click', () => mgrOpenReview(Number(b.dataset.mgOpen)));
      });
    }
    mgrRenderPagination(data.page || mgrPage, data.total_pages || 1, data.total || rows.length);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="mg-empty">${escapeHtml(mgrErr(err, 'Could not load booking requests.'))}</td></tr>`;
  }
}

function mgrRenderPagination(page, totalPages, total) {
  const el = $mg('mgrPagination');
  if (totalPages <= 1) { el.innerHTML = `<span>${total} request${total === 1 ? '' : 's'}</span>`; return; }
  el.innerHTML = `
    <span>${total} requests · page ${page} of ${totalPages}</span>
    <button type="button" class="btn btn-ghost btn-sm" id="mgrPrev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
    <button type="button" class="btn btn-ghost btn-sm" id="mgrNext" ${page >= totalPages ? 'disabled' : ''}>Next</button>`;
  $mg('mgrPrev')?.addEventListener('click', () => { mgrPage = page - 1; mgrLoadQueue(); });
  $mg('mgrNext')?.addEventListener('click', () => { mgrPage = page + 1; mgrLoadQueue(); });
}

$mg('mgrRefreshBtn').addEventListener('click', () => mgrLoadQueue());
$mg('mgrSearch').addEventListener('input', e => {
  clearTimeout(mgrSearchTimer);
  const v = e.target.value;
  mgrSearchTimer = setTimeout(() => { mgrSearch = v.trim(); mgrPage = 1; mgrLoadQueue(); }, 250);
});

/* --------------------------------------------------------- notifications */

/* `notify_managers` has been writing a row on every submitted Classic Tours
   booking since CR-2 landed, and the Manager holds `notification.view` — but
   the portal had no surface, so those rows accumulated unread and unreadable.
   This is that surface: the bell for the newest few, the section for the rest.
   No new endpoint; /api/notifications already serves any role that holds the
   code. */

function mgrNotifHtml(n) {
  const unread = !(n.is_read ?? n.read ?? false);
  return `<div class="mg-notif${unread ? ' unread' : ''}" data-mg-notif="${n.id}" role="button" tabindex="0">
    <b>${escapeHtml(n.title || n.subject || 'Notification')}</b>
    <p>${escapeHtml(n.message || n.body || '')}</p>
    <time>${escapeHtml(fmtDateTime(n.created_at))}</time>
  </div>`;
}

async function mgrMarkRead(id, el) {
  if (!el.classList.contains('unread')) return;
  el.classList.remove('unread');
  try {
    await axios.patch(`${MGR_API}/api/notifications/${id}/read`, {}, { headers: managerAuthHeaders() });
    mgrLoadUnread();
  } catch {
    /* Visual only — the row stays read on screen; the next load corrects it. */
  }
}

function mgrWireNotifRows(root) {
  root.querySelectorAll('[data-mg-notif]').forEach(el => {
    const go = () => mgrMarkRead(el.dataset.mgNotif, el);
    el.addEventListener('click', go);
    /* role="button" without a key handler is a control a keyboard cannot use. */
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
}

async function mgrLoadUnread() {
  try {
    const { data } = await axios.get(`${MGR_API}/api/notifications/unread-count`,
                                     { headers: managerAuthHeaders() });
    const n = Number(data.count ?? data.unread_count ?? 0);
    $mg('mgrBellDot').style.display = n > 0 ? '' : 'none';
    const badge = $mg('mgrNotifNavBadge');
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = n === 0;
  } catch {
    $mg('mgrBellDot').style.display = 'none';
  }
}

async function mgrLoadBell() {
  const list = $mg('mgrNotifList');
  list.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data } = await axios.get(`${MGR_API}/api/notifications?page_size=8`,
                                     { headers: managerAuthHeaders() });
    const items = data.items || [];
    list.innerHTML = items.length
      ? items.map(mgrNotifHtml).join('')
      : '<div class="empty-state">Nothing yet.</div>';
    mgrWireNotifRows(list);
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(mgrErr(err, 'Could not load notifications.'))}</div>`;
  }
}

let mgrNotifPage = 1;

async function mgrLoadNotificationPage(page = mgrNotifPage) {
  mgrNotifPage = page;
  const box = $mg('mgrNotifFull');
  box.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data } = await axios.get(`${MGR_API}/api/notifications?page=${page}&page_size=20`,
                                     { headers: managerAuthHeaders() });
    const items = data.items || [];
    box.innerHTML = items.length
      ? items.map(mgrNotifHtml).join('')
      : '<div class="empty-state">No notifications yet. New booking requests will appear here.</div>';
    mgrWireNotifRows(box);

    const el = $mg('mgrNotifPagination');
    const totalPages = data.total_pages || 1;
    if (totalPages <= 1) {
      el.innerHTML = `<span>${data.total || items.length} notification${(data.total || items.length) === 1 ? '' : 's'}</span>`;
    } else {
      el.innerHTML = `
        <span>${data.total} notifications · page ${data.page} of ${totalPages}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="mgrNotifPrev" ${data.page <= 1 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn-ghost btn-sm" id="mgrNotifNext" ${data.page >= totalPages ? 'disabled' : ''}>Next</button>`;
      $mg('mgrNotifPrev')?.addEventListener('click', () => mgrLoadNotificationPage(data.page - 1));
      $mg('mgrNotifNext')?.addEventListener('click', () => mgrLoadNotificationPage(data.page + 1));
    }
  } catch (err) {
    box.innerHTML = `<div class="empty-state">${escapeHtml(mgrErr(err, 'Could not load notifications.'))}</div>`;
  }
}

async function mgrMarkAllRead() {
  try {
    await axios.post(`${MGR_API}/api/notifications/read-all`, {}, { headers: managerAuthHeaders() });
    document.querySelectorAll('.mg-notif.unread').forEach(el => el.classList.remove('unread'));
    mgrLoadUnread();
    showToast('All notifications marked read.');
  } catch (err) {
    showToast(mgrErr(err, 'Could not mark them read.'), true);
  }
}

$mg('mgrBellBtn').addEventListener('click', e => {
  e.stopPropagation();
  const dd = $mg('mgrNotifDropdown');
  const opening = !dd.classList.contains('open');
  dd.classList.toggle('open', opening);
  if (opening) mgrLoadBell();
});
document.addEventListener('click', e => {
  if (!e.target.closest('.icon-btn-wrap')) $mg('mgrNotifDropdown')?.classList.remove('open');
});
$mg('mgrMarkAllBtn').addEventListener('click', e => { e.stopPropagation(); mgrMarkAllRead(); });
$mg('mgrNotifMarkAllBtn').addEventListener('click', () => mgrMarkAllRead().then(() => mgrLoadNotificationPage(1)));

/* --------------------------------------------------------------- profile */

async function mgrLoadProfile() {
  const msg = $mg('mgrProfileMsg');
  msg.className = 'msg';
  msg.textContent = '';
  try {
    const { data } = await axios.get(`${MGR_API}/api/profile`, { headers: managerAuthHeaders() });
    $mg('mgrPfName').value = data.full_name || '';
    $mg('mgrPfEmail').value = data.email || '';
    $mg('mgrPfPhone').value = data.mobile || data.phone || '';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = mgrErr(err, 'Could not load your profile.');
  }
}

$mg('mgrProfileForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $mg('mgrProfileMsg');
  const name = $mg('mgrPfName').value.trim();
  if (!name) {
    msg.className = 'msg error';
    msg.textContent = 'Your name cannot be blank.';
    return;
  }
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  try {
    const { data } = await axios.put(`${MGR_API}/api/profile`, {
      full_name: name,
      phone: $mg('mgrPfPhone').value.trim() || null,
    }, { headers: managerAuthHeaders() });
    msg.className = 'msg success';
    msg.textContent = 'Profile updated.';
    /* The chip in the topbar and the cached session both carry the old name
       until this is written back. */
    localStorage.setItem(MGR_KEYS.fullName, data.full_name);
    const stored = getPortalUser('manager') || {};
    localStorage.setItem('manager_user_json', JSON.stringify({ ...stored, full_name: data.full_name }));
    $mg('mgrUserName').textContent = data.full_name;
    $mg('mgrAvatar').textContent = (data.full_name.trim()[0] || 'M').toUpperCase();
    showToast('Profile updated.');
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = mgrErr(err, 'Could not save your profile.');
  }
});

$mg('mgrPasswordForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $mg('mgrPasswordMsg');
  const current = $mg('mgrPwCurrent').value;
  const next = $mg('mgrPwNew').value;
  const confirm = $mg('mgrPwConfirm').value;

  const fail = text => { msg.className = 'msg error'; msg.textContent = text; };
  if (next.length < 8) return fail('The new password must be at least 8 characters.');
  if (next !== confirm) return fail('The two new passwords do not match.');
  if (next === current) return fail('The new password must be different from the current one.');

  msg.className = 'msg';
  msg.textContent = 'Changing…';
  try {
    await axios.post(`${MGR_API}/api/auth/change-password`,
      { current_password: current, new_password: next },
      { headers: managerAuthHeaders() });
    $mg('mgrPasswordForm').reset();
    msg.className = 'msg success';
    msg.textContent = 'Password changed.';
    showToast('Password changed.');
  } catch (err) {
    fail(mgrErr(err, 'Could not change your password.'));
  }
});

/* ---------------------------------------------------------------- review */

function mgrCloseReview() {
  $mg('mgrReviewOverlay').classList.remove('open');
  $mg('mgrReviewBody').innerHTML = '';
  mgrOpenId = null;
  /* Hand focus back to the Review button that opened this, so a keyboard user
     lands where they left rather than at the top of the document. */
  mgrReleaseFocus?.();
  mgrReleaseFocus = null;
}

async function mgrOpenReview(id) {
  mgrOpenId = id;
  const overlay = $mg('mgrReviewOverlay');
  $mg('mgrReviewBody').innerHTML = `<div class="mg-empty">Loading booking request…</div>`;
  overlay.classList.add('open');
  /* Trapped from the moment it opens, not after the fetch — otherwise Tab
     escapes into the page behind for as long as the request takes. */
  mgrReleaseFocus = trapFocus($mg('mgrReviewBody'));
  try {
    const { data } = await axios.get(`${MGR_API}/api/manager/bookings/${id}`, { headers: managerAuthHeaders() });
    mgrRenderReview(data);
  } catch (err) {
    $mg('mgrReviewBody').innerHTML = `
      <div class="mg-modal-head"><h2 id="mgrReviewTitle">Booking Request</h2>
        <button type="button" class="mg-modal-close" id="mgrReviewClose" aria-label="Close" data-focus-trap-skip>&times;</button></div>
      <div class="msg error">${escapeHtml(mgrErr(err, 'Could not load this booking request.'))}</div>`;
    $mg('mgrReviewClose').addEventListener('click', mgrCloseReview);
  }
}

function mgrRenderReview(data) {
  const r = data.request;
  const d = r.details || {};
  const contact = d.contact || {};
  const roundTrip = d.trip_type === 'round_trip';
  const decidable = data.can_decide;
  const isHotel = r.travel_type === 'hotel';

  $mg('mgrReviewBody').innerHTML = `
    <div class="mg-modal-head">
      <h2 id="mgrReviewTitle">${escapeHtml(r.request_number)}
        <span class="badge ${MGR_STATUS_BADGE[r.status] || ''}" style="margin-left:8px;">${escapeHtml(r.status_label)}</span>
      </h2>
      <button type="button" class="mg-modal-close" id="mgrReviewClose" aria-label="Close" data-focus-trap-skip>&times;</button>
    </div>

    <div class="mg-section">
      <h3>Booking</h3>
      <dl class="mg-dl">
        <div><dt>Merchant</dt><dd>${escapeHtml(r.merchant_name || '—')}</dd></div>
        <div><dt>Raised by</dt><dd>${escapeHtml(r.raised_by || '—')}</dd></div>
        <div><dt>Booking reference</dt><dd class="mg-ref">${escapeHtml(r.booking_reference || '—')}</dd></div>
        <!-- A booking on this queue arrived one of two ways. A dash here would
             read as missing data on a booking that never had an enquiry. -->
        <div><dt>From enquiry</dt><dd class="mg-ref">${
          isHotel ? (d.hotel_enquiry_reference
            ? escapeHtml(d.hotel_enquiry_reference)
            : (d.direct_booking ? 'Direct booking — not quoted' : '—'))
          : (d.enquiry_reference
            ? escapeHtml(d.enquiry_reference)
            : (d.direct_booking ? 'Direct booking — not quoted' : '—'))}</dd></div>
        <div><dt>Submitted</dt><dd>${escapeHtml(fmtDateTime(r.created_at))}</dd></div>
        <div><dt>${isHotel ? 'Guests' : 'Travellers'}</dt><dd>${
          isHotel ? (r.hotel_guests || []).length : (r.passengers || []).length}</dd></div>
      </dl>
    </div>

    ${isHotel ? `
    <div class="mg-section">
      <h3>Hotel Stay <span style="font-weight:600;text-transform:none;letter-spacing:0;">— locked from the answered enquiry</span></h3>
      <dl class="mg-dl">
        <div><dt>Destination</dt><dd>${escapeHtml(d.destination_city || '—')}</dd></div>
        <div><dt>Hotel</dt><dd>${escapeHtml(d.hotel_name || '—')}</dd></div>
        <div><dt>Star category</dt><dd>${d.star_category ? `${escapeHtml(d.star_category)} Star` : '—'}</dd></div>
        <div><dt>Room type</dt><dd>${escapeHtml(d.room_type || '—')}</dd></div>
        <div><dt>Meal plan</dt><dd>${escapeHtml((d.meal_plan || '—').replace(/_/g, ' '))}</dd></div>
        <div><dt>Check-in</dt><dd>${escapeHtml(fmtDate(r.travel_date))}</dd></div>
        <div><dt>Check-out</dt><dd>${escapeHtml(fmtDate(r.return_date))}</dd></div>
        <div><dt>Preferred location</dt><dd>${escapeHtml(d.preferred_location || '—')}</dd></div>
      </dl>
    </div>

    <div class="mg-section">
      <h3>Guests</h3>
      <div class="table-wrap"><table><thead><tr>
        <th>#</th><th>Name</th><th>Type</th><th>Room</th><th>ID proof</th>
      </tr></thead><tbody>
        ${(r.hotel_guests || []).map((g, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml([g.title, g.first_name, g.last_name].filter(Boolean).join(' '))}${
              g.is_lead_guest ? ' <span class="badge">Lead</span>' : ''}</td>
            <td>${escapeHtml(g.guest_type || 'adult')}</td>
            <td>Room ${g.room_number}</td>
            <td class="mg-ref">${escapeHtml(g.id_proof_number || '—')}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="mg-empty">No guests recorded.</td></tr>'}
      </tbody></table></div>
    </div>` : `
    <div class="mg-section">
      <h3>Itinerary <span style="font-weight:600;text-transform:none;letter-spacing:0;">— locked from the answered enquiry</span></h3>
      <dl class="mg-dl">
        <div><dt>Trip type</dt><dd>${tripTypeLabel(d.trip_type)}</dd></div>
        <div><dt>From</dt><dd>${escapeHtml([d.origin_city, d.origin].filter(Boolean).join(' · ') || '—')}</dd></div>
        <div><dt>To</dt><dd>${escapeHtml([d.destination_city, d.destination].filter(Boolean).join(' · ') || '—')}</dd></div>
        <div><dt>Airline</dt><dd>${escapeHtml(fmtAirline(d.airline))}</dd></div>
        <div><dt>Flight number</dt><dd class="mg-ref">${escapeHtml(d.flight_number || '—')}</dd></div>
        <div><dt>Departure</dt><dd>${escapeHtml(fmtDate(r.travel_date))}</dd></div>
        ${roundTrip ? `<div><dt>Return</dt><dd>${escapeHtml(fmtDate(r.return_date))}</dd></div>` : ''}
        <div><dt>Preferred time</dt><dd>${escapeHtml(mgTime(d.preferred_time))}</dd></div>
        ${roundTrip
          ? `<div><dt>Return time</dt><dd>${escapeHtml(mgTime(d.return_preferred_time))}</dd></div>`
          : ''}
        <div><dt>Class</dt><dd>${escapeHtml(d.travel_class || '—')}</dd></div>
        <div><dt>Booking Class</dt><dd>${escapeHtml(d.booking_class || '—')}</dd></div>
        <div><dt>Route</dt><dd>${d.international ? 'International' : 'Domestic'}</dd></div>
      </dl>
    </div>

    <div class="mg-section">
      <h3>Passengers</h3>
      <div class="table-wrap"><table><thead><tr>
        <th>#</th><th>Name</th><th>Type</th><th>Gender</th><th>Date of birth</th>
        <th>Nationality</th><th>Passport</th><th>Expiry</th>
      </tr></thead><tbody>
        ${(r.passengers || []).map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' '))}</td>
            <td>${escapeHtml(p.passenger_type || 'adult')}</td>
            <td>${escapeHtml(p.gender || '—')}</td>
            <td>${escapeHtml(p.dob ? fmtDate(p.dob) : '—')}</td>
            <td>${escapeHtml(p.nationality || '—')}</td>
            <td class="mg-ref">${escapeHtml(p.passport_number || '—')}</td>
            <td>${escapeHtml(p.passport_expiry ? fmtDate(p.passport_expiry) : '—')}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="mg-empty">No passengers recorded.</td></tr>'}
      </tbody></table></div>
    </div>`}

    <div class="mg-section">
      <h3>Contact</h3>
      <dl class="mg-dl">
        <div><dt>Name</dt><dd>${escapeHtml(contact.name || '—')}</dd></div>
        <div><dt>Email</dt><dd>${escapeHtml(contact.email || '—')}</dd></div>
        <div><dt>Phone</dt><dd>${escapeHtml(contact.phone || '—')}</dd></div>
        <div><dt>Alternate</dt><dd>${escapeHtml(contact.alternate_phone || '—')}</dd></div>
      </dl>
      ${d.special_requests ? `<div class="mg-note"><strong>Special requests:</strong> ${escapeHtml(d.special_requests)}</div>` : ''}
      ${r.remarks ? `<div class="mg-note"><strong>Merchant remarks:</strong> ${escapeHtml(r.remarks)}</div>` : ''}
      ${d.manager_remarks ? `<div class="mg-note"><strong>Previously returned:</strong> ${escapeHtml(d.manager_remarks)}</div>` : ''}
    </div>

    <div class="mg-section">
      <h3>Timeline</h3>
      <ul class="mg-timeline">
        ${(data.timeline || []).map(s => `
          <li class="${s.state === 'pending' ? 'pending' : ''}">
            <div class="mg-tl-label">${escapeHtml(s.label || s.status || '')}</div>
            <div class="mg-tl-meta">${s.at ? escapeHtml(fmtDateTime(s.at)) : 'Not yet'}${s.by ? ` · ${escapeHtml(s.by)}` : ''}</div>
            ${s.reason ? `<div class="mg-tl-note">${escapeHtml(s.reason)}</div>` : ''}
            ${s.note ? `<div class="mg-tl-note">${escapeHtml(s.note)}</div>` : ''}
          </li>`).join('')}
      </ul>
    </div>

    ${data.reviewer_name && !decidable
      ? `<div class="mg-note">${escapeHtml(data.reviewer_name)} is reviewing this booking request. Only they can decide it.</div>`
      : ''}

    ${decidable ? `
      <div class="mg-section">
        <h3>Decision</h3>
        <div class="form-field">
          <label for="mgrRemarks">Remarks</label>
          <textarea id="mgrRemarks" rows="3"
            placeholder="Required when returning for correction — tell the merchant exactly what to fix."></textarea>
        </div>
        <div class="modal-actions">
          ${r.status === 'pending_approval'
            ? '<button type="button" class="btn btn-ghost" id="mgrStartBtn">Start review</button>' : ''}
          <button type="button" class="btn btn-ghost" id="mgrReturnBtn">Return for correction</button>
          <button type="button" class="btn btn-coral" id="mgrApproveBtn">Approve for ticketing</button>
        </div>
        <div class="msg" id="mgrDecisionMsg" aria-live="polite"></div>
      </div>` : ''}`;

  $mg('mgrReviewClose').addEventListener('click', mgrCloseReview);

  /* The body was just replaced, so whatever had focus is gone from the DOM and
     focus has fallen to <body>. Put it back on the first real control — the
     trap itself is still in place on the container, which does not change. */
  const first = $mg('mgrReviewBody').querySelector(
    'button:not([data-focus-trap-skip]), textarea, input, select, a[href]');
  if (first) first.focus();

  if (!decidable) return;

  $mg('mgrStartBtn')?.addEventListener('click', () => mgrDecide('start-review'));
  $mg('mgrApproveBtn').addEventListener('click', () => mgrDecide('approve'));
  $mg('mgrReturnBtn').addEventListener('click', () => mgrDecide('return'));
}

async function mgrDecide(action) {
  const msg = $mg('mgrDecisionMsg');
  const remarks = ($mg('mgrRemarks')?.value || '').trim();
  if (action === 'return' && !remarks) {
    msg.className = 'msg error';
    msg.textContent = 'Tell the merchant what needs correcting before returning it.';
    $mg('mgrRemarks').focus();
    return;
  }

  const buttons = ['mgrStartBtn', 'mgrApproveBtn', 'mgrReturnBtn'].map(id => $mg(id)).filter(Boolean);
  buttons.forEach(b => { b.disabled = true; });
  msg.className = 'msg';
  msg.textContent = 'Working…';

  const payload = action === 'return' ? { remarks } : (remarks ? { note: remarks } : {});
  try {
    const { data } = await axios.post(
      `${MGR_API}/api/manager/bookings/${mgrOpenId}/${action}`, payload,
      { headers: managerAuthHeaders() }
    );
    if (action === 'start-review') {
      mgrRenderReview(data);
      mgrLoadQueue();
      return;
    }
    mgrCloseReview();
    mgrLoadQueue();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = mgrErr(err, 'Could not complete that action.');
    buttons.forEach(b => { b.disabled = false; });
  }
}

$mg('mgrReviewOverlay').addEventListener('click', e => {
  if (e.target === $mg('mgrReviewOverlay')) mgrCloseReview();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $mg('mgrReviewOverlay').classList.contains('open')) mgrCloseReview();
});

/* ------------------------------------------------------------------ boot */

document.querySelectorAll('[data-mg-nav]').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); mgrGo(a.dataset.mgNav); });
});
window.addEventListener('hashchange', () => {
  const s = (location.hash || '').replace('#', '');
  if (s && MGR_TITLES[s] && !$mg(`mgr-${s}`)?.classList.contains('active')) mgrGo(s);
});

$mg('mobileMenuBtn')?.addEventListener('click', () => {
  document.querySelector('.sidebar')?.classList.toggle('open');
  $mg('sidebarBackdrop')?.classList.toggle('open');
});
$mg('sidebarBackdrop')?.addEventListener('click', () => {
  document.querySelector('.sidebar')?.classList.remove('open');
  $mg('sidebarBackdrop')?.classList.remove('open');
});

if (isManagerLoggedIn()) mgrShowApp(); else mgrShowAuth();
