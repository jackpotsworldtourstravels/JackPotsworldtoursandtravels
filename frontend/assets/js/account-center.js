'use strict';
/* ===========================================================================
   account-center.js - the customer Account Center, mountable on any B2C page.
   ===========================================================================
   WHY THIS IS ITS OWN FILE

   This used to live in the bottom half of app.js, which only the landing page
   loads. That is the whole reason the profile chip on every other B2C page was
   a LINK to `index.html?account=profile`: the Account Center was not present to
   open. Both shells said so in a comment - "building one would be a fifth copy
   of something index.html already has".

   The answer is not a fifth copy, it is one copy any page can load. So the
   implementation moved here unchanged and the pages that need it load this
   file. Leaving a booking to look at your profile - losing a half-filled
   traveller form with it - was never a design decision; it was a consequence of
   where the code happened to sit.

   HOW IT MOUNTS
   The modal markup used to be 132 lines at the bottom of index.html. It is the
   MARKUP constant below, injected into <body> on load *only when the page has
   none* - so index.html keeps using its own static copy and nothing about that
   page changes.

   WHAT IT NEEDS FROM THE HOST PAGE
   Six things, passed through configure() rather than reached for as globals,
   because two of them - the profile dropdown and the mobile nav - do not exist
   outside the landing page. Every DOM lookup for those is null-guarded here, so
   on a booking page that wiring simply does not attach.

   Also requires, and already present on every page that loads this: auth.js
   (getStoredAuth / clearStoredAuth / authHeaders), shared/formatters.js
   (escapeHtml / money / fmtDate / fmtTime), jp-icons.js, and axios.
   =========================================================================== */
