'use strict';
/* Classic — Payment Management (migration 0041).
   ===========================================================================
   The merchant's side of the payments desk: requests our team has raised, the
   proof the merchant uploads against them, and where each one got to.

   MONEY ARRIVES AS A STRING AND IS NEVER PARSED
   `Decimal` fields serialise as JSON strings precisely so a float cannot get
   near them. `moneyStr` formats the string for display; nothing here calls
   `Number()` on an amount, because the moment anything does, this screen has a
   second opinion about the merchant's money.

   WHAT THIS SCREEN USED TO BE
   "Payments": the per-booking payable list for the catalog-led track, with an
   account-position strip and a statement. It is now Payment Requests / Pending
   / Approved / Rejected.

   WHAT THAT REPLACED, AND WHAT SURVIVED IT
   The statement and the account position moved out rather than away: the
   Wallet screen is the portal's single running-account surface, and this screen
   showing a second balance beside it was the duplication the redesign removed.
   Their loaders are gone with the markup they rendered, but the endpoints they
   called are untouched: finance_service still serves /position and /statement,
   and Wallet renders the same figures from the same computation. Nothing about
   how the platform calculates a merchant's money changed here.

   The `Pay` dialog is kept for the same reason: My Requests opens it for a row
   at Payment Pending, and deleting it would have taken that path with it.

   THE ONE RULE THIS SCREEN STATES OUT LOUD
   **Settling credits nothing.** Uploading the proof hands the request to the
   desk; the wallet moves only when an admin approves it. The screen says so
   where a merchant would otherwise expect its balance to change.
*/

const CL_PR_TABS = [
  ['requests', 'Payment Requests'],
  ['pending', 'Pending Requests'],
  ['approved', 'Approved Requests'],
  ['rejected', 'Rejected Requests'],
];

const CL_PR_METHOD_LABELS = {
  bank_transfer: 'Bank transfer', cash: 'Cash', crypto: 'Crypto',
  upi: 'UPI', qr: 'QR', other: 'Other',
};

/* Which fields the merchant is shown for each method, in the order the desk
   filled them in. Mirrors payment_admin_service.REQUEST_METHODS — the server is
   the allowlist; this is only the labelling. */
const CL_PR_INSTRUCTIONS = {
  bank_transfer: [['bank_name', 'Bank name'], ['account_number', 'Account number'],
                  ['ifsc', 'IFSC'], ['branch', 'Branch']],
  cash: [['token_details', 'Token details'], ['note_number', 'Unique note number']],
  crypto: [['wallet_address', 'Wallet address'], ['network', 'Network']],
};

let clPrTab = 'requests';
let clPrLoaded = new Set();

