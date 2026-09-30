/* Admin — B2C Bookings (Phase 2 of the B2C Admin Portal build-out)
   ==================================================================
   This is the module that answers "when a customer books a flight, hotel or
   package from the B2C site, where does admin see it?" — every row here is a
   real customer_bookings / customer_hotel_bookings / customer_package_
   bookings row, merged the same way the Customer Payments screen already
   merges its three products.

   GAMING PACKAGES ALWAYS SHOWS EMPTY HERE, ON PURPOSE. The public Gaming
   Packages page is a call-back enquiry form, not a bookable product — there
   is no gaming booking table. A lead that becomes a real trip is tracked on
   the Gaming Tour Packages screen (Converted Bookings), not here; the tab
   exists for symmetry with Catalogue Management, not because rows can appear
   under it.

   ENDPOINTS:
     GET   /api/admin/customer-bookings              paged, filterable list
     GET   /api/admin/customer-bookings/counts        counts per product
     GET   /api/admin/customer-bookings/{id}          one booking, in full
     PATCH /api/admin/customer-bookings/{id}/status   the one write this
                                                       module has

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDateTime, rowsSkeleton, renderPagination, PAGE_SIZE,
   navigateToSection) and moneyStr from shared/formatters.js, plus
   openCustomerDetail from admin-b2c-customers.js for the "View Customer"
   cross-link. Nothing here restates them. */

const BKG_SERVICE_TABS = [
  ['', 'All'],
  ['flight', 'Flights'],
  ['hotel', 'Hotels'],
  ['package', 'Tour Packages'],
  ['gaming', 'Gaming Packages'],
];

const BKG_STATUS_TONE = {
  CONFIRMED: 'confirmed', COMPLETED: 'confirmed',
  PENDING: 'pending', CANCELLED: 'cancelled',
};
const BKG_PAYMENT_TONE = {
  CAPTURED: 'confirmed', SUCCESS: 'confirmed',
  PENDING: 'pending', PROCESSING: 'pending', AUTHORIZED: 'pending',
  FAILED: 'cancelled', CANCELLED: 'cancelled', EXPIRED: 'cancelled',
  REFUNDED: 'refunded', NO_PAYMENT: 'pending',
};

const bkgState = { service: '', status: '', search: '', page: 1 };
let bkgWired = false;

function bkgPill(value, toneMap) {
  const tone = toneMap[value] || 'pending';
  return `<span class="badge ${tone}">${escapeHtml(value)}</span>`;
}

function bkgDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return escapeHtml(v); }
}

async function initB2CBookings() {
  if (!bkgWired) {
    bkgWired = true;
    const tabs = document.getElementById('bkgServiceTabs');
    tabs.innerHTML = BKG_SERVICE_TABS.map(([value, label]) => `
      <button type="button" role="tab" class="ops-tab${value === bkgState.service ? ' active' : ''}"
              data-bkg-tab="${escapeHtml(value)}">${escapeHtml(label)}</button>`).join('');
    tabs.querySelectorAll('[data-bkg-tab]').forEach(b => b.addEventListener('click', () => {
      bkgState.service = b.dataset.bkgTab;
      bkgState.page = 1;
      tabs.querySelectorAll('.ops-tab').forEach(t => t.classList.toggle('active', t === b));
      loadB2CBookings();
    }));

    document.getElementById('bkgStatusFilter').addEventListener('change', e => {
      bkgState.status = e.target.value;
      bkgState.page = 1;
      loadB2CBookings();
    });

    const search = document.getElementById('bkgSearch');
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        bkgState.search = search.value.trim();
        bkgState.page = 1;
        loadB2CBookings();
      }, 300);
    });

    document.getElementById('bkgTable').addEventListener('click', e => {
      const btn = e.target.closest('[data-bkg-open]');
      if (btn) openBookingDetail(btn.dataset.bkgOpen);
    });
  }
  await loadB2CBookings();
}