const AccountCenter = (function () {

  /* ---- host-supplied dependencies ------------------------------------- */
  let API_BASE = '';
  let apiErrorText = (err, fallback) => fallback;
  let mobileNav = null;
  let openAuth = () => {};
  let renderAuthNav = () => {};
  /* The wishlist map is owned by app.js. Logging out has to clear it THERE
     rather than rebind a copy in here, which would leave the hearts on the
     landing page still lit. */
  let resetWishlist = () => {};

  function configure(o) {
    if (!o) return;
    if (o.API_BASE      !== undefined) API_BASE      = o.API_BASE;
    if (o.apiErrorText  !== undefined) apiErrorText  = o.apiErrorText;
    if (o.mobileNav     !== undefined) mobileNav     = o.mobileNav;
    if (o.openAuth      !== undefined) openAuth      = o.openAuth;
    if (o.renderAuthNav !== undefined) renderAuthNav = o.renderAuthNav;
    if (o.resetWishlist !== undefined) resetWishlist = o.resetWishlist;
  }

  /* ---- the modal markup, for pages that do not already carry it -------- */
  const MARKUP = String.raw`<div class="modal-overlay" id="accountModalOverlay">
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="acctHeaderName">
    <button class="modal-close" id="acctModalCloseBtn" type="button" aria-label="Close">&times;</button>
    <div class="acct-header">
      <span class="acct-header-avatar" id="acctHeaderAvatar">U</span>
      <div class="acct-header-info">
        <div class="acct-header-name" id="acctHeaderName">Traveler</div>
        <div class="acct-header-email" id="acctHeaderEmail">—</div>
      </div>
    </div>
    <div class="acct-body">
      <nav class="acct-tabs" id="acctTabs">
        <div class="acct-tab" data-tab="profile"><svg class="dd-icon" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>My Profile</div>
        <div class="acct-tab" data-tab="bookings"><svg class="dd-icon" viewBox="0 0 24 24"><path d="M4 3h16v18l-3-2-2 2-3-2-3 2-2-2-3 2Z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/></svg>My Bookings</div>
        <div class="acct-tab" data-tab="wishlist"><svg class="dd-icon" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>Wishlist</div>
        <div class="acct-tab" data-tab="payments"><svg class="dd-icon" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2.5"/><line x1="2" y1="10" x2="22" y2="10"/></svg>Payment History</div>
        <div class="acct-tab" data-tab="notifications"><svg class="dd-icon" viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>Notifications</div>
        <div class="acct-tab" data-tab="support"><svg class="dd-icon" viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><circle cx="12" cy="12" r="9"/></svg>Support Tickets</div>
        <div class="acct-tab" data-tab="reviews"><svg class="dd-icon" viewBox="0 0 24 24"><path d="m12 2 3.1 6.6 7.2.8-5.4 4.9 1.5 7.1L12 17.8 5.6 21.4l1.5-7.1-5.4-4.9 7.2-.8Z"/></svg>Reviews</div>
        <div class="acct-tab" data-tab="settings"><svg class="dd-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82"/></svg>Settings</div>
      </nav>
      <div class="acct-panels">
        <div class="acct-panel" id="acctPanel-profile">
          <h2>My Profile</h2>
          <form id="acctProfileForm">
            <div class="acct-form-grid">
              <div class="acct-form-field"><label>Full Name</label><input id="acctProfileName" type="text" required></div>
              <div class="acct-form-field"><label>Email</label><input id="acctProfileEmail" type="email" disabled></div>
              <div class="acct-form-field"><label>Mobile</label><input id="acctProfileMobile" type="tel"></div>
              <div class="acct-form-field">
                <label>Gender</label>
                <select id="acctProfileGender">
                  <option value="">Select</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="other">Other</option>
                  <option value="prefer_not_to_say">Prefer not to say</option>
                </select>
              </div>
              <div class="acct-form-field"><label>Date of Birth</label><input id="acctProfileDob" type="date"></div>
              <div class="acct-form-field"><label>Country</label><input id="acctProfileCountry" type="text"></div>
              <div class="acct-form-field"><label>State</label><input id="acctProfileState" type="text"></div>
              <div class="acct-form-field"><label>City</label><input id="acctProfileCity" type="text"></div>
            </div>
            <div class="acct-form-field" style="max-width:none;"><label>Address</label><input id="acctProfileAddress" type="text"></div>
            <button type="submit" class="btn btn-coral">Save Changes</button>
            <div class="acct-msg" id="acctProfileMsg"></div>
          </form>
        </div>

        <div class="acct-panel" id="acctPanel-bookings">
          <h2>My Bookings</h2>
          <div id="acctBookingsList"><div class="acct-empty">Loading…</div></div>
        </div>

        <div class="acct-panel" id="acctPanel-wishlist">
          <h2>My Wishlist</h2>
          <div id="acctWishlistList"><div class="acct-empty">Loading…</div></div>
        </div>

        <div class="acct-panel" id="acctPanel-payments">
          <h2>Payment History</h2>
          <div class="acct-table-wrap"><table class="acct-table" id="acctPaymentsTable"><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Transaction Ref</th></tr></thead><tbody></tbody></table></div>
        </div>

        <div class="acct-panel" id="acctPanel-notifications">
          <div class="acct-section-head">
            <h2>Notifications</h2>
            <button type="button" class="btn btn-navy btn-sm" id="acctMarkAllReadBtn">Mark All as Read</button>
          </div>
          <div id="acctNotificationsList"><div class="acct-empty">Loading…</div></div>
          <div class="acct-notif-clearbar" id="acctNotifClearBar" style="display:none;">
            <button type="button" class="btn btn-danger btn-sm" id="acctClearAllBtn">Clear All</button>
          </div>
        </div>

        <div class="acct-panel" id="acctPanel-support">
          <h2>Raise a support ticket</h2>
          <form id="acctTicketForm" style="margin-bottom:26px;">
            <div class="acct-form-field"><label>Subject</label><input id="acctTicketSubject" type="text" required maxlength="200"></div>
            <div class="acct-form-field" style="max-width:none;"><label>Description</label><input id="acctTicketDescription" type="text" required maxlength="4000"></div>
            <div class="acct-form-field">
              <label>Priority</label>
              <select id="acctTicketPriority">
                <option value="low">Low</option>
                <option value="normal" selected>Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <button type="submit" class="btn btn-coral">Submit Ticket</button>
            <div class="acct-msg" id="acctTicketMsg"></div>
          </form>
          <h2>My support tickets</h2>
          <div id="acctTicketsList"><div class="acct-empty">Loading…</div></div>
        </div>

        <div class="acct-panel" id="acctPanel-reviews">
          <h2>My Reviews</h2>
          <div id="acctReviewsList"><div class="acct-empty">Loading…</div></div>
        </div>

        <div class="acct-panel" id="acctPanel-settings">
          <h2>Change password</h2>
          <form id="acctPasswordForm" style="margin-bottom:10px;">
            <div class="acct-form-field"><label>Current Password</label><input id="acctCurrentPassword" type="password" autocomplete="current-password" required></div>
            <div class="acct-form-field"><label>New Password</label><input id="acctNewPassword" type="password" autocomplete="new-password" required minlength="8"></div>
            <!-- The customer API takes confirm_password as a real field. Sending
                 a copy of New Password would satisfy it while letting a typo
                 through unnoticed, so the traveller types it twice. -->
            <div class="acct-form-field"><label>Confirm New Password</label><input id="acctConfirmPassword" type="password" autocomplete="new-password" required minlength="8"></div>
            <button type="submit" class="btn btn-navy">Change Password</button>
            <div class="acct-msg" id="acctPasswordMsg"></div>
          </form>
          <h2 style="margin-top:26px;">Notification preferences</h2>
          <p style="color:var(--muted); font-size:13.5px; line-height:1.6; max-width:480px;">
            You currently receive in-app notifications for bookings, payments, and support updates —
            there's nothing to configure yet since email/SMS delivery isn't wired up. This section is
            reserved for when those channels go live.
          </p>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="acctConfirmOverlay">
  <div class="modal-card">
    <button class="modal-close" id="acctConfirmCloseBtn" type="button" aria-label="Close">&times;</button>
    <div id="acctConfirmBody"></div>
  </div>
</div>`;

  function ensureMarkup() {
    if (document.getElementById('accountModalOverlay')) return;   // index.html
    const host = document.createElement('div');
    host.innerHTML = MARKUP;
    while (host.firstChild) document.body.appendChild(host.firstChild);
  }

  /* LOAD THIS FILE FROM INSIDE <body>, never <head>. Everything below binds to
     elements that live in MARKUP, so the injection has to complete before those
     lines run — which means it cannot be deferred to DOMContentLoaded. The
     throw is deliberate: a silent no-op here would surface much later as a
     scattering of null-reference errors from the handlers instead. */
  if (!document.body) {
    throw new Error('account-center.js must be loaded from inside <body>, after it opens.');
  }
  ensureMarkup();

  /* =====================================================================
     Everything below is the original app.js implementation, unchanged apart
     from the null-guards described above.
     ===================================================================== */

/* ================================================================
   ACCOUNT CENTER — replaces the old separate dashboard.html.
   Every section below is a direct port of that page's logic, now
   living inside one modal on the homepage instead of its own page.
   ================================================================ */
/* authHeaders() (equivalent to getStoredAuth().access-based version that
   used to live here) now lives in assets/js/auth.js; money/fmtDate/fmtTime
   now live in shared/formatters.js. */

/* ---------- Modal open/close + tab switching ---------- */
const acctModalOverlay = document.getElementById('accountModalOverlay');
const acctLoadedTabs = new Set();
let acctCurrentUser = null;

function openAccountCenter(tab) {
  const { access } = getStoredAuth();
  if (!access) { openAuth('login'); return; }
  acctModalOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  goToAcctTab(tab || 'profile');
  if (!acctCurrentUser) loadAcctHeaderProfile();
}
function closeAccountCenter() {
  acctModalOverlay.classList.remove('open');
  document.body.style.overflow = '';
}
document.getElementById('acctModalCloseBtn').addEventListener('click', closeAccountCenter);
acctModalOverlay.addEventListener('click', e => { if (e.target === acctModalOverlay) closeAccountCenter(); });

function goToAcctTab(name) {
  document.querySelectorAll('.acct-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.acct-panel').forEach(p => p.classList.toggle('active', p.id === `acctPanel-${name}`));
  if (!acctLoadedTabs.has(name)) {
    acctLoadedTabs.add(name);
    loadAcctTab(name);
  }
}
document.querySelectorAll('.acct-tab').forEach(tab => {
  tab.addEventListener('click', () => goToAcctTab(tab.dataset.tab));
});
function loadAcctTab(name) {
  if (name === 'profile') return loadAcctProfile();
  if (name === 'bookings') return loadAcctBookings();
  if (name === 'wishlist') return loadAcctWishlist();
  if (name === 'payments') return loadAcctPayments();
  if (name === 'notifications') return loadAcctNotifications();
  if (name === 'support') return loadAcctSupportTickets();
  if (name === 'reviews') return loadAcctReviews();
}

/* Every dropdown item (desktop + mobile) and profile-chip toggle */
document.querySelectorAll('[data-acct-tab]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('profileDropdown')?.classList.remove('open');
    document.getElementById('profileChipBtn')?.classList.remove('open');
    mobileNav?.classList.remove('open');
    openAccountCenter(link.dataset.acctTab);
  });
});
const profileChipBtn = document.getElementById('profileChipBtn');
const profileDropdown = document.getElementById('profileDropdown');
/* Absent on the booking pages, which carry their own header. */
if (profileChipBtn && profileDropdown) {
  profileChipBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = profileDropdown.classList.toggle('open');
    profileChipBtn.classList.toggle('open', open);
  });
  document.addEventListener('click', () => {
    profileDropdown.classList.remove('open');
    profileChipBtn.classList.remove('open');
  });
}