function clInitPayments() {
  $('cl-payments').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Payment Management</h1>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clPrRefresh">
          ${clIco('refresh', { size: 15 })} Refresh
        </button>
      </div>
    </div>

    <div class="cl-tabs" id="clPrTabs" role="tablist">
      ${CL_PR_TABS.map(([key, label]) => `
        <button type="button" class="cl-tab${key === clPrTab ? ' active' : ''}"
                data-cl-pr-tab="${key}" role="tab" aria-selected="${key === clPrTab}">
          ${label} <span class="cl-tab-count" data-cl-pr-count="${key}"></span>
        </button>`).join('')}
    </div>

    ${CL_PR_TABS.map(([key, label]) => `
      <div class="cl-panel" data-cl-pr-pane="${key}"${key === clPrTab ? '' : ' style="display:none;"'}>
        <div class="cl-panel-head"><h2>${label}</h2></div>
        <div class="cl-panel-body cl-flush">
          <div class="cl-table-wrap">
            <table class="cl-table">
              <thead><tr>
                <th>Reference</th><th>Raised</th><th class="cl-num">Amount</th>
                <th>Method</th><th>Status</th><th class="cl-actions">Action</th>
              </tr></thead>
              <tbody data-cl-pr-body="${key}"></tbody>
            </table>
          </div>
        </div>
      </div>`).join('')}

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>${clIco('info')}How a payment request works</h2></div>
      <div class="cl-panel-body">
        <ol style="margin:0;padding-left:20px;font-size:13px;color:var(--cl-text-2);line-height:1.85;">
          <li>Our payments desk raises a request and tells you where to send the money.</li>
          <li>You pay, then record it here with your reference and the payment proof.</li>
          <li>The request moves to <b>Pending</b> while we confirm the money arrived.</li>
          <li>Once approved, <b>your wallet is credited</b>. Until then nothing is added to your balance.</li>
          <li>A rejected request tells you what to correct, and can be paid and submitted again.</li>
        </ol>
      </div>
    </div>`;

  $('clPrRefresh').addEventListener('click', () => {
    /* A refresh must actually re-fetch, so the lazy-load memo is cleared —
       otherwise the button only ever reloads the tab you are standing on. */
    clPrLoaded = new Set();
    clLoadPaymentRequests(clPrTab);
    clLoadPaymentRequestCounts();
  });

  document.querySelectorAll('[data-cl-pr-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      clPrTab = btn.dataset.clPrTab;
      document.querySelectorAll('[data-cl-pr-tab]').forEach(b => {
        const on = b.dataset.clPrTab === clPrTab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      document.querySelectorAll('[data-cl-pr-pane]').forEach(p => {
        p.style.display = p.dataset.clPrPane === clPrTab ? '' : 'none';
      });
      /* Lazy: a tab is fetched the first time it is opened, not all four on
         load. Same rule Service Requests uses. */
      clLoadPaymentRequests(clPrTab);
    });
  });

  return Promise.all([
    clLoadPaymentRequests(clPrTab),
    clLoadPaymentRequestCounts(),
  ]);
}

async function clLoadPaymentRequestCounts() {
  try {
    const c = await MerchantApi.paymentRequestCounts();
    document.querySelectorAll('[data-cl-pr-count]').forEach(el => {
      const n = c[el.dataset.clPrCount] || 0;
      el.textContent = n ? String(n) : '';
    });
  } catch { /* A missing badge is not worth an error banner over the table. */ }
}

async function clLoadPaymentRequests(bucket, { force = false } = {}) {
  const body = document.querySelector(`[data-cl-pr-body="${bucket}"]`);
  if (!body) return;
  if (clPrLoaded.has(bucket) && !force) return;
  clPrLoaded.add(bucket);

  body.innerHTML = clLoadingRow(6, 'Loading…');
  try {
    const data = await MerchantApi.paymentRequests({ bucket, pageSize: 50 });
    const items = data.items || [];
    body.innerHTML = items.length
      ? items.map(clPrRow).join('')
      : clEmptyRow(6, {
          requests: 'Nothing to pay right now.',
          pending: 'Nothing waiting on our approval.',
          approved: 'No approved payments yet.',
          rejected: 'No rejected payments.',
        }[bucket] || 'Nothing here.');

    body.querySelectorAll('[data-cl-pr-view]').forEach(b =>
      b.addEventListener('click', () => {
        const row = items.find(x => String(x.topup_id) === b.dataset.clPrView);
        if (row) clOpenPaymentRequestModal(row);
      }));
  } catch (err) {
    clPrLoaded.delete(bucket);
    body.innerHTML = clEmptyRow(6, clError(err, 'Could not load payment requests.'));
  }
}

function clPrStatusTag(status) {
  const tone = { awaiting_payment: '', submitted: 'warn', verified: 'ok', rejected: 'err' }[status] || '';
  const text = {
    awaiting_payment: 'Awaiting your payment', submitted: 'Pending approval',
    verified: 'Approved', rejected: 'Rejected',
  }[status] || status;
  return `<span class="cl-tag${tone ? ` cl-tag-${tone}` : ''}">${escapeHtml(text)}</span>`;
}

function clPrRow(r) {
  /* Settle covers both the first payment and a resubmission after rejection —
     one server call, so one button. */
  const settleable = r.status === 'awaiting_payment' || r.status === 'rejected';
  return `<tr>
    <td class="cl-ref">${escapeHtml(r.topup_number || '—')}
      ${r.resubmission_count
        ? `<div class="cl-kpi-sub">Resubmitted ×${r.resubmission_count}</div>` : ''}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(r.submitted_at))}</td>
    <td class="cl-num">${escapeHtml(moneyStr(r.amount))}</td>
    <td class="cl-nowrap">${escapeHtml(CL_PR_METHOD_LABELS[r.method] || r.method)}</td>
    <td>${clPrStatusTag(r.status)}</td>
    <td class="cl-actions">
      <button type="button" class="cl-btn cl-btn-sm${settleable ? ' cl-btn-primary' : ''}"
              data-cl-pr-view="${r.topup_id}">${settleable ? 'Pay now' : 'View'}</button>
    </td>
  </tr>`;
}

function clOpenPaymentRequestModal(r) {
  const settleable = r.status === 'awaiting_payment' || r.status === 'rejected';
  /* Mirrors topup_service._PROOF_RULES. A bank transfer is matched against the
     statement by its UTR; cash and crypto have none, so the image IS the proof.
     Stated here so the merchant knows what to bring before it starts typing —
     the server refuses the wrong combination either way. */
  const needsUtr = r.method === 'bank_transfer';
  const fields = CL_PR_INSTRUCTIONS[r.method] || [];

  clOpenModal(`Payment request — ${r.topup_number || ''}`, `
    <dl class="cl-dl" style="margin-bottom:13px;">
      <div><dt>Amount</dt><dd><b>${escapeHtml(moneyStr(r.amount))}</b></dd></div>
      <div><dt>Method</dt><dd>${escapeHtml(CL_PR_METHOD_LABELS[r.method] || r.method)}</dd></div>
      <div><dt>Status</dt><dd>${clPrStatusTag(r.status)}</dd></div>
      <div><dt>Raised</dt><dd>${escapeHtml(fmtDate(r.submitted_at))}</dd></div>
    </dl>

    ${fields.length ? `
      <h3 style="font-size:12px;margin:14px 0 6px;">Where to send it</h3>
      <dl class="cl-dl" style="margin-bottom:13px;">
        ${fields.map(([key, label]) => `
          <div><dt>${label}</dt>
            <dd class="cl-ref">${escapeHtml(r.instructions?.[key] || '—')}</dd></div>`).join('')}
        ${r.instructions?.note
          ? `<div><dt>Note</dt><dd>${escapeHtml(r.instructions.note)}</dd></div>` : ''}
      </dl>` : ''}

    ${r.status === 'rejected' && r.review_remarks ? `
      <div class="cl-msg cl-msg-err" style="margin-bottom:13px;">
        <b>Rejected:</b> ${escapeHtml(r.review_remarks)}
      </div>` : ''}

    ${r.status === 'verified' ? `
      <div class="cl-msg cl-msg-ok" style="margin-bottom:13px;">
        Approved${r.wallet_txn_number ? ` — credited to your wallet as <b>${escapeHtml(r.wallet_txn_number)}</b>` : ''}.
      </div>` : ''}

    ${r.status === 'submitted' ? `
      <div class="cl-msg cl-msg-muted" style="margin-bottom:13px;">
        With our payments desk. Your wallet is credited once it is approved.
      </div>` : ''}

    ${settleable ? `
      <h3 style="font-size:12px;margin:14px 0 6px;">Record your payment</h3>
      <div class="cl-form cl-form-2">
        ${needsUtr ? `
          <div class="cl-field cl-field-full">
            <label for="clPrUtr">UTR / reference number<span class="cl-req">*</span></label>
            <input type="text" id="clPrUtr" maxlength="64" placeholder="From your bank transfer">
          </div>` : ''}
        <div class="cl-field cl-field-full">
          <label for="clPrProof">Payment proof<span class="cl-req">*</span></label>
          <input type="file" id="clPrProof" accept="image/png,image/jpeg,application/pdf">
        </div>
      </div>
      <p class="cl-kpi-sub" style="margin:6px 0 0;">
        Submitting does not credit your wallet — our team approves it first.
      </p>
      <div class="cl-msg" id="clPrMsg"></div>` : ''}`,
    settleable
      ? `<button type="button" class="cl-btn" data-cl-pr-abort>Cancel</button>
         <button type="button" class="cl-btn cl-btn-primary" data-cl-pr-go
           ${clActionAttrs('payment.pay', CL_NO_PAY)}>Submit payment</button>`
      : '<button type="button" class="cl-btn" data-cl-pr-abort>Close</button>');

  $('clModalFoot').querySelector('[data-cl-pr-abort]').addEventListener('click', clCloseModal);

  const go = $('clModalFoot').querySelector('[data-cl-pr-go]');
  if (!go) return;

  go.addEventListener('click', async () => {
    const msg = $('clPrMsg');
    const utr = needsUtr ? ($('clPrUtr').value || '').trim() : '';
    const proof = $('clPrProof').files[0];

    /* Checked here as well as server-side so the merchant gets the reason
       immediately rather than a bare 400 after the upload. */
    if (needsUtr && !utr) return clMsg(msg, 'Enter the UTR from your bank transfer.', 'err');
    if (!proof) return clMsg(msg, 'Attach the payment proof.', 'err');

    go.disabled = true;
    clMsg(msg, 'Submitting…', 'muted');
    try {
      await MerchantApi.settlePaymentRequest(r.topup_id, { utr: utr || undefined, proof });
      clCloseModal();
      clPrLoaded = new Set();
      await Promise.all([clLoadPaymentRequests(clPrTab), clLoadPaymentRequestCounts()]);
      clInvalidate('dashboard', 'wallet');
      clLoadUnreadCount();
    } catch (err) {
      clMsg(msg, clError(err, 'Could not submit that payment.'), 'err');
      go.disabled = false;
    }
  });
}

/* ------------------------------------------- retired with the redesign (0041)

   `clLoadFinance`, `clLoadStatement`, `clLoadPayments` and `clPayRow` used to
   live here: the account-position strip, the statement ledger and the
   per-booking payable table. Payment Management no longer renders any of that
   markup, so every one of them would now throw on a null element.

   NOTHING WAS REMOVED FROM THE API. GET /api/merchant/finance/position and
   /statement are untouched and still served by finance_service; the Wallet
   screen is the portal's single running-account surface and shows the same
   figures from the same computation. The payable list moved to My Requests,
   which is where a row at Payment Pending is worked.

   `clOpenPayModal` below is deliberately kept — My Requests opens it for a row
   at Payment Pending, and deleting it would have taken that path with it.
   ------------------------------------------------------------------------ */

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
     <button type="button" class="cl-btn cl-btn-primary" data-cl-pay-go
       ${clActionAttrs('payment.pay', CL_NO_PAY)}>Submit payment</button>`);

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
      /* And so can Booking Request's recent strip, which is a third place this
         dialog is now opened from. Not clRefreshIfVisible('booking-request') —
         that would re-run the section's loader, and the same section renders
         the passenger FORM. See clRefreshRecentBookings in classic-booking.js. */
      clRefreshRecentBookings();
      if (!$('cl-payments').classList.contains('active')) clInvalidate('payments');
      if (!$('cl-requests').classList.contains('active')) clInvalidate('requests');
      clLoadUnreadCount();
    } catch (err) {
      clMsg(msg, clError(err, 'Payment failed.'), 'err');
      btn.disabled = false;
    }
  });
}