async function loadB2CBookings(page = bkgState.page) {
  bkgState.page = page;
  const tbody = document.querySelector('#bkgTable tbody');
  tbody.innerHTML = `<tr><td colspan="9">${rowsSkeleton(6)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/customer-bookings`, {
      headers: authHeaders(),
      params: {
        search: bkgState.search || undefined,
        service_type: bkgState.service || undefined,
        status: bkgState.status || undefined,
        page, page_size: PAGE_SIZE,
      },
    });
    const summary = document.getElementById('bkgSummary');
    if (summary) summary.textContent = `${data.total} booking${data.total === 1 ? '' : 's'}`;
    if (!data.items.length) {
      /* The one non-generic empty state: Gaming Packages has no booking
         table at all, and saying so beats a bare "no results" that reads
         like a search that merely came up short. */
      const msg = bkgState.service === 'gaming'
        ? 'Gaming Packages has no bookings — it is a call-back enquiry, tracked on the Gaming Tour Packages screen.'
        : 'No bookings match this filter.';
      tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${escapeHtml(msg)}</td></tr>`;
    } else {
      tbody.innerHTML = data.items.map(b => `
        <tr>
          <td><strong>${escapeHtml(b.booking_id)}</strong></td>
          <td>${escapeHtml(b.customer.name)}<div class="cell-sub">${escapeHtml(b.customer.email)}</div></td>
          <td>${escapeHtml(b.service_type)}</td>
          <td>${escapeHtml(b.destination)}</td>
          <td>${bkgDate(b.travel_date)}</td>
          <td class="num">${moneyStr(b.amount)}</td>
          <td>${bkgPill(b.payment_status, BKG_PAYMENT_TONE)}</td>
          <td>${bkgPill(b.booking_status, BKG_STATUS_TONE)}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-bkg-open="${escapeHtml(b.booking_id)}">View</button></td>
        </tr>`).join('');
    }
    renderPagination('bkgPagination', data.page, data.total_pages, data.total, loadB2CBookings);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Failed to load bookings.</td></tr>`;
  }
}

function bkgInfoItem(label, value) {
  return `<div class="info-item"><label>${escapeHtml(label)}</label><div>${value}</div></div>`;
}

async function openBookingDetail(bookingId) {
  const overlay = document.getElementById('bkgModalOverlay');
  const body = document.getElementById('bkgModalBody');
  if (!overlay || !body) return;
  overlay.classList.add('open');
  wireBkgModalChrome(overlay);
  body.innerHTML = `<div class="modal-head"><h3>Booking</h3>
    <button type="button" class="modal-close" data-bkg-close aria-label="Close">&times;</button></div>
    <div class="modal-body">${rowsSkeleton(4)}</div>`;

  let d;
  try {
    const res = await axios.get(`${API_BASE}/api/admin/customer-bookings/${encodeURIComponent(bookingId)}`,
      { headers: authHeaders() });
    d = res.data;
  } catch (err) {
    body.innerHTML = `<div class="modal-head"><h3>Booking</h3>
      <button type="button" class="modal-close" data-bkg-close aria-label="Close">&times;</button></div>
      <div class="modal-body"><p class="msg error">${escapeHtml(
        (err.response && err.response.data && err.response.data.detail) || 'Could not load this booking.')}</p></div>`;
    return;
  }
  renderBookingDetail(d);
}