function doAccountLogout() {
  const { access } = getStoredAuth();
  axios.post(`${API_BASE}/api/customer/auth/logout`, {}, { headers: { Authorization: `Bearer ${access}` } }).catch(() => {});
  clearStoredAuth();
  acctCurrentUser = null;
  acctLoadedTabs.clear();
  resetWishlist();
  closeAccountCenter();
  renderAuthNav();
}
document.getElementById('profileLogoutBtn')?.addEventListener('click', doAccountLogout);
document.getElementById('mobileLogoutLink')?.addEventListener('click', e => { e.preventDefault(); doAccountLogout(); });

/* ---------- Profile (header + editable form) ---------- */
/* The customer record names two of these differently from the old platform
   `users` row this form was written against: `dob` is `date_of_birth`, and the
   single `address` line is `address_line1`. Reading the old names returned
   undefined and quietly blanked both fields on every load. */
async function loadAcctHeaderProfile() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/customer/auth/me`, { headers: authHeaders() });
    acctCurrentUser = data;
    const initials = data.full_name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'U';
    document.getElementById('acctHeaderAvatar').textContent = initials;
    document.getElementById('acctHeaderName').textContent = data.full_name;
    document.getElementById('acctHeaderEmail').textContent = data.email;
  } catch (err) { /* header just won't populate this cycle */ }
}
async function loadAcctProfile() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/customer/auth/me`, { headers: authHeaders() });
    acctCurrentUser = data;
    document.getElementById('acctProfileName').value = data.full_name;
    document.getElementById('acctProfileEmail').value = data.email;
    document.getElementById('acctProfileMobile').value = data.mobile || '';
    document.getElementById('acctProfileGender').value = data.gender || '';
    document.getElementById('acctProfileDob').value = data.date_of_birth || '';
    document.getElementById('acctProfileCountry').value = data.country || '';
    document.getElementById('acctProfileState').value = data.state || '';
    document.getElementById('acctProfileCity').value = data.city || '';
    document.getElementById('acctProfileAddress').value = data.address_line1 || '';
  } catch (err) { /* fields stay blank */ }
}
document.getElementById('acctProfileForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('acctProfileMsg');
  try {
    /* PATCH, not PUT: every field on CustomerProfileUpdateRequest is optional
       and only what is sent gets written, so the columns this form has no
       input for (address_line2, postal_code, profile_photo) are left alone
       rather than being nulled on every save.

       The email is deliberately absent — it is the login identifier, and no
       endpoint changes it. The field is `disabled` in the markup. */
    const { data } = await axios.patch(`${API_BASE}/api/customer/profile`, {
      full_name: document.getElementById('acctProfileName').value,
      mobile: document.getElementById('acctProfileMobile').value || null,
      gender: document.getElementById('acctProfileGender').value || null,
      date_of_birth: document.getElementById('acctProfileDob').value || null,
      country: document.getElementById('acctProfileCountry').value || null,
      state: document.getElementById('acctProfileState').value || null,
      city: document.getElementById('acctProfileCity').value || null,
      address_line1: document.getElementById('acctProfileAddress').value || null,
    }, { headers: authHeaders() });
    setStoredAuth(getStoredAuth().access, getStoredAuth().refresh, data.full_name, 'customer', data.id);
    renderAuthNav();
    loadAcctHeaderProfile();
    msg.textContent = 'Profile updated.';
    msg.className = 'acct-msg success';
  } catch (err) {
    msg.textContent = apiErrorText(err, 'Failed to update profile.');
    msg.className = 'acct-msg error';
  }
});
document.getElementById('acctPasswordForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('acctPasswordMsg');
  const next = document.getElementById('acctNewPassword').value;
  const confirm = document.getElementById('acctConfirmPassword').value;
  if (next !== confirm) {
    msg.textContent = 'Both new passwords must match.';
    msg.className = 'acct-msg error';
    document.getElementById('acctConfirmPassword').focus();
    return;
  }
  try {
    await axios.post(`${API_BASE}/api/customer/auth/change-password`, {
      current_password: document.getElementById('acctCurrentPassword').value,
      new_password: next,
      confirm_password: confirm,
    }, { headers: authHeaders() });
    msg.textContent = 'Password changed successfully.';
    msg.className = 'acct-msg success';
    e.target.reset();
  } catch (err) {
    msg.textContent = apiErrorText(err, 'Failed to change password.');
    msg.className = 'acct-msg error';
  }
});

/* ---------- Bookings (list, cancel, confirmation/timeline) ----------
   Reads the real `GET /api/customer/bookings` (migration 0053) — every field
   below (booking_ref, product_type, airline, origin_city, total_amount,
   passengers[], payments[]) is what that response actually carries. Only
   flight bookings exist server-side today (hotels/cruises/packages are still
   the client-side demo in booking-store.js — see BookingApi.isLive); this
   renders whatever `product_type`s the endpoint returns, so it needs no
   further change once the others are real too. */
const TYPE_ICONS = {
  flight: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-1 .1-1.3.5l-.7.7 4.2 3-1.5 1.5-2.5-.5-.7.7 2 2 2 2 .7-.7-.5-2.5 1.5-1.5 3 4.2.7-.7c.4-.3.6-.8.5-1.3Z"/>',
  hotel: '<path d="M3 21V7a2 2 0 0 1 2-2h6v16"/><path d="M11 9h8a2 2 0 0 1 2 2v10"/><path d="M3 21h18"/>',
  cruise: '<path d="M2 21c1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0"/><path d="M4 18l1-9h14l1 9"/><path d="M10 9V4h4v5"/>',
  package: '<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
};
let allBookingsCache = [];

/* My Trips: everything the customer has booked, flight and hotel together.
   Two tables, two endpoints (see migration 0055's isolation reasoning), one
   list here — a hotel row is aliased onto the field names the flight-shaped
   rendering below already reads (`travel_date`, `passengers`) so bookingTitle/
   bookingRoute/showAcctConfirmation/the row and card renderers below need a
   handful of `product_type === 'hotel'` branches, not a second copy of each. */
