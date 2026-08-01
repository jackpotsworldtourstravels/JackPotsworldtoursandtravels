/* Admin — Wallet & Top-ups (CR-4d)
   ================================
   The staff side of the merchant wallet: the queue that decides whether money
   arrived, the reconciliation that proves the ledger still adds up, and the
   accounts merchants are told to pay into.

   WHY THIS IS NOT A TAB INSIDE PAYMENT MANAGEMENT
   That screen is per-booking payments on the standard track — an invoice, a
   transaction id, a refund. This is a *running account*. The two settlement
   models answer "what does this merchant owe" differently, and putting them on
   one screen is how a figure gets read against the wrong one. They stay apart.

   THE ONE RULE THIS SCREEN ENFORCES VISUALLY
   Pending top-ups are money a merchant *says* it has sent. They are shown
   beside a balance and never added to one — WALLET_ARCHITECTURE §8. Every
   figure here comes from the API as a decimal string and goes through
   moneyStr(); nothing is parsed into a Number, because M4's rule is that the
   browser never does money arithmetic.

   ENDPOINTS
     GET  /api/admin/wallet/topups/counts              tab badges + pending total
     GET  /api/admin/wallet/topups                     the queue, oldest first
     GET  /api/admin/wallet/topups/{id}                one claim, with the balance
     GET  /api/admin/wallet/topups/{id}/proof          the screenshot (attachment)
     POST /api/admin/wallet/topups/{id}/verify         credits the wallet
     POST /api/admin/wallet/topups/{id}/reject         moves no money, needs a reason
     GET  /api/admin/wallet/reconciliation             drift per merchant
     GET  /api/admin/merchants/{id}/wallet/transactions the ledger, as the merchant sees it
     GET/POST/PUT/DELETE /api/admin/payment-accounts   where money is sent
     POST /api/admin/payment-accounts/{id}/qr          the QR image
*/

const WD_BUCKETS = [
  ['pending', 'Awaiting verification'],
  ['verified', 'Verified'],
  ['rejected', 'Rejected'],
  ['all', 'All'],
];

let wdBucket = 'pending';
let wdPage = 1;
let wdSearch = '';
let wdMerchantId = '';
let wdReleaseTrap = null;

const wdMoney = v => (typeof moneyStr === 'function' ? moneyStr(v) : `₹${v}`);

function wdErr(err, fallback) {
  return err?.response?.data?.detail || fallback;
}

function wdEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function wdDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const WD_METHOD_LABELS = {
  bank_transfer: 'Bank transfer', upi: 'UPI', qr: 'QR', cash: 'Cash', other: 'Other',
};

const WD_TXN_LABELS = {
  booking_debit: 'Ticket booking', wallet_recharge: 'Wallet recharge',
  refund_credit: 'Refund', cancellation_charge: 'Cancellation charge',
  credit_note: 'Credit note', manual_adjustment: 'Manual adjustment',
};

function wdStatusChip(status) {
  /* Colour is never the only carrier — every chip carries its word. */
  const map = { submitted: 'pending', verified: 'ok', rejected: 'danger' };
  const text = { submitted: 'Awaiting verification', verified: 'Verified', rejected: 'Rejected' };
  return `<span class="badge ${map[status] || ''}">${wdEsc(text[status] || status)}</span>`;
}

/* ---------------------------------------------------------------- queue --- */
async function wdLoadCounts() {
  try {
    const { data } = await axios.get(
      `${API_BASE}/api/admin/wallet/topups/counts`, { headers: authHeaders() });

    document.getElementById('wdTabs').innerHTML = WD_BUCKETS.map(([key, label]) => `
      <button type="button" class="ops-tab${key === wdBucket ? ' active' : ''}"
              data-wd-bucket="${key}" role="tab" aria-selected="${key === wdBucket}">
        ${wdEsc(label)} <span class="ops-tab-count">${data[key] ?? 0}</span>
      </button>`).join('');
    document.querySelectorAll('[data-wd-bucket]').forEach(b => {
      b.addEventListener('click', () => {
        wdBucket = b.dataset.wdBucket; wdPage = 1; wdLoadCounts(); wdLoadQueue();
      });
    });

    /* The backlog, stated as money as well as a row count — "12 waiting" and
       "₹4,80,000 waiting" are different facts and the second is the one that
       decides whether this queue is urgent. */
    document.getElementById('wdPendingSummary').textContent =
      data.pending ? `${data.pending} awaiting verification · ${wdMoney(data.pending_amount)}` : '';

    const badge = document.getElementById('wdNavBadge');
    if (badge) {
      badge.hidden = !data.pending;
      badge.textContent = data.pending || '';
    }
  } catch (err) {
    showToast(wdErr(err, 'Could not load the verification queue.'), true);
  }
}

