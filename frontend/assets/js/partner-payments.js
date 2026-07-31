'use strict';
/* Merchant Portal — Payments.
   ---------------------------------------------------------------------------
   New screen in this pass, no new backend. There is deliberately no merchant
   payments-list endpoint in the v2 API (GET /api/admin/payments is gated on
   P.PAYMENT_VIEW, which merchants don't hold), so this composes the existing
   GET /api/requests and narrows it to the statuses that carry a payment:

     payment_pending  -> merchant owes money, can pay now
     paid             -> paid, awaiting Admin verification
     ticket_issued    -> verified and ticketed

   Paying reuses openPayModal() from partner-request-history.js, which posts to the
   existing POST /api/requests/{id}/pay. Per-payment rows (method, txn id, verified
   at) come back embedded in GET /api/requests/{id}, which openBookingDetailModal
   already renders — so "View" opens that rather than duplicating it here.

   Styled with the existing portal classes (.panel/.table-wrap/.badge), not the
   travel-style mh-* layer: Payments belongs to the account-menu group, and this
   pass only re-skins the Home booking surface. */

const PAY_STATUSES = ['payment_pending', 'paid', 'ticket_issued'];
let payFiltersWired = false;

function payRow(r) {
  const amount = r.total_amount != null ? money(r.total_amount) : '—';
  /* Payable needs a positive amount as well as the right status:
     ticket_service.record_payment rejects `amount <= 0` with a 400, so a "Pay ₹0"
     button could only ever fail. Requests that reach Payment Pending before
     they've been priced (a service request awaiting a quote) get an explanatory
     note instead of a dead button. */
  const priced = Number(r.total_amount) > 0;
  const canPay = r.status === 'payment_pending' && priced;
  const awaitingPrice = r.status === 'payment_pending' && !priced;
  /* Service requests carry no travel_type, so the column falls back to what the
     row actually is ("Passenger Modification") rather than showing a bare dash. */
  const kind = r.travel_type || statusLabel(r.request_type) || '—';
  return `
    <tr>
      <td>${escapeHtml(r.request_number)}</td>
      <td>${escapeHtml(r.booking_reference || '—')}</td>
      <td style="text-transform:capitalize">${escapeHtml(kind)}</td>
      <td>${r.travel_date ? fmtDate(r.travel_date) : '—'}</td>
      <td>${amount}</td>
      <td><span class="badge ${r.status}">${escapeHtml(r.status_label || statusLabel(r.status))}</span></td>
      <td>
        ${canPay ? `<button type="button" class="btn btn-coral btn-sm" data-pay-now="${r.id}">Pay ${amount}</button>` : ''}
        ${awaitingPrice ? '<span class="pay-note">Awaiting amount from our team</span>' : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-pay-view="${r.id}">View</button>
      </td>
    </tr>`;
}

function initPaymentsFilters() {
  document.getElementById('payStatusFilter').addEventListener('change', loadPayments);
}

async function loadPayments() {
  if (!payFiltersWired) { initPaymentsFilters(); payFiltersWired = true; }
  const tbody = document.querySelector('#payTable tbody');
  tbody.innerHTML = rowsSkeleton();

  const chosen = document.getElementById('payStatusFilter').value;
  /* Deliberately NOT narrowed to request_type=booking any more. That filter hid
     real money from the merchant: a service request (date change, passenger
     modification…) also reaches Payment Pending, and ticket_service.record_payment
     gates only on `status is PAYMENT_PENDING` — it never checks the request type —
     so those are payable through the very same POST /api/requests/{id}/pay.
     With the booking filter on, Dashboard counted a payment due that this screen
     then showed as "Nothing to pay right now" (found in the browser: the merchant's
     only payment_pending row was SRQ-2026-000001, a passenger_modification). */
  const params = { page_size: 50 };
  /* One status filters server-side. "All payment stages" can't be expressed as a
     single status param, so it fetches the list and narrows here instead of
     firing three parallel requests. */
  if (chosen) params.status = chosen;

  try {
    const { data } = await axios.get(`${API_BASE}/api/requests`, {
      headers: partnerAuthHeaders(), params,
    });
    const rows = chosen ? data.items : data.items.filter(r => PAY_STATUSES.includes(r.status));
    tbody.innerHTML = rows.length
      ? rows.map(payRow).join('')
      : '<tr><td colspan="7" class="empty-state">Nothing to pay right now.</td></tr>';

    tbody.querySelectorAll('[data-pay-view]').forEach(b => {
      b.addEventListener('click', () => openBookingDetailModal(b.dataset.payView));
    });
    tbody.querySelectorAll('[data-pay-now]').forEach(b => {
      b.addEventListener('click', () => {
        const request = rows.find(r => String(r.id) === b.dataset.payNow);
        if (request) openPayModal(request);
      });
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load payments.</td></tr>';
  }
}