async function fetchAllCustomerBookings() {
  const [flightsRes, hotelsRes, packagesRes] = await Promise.allSettled([
    axios.get(`${API_BASE}/api/customer/bookings`, { headers: authHeaders() }),
    axios.get(`${API_BASE}/api/customer/hotel-bookings`, { headers: authHeaders() }),
    axios.get(`${API_BASE}/api/customer/package-bookings`, { headers: authHeaders() }),
  ]);
  if (flightsRes.status === 'rejected' && hotelsRes.status === 'rejected' && packagesRes.status === 'rejected') {
    throw flightsRes.reason;
  }
  const flights = flightsRes.status === 'fulfilled' ? flightsRes.value.data : [];
  const hotels = hotelsRes.status === 'fulfilled' ? hotelsRes.value.data : [];
  const packages = packagesRes.status === 'fulfilled' ? packagesRes.value.data : [];
  const merged = [
    ...flights,
    ...hotels.map(h => ({ ...h, travel_date: h.check_in_date, passengers: h.guests || [] })),
    ...packages.map(p => ({ ...p, travel_date: p.departure_date, passengers: p.travellers || [] })),
  ];
  merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return merged;
}

function bookingTitle(b) {
  if (b.product_type === 'flight') return `${b.airline || 'Flight'} ${b.flight_number || ''}`.trim();
  if (b.product_type === 'hotel') return b.hotel_name || `Hotel — ${b.booking_ref}`;
  if (b.product_type === 'package') return b.package_name || `Package — ${b.booking_ref}`;
  return `${b.product_type} — ${b.booking_ref}`;
}
function bookingRoute(b) {
  if (b.product_type === 'hotel') return b.hotel_location || '';
  if (b.product_type === 'package') return b.package_days ? `${b.package_days} day${b.package_days === 1 ? '' : 's'}` : '';
  if (!b.origin_city && !b.destination_city) return '';
  return `${b.origin_city || b.origin_code || ''} → ${b.destination_city || b.destination_code || ''}`;
}
function renderTimeline(booking) {
  if (booking.status === 'cancelled') {
    return `<div class="timeline">
      <div class="tl-step done"><span class="tl-dot"></span><span class="tl-label">Booked</span></div>
      <div class="tl-line done"></div>
      <div class="tl-step cancelled-step"><span class="tl-dot"></span><span class="tl-label">Cancelled</span></div>
    </div>`;
  }
  const isPastTravel = booking.travel_date && new Date(booking.travel_date) < new Date();
  const confirmedDone = booking.status === 'confirmed' || booking.status === 'completed';
  const completedDone = booking.status === 'completed' || (confirmedDone && isPastTravel);
  const steps = [{ label: 'Booked', done: true }, { label: 'Confirmed', done: confirmedDone }, { label: 'Completed', done: completedDone }];
  return `<div class="timeline">${steps.map((s, i) => `
    ${i > 0 ? `<div class="tl-line ${steps[i - 1].done ? 'done' : ''}"></div>` : ''}
    <div class="tl-step ${s.done ? 'done' : ''}"><span class="tl-dot"></span><span class="tl-label">${s.label}</span></div>
  `).join('')}</div>`;
}
function closeAcctTicket() { document.getElementById('acctConfirmOverlay').classList.remove('open'); }
document.getElementById('acctConfirmCloseBtn').addEventListener('click', closeAcctTicket);

