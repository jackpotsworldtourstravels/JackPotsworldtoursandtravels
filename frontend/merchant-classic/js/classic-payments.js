'use strict';
/* Classic — Payments.
   ===========================================================================
   The same /api/requests rows as My Requests, narrowed to the money stages.

   Two things here are deliberate and were wrong in the Premium portal before
   they were found by driving it:

   1. NO request_type FILTER. ticket_service.record_payment gates on
      `status is PAYMENT_PENDING` and never checks the type, so service requests
      (date change, passenger modification) are payable through the very same
      POST /api/requests/{id}/pay. Filtering to booking rows hid a genuinely
      payable request and the screen said "nothing to pay" while the dashboard
      counted one due.

   2. AN UNPRICED ROW IS NOT PAYABLE. record_payment rejects amount <= 0 with a
      400, so a Payment Pending row with no amount can only ever fail. It shows
      "Awaiting amount from our team" instead of a button that 400s. */

let clPayRows = [];

function clInitPayments() {
  $('cl-payments').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Payments</h1>
        <p>Requests at a payment stage. Submitted payments are verified by our team before ticketing.</p>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-toolbar">
        <div class="cl-field">
          <label for="clPayStatus">Stage</label>
          <select id="clPayStatus" data-cl-status-filter>
            <option value="">All payment stages</option>
            ${MERCHANT_PAYMENT_STATUSES.map(s => `<option value="${s}">${clLabel(s)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field" style="min-width:0;">
          <label>&nbsp;</label>
          <button type="button" class="cl-btn" id="clPayRefresh">Refresh</button>
        </div>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Request no.</th><th>Item</th><th>Type</th><th>Stage</th>
              <th class="cl-num">Amount</th><th>Travel date</th><th class="cl-actions">Action</th>
            </tr></thead>
            <tbody id="clPayBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-pager"><span class="cl-pager-info" id="clPayCount">—</span></div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>How payment works</h2></div>
      <div class="cl-panel-body">
        <ol style="margin:0;padding-left:17px;font-size:12.5px;color:var(--cl-ink-soft);line-height:1.7;">
          <li>A request is approved by our team and moves to <b>Payment Pending</b>.</li>
          <li>You record the payment here with the amount, method and your transaction reference.</li>
          <li>The request stays in Payment Pending while we verify the transfer.</li>
          <li>Once verified it moves to <b>Paid</b>, then <b>Ticketed</b> when documents are issued.</li>
        </ol>
      </div>
    </div>`;

  $('clPayRefresh').addEventListener('click', () => clLoadPayments());
  $('clPayStatus').addEventListener('change', () => clLoadPayments());
  return clLoadPayments();
}

async function clLoadPayments() {
  const body = $('clPayBody');
  body.innerHTML = clLoadingRow(7, 'Loading payables…');
  const chosen = $('clPayStatus').value;

  /* One status can be filtered server-side; "all payment stages" is not
     expressible as a single status param, so that case fetches and narrows
     here rather than firing three parallel requests. */
  const params = { page_size: 100 };
  if (chosen) params.status = chosen;

  try {
    const data = await MerchantApi.listRequests(params);
    const items = data.items || [];
    clPayRows = chosen ? items : items.filter(r => MERCHANT_PAYMENT_STATUSES.includes(r.status));

    body.innerHTML = clPayRows.length
      ? clPayRows.map(clPayRow).join('')
      : clEmptyRow(7, 'Nothing at a payment stage right now.');
    $('clPayCount').textContent = `${clPayRows.length} request${clPayRows.length === 1 ? '' : 's'}`;

    body.querySelectorAll('[data-cl-pay-view]').forEach(b =>
      b.addEventListener('click', () => clOpenRequestDetail(b.dataset.clPayView)));
    body.querySelectorAll('[data-cl-pay-now]').forEach(b =>
      b.addEventListener('click', () => {
        const r = clPayRows.find(x => String(x.id) === b.dataset.clPayNow);
        if (r) clOpenPayModal(r);
      }));
  } catch (err) {
    body.innerHTML = clEmptyRow(7, clError(err, 'Failed to load payments.'));
    $('clPayCount').textContent = '—';
  }
}

function clPayRow(r) {
  const payable = r.status === 'payment_pending' && Number(r.total_amount) > 0;
  const unpriced = r.status === 'payment_pending' && !(Number(r.total_amount) > 0);
  return `<tr>
    <td class="cl-ref">${escapeHtml(r.request_number || '—')}</td>
    <td>${escapeHtml(r.title || '—')}</td>
    <td class="cl-nowrap">${escapeHtml(clLabel(r.request_type || r.travel_type || '—'))}</td>
    <td>${clTag(r.status)}</td>
    <td class="cl-num">${money(r.total_amount)}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(r.travel_date))}</td>
    <td class="cl-actions">
      <button type="button" class="cl-btn cl-btn-sm" data-cl-pay-view="${r.id}">View</button>
      ${payable ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-pay-now="${r.id}">Pay</button>` : ''}
      ${unpriced ? '<span class="cl-tag">Awaiting amount from our team</span>' : ''}
      ${r.status === 'paid' ? '<span class="cl-tag cl-tag-ok">Verified</span>' : ''}
    </td>
  </tr>`;
}

/* Shared by Payments and My Requests — one payment dialog, one code path, so
   the two screens cannot drift on what gets posted. */
function clOpenPayModal(request) {
  clOpenModal(`Record payment — ${request.request_number || ''}`, `
    <dl class="cl-dl" style="margin-bottom:13px;">
      <div><dt>Request</dt><dd class="cl-ref">${escapeHtml(request.request_number || '—')}</dd></div>
      <div><dt>Item</dt><dd>${escapeHtml(request.title || '—')}</dd></div>
      <div><dt>Amount due</dt><dd><b>${money(request.total_amount)}</b></dd></div>
    </dl>
    <div class="cl-form cl-form-2">
      <div class="cl-field">
        <label for="clPayAmount">Amount paid (₹)<span class="cl-req">*</span></label>
        <input type="number" id="clPayAmount" min="1" step="0.01" value="${Number(request.total_amount) || ''}">
      </div>
      <div class="cl-field">
        <label for="clPayMethod">Method<span class="cl-req">*</span></label>
        <select id="clPayMethod">
          <option value="bank_transfer">Bank transfer</option>
          <option value="upi">UPI</option>
          <option value="card">Card</option>
          <option value="wallet">Wallet</option>
        </select>
      </div>
      <div class="cl-field cl-field-full">
        <label for="clPayTxn">Transaction reference</label>
        <input type="text" id="clPayTxn" placeholder="UTR / reference number (optional but speeds up verification)">
      </div>
    </div>
    <div class="cl-msg" id="clPayMsg"></div>`,
    `<button type="button" class="cl-btn" data-cl-pay-abort>Cancel</button>
     <button type="button" class="cl-btn cl-btn-primary" data-cl-pay-go>Submit payment</button>`);

  $('clModalFoot').querySelector('[data-cl-pay-abort]').addEventListener('click', clCloseModal);
  $('clModalFoot').querySelector('[data-cl-pay-go]').addEventListener('click', async () => {
    const msg = $('clPayMsg');
    const amount = Number($('clPayAmount').value);
    /* Checked here as well as server-side so the merchant gets the reason
       immediately rather than a bare 400. */
    if (!(amount > 0)) return clMsg(msg, 'Enter an amount greater than zero.', 'err');

    const btn = $('clModalFoot').querySelector('[data-cl-pay-go]');
    btn.disabled = true;
    clMsg(msg, 'Submitting payment…', 'muted');
    try {
      await MerchantApi.payRequest(request.id, {
        amount,
        method: $('clPayMethod').value,
        transactionId: $('clPayTxn').value.trim(),
      });
      clCloseModal();
      clInvalidate('dashboard', 'reports');
      /* Both money screens can be looking at this row. */
      clRefreshIfVisible('payments');
      clRefreshIfVisible('requests');
      if (!$('cl-payments').classList.contains('active')) clInvalidate('payments');
      if (!$('cl-requests').classList.contains('active')) clInvalidate('requests');
      clLoadUnreadCount();
    } catch (err) {
      clMsg(msg, clError(err, 'Payment failed.'), 'err');
      btn.disabled = false;
    }
  });
}