async function wdLoadQueue() {
  const tbody = document.querySelector('#wdTable tbody');
  tbody.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
  try {
    const params = new URLSearchParams({ bucket: wdBucket, page: wdPage, page_size: 20 });
    if (wdSearch) params.set('search', wdSearch);
    if (wdMerchantId) params.set('merchant_id', wdMerchantId);
    const { data } = await axios.get(
      `${API_BASE}/api/admin/wallet/topups?${params}`, { headers: authHeaders() });

    if (!data.items.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="ops-sub">Nothing here.</td></tr>`;
      document.getElementById('wdPagination').innerHTML = '';
      return;
    }

    tbody.innerHTML = data.items.map(t => `
      <tr>
        <td><strong>${wdEsc(t.topup_number)}</strong></td>
        <td>${wdEsc(t.merchant_name || '—')}</td>
        <td>${wdMoney(t.amount)}</td>
        <td>${wdEsc(WD_METHOD_LABELS[t.method] || t.method)}</td>
        <td>${wdEsc(t.utr || '—')}</td>
        <td>${wdEsc(wdDateTime(t.submitted_at))}</td>
        <td>${wdStatusChip(t.status)}${
          t.wallet_txn_number ? `<br><span class="ops-sub">${wdEsc(t.wallet_txn_number)}</span>` : ''
        }</td>
        <td><button type="button" class="btn btn-sm" data-wd-review="${t.topup_id}">
          ${t.status === 'submitted' ? 'Review' : 'View'}
        </button></td>
      </tr>`).join('');

    document.querySelectorAll('[data-wd-review]').forEach(b => {
      b.addEventListener('click', () => wdOpenReview(Number(b.dataset.wdReview)));
    });

    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    document.getElementById('wdPagination').innerHTML = pages > 1
      ? `<button type="button" class="btn btn-sm" id="wdPrev" ${wdPage <= 1 ? 'disabled' : ''}>Previous</button>
         <span class="ops-sub">Page ${data.page} of ${pages} · ${data.total} total</span>
         <button type="button" class="btn btn-sm" id="wdNext" ${wdPage >= pages ? 'disabled' : ''}>Next</button>`
      : `<span class="ops-sub">${data.total} total</span>`;
    document.getElementById('wdPrev')?.addEventListener('click', () => { wdPage--; wdLoadQueue(); });
    document.getElementById('wdNext')?.addEventListener('click', () => { wdPage++; wdLoadQueue(); });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="msg error">${wdEsc(wdErr(err, 'Could not load the queue.'))}</td></tr>`;
  }
}

/* --------------------------------------------------------------- review --- */
function wdCloseReview() {
  document.getElementById('wdReviewOverlay').classList.remove('open');
  if (wdReleaseTrap) { wdReleaseTrap(); wdReleaseTrap = null; }
}

async function wdOpenReview(topupId) {
  const overlay = document.getElementById('wdReviewOverlay');
  const body = document.getElementById('wdReviewBody');
  body.innerHTML = '<p>Loading…</p>';
  overlay.classList.add('open');

  let data;
  try {
    ({ data } = await axios.get(
      `${API_BASE}/api/admin/wallet/topups/${topupId}`, { headers: authHeaders() }));
  } catch (err) {
    body.innerHTML = `<p class="msg error">${wdEsc(wdErr(err, 'Could not load that claim.'))}</p>`;
    return;
  }

  const t = data.topup;
  const decidable = t.status === 'submitted';

  body.innerHTML = `
    <div class="ops-modal-head">
      <h2 id="wdReviewTitle">${wdEsc(t.topup_number)}</h2>
      <button type="button" class="icon-btn" id="wdReviewClose" aria-label="Close">&times;</button>
    </div>
    <div class="ops-modal-body">
      <div class="ops-grid-3">
        <div><span class="ops-label">Merchant</span><span class="ops-value">${wdEsc(t.merchant_name || '—')}</span></div>
        <div><span class="ops-label">Amount claimed</span><span class="ops-value"><strong>${wdMoney(t.amount)}</strong></span></div>
        <div><span class="ops-label">Method</span><span class="ops-value">${wdEsc(WD_METHOD_LABELS[t.method] || t.method)}</span></div>
        <div><span class="ops-label">UTR / reference</span><span class="ops-value">${wdEsc(t.utr || '—')}</span></div>
        <div><span class="ops-label">Paid into</span><span class="ops-value">${wdEsc(t.payment_account_label || '—')}</span></div>
        <div><span class="ops-label">Submitted</span><span class="ops-value">${wdEsc(wdDateTime(t.submitted_at))}</span></div>
      </div>

      <!-- The balance BEFORE the decision, so the operator sees what they are
           about to change rather than what they changed. -->
      <div class="wd-balance-strip">
        <div><span class="ops-label">Wallet balance now</span>
             <span class="ops-value ${moneyIsPositive(data.wallet_balance) ? '' : 'wd-neg'}">${wdMoney(data.wallet_balance)}</span></div>
        <div><span class="ops-label">This claim</span><span class="ops-value">+ ${wdMoney(t.amount)}</span></div>
        <div><span class="ops-label">Status</span><span class="ops-value">${wdStatusChip(t.status)}</span></div>
        ${t.wallet_txn_number ? `<div><span class="ops-label">Ledger entry</span><span class="ops-value">${wdEsc(t.wallet_txn_number)}</span></div>` : ''}
      </div>

      <div class="ops-row" style="margin-top:16px;">
        <span class="ops-label">Payment proof</span>
        ${t.has_proof
          ? `<button type="button" class="btn btn-sm" id="wdProofBtn">Download ${wdEsc(t.proof_filename || 'proof')}</button>`
          : '<span class="ops-sub">No screenshot was attached.</span>'}
      </div>

      ${t.review_remarks ? `
        <div class="ops-row"><span class="ops-label">Remarks</span>
          <span class="ops-value">${wdEsc(t.review_remarks)}</span></div>` : ''}
      ${t.reviewed_at ? `
        <div class="ops-row"><span class="ops-label">Decided</span>
          <span class="ops-value">${wdEsc(wdDateTime(t.reviewed_at))}</span></div>` : ''}

      ${decidable ? `
        <div class="form-field" style="max-width:none; margin-top:16px;">
          <label for="wdRemarks">Remarks</label>
          <textarea id="wdRemarks" rows="2"
                    placeholder="Optional when verifying — required when rejecting."></textarea>
        </div>
        <div class="ops-actions">
          <button type="button" class="btn btn-coral" id="wdVerifyBtn">Verify &amp; credit wallet</button>
          <button type="button" class="btn" id="wdRejectBtn">Reject</button>
          <div class="msg" id="wdReviewMsg" aria-live="polite"></div>
        </div>` : `
        <div class="ops-actions"><span class="ops-sub">This claim has already been decided.</span></div>`}
    </div>`;

  document.getElementById('wdReviewClose').addEventListener('click', wdCloseReview);
  document.getElementById('wdProofBtn')?.addEventListener('click', () => wdDownloadProof(t.topup_id));
  if (decidable) {
    document.getElementById('wdVerifyBtn').addEventListener('click', () => wdDecide(t.topup_id, 'verify'));
    document.getElementById('wdRejectBtn').addEventListener('click', () => wdDecide(t.topup_id, 'reject'));
  }

  wdReleaseTrap = trapFocus(body);
}

async function wdDownloadProof(topupId) {
  /* Fetched with the auth header and handed to the browser as a blob: the
     endpoint is authenticated, so a bare href would 401. */
  try {
    const res = await axios.get(`${API_BASE}/api/admin/wallet/topups/${topupId}/proof`,
      { headers: authHeaders(), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = (res.headers['content-disposition'] || '').match(/filename="?([^"]+)"?/)?.[1] || 'proof';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(wdErr(err, 'Could not download that proof.'), true);
  }
}

async function wdDecide(topupId, action) {
  const msg = document.getElementById('wdReviewMsg');
  const remarks = document.getElementById('wdRemarks').value.trim();

  if (action === 'reject' && remarks.length < 3) {
    /* Mirrors the server rule rather than discovering it: the merchant believes
       it has paid us, and a refusal with no reason produces a phone call. */
    msg.className = 'msg error';
    msg.textContent = 'Give a reason — the merchant needs to know what to correct.';
    document.getElementById('wdRemarks').focus();
    return;
  }

  const title = action === 'verify' ? 'Verify this payment?' : 'Reject this payment?';
  const detail = action === 'verify'
    ? 'The merchant’s wallet is credited immediately and cannot be un-credited — a mistake is corrected by posting an adjustment.'
    : 'No money moves. The merchant is told why and can correct and resubmit.';
  if (!await confirmDialog({ title, message: detail, confirmText: 'Confirm' })) return;

  msg.className = 'msg';
  msg.textContent = 'Working…';
  try {
    const { data } = await axios.post(
      `${API_BASE}/api/admin/wallet/topups/${topupId}/${action}`,
      { remarks: remarks || undefined }, { headers: authHeaders() });
    showToast(action === 'verify'
      ? `Credited. ${data.transaction_reference} — balance ${wdMoney(data.wallet_balance_after)}.`
      : 'Rejected. The merchant has been told why.');
    wdCloseReview();
    wdLoadCounts(); wdLoadQueue(); wdLoadReconciliation();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = wdErr(err, 'Could not record that decision.');
  }
}

/* ------------------------------------------------------- reconciliation --- */
async function wdLoadReconciliation() {
  const tbody = document.querySelector('#wdReconTable tbody');
  tbody.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
  try {
    const { data } = await axios.get(
      `${API_BASE}/api/admin/wallet/reconciliation`, { headers: authHeaders() });

    /* Drift is the headline. Zero everywhere is the only acceptable state, and
       the wording says so rather than leaving a red number to speak for itself. */
    const status = document.getElementById('wdReconStatus');
    status.textContent = data.reconciled
      ? `All ${data.merchant_count} merchants reconcile — ledger and balances agree.`
      : `${data.drifted_merchant_count} of ${data.merchant_count} merchants DO NOT reconcile.`;
    status.className = data.reconciled ? 'ops-sub' : 'msg error';

    tbody.innerHTML = data.merchants.map(m => `
      <tr>
        <td><strong>${wdEsc(m.merchant_name)}</strong></td>
        <td class="${moneyIsPositive(m.wallet_balance) ? '' : 'wd-neg'}">${wdMoney(m.wallet_balance)}</td>
        <td>${wdMoney(m.ledger_balance)}</td>
        <td>${m.reconciled
              ? '<span class="badge ok">0.00</span>'
              : `<span class="badge danger">${wdMoney(m.drift)}</span>`}</td>
        <td>${wdMoney(m.outstanding)}</td>
        <td>${Number(m.credit_limit) > 0 ? wdMoney(m.credit_limit) : '<span class="ops-sub">No limit</span>'}</td>
        <td>${m.pending_topup_count
              ? `${wdMoney(m.pending_topup_amount)} <span class="ops-sub">(${m.pending_topup_count})</span>`
              : '—'}</td>
        <td><button type="button" class="btn btn-sm" data-wd-ledger="${m.merchant_id}"
                    data-wd-name="${wdEsc(m.merchant_name)}">Ledger</button></td>
      </tr>`).join('');

    document.querySelectorAll('[data-wd-ledger]').forEach(b => {
      b.addEventListener('click', () => wdOpenLedger(Number(b.dataset.wdLedger), b.dataset.wdName));
    });

    const sel = document.getElementById('wdMerchantFilter');
    if (sel && sel.options.length <= 1) {
      sel.insertAdjacentHTML('beforeend', data.merchants.map(m =>
        `<option value="${m.merchant_id}">${wdEsc(m.merchant_name)}</option>`).join(''));
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="msg error">${wdEsc(wdErr(err, 'Could not reconcile.'))}</td></tr>`;
  }
}

async function wdOpenLedger(merchantId, name) {
  const overlay = document.getElementById('wdLedgerOverlay');
  const body = document.getElementById('wdLedgerBody');
  body.innerHTML = '<p>Loading…</p>';
  overlay.classList.add('open');

  try {
    const { data } = await axios.get(
      `${API_BASE}/api/admin/merchants/${merchantId}/wallet/transactions?page_size=100`,
      { headers: authHeaders() });

    body.innerHTML = `
      <div class="ops-modal-head">
        <h2 id="wdLedgerTitle">${wdEsc(name)} — wallet ledger</h2>
        <button type="button" class="icon-btn" id="wdLedgerClose" aria-label="Close">&times;</button>
      </div>
      <div class="ops-modal-body">
        <p class="ops-sub">Balance <strong class="${moneyIsPositive(data.wallet_balance) ? '' : 'wd-neg'}">${wdMoney(data.wallet_balance)}</strong>
           · ${data.total} transactions. These are the same rows the merchant sees.</p>
        <div class="table-wrap"><table><thead><tr>
          <th>Reference</th><th>Type</th><th>Debit</th><th>Credit</th><th>Balance</th><th>When</th><th>Reason</th>
        </tr></thead><tbody>
          ${data.items.length ? data.items.map(x => `
            <tr>
              <td>${wdEsc(x.txn_number)}</td>
              <td>${wdEsc(WD_TXN_LABELS[x.txn_type] || x.txn_type)}</td>
              <td>${Number(x.debit) > 0 ? wdMoney(x.debit) : '—'}</td>
              <td>${Number(x.credit) > 0 ? wdMoney(x.credit) : '—'}</td>
              <td class="${moneyIsPositive(x.balance_after) ? '' : 'wd-neg'}">${wdMoney(x.balance_after)}</td>
              <td>${wdEsc(wdDateTime(x.created_at))}</td>
              <td class="ops-sub">${wdEsc(x.reason || '—')}</td>
            </tr>`).join('')
            : '<tr><td colspan="7" class="ops-sub">No transactions yet.</td></tr>'}
        </tbody></table></div>
      </div>`;
    document.getElementById('wdLedgerClose').addEventListener('click', () => {
      overlay.classList.remove('open');
      if (wdReleaseTrap) { wdReleaseTrap(); wdReleaseTrap = null; }
    });
    wdReleaseTrap = trapFocus(body);
  } catch (err) {
    body.innerHTML = `<p class="msg error">${wdEsc(wdErr(err, 'Could not load that ledger.'))}</p>`;
  }
}

/* ------------------------------------------------------ payment accounts --- */
const WD_ACCOUNT_FIELDS = {
  bank: [
    ['account_name', 'Account name', true], ['account_number', 'Account number', true],
    ['ifsc', 'IFSC', true], ['bank_name', 'Bank', false], ['branch', 'Branch', false],
  ],
  upi: [['upi_id', 'UPI ID', true], ['payee_name', 'Payee name', false]],
  qr: [['upi_id', 'UPI ID', false], ['payee_name', 'Payee name', false], ['note', 'Note', false]],
};

async function wdLoadAccounts() {
  const tbody = document.querySelector('#wdAccountsTable tbody');
  tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try {
    const { data } = await axios.get(
      `${API_BASE}/api/admin/payment-accounts`, { headers: authHeaders() });

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="ops-sub">
        No payment accounts yet. Until one is active and usable, the merchant's
        Add Money screen has nowhere to send money to.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(a => `
      <tr>
        <td><strong>${wdEsc(a.label)}</strong></td>
        <td>${wdEsc(a.account_type.toUpperCase())}</td>
        <td class="ops-sub">${wdEsc(
          Object.entries(a.details || {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')
          || (a.has_qr_image ? 'QR image attached' : '—'))}</td>
        <td>${a.display_order}</td>
        <td>${a.is_active
              ? '<span class="badge ok">Active</span>'
              : '<span class="badge">Retired</span>'}</td>
        <td>
          <button type="button" class="btn btn-sm" data-wd-editacc="${a.account_id}">Edit</button>
          ${a.is_active
            ? `<button type="button" class="btn btn-sm" data-wd-retireacc="${a.account_id}"
                       data-wd-acclabel="${wdEsc(a.label)}">Retire</button>`
            : ''}
        </td>
      </tr>`).join('');

    window.__wdAccounts = data;
    document.querySelectorAll('[data-wd-editacc]').forEach(b => {
      b.addEventListener('click', () => wdOpenAccount(Number(b.dataset.wdEditacc)));
    });
    document.querySelectorAll('[data-wd-retireacc]').forEach(b => {
      b.addEventListener('click', () => wdRetireAccount(Number(b.dataset.wdRetireacc), b.dataset.wdAcclabel));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="msg error">${wdEsc(wdErr(err, 'Could not load accounts.'))}</td></tr>`;
  }
}

function wdCloseAccount() {
  document.getElementById('wdAccountOverlay').classList.remove('open');
  if (wdReleaseTrap) { wdReleaseTrap(); wdReleaseTrap = null; }
}

function wdOpenAccount(accountId) {
  const overlay = document.getElementById('wdAccountOverlay');
  const body = document.getElementById('wdAccountBody');
  const existing = accountId
    ? (window.__wdAccounts || []).find(a => a.account_id === accountId)
    : null;
  const type = existing?.account_type || 'bank';

  const fieldsFor = t => (WD_ACCOUNT_FIELDS[t] || []).map(([key, label, required]) => `
    <div class="form-field" style="max-width:none;">
      <label for="wdAcc_${key}">${wdEsc(label)}${required ? ' *' : ''}</label>
      <input type="text" id="wdAcc_${key}" data-wd-detail="${key}"
             value="${wdEsc(existing?.details?.[key] || '')}">
    </div>`).join('');

  body.innerHTML = `
    <div class="ops-modal-head">
      <h2 id="wdAccountTitle">${existing ? 'Edit payment account' : 'Add payment account'}</h2>
      <button type="button" class="icon-btn" id="wdAccClose" aria-label="Close">&times;</button>
    </div>
    <div class="ops-modal-body">
      <div class="form-field" style="max-width:none;">
        <label for="wdAccType">Type</label>
        <select id="wdAccType" ${existing ? 'disabled' : ''}>
          <option value="bank"${type === 'bank' ? ' selected' : ''}>Bank account</option>
          <option value="upi"${type === 'upi' ? ' selected' : ''}>UPI ID</option>
          <option value="qr"${type === 'qr' ? ' selected' : ''}>QR code</option>
        </select>
        ${existing ? '<p class="ops-sub">The rail cannot be changed — retire this account and add another.</p>' : ''}
      </div>
      <div class="form-field" style="max-width:none;">
        <label for="wdAccLabel">Label *</label>
        <input type="text" id="wdAccLabel" value="${wdEsc(existing?.label || '')}"
               placeholder="What merchants see, e.g. HDFC Current — JackPots">
      </div>
      <div id="wdAccFields">${fieldsFor(type)}</div>
      <div class="form-field" style="max-width:none;">
        <label for="wdAccOrder">Display order</label>
        <input type="number" id="wdAccOrder" value="${existing?.display_order ?? 0}" step="1">
      </div>
      <div class="form-field" style="max-width:none;">
        <label for="wdAccQr">QR image${type === 'qr' ? ' *' : ''}</label>
        <input type="file" id="wdAccQr" accept="image/png,image/jpeg,image/webp">
        <p class="ops-sub">${existing?.has_qr_image
          ? 'An image is attached — uploading replaces it.'
          : 'PNG, JPEG or WebP. Required before a QR account can be made active.'}</p>
      </div>
      <label class="ops-check">
        <input type="checkbox" id="wdAccActive" ${existing ? (existing.is_active ? 'checked' : '') : 'checked'}>
        Active — shown on the merchant's Add Money screen
      </label>
      <div class="ops-actions">
        <button type="button" class="btn btn-coral" id="wdAccSave">${existing ? 'Save changes' : 'Create account'}</button>
        <div class="msg" id="wdAccMsg" aria-live="polite"></div>
      </div>
    </div>`;

  overlay.classList.add('open');
  document.getElementById('wdAccClose').addEventListener('click', wdCloseAccount);
  document.getElementById('wdAccType').addEventListener('change', e => {
    document.getElementById('wdAccFields').innerHTML = fieldsFor(e.target.value);
  });
  document.getElementById('wdAccSave').addEventListener('click', () => wdSaveAccount(accountId));
  wdReleaseTrap = trapFocus(body);
}

async function wdSaveAccount(accountId) {
  const msg = document.getElementById('wdAccMsg');
  const label = document.getElementById('wdAccLabel').value.trim();
  if (!label) {
    msg.className = 'msg error';
    msg.textContent = 'Give the account a label — it is what merchants see.';
    document.getElementById('wdAccLabel').focus();
    return;
  }

  const details = {};
  document.querySelectorAll('[data-wd-detail]').forEach(i => {
    if (i.value.trim()) details[i.dataset.wdDetail] = i.value.trim();
  });

  const type = document.getElementById('wdAccType').value;
  const active = document.getElementById('wdAccActive').checked;
  const order = Number(document.getElementById('wdAccOrder').value) || 0;
  const file = document.getElementById('wdAccQr').files[0];

  msg.className = 'msg';
  msg.textContent = 'Saving…';
  try {
    let id = accountId;
    if (id) {
      /* Deactivate-then-upload-then-reactivate is not needed: the server checks
         usability against the resulting state, and the QR upload below happens
         before we ask for `is_active: true` on a QR account. */
      await axios.put(`${API_BASE}/api/admin/payment-accounts/${id}`,
        { label, details, display_order: order, is_active: file && type === 'qr' ? false : active },
        { headers: authHeaders() });
    } else {
      const { data } = await axios.post(`${API_BASE}/api/admin/payment-accounts`,
        { account_type: type, label, details, display_order: order,
          /* A QR account cannot be created active — it has no image yet. It is
             switched on after the upload, below. */
          is_active: type === 'qr' ? false : active },
        { headers: authHeaders() });
      id = data.account_id;
    }

    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      await axios.post(`${API_BASE}/api/admin/payment-accounts/${id}/qr`, fd,
        { headers: authHeaders() });
      if (active) {
        await axios.put(`${API_BASE}/api/admin/payment-accounts/${id}`,
          { is_active: true }, { headers: authHeaders() });
      }
    }

    showToast(accountId ? 'Payment account updated.' : 'Payment account added.');
    wdCloseAccount();
    wdLoadAccounts();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = wdErr(err, 'Could not save that account.');
  }
}

async function wdRetireAccount(accountId, label) {
  if (!await confirmDialog({
    title: `Retire ${label}?`,
    message: 'It disappears from the merchant’s Add Money screen. Past top-ups paid into it keep their record — the account is never deleted.',
    confirmText: 'Retire',
  })) return;
  try {
    await axios.delete(`${API_BASE}/api/admin/payment-accounts/${accountId}`,
      { headers: authHeaders() });
    showToast('Account retired.');
    wdLoadAccounts();
  } catch (err) {
    showToast(wdErr(err, 'Could not retire that account.'), true);
  }
}

/* ----------------------------------------------------------------- wire --- */
function wdInit() {
  wdLoadCounts();
  wdLoadQueue();
  wdLoadReconciliation();
  wdLoadAccounts();
}

document.addEventListener('DOMContentLoaded', () => {
  const search = document.getElementById('wdSearch');
  let timer = null;
  search?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { wdSearch = search.value.trim(); wdPage = 1; wdLoadQueue(); }, 300);
  });
  document.getElementById('wdMerchantFilter')?.addEventListener('change', e => {
    wdMerchantId = e.target.value; wdPage = 1; wdLoadQueue();
  });
  document.getElementById('wdAddAccountBtn')?.addEventListener('click', () => wdOpenAccount(null));

  document.querySelector('[data-section="wallet-desk"]')?.addEventListener('click', () => {
    setTimeout(wdInit, 0);
  });

  /* The nav badge is the only part that loads without visiting the section:
     an unverified payment is money sitting still, and the desk should see it
     from any screen. */
  if (localStorage.getItem('jwt_access')) wdLoadCounts();
});

['wdReviewOverlay', 'wdAccountOverlay', 'wdLedgerOverlay'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', e => {
    if (e.target === document.getElementById(id)) {
      document.getElementById(id).classList.remove('open');
      if (wdReleaseTrap) { wdReleaseTrap(); wdReleaseTrap = null; }
    }
  });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  ['wdReviewOverlay', 'wdAccountOverlay', 'wdLedgerOverlay'].forEach(id => {
    const el = document.getElementById(id);
    if (el?.classList.contains('open')) {
      el.classList.remove('open');
      if (wdReleaseTrap) { wdReleaseTrap(); wdReleaseTrap = null; }
    }
  });
});