async function showAcctConfirmation(bookingRef) {
  const booking = allBookingsCache.find(b => b.booking_ref === bookingRef);
  if (!booking) return;
  const payment = (booking.payments || [])[booking.payments.length - 1];
  const reference = booking.booking_ref;
  const isFlight = booking.product_type === 'flight';
  const isHotel = booking.product_type === 'hotel';
  const isPackage = booking.product_type === 'package';
  const contact = (booking.passengers || []).find(p => p.is_contact) || (booking.passengers || [])[0];

  const itemTitle = isFlight
    ? `${booking.airline || ''} · ${booking.cabin_class || ''}`
    : bookingTitle(booking);
  const sourceDestRow = isFlight ? `
        <div class="confirm-row"><span>From</span><span>${escapeHtml(booking.origin_city || booking.origin_code || '—')}</span></div>
        <div class="confirm-row"><span>To</span><span>${escapeHtml(booking.destination_city || booking.destination_code || '—')}</span></div>`
    : isHotel ? `
        <div class="confirm-row"><span>Property</span><span>${escapeHtml(booking.hotel_name || '—')}</span></div>
        <div class="confirm-row"><span>Location</span><span>${escapeHtml(booking.hotel_location || '—')}</span></div>` : '';
  const timeRow = isFlight
    ? `<div class="confirm-row"><span>Time</span><span>${escapeHtml(booking.departure_time || '—')} – ${escapeHtml(booking.arrival_time || '—')}</span></div>` : '';
  const seatRow = isFlight
    ? `<div class="confirm-row"><span>Seat Number</span><span>Assigned at check-in</span></div>` : '';
  const stayRow = isHotel ? `
        <div class="confirm-row"><span>Room</span><span>${escapeHtml(booking.room_name || '—')}</span></div>
        <div class="confirm-row"><span>Check-in</span><span>${fmtDate(booking.check_in_date)}</span></div>
        <div class="confirm-row"><span>Check-out</span><span>${fmtDate(booking.check_out_date)}</span></div>
        <div class="confirm-row"><span>Nights</span><span>${escapeHtml(booking.nights ?? '—')}</span></div>` : '';
  const tripRow = isPackage ? `
        <div class="confirm-row"><span>Destination</span><span>${escapeHtml(booking.package_name || '—')}</span></div>
        <div class="confirm-row"><span>Duration</span><span>${escapeHtml(booking.package_days ? booking.package_days + ' days' : '—')}</span></div>
        <div class="confirm-row"><span>Departure date</span><span>${fmtDate(booking.departure_date)}</span></div>` : '';

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(reference)}`;

  document.getElementById('acctConfirmBody').innerHTML = `
    <div class="ticket-head">
      <img src="assets/images/jackpots-logo-full.png" alt="JackPots World Tours & Travels">
      <div>
        <div class="th-name">${escapeHtml(itemTitle)}</div>
      </div>
    </div>
    ${renderTimeline(booking)}
    <div class="confirm-row"><span>Booking Reference</span><span>${escapeHtml(reference)}</span></div>
    ${booking.pnr ? `<div class="confirm-row"><span>PNR</span><span>${escapeHtml(booking.pnr)}</span></div>` : ''}
    <div class="confirm-row"><span>${isHotel ? 'Guest Name' : isPackage ? 'Traveller Name' : 'Passenger Name'}</span><span>${escapeHtml(contact ? `${contact.first_name} ${contact.last_name}` : (acctCurrentUser?.full_name || '—'))}</span></div>
    <div class="confirm-row"><span>Type</span><span style="text-transform:capitalize">${booking.product_type}</span></div>
    ${sourceDestRow}
    ${!isHotel && !isPackage ? `<div class="confirm-row"><span>Date</span><span>${fmtDate(booking.travel_date)}</span></div>` : ''}
    ${timeRow}
    ${seatRow}
    ${stayRow}
    ${tripRow}
    <div class="confirm-row"><span>${isHotel ? 'Guests' : isPackage ? 'Travellers' : 'Passengers'}</span><span>${(booking.passengers || []).length || 1}</span></div>
    <div class="confirm-row"><span>Booking Status</span><span style="text-transform:capitalize">${booking.status}</span></div>
    ${payment ? `<div class="confirm-row"><span>Payment Status</span><span style="text-transform:capitalize">${payment.status}</span></div>` : ''}
    <div class="confirm-row"><span>Total Amount</span><span>${money(booking.total_amount)}</span></div>
    <div class="confirm-row"><span>Booked On</span><span>${fmtDate(booking.created_at)}</span></div>
    ${payment ? `
      <div class="confirm-row"><span>Payment Method</span><span style="text-transform:capitalize">${payment.method}</span></div>
      ${payment.provider_reference ? `<div class="confirm-row"><span>Transaction Ref</span><span>${escapeHtml(payment.provider_reference)}</span></div>` : ''}
    ` : ''}
    <div class="ticket-qr">
      <img src="${qrUrl}" alt="Booking QR code" width="140" height="140">
      <div class="tq-ref">${reference}</div>
    </div>
    <div class="ticket-support">Need help with this booking? Call +91 12345 67890 or email info@jackpotsworldtours.com</div>
    <div class="ticket-actions">
      <button type="button" class="btn btn-coral btn-sm" id="ticketDownloadBtn">Download PDF</button>
      <button type="button" class="btn btn-navy btn-sm" id="ticketPrintBtn">Print Ticket</button>
      <button type="button" class="btn btn-navy btn-sm" id="ticketShareBtn">Share Ticket</button>
      <button type="button" class="btn btn-ghost btn-sm" id="ticketCloseBtn">Close</button>
    </div>
  `;
  document.getElementById('acctConfirmOverlay').classList.add('open');

  document.getElementById('ticketDownloadBtn').addEventListener('click', () => window.print());
  document.getElementById('ticketPrintBtn').addEventListener('click', () => window.print());
  document.getElementById('ticketCloseBtn').addEventListener('click', closeAcctTicket);
  document.getElementById('ticketShareBtn').addEventListener('click', async () => {
    const shareText = `My ${booking.product_type} booking with JackPots World Tours & Travels — Ref ${reference}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'JackPots World Tours & Travels — Booking Ticket', text: shareText }); }
      catch (err) { /* user cancelled the native share sheet */ }
      return;
    }
    const withTimeout = (promise, ms) => Promise.race([
      promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
    try {
      await withTimeout(navigator.clipboard.writeText(shareText), 2000);
      alert('Ticket details copied to clipboard.');
    } catch (err) {
      prompt('Copy your ticket details:', shareText);
    }
  });
}

function bookingRowHtml(b) {
  const route = bookingRoute(b);
  return `
    <div class="acct-row">
      <div class="ar-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;">${TYPE_ICONS[b.product_type] || TYPE_ICONS.package}</svg></div>
      <div class="ar-main">
        <div class="ar-title">${escapeHtml(bookingTitle(b))}</div>
        <div class="ar-sub">${route ? escapeHtml(route) + ' · ' : ''}Booked ${fmtDate(b.created_at)} ${b.travel_date ? '· Travel ' + fmtDate(b.travel_date) : ''}</div>
      </div>
      <span class="badge ${b.status}">${escapeHtml(b.status)}</span>
      <div class="ar-amount">${money(b.total_amount)}</div>
      <button type="button" class="btn btn-coral btn-sm" data-confirm-id="${b.booking_ref}">View Ticket</button>
      ${b.status !== 'cancelled' ? `<button type="button" class="btn btn-danger btn-sm" data-cancel-id="${b.booking_ref}">Cancel</button>` : ''}
    </div>`;
}
async function cancelBookingById(bookingRef, onSuccess) {
  if (!confirm('Cancel this booking?')) return;
  /* JPH###### is a hotel booking, JPP###### a package booking (each its own
     table/sequence — see migrations 0055/0056); everything else is flight. */
  const path = /^JPH/.test(bookingRef) ? 'hotel-bookings'
    : /^JPP/.test(bookingRef) ? 'package-bookings' : 'bookings';
  try {
    await axios.post(`${API_BASE}/api/customer/${path}/${bookingRef}/cancel`, {}, { headers: authHeaders() });
    if (typeof onSuccess === 'function') await onSuccess();
  } catch (err) { alert(apiErrorText(err, 'Failed to cancel booking.')); }
}
function wireBookingRowActions(container) {
  container.querySelectorAll('[data-confirm-id]').forEach(btn => btn.addEventListener('click', () => showAcctConfirmation(btn.dataset.confirmId)));
  container.querySelectorAll('[data-cancel-id]').forEach(btn => {
    btn.addEventListener('click', () => cancelBookingById(btn.dataset.cancelId, async () => {
      await loadAcctBookings();
      loadUpcomingJourney();
    }));
  });
}
async function loadAcctBookings() {
  const container = document.getElementById('acctBookingsList');
  try {
    const data = await fetchAllCustomerBookings();
    allBookingsCache = data;
    if (!data.length) {
      container.innerHTML = '<div class="acct-empty">No bookings yet — go find your next trip!</div>';
      return;
    }
    container.innerHTML = data.map(b => bookingRowHtml(b)).join('');
    wireBookingRowActions(container);
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load bookings.</div>';
  }
}

/* ---------- Homepage: Your Upcoming Journey ---------- */
let upcomingCountdownTimer = null;