function renderBookingDetail(d) {
  const body = document.getElementById('bkgModalBody');
  const passengers = d.passengers.length
    ? `<ul class="ge-side-list">${d.passengers.map(p =>
        `<li>${escapeHtml(p.name)} <span class="cell-sub">(${escapeHtml(p.type)})</span></li>`).join('')}</ul>`
    : '<p class="empty-state">No traveller details recorded.</p>';

  const statusOptions = ['pending', 'confirmed', 'cancelled', 'completed']
    .map(s => `<option value="${s}" ${s === d.booking_status.toLowerCase() ? 'selected' : ''}>${
      s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('');

  body.innerHTML = `
    <div class="modal-head"><h3>${escapeHtml(d.booking_id)} <span class="cell-sub">(${escapeHtml(d.service_type)})</span></h3>
      <button type="button" class="modal-close" data-bkg-close aria-label="Close">&times;</button></div>
    <div class="modal-body">
      <h4 class="cp-events-title">Customer Information</h4>
      <div class="detail-grid">
        ${bkgInfoItem('Name', escapeHtml(d.customer.name))}
        ${bkgInfoItem('Email', `<a href="mailto:${escapeHtml(d.customer.email)}">${escapeHtml(d.customer.email)}</a>`)}
        ${bkgInfoItem('Mobile', d.customer.mobile ? `<a href="tel:${escapeHtml(d.customer.mobile)}">${escapeHtml(d.customer.mobile)}</a>` : '—')}
      </div>

      <h4 class="cp-events-title">Trip Information</h4>
      <div class="detail-grid">
        ${bkgInfoItem('Service', escapeHtml(d.service_type))}
        ${bkgInfoItem('Destination', escapeHtml(d.destination))}
        ${bkgInfoItem('Travel Date', bkgDate(d.travel_date))}
        ${bkgInfoItem('Booked On', fmtDateTime(d.created_at))}
      </div>
      <p class="cp-events-title" style="margin-bottom:6px;">Passengers</p>
      ${passengers}

      <h4 class="cp-events-title">Payment</h4>
      <div class="detail-grid">
        ${bkgInfoItem('Amount', `${moneyStr(d.amount)} ${escapeHtml(d.currency)}`)}
        ${bkgInfoItem('Transaction ID', d.payment.transaction_id ? `<span class="mono">${escapeHtml(d.payment.transaction_id)}</span>` : '—')}
        ${bkgInfoItem('Method', d.payment.method ? escapeHtml(d.payment.method) : '—')}
        ${bkgInfoItem('Payment Status', bkgPill(d.payment.status, BKG_PAYMENT_TONE))}
      </div>

      <h4 class="cp-events-title">Update Status</h4>
      <div class="form-field" style="max-width:none;">
        <label for="bkgStatusSelect">Booking Status</label>
        <select id="bkgStatusSelect" class="status-select">${statusOptions}</select>
      </div>
      <div class="msg" id="bkgSaveMsg"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="bkgViewCustomerBtn">View Customer</button>
        <button type="button" class="btn btn-navy" id="bkgSaveStatusBtn">Save</button>
      </div>
    </div>`;

  document.getElementById('bkgViewCustomerBtn').addEventListener('click', () => {
    document.getElementById('bkgModalOverlay').classList.remove('open');
    navigateToSection('b2c-customers', () => openCustomerDetail(d.customer.id));
  });
  document.getElementById('bkgSaveStatusBtn').addEventListener('click', () => saveBookingStatus(d.booking_id));
}

async function saveBookingStatus(bookingId) {
  const select = document.getElementById('bkgStatusSelect');
  const msg = document.getElementById('bkgSaveMsg');
  const btn = document.getElementById('bkgSaveStatusBtn');
  btn.disabled = true;
  msg.textContent = '';
  msg.className = 'msg';
  try {
    const { data } = await axios.patch(
      `${API_BASE}/api/admin/customer-bookings/${encodeURIComponent(bookingId)}/status`,
      { status: select.value }, { headers: authHeaders() },
    );
    renderBookingDetail(data);
    if (typeof showToast === 'function') showToast('Booking status updated.');
    loadB2CBookings(bkgState.page);
  } catch (err) {
    msg.textContent = (err.response && err.response.data && err.response.data.detail) || 'Could not save this change.';
    msg.className = 'msg error';
    btn.disabled = false;
  }
}

function wireBkgModalChrome(overlay) {
  if (overlay.dataset.bkgWired === '1') return;
  overlay.dataset.bkgWired = '1';
  const close = () => overlay.classList.remove('open');
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.addEventListener('click', e => { if (e.target.closest('[data-bkg-close]')) close(); });
}