function upcomingCardHtml(entry) {
  const { booking, when } = entry;
  const isFlight = booking.product_type === 'flight';
  const isHotel = booking.product_type === 'hotel';
  const isPackage = booking.product_type === 'package';
  const fromTo = isFlight
    ? `<span>${escapeHtml(booking.origin_city || booking.origin_code || '')} &rarr; ${escapeHtml(booking.destination_city || booking.destination_code || '')}</span>`
    : isHotel ? `<span>${escapeHtml(booking.hotel_location || '')}</span>`
    : isPackage ? `<span>${escapeHtml(booking.package_days ? booking.package_days + ' days' : '')}</span>` : '';
  const timeSpan = isFlight ? `<span>Time: <b>${escapeHtml(booking.departure_time || '—')}</b></span>` : '';
  const seatSpan = isFlight ? `<span>Seat: <b>Assigned at check-in</b></span>` : '';
  const dateLabel = isHotel ? 'Check-in' : isPackage ? 'Departure' : 'Date';
  const stayMeta = isHotel ? `<span>Check-out: <b>${fmtDate(booking.check_out_date)}</b></span><span>Room: <b>${escapeHtml(booking.room_name || '—')}</b></span>` : '';
  return `
    <div class="upcoming-card" data-upcoming-id="${booking.booking_ref}" data-upcoming-when="${when.toISOString()}">
      <div class="upcoming-main">
        <div class="upcoming-title">${escapeHtml(bookingTitle(booking))}</div>
        <div class="upcoming-sub">${escapeHtml(booking.booking_ref)}${booking.pnr ? ' · PNR ' + escapeHtml(booking.pnr) : ''} · <span class="badge ${booking.status}">${escapeHtml(booking.status)}</span></div>
        <div class="upcoming-meta">
          ${fromTo}
          <span>${dateLabel}: <b>${fmtDate(booking.travel_date)}</b></span>
          ${timeSpan}
          ${stayMeta}
          <span>${isHotel ? 'Guests' : isPackage ? 'Travellers' : 'Passengers'}: <b>${(booking.passengers || []).length || 1}</b></span>
          ${seatSpan}
        </div>
      </div>
      <div class="upcoming-countdown" data-countdown></div>
      <div class="upcoming-actions">
        <button type="button" class="btn btn-coral btn-sm" data-upcoming-view="${booking.booking_ref}">View Ticket</button>
        <button type="button" class="btn btn-navy btn-sm" data-upcoming-download="${booking.booking_ref}">Download Ticket</button>
        <button type="button" class="btn btn-ghost btn-sm" data-upcoming-account>View Booking</button>
        <button type="button" class="btn btn-danger btn-sm" data-upcoming-cancel="${booking.booking_ref}">Cancel Booking</button>
      </div>
    </div>`;
}

function tickUpcomingCountdowns() {
  const now = Date.now();
  const cards = document.querySelectorAll('#upcomingJourneyList .upcoming-card');
  cards.forEach(card => {
    const when = new Date(card.dataset.upcomingWhen).getTime();
    const diff = when - now;
    if (diff <= 0) {
      card.remove();
      return;
    }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const box = card.querySelector('[data-countdown]');
    box.innerHTML = `
      <div class="cd-box"><div class="cd-num">${days}</div><div class="cd-label">Days</div></div>
      <div class="cd-box"><div class="cd-num">${String(hours).padStart(2, '0')}</div><div class="cd-label">Hours</div></div>
      <div class="cd-box"><div class="cd-num">${String(minutes).padStart(2, '0')}</div><div class="cd-label">Minutes</div></div>`;
  });
  if (!document.querySelectorAll('#upcomingJourneyList .upcoming-card').length) {
    document.getElementById('upcomingJourneySection')?.classList.remove('open');
    clearInterval(upcomingCountdownTimer);
  }
}

function wireUpcomingJourneyActions() {
  document.querySelectorAll('[data-upcoming-view]').forEach(btn => {
    btn.addEventListener('click', () => showAcctConfirmation(btn.dataset.upcomingView));
  });
  document.querySelectorAll('[data-upcoming-download]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await showAcctConfirmation(btn.dataset.upcomingDownload);
      window.print();
    });
  });
  document.querySelectorAll('[data-upcoming-account]').forEach(btn => {
    btn.addEventListener('click', () => openAccountCenter('bookings'));
  });
  document.querySelectorAll('[data-upcoming-cancel]').forEach(btn => {
    btn.addEventListener('click', () => cancelBookingById(btn.dataset.upcomingCancel, loadUpcomingJourney));
  });
}

async function loadUpcomingJourney() {
  const section = document.getElementById('upcomingJourneySection');
  const list = document.getElementById('upcomingJourneyList');
  const { access } = getStoredAuth();
  if (!access) { section.classList.remove('open'); clearInterval(upcomingCountdownTimer); return; }
  try {
    const data = await fetchAllCustomerBookings();
    allBookingsCache = data;
    const now = new Date();
    const candidates = data.filter(b => b.status !== 'cancelled' && b.status !== 'completed' && b.travel_date);
    const resolved = candidates.map(b => {
      let when = new Date(`${b.travel_date}T00:00:00`);
      if (b.product_type === 'flight' && b.departure_time) {
        const clock = new Date(b.departure_time);
        if (!isNaN(clock)) when.setHours(clock.getHours(), clock.getMinutes(), clock.getSeconds(), 0);
      }
      return { booking: b, when };
    });
    const upcoming = resolved.filter(r => r.when.getTime() > now.getTime()).sort((a, b) => a.when - b.when);
    clearInterval(upcomingCountdownTimer);
    if (!upcoming.length) {
      list.innerHTML = '';
      section.classList.remove('open');
      return;
    }
    list.innerHTML = upcoming.map(upcomingCardHtml).join('');
    wireUpcomingJourneyActions();
    tickUpcomingCountdowns();
    upcomingCountdownTimer = setInterval(tickUpcomingCountdowns, 1000);
    section.classList.add('open');
  } catch (err) {
    section.classList.remove('open');
  }
}

/* ---------- Payment History ---------- */
async function loadAcctPayments() {
  const tbody = document.querySelector('#acctPaymentsTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/customer/payments/history`, { headers: authHeaders() });
    tbody.innerHTML = data.map(p => `
      <tr><td>${fmtDate(p.created_at)}</td><td>${money(p.amount)}</td><td style="text-transform:capitalize">${escapeHtml(p.method)}</td><td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td><td>${escapeHtml(p.transaction_ref || p.booking_ref)}</td></tr>
    `).join('') || `<tr><td colspan="5" class="acct-empty">No payments yet.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="acct-empty">Failed to load payment history.</td></tr>`;
  }
}

/* ---------- Wishlist ---------- */
const ACCT_WISHLIST_ENDPOINTS = { flight: 'flights', hotel: 'hotels', cruise: 'cruises', package: 'packages' };
async function fetchWishlistWithCatalog() {
  const { data } = await axios.get(`${API_BASE}/api/customer/wishlist`, { headers: authHeaders() });
  const catalogs = {};
  /* No REST catalogue exists for these (they're still travel-data.js's static
     sample arrays, browsed client-side, not served over HTTP) — so a saved
     item can never be enriched with a name/price yet. Caught per type rather
     than left to fail the outer Promise.all, so one 404 does not turn a
     working wishlist into "Failed to load wishlist"; wishlistLabel() already
     has a "no longer available" fallback for exactly this case. */
  await Promise.all([...new Set(data.map(w => w.item_type))].map(async t => {
    try {
      const { data: items } = await axios.get(`${API_BASE}/api/${ACCT_WISHLIST_ENDPOINTS[t]}`);
      catalogs[t] = new Map(items.map(i => [i.id, i]));
    } catch (err) {
      catalogs[t] = new Map();
    }
  }));
  return { data, catalogs };
}
function wishlistLabel(type, item) {
  if (!item) return `${type} #? (no longer available)`;
  if (type === 'flight') return `${item.airline} ${item.from_airport}→${item.to_airport}`;
  if (type === 'hotel') return item.name;
  if (type === 'cruise') return item.name;
  return item.title;
}
function wishlistPrice(type, item) { return item ? money(type === 'hotel' ? item.price_per_night : item.price) : '—'; }
async function loadAcctWishlist() {
  const container = document.getElementById('acctWishlistList');
  try {
    const { data, catalogs } = await fetchWishlistWithCatalog();
    if (!data.length) {
      container.innerHTML = '<div class="acct-empty">Your wishlist is empty.</div>';
      return;
    }
    container.innerHTML = data.map(w => {
      const item = catalogs[w.item_type]?.get(w.item_id);
      return `
        <div class="acct-row">
          <div class="ar-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;">${TYPE_ICONS[w.item_type] || TYPE_ICONS.package}</svg></div>
          <div class="ar-main">
            <div class="ar-title" style="text-transform:none;">${escapeHtml(wishlistLabel(w.item_type, item))}</div>
            <div class="ar-sub" style="text-transform:capitalize;">${w.item_type} · ${wishlistPrice(w.item_type, item)} · Saved ${fmtDate(w.created_at)}</div>
          </div>
          <button type="button" class="btn btn-danger btn-sm" data-remove-wishlist="${w.id}">Remove</button>
        </div>`;
    }).join('');
    container.querySelectorAll('[data-remove-wishlist]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await axios.delete(`${API_BASE}/api/customer/wishlist/${btn.dataset.removeWishlist}`, { headers: authHeaders() });
          loadAcctWishlist();
        } catch (err) { alert('Failed to remove item.'); }
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load wishlist.</div>';
  }
}

/* ---------- Notifications ---------- */
async function loadAcctNotifications() {
  const container = document.getElementById('acctNotificationsList');
  const clearBar = document.getElementById('acctNotifClearBar');
  try {
    const { data } = await axios.get(`${API_BASE}/api/customer/notifications`, { headers: authHeaders() });
    if (!data.length) {
      container.innerHTML = `
        <div class="acct-empty acct-empty-notif">
          <!-- Was an emoji bell, which rendered as a different picture on every
               OS and in full colour on most. jp-icons draws it in the current
               text colour, so it matches the empty state around it. -->
          <div class="aei">${typeof JPIcon !== 'undefined' ? JPIcon.html('bell') : ''}</div>
          <div class="aet">No notifications yet</div>
          <div class="aes">We'll notify you when something important happens.</div>
        </div>`;
      /* Sized by .aei's own font-size (1.25em of 38px), so no jpi-* class here
         — jpi-xl would have made it 95px. Armed explicitly because this renders
         long after jp-icons.js mounted. */
      if (typeof JPIcon !== 'undefined') JPIcon.mount(container);
      clearBar.style.display = 'none';
      return;
    }
    container.innerHTML = data.map(n => `
      <div class="acct-notif-item ${n.is_read ? '' : 'unread'}">
        <div class="nt">${escapeHtml(n.title)}</div>
        <div class="nm">${escapeHtml(n.message)}</div>
        <div class="ndate">${fmtDate(n.created_at)}</div>
        ${!n.is_read ? `<div class="acct-notif-actions"><button type="button" class="btn btn-ghost btn-sm" data-mark-read="${n.id}">Mark as Read</button></div>` : ''}
      </div>
    `).join('');
    clearBar.style.display = data.some(n => n.is_read) ? 'flex' : 'none';
    container.querySelectorAll('[data-mark-read]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await axios.patch(`${API_BASE}/api/customer/notifications/${btn.dataset.markRead}/read`, {}, { headers: authHeaders() });
          loadAcctNotifications();
        } catch (err) { alert('Failed to mark as read.'); }
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load notifications.</div>';
    clearBar.style.display = 'none';
  }
}

document.getElementById('acctMarkAllReadBtn').addEventListener('click', async () => {
  try {
    await axios.patch(`${API_BASE}/api/customer/notifications/read-all`, {}, { headers: authHeaders() });
    loadAcctNotifications();
  } catch (err) { alert('Failed to mark all as read.'); }
});

document.getElementById('acctClearAllBtn').addEventListener('click', async () => {
  if (!confirm('Are you sure you want to clear all notifications?')) return;
  try {
    await axios.delete(`${API_BASE}/api/customer/notifications/read`, { headers: authHeaders() });
    loadAcctNotifications();
  } catch (err) { alert('Failed to clear notifications.'); }
});

/* ---------- Reviews ---------- */
/* Was '★'.repeat(n) + '☆'.repeat(5-n) — two different glyphs whose shapes
   and widths came from whatever font the OS had, and which some platforms drew
   as full-colour emoji. jp-icons draws one star and dims the rest. */
function starString(rating) {
  return (typeof JPIcon !== 'undefined') ? JPIcon.stars(rating)
    : '★'.repeat(rating) + '☆'.repeat(5 - rating);
}
async function loadAcctReviews() {
  const container = document.getElementById('acctReviewsList');
  try {
    const { data } = await axios.get(`${API_BASE}/api/customer/reviews/mine`, { headers: authHeaders() });
    if (!data.length) {
      container.innerHTML = "<div class=\"acct-empty\">You haven't written any reviews yet.</div>";
      return;
    }
    container.innerHTML = data.map(r => `
      <div class="acct-row" data-review-row="${r.id}">
        <div class="ar-main">
          <div class="ar-title">${escapeHtml(r.item_type)} #${r.item_id}</div>
          <div class="ar-sub" style="color:var(--gold-dark); letter-spacing:1px;">${starString(r.rating)}</div>
          ${r.comment ? `<div class="ar-sub">${escapeHtml(r.comment)}</div>` : ''}
          <div class="ar-sub">${fmtDate(r.created_at)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-edit-review="${r.id}" data-rating="${r.rating}" data-comment="${escapeHtml(r.comment || '')}">Edit</button>
        <button type="button" class="btn btn-danger btn-sm" data-delete-review="${r.id}">Delete</button>
      </div>
    `).join('');
    container.querySelectorAll('[data-edit-review]').forEach(btn => {
      btn.addEventListener('click', () => openAcctReviewEdit(btn.dataset.editReview, Number(btn.dataset.rating), btn.dataset.comment));
    });
    container.querySelectorAll('[data-delete-review]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this review?')) return;
        try {
          await axios.delete(`${API_BASE}/api/customer/reviews/${btn.dataset.deleteReview}`, { headers: authHeaders() });
          loadAcctReviews();
        } catch (err) { alert('Failed to delete review.'); }
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load reviews.</div>';
  }
}
function openAcctReviewEdit(reviewId, rating, comment) {
  const row = document.querySelector(`[data-review-row="${reviewId}"]`);
  let selected = rating;
  row.innerHTML = `
    <div class="ar-main" style="width:100%;">
      <div class="acct-star-input" id="acctEditStars-${reviewId}">
        ${[1, 2, 3, 4, 5].map(n => `<span data-star="${n}" class="${n <= rating ? 'active' : ''}">`
          + (typeof JPIcon !== 'undefined' ? JPIcon.html('star', { size: 'sm' }) : '★')
          + `</span>`).join('')}
      </div>
      <input type="text" id="acctEditComment-${reviewId}" value="${escapeHtml(comment)}" style="width:100%; padding:10px 12px; border-radius:10px; border:1.5px solid var(--line); font-size:13.5px; margin-bottom:10px;">
      <div style="display:flex; gap:8px;">
        <button type="button" class="btn btn-coral btn-sm" id="acctSaveReview-${reviewId}">Save</button>
        <button type="button" class="btn btn-ghost btn-sm" id="acctCancelReview-${reviewId}">Cancel</button>
      </div>
    </div>
  `;
  row.querySelectorAll(`#acctEditStars-${reviewId} span`).forEach(s => {
    s.addEventListener('click', () => {
      selected = Number(s.dataset.star);
      row.querySelectorAll(`#acctEditStars-${reviewId} span`).forEach(x => x.classList.toggle('active', Number(x.dataset.star) <= selected));
    });
  });
  document.getElementById(`acctCancelReview-${reviewId}`).addEventListener('click', loadAcctReviews);
  document.getElementById(`acctSaveReview-${reviewId}`).addEventListener('click', async () => {
    try {
      await axios.put(`${API_BASE}/api/customer/reviews/${reviewId}`, { rating: selected, comment: document.getElementById(`acctEditComment-${reviewId}`).value }, { headers: authHeaders() });
      loadAcctReviews();
    } catch (err) { alert('Failed to update review.'); }
  });
}

/* ---------- Support Tickets ---------- */
async function loadAcctSupportTickets() {
  const container = document.getElementById('acctTicketsList');
  try {
    const { data } = await axios.get(`${API_BASE}/api/customer/support-tickets`, { headers: authHeaders() });
    if (!data.length) {
      container.innerHTML = '<div class="acct-empty">No support tickets yet.</div>';
      return;
    }
    container.innerHTML = data.map(t => `
      <div class="acct-row">
        <div class="ar-main">
          <div class="ar-title" style="text-transform:none;">${escapeHtml(t.subject)}</div>
          <div class="ar-sub">${escapeHtml(t.description)}</div>
          <div class="ar-sub">Priority: ${escapeHtml(t.priority)} · Raised ${fmtDate(t.created_at)}</div>
        </div>
        <span class="badge ${t.status}">${escapeHtml(t.status.replace('_', ' '))}</span>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load support tickets.</div>';
  }
}
document.getElementById('acctTicketForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('acctTicketMsg');
  try {
    await axios.post(`${API_BASE}/api/customer/support-tickets`, {
      subject: document.getElementById('acctTicketSubject').value,
      description: document.getElementById('acctTicketDescription').value,
      priority: document.getElementById('acctTicketPriority').value,
    }, { headers: authHeaders() });
    msg.textContent = 'Ticket submitted — our support team will get back to you.';
    msg.className = 'acct-msg success';
    e.target.reset();
    loadAcctSupportTickets();
  } catch (err) {
    msg.textContent = apiErrorText(err, 'Failed to submit ticket.');
    msg.className = 'acct-msg error';
  }
});

loadUpcomingJourney();

/* ---------------------------------------------------------------------------
   ARRIVING FROM A SERVICE PAGE.

   flights.html and friends carry the header but not the sign-in modal or the
   Account Center — duplicating a password -> OTP flow onto six more pages would
   be six more things to keep correct. They link back here with an intent
   instead.

   ?signin=1        open the customer login modal
   ?account=<tab>   open the Account Center on that tab

   NOT `#login`: handleOperationsSignInHandoff() above claims that hash and
   forwards it to partner-login.html, so a traveller sent there would land on
   the MERCHANT sign-in.

   Runs last so every function and const it touches is already initialised, and
   the parameter is stripped afterwards — a bookmarked or refreshed URL should
   not keep reopening a dialog the visitor has closed.
   --------------------------------------------------------------------------- */
(function handleServicePageIntent() {
  const params = new URLSearchParams(location.search);
  const signin = params.get('signin');
  const account = params.get('account');
  if (!signin && !account) return;

  const { access } = getStoredAuth();
  /* ?account= while signed out is still a request to reach the account, so it
     opens the door rather than doing nothing. */
  if (account && access) openAccountCenter(account);
  else openAuth('login');

  params.delete('signin');
  params.delete('account');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
})();


  return {
    configure,
    open: openAccountCenter,
    close: closeAccountCenter,
    loadUpcomingJourney,
    starString,
  };
})();
