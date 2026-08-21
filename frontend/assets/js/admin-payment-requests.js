/* Admin — Payment Management (migration 0041)
   ===========================================
   The desk asks a merchant's manager to pay, the manager pays and uploads the
   proof, the desk approves, and only then does the wallet move.

   WHAT THIS REPLACED
   The section used to list per-booking payment transactions with a Verify and a
   Refund button. That flow is retired at the UI, not at the API: /api/admin/payments
   and its refund endpoint are untouched and still serve Reports and Analytics.
   What is gone is the *entry point*, because the spec replaced the workflow.

   WHY THERE IS NO CREDIT BUTTON HERE
   Approval is POST /api/admin/wallet/topups/{id}/verify — the same endpoint the
   Wallet & Top-ups desk has always used, unchanged. That endpoint is the only
   path that credits a merchant wallet from a payment, and it is protected by a
   row lock and by a unique index on the ledger link. Adding a second approval
   path for this screen would have put a credit outside that guard, so this
   screen calls the existing one.

   THE STATUS THAT MAKES IT SAFE
   A raised request is `awaiting_payment`, which the verify endpoint refuses
   with a 409. So there is no sequence of clicks on this screen that credits a
   wallet without a manager having paid — that is enforced by the server's
   status machine, not by hiding a button.

   MONEY
   Every figure arrives as a decimal string and goes through moneyStr(). Nothing
   is parsed into a Number: the browser does no money arithmetic (M4's rule).

   ENDPOINTS
     GET  /api/admin/merchants                              the company picker
     GET  /api/admin/merchants/{id}/managers                the manager picker
     POST /api/admin/wallet/payment-requests                raise one
     POST /api/admin/wallet/payment-requests/{id}/cancel    withdraw an unpaid one
     GET  /api/admin/wallet/topups                          the list, by bucket
     GET  /api/admin/wallet/topups/counts                   tab badges
     GET  /api/admin/wallet/topups/{id}                     one request, with balance
     GET  /api/admin/wallet/topups/{id}/proof               the uploaded proof
     POST /api/admin/wallet/topups/{id}/verify              approve — credits
     POST /api/admin/wallet/topups/{id}/reject              reject — moves nothing
*/

const PR_BUCKETS = [
  ['requests', 'Payment Requests'],
  ['pending', 'Pending'],
  ['verified', 'Approved'],
  ['rejected', 'Rejected'],
];

/* The three methods the desk may request, and the ONLY three the API accepts —
   `RaisePaymentRequest.method` is `Literal["bank_transfer", "cash", "crypto"]`
   (backend/app/schemas/payment_admin.py) and `payment_admin_service.REQUEST_METHODS`
   is the allowlist its instruction keys are filtered against. UPI and QR are
   absent on purpose and are NOT a gap in this screen: those are the merchant's
   own Add Money rails, where it pays into an account we published, while a
   payment request names where *we* want the money sent.

   ADDING A METHOD IS ONE ENTRY HERE PLUS ONE ON THE SERVER. Everything below
   is driven off this table — the picker, the section heading, the fields, the
   payload — so a fourth method inherits the identical layout by construction
   rather than by somebody remembering to match it. `type` is optional and
   defaults to a text input; `options` makes it a select. */
const PR_METHODS = {
  bank_transfer: {
    label: 'Bank Transfer',
    /* The heading over the method's own fields. Written per method rather than
       as "Payment Details" for all three, because the section is answering
       "where do we want it sent", and that reads differently for cash. */
    section: 'Bank account to pay into',
    fields: [
      ['bank_name', 'Bank Name'],
      ['account_number', 'Account Number'],
      ['ifsc', 'IFSC'],
      ['branch', 'Branch'],
    ],
  },
  cash: {
    label: 'Cash',
    section: 'Cash handover details',
    fields: [
      ['token_details', 'Token Details'],
      ['note_number', 'Unique Note Number'],
    ],
  },
  crypto: {
    label: 'Crypto',
    section: 'Wallet to send to',
    fields: [
      ['wallet_address', 'Wallet Address'],
      ['network', 'Network', { options: ['TRC20', 'ERC20', 'BEP20'] }],
    ],
  },
};

let prBucket = 'requests';
let prPage = 1;
let prSearch = '';
let prMerchantFilter = '';
let prMerchantCache = null;
let prReleaseTrap = null;

const prMoney = v => (typeof moneyStr === 'function' ? moneyStr(v) : `₹${v}`);

/* FastAPI's `detail` is a string for a raised HTTPException but an ARRAY of
   error objects for a 422. Returning it unchecked put a literal
   "[object Object]" on screen where the reason should have been. */
function prErr(err, fallback) {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const first = detail[0];
    const field = Array.isArray(first?.loc) ? first.loc[first.loc.length - 1] : null;
    return first?.msg ? `${field ? `${field}: ` : ''}${first.msg}` : fallback;
  }
  return fallback;
}

function prEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function prDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function prStatusChip(status) {
  /* Colour is never the only carrier — every badge carries its word. Reuses
     admin.css's existing .badge modifiers rather than introducing a parallel
     chip vocabulary for one screen. */
  const cls = {
    awaiting_payment: 'pending', submitted: 'pending',
    verified: 'confirmed', rejected: 'cancelled',
  }[status] || 'pending';
  const text = {
    awaiting_payment: 'Awaiting payment', submitted: 'Pending approval',
    verified: 'Approved', rejected: 'Rejected',
  }[status] || status;
  return `<span class="badge ${cls}">${prEsc(text)}</span>`;
}

/* ---------- The company picker, fetched once ---------- */
/* page_size is 100 because that is the endpoint's documented ceiling — asking
   for 200 is a 422, not a longer list. Paged rather than assumed: a platform
   with more than 100 active merchants keeps filling the dropdown instead of
   silently truncating it at whatever one request returned. */
async function prMerchants() {
  if (prMerchantCache) return prMerchantCache;
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const { data } = await axios.get(`${API_BASE}/api/admin/merchants`, {
      headers: authHeaders(), params: { page, page_size: 100 },
    });
    const items = data.items || [];
    all.push(...items);
    if (all.length >= (data.total || 0) || !items.length) break;
  }
  prMerchantCache = all
    .filter(m => m.status === 'active')
    .sort((a, b) => (a.merchant_name || '').localeCompare(b.merchant_name || ''));
  return prMerchantCache;
}

/* ---------- The list ---------- */
function prRenderTabs(counts) {
  const el = document.getElementById('prTabs');
  if (!el) return;
  el.innerHTML = PR_BUCKETS.map(([key, label]) => {
    const n = counts?.[key];
    return `<button class="ops-tab${key === prBucket ? ' active' : ''}" data-bucket="${key}"
              role="tab" aria-selected="${key === prBucket}">
              ${label}${n ? ` <span class="ops-tab-count">${n}</span>` : ''}
            </button>`;
  }).join('');
  el.querySelectorAll('[data-bucket]').forEach(b => {
    b.addEventListener('click', () => {
      prBucket = b.dataset.bucket;
      prPage = 1;
      loadPaymentRequests();
    });
  });
}

async function loadPaymentRequests(page = prPage) {
  prPage = page;
  const tbody = document.querySelector('#prTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Loading…</td></tr>';

  try {
    const [listRes, countsRes] = await Promise.all([
      axios.get(`${API_BASE}/api/admin/wallet/topups`, {
        headers: authHeaders(),
        params: {
          bucket: prBucket, page: prPage, page_size: PAGE_SIZE,
          search: prSearch || undefined,
          merchant_id: prMerchantFilter || undefined,
          initiated: 'admin',
        },
      }),
      axios.get(`${API_BASE}/api/admin/wallet/topups/counts`, {
        headers: authHeaders(), params: { initiated: 'admin' },
      }).catch(() => ({ data: {} })),
    ]);

    prRenderTabs(countsRes.data);

    /* `initiated: 'admin'` on BOTH calls. The queue endpoint is shared with the
       Wallet & Top-ups desk, which also carries the merchant's own Add Money
       submissions. Filtering in the browser instead made the badge read 349
       above a table of three, and left `total` counting rows this screen never
       shows — so page 2 could come back empty while the pager offered page 3. */
    const rows = listRes.data.items || [];

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">
        No ${prBucket === 'requests' ? 'open requests' : 'requests in this state'}.
      </td></tr>`;
    } else {
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td><strong>${prEsc(r.topup_number)}</strong>${
            r.resubmission_count
              ? `<div class="cell-sub">Resubmitted ×${r.resubmission_count}</div>` : ''
          }</td>
          <td class="jp-truncate" title="${prEsc(r.merchant_name || '—')}">${prEsc(r.merchant_name || '—')}</td>
          <td>${prEsc(r.assigned_manager_name || '—')}</td>
          <td class="num">${prMoney(r.amount)}</td>
          <td>${prEsc(PR_METHODS[r.method]?.label || r.method)}</td>
          <td>${prEsc(r.utr || '—')}</td>
          <td>${prStatusChip(r.status)}</td>
          <td><button class="btn btn-sm btn-ghost" data-view="${r.topup_id}">View</button></td>
        </tr>`).join('');

      tbody.querySelectorAll('[data-view]').forEach(b => {
        b.addEventListener('click', () => openPaymentRequestModal(Number(b.dataset.view)));
      });
    }

    /* The server's total already counts only this screen's rows, because the
       filter is applied there. Same helper and same argument order as every
       other admin table — (containerId, page, totalPages, total, cb). */
    const total = listRes.data.total || 0;
    renderPagination(
      'prPagination', prPage, Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total, loadPaymentRequests,
    );
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Could not load payment requests.</td></tr>';
    showToast(prErr(err, 'Could not load payment requests.'), true);
  }
}

/* ---------- Raising a request ----------
   ONE LAYOUT FOR EVERY METHOD, GENERATED RATHER THAN REPEATED.
   The method's fields used to be built by a function with a hardcoded `if
   (name === 'network')` branch, and they were written into a bare second
   `.form-grid` directly under the first — which, with §15's
   `.form-grid{margin-bottom:0}`, meant the two blocks touched. Every method had
   its own shape underneath: bank transfer contributed four fields, cash and
   crypto two, so where the seam fell moved with the picker and no two methods
   looked alike.

   Now every method renders through the same builder into the same section, so
   they are identical by construction: a heading, a two-column grid, the same
   42px controls, the same 24px rhythm. A method with an odd number of fields
   leaves the second column of its last row empty — which is what a two-column
   grid is supposed to do, and is stable rather than reflowing. */
function prField(name, label, opts = {}) {
  const id = `pr-${name}`;
  const control = opts.options
    ? `<select id="${id}" name="${name}" required>
         ${opts.options.map(o => `<option value="${prEsc(o)}">${prEsc(o)}</option>`).join('')}
       </select>`
    : `<input id="${id}" name="${name}" type="${opts.type || 'text'}"
              required maxlength="120" autocomplete="off">`;
  return `<div class="form-field">
    <label for="${id}">${prEsc(label)}</label>${control}</div>`;
}

/* The heading + grid for whichever method is selected, replaced as one block so
   the section title can never describe the fields under a different method. */
function prMethodSection(method) {
  const spec = PR_METHODS[method];
  if (!spec) return '';
  return `<div class="form-section-title">${prEsc(spec.section || 'Payment details')}</div>
    <div class="form-grid">
      ${spec.fields.map(([name, label, opts]) => prField(name, label, opts || {})).join('')}
    </div>`;
}

async function openRaisePaymentRequestModal() {
  const overlay = document.getElementById('prRaiseOverlay');
  const body = document.getElementById('prRaiseBody');
  body.innerHTML = '<h2>Initiate Payment Request</h2><p class="ops-sub">Loading companies…</p>';
  overlay.classList.add('open');
  prReleaseTrap?.();
  prReleaseTrap = typeof trapFocus === 'function' ? trapFocus(overlay) : null;

  let merchants = [];
  try {
    merchants = await prMerchants();
  } catch (err) {
    body.innerHTML = `<h2>Initiate Payment Request</h2>
      <p class="msg error">${prEsc(prErr(err, 'Could not load companies.'))}</p>`;
    return;
  }

  /* The explanatory line that used to sit here — "The manager is asked to pay.
     Nothing is credited until you approve the proof." — was removed on request.
     The workflow it described is unchanged: this endpoint still only *asks*,
     and a wallet is still credited nowhere but the top-up verify endpoint. */
  /* THREE SECTIONS, EACH A HEADING OVER ONE TWO-COLUMN GRID. Every field in the
     dialog now sits inside a `.form-grid`, including the note — which reaches
     full width through §15's `.form-field:has(textarea)` rule rather than by
     being written outside the grid, so it lines up with the columns above it
     instead of merely happening to be the same width. */
  body.innerHTML = `
    <h2>Initiate Payment Request</h2>
    <form id="prRaiseForm">
      <div class="form-section-title">Who is being asked, and for how much</div>
      <div class="form-grid">
        <div class="form-field"><label for="prMerchantSel">Merchant Company</label>
          <select id="prMerchantSel" name="merchant_id" required>
            <option value="">Select a company…</option>
            ${merchants.map(m => `<option value="${m.id}">${prEsc(m.merchant_name || m.company_name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field"><label for="prManagerSel">Merchant Manager</label>
          <select id="prManagerSel" name="manager_id" required disabled>
            <option value="">Select a company first</option>
          </select>
        </div>
        <div class="form-field"><label for="prAmountInput">Amount (₹)</label>
          <input id="prAmountInput" name="amount" type="number" min="0.01" step="0.01" required>
        </div>
        <div class="form-field"><label for="prMethodSel">Payment Method</label>
          <select id="prMethodSel" name="method" required>
            ${Object.entries(PR_METHODS).map(([v, s]) => `<option value="${v}">${prEsc(s.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <!-- form-section marks this as a bare grouping wrapper: it holds a heading
           and its grid so the two can be swapped together, and jp-ds.css §15
           gives it no spacing of its own (the heading inside already sets the
           32px section rhythm). NO BACKTICKS IN THIS COMMENT: it sits inside a
           template literal, and a backtick here closes it — which is a runtime
           ReferenceError that node --check still calls valid syntax. -->
      <div class="form-section" id="prMethodFields">${prMethodSection('bank_transfer')}</div>
      <div class="form-section-title">Anything the manager should know</div>
      <div class="form-grid">
        <div class="form-field"><label for="prNoteInput">Note to the manager <span class="cell-sub">(optional)</span></label>
          <textarea id="prNoteInput" name="note" rows="2" maxlength="500"></textarea>
        </div>
      </div>
      <div class="msg" id="prRaiseMsg"></div>
      <div class="modal-actions">
        <button type="submit" class="btn btn-coral">Send Request</button>
        <button type="button" class="btn btn-ghost" id="prRaiseCancel">Cancel</button>
      </div>
    </form>`;

  const form = document.getElementById('prRaiseForm');
  const close = () => { overlay.classList.remove('open'); prReleaseTrap?.(); prReleaseTrap = null; };
  document.getElementById('prRaiseCancel').addEventListener('click', close);

  /* Managers are fetched per company, not filtered from one big list: the list
     is the *server's* answer to "who may this be addressed to", and it applies
     the same active-manager rule the POST re-checks. */
  form.merchant_id.addEventListener('change', async () => {
    const sel = form.manager_id;
    const id = form.merchant_id.value;
    sel.disabled = true;
    sel.innerHTML = '<option value="">Loading…</option>';
    if (!id) { sel.innerHTML = '<option value="">Select a company first</option>'; return; }
    try {
      const { data } = await axios.get(`${API_BASE}/api/admin/merchants/${id}/managers`, {
        headers: authHeaders(),
      });
      if (!data.length) {
        sel.innerHTML = '<option value="">This company has no active manager</option>';
        return;
      }
      sel.innerHTML = '<option value="">Select a manager…</option>' + data.map(
        u => `<option value="${u.user_id}">${prEsc(u.full_name)} — ${prEsc(u.email)}</option>`
      ).join('');
      sel.disabled = false;
    } catch (err) {
      sel.innerHTML = `<option value="">${prEsc(prErr(err, 'Could not load managers'))}</option>`;
    }
  });

  /* Heading and fields are swapped together, as one block — replacing only the
     fields would leave "Bank account to pay into" over a crypto wallet. */
  form.method.addEventListener('change', () => {
    document.getElementById('prMethodFields').innerHTML = prMethodSection(form.method.value);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = document.getElementById('prRaiseMsg');
    const submit = form.querySelector('button[type=submit]');
    const method = form.method.value;

    const instructions = {};
    PR_METHODS[method].fields.forEach(([name]) => {
      instructions[name] = (form.elements[name]?.value || '').trim();
    });

    submit.disabled = true;
    msg.className = 'msg';
    msg.textContent = '';
    try {
      await axios.post(`${API_BASE}/api/admin/wallet/payment-requests`, {
        merchant_id: Number(form.merchant_id.value),
        manager_id: Number(form.manager_id.value),
        /* Sent as the typed string, never Number(): the API takes a decimal and
           a float round-trip is exactly the paise drift M4 banned. */
        amount: form.amount.value,
        method,
        instructions,
        note: form.note.value.trim() || null,
      }, { headers: authHeaders() });
      close();
      showToast('Payment request sent to the manager.');
      prBucket = 'requests';
      loadPaymentRequests(1);
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = prErr(err, 'Could not send the request.');
    } finally {
      submit.disabled = false;
    }
  });
}

/* ---------- One request ---------- */
async function openPaymentRequestModal(topupId) {
  const overlay = document.getElementById('prDetailOverlay');
  const body = document.getElementById('prDetailBody');
  body.innerHTML = '<p class="ops-sub">Loading…</p>';
  overlay.classList.add('open');
  prReleaseTrap?.();
  prReleaseTrap = typeof trapFocus === 'function' ? trapFocus(overlay) : null;

  const close = () => { overlay.classList.remove('open'); prReleaseTrap?.(); prReleaseTrap = null; };

  let d;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/wallet/topups/${topupId}`, {
      headers: authHeaders(),
    });
    d = data;
  } catch (err) {
    body.innerHTML = `<p class="msg error">${prEsc(prErr(err, 'Could not load that request.'))}</p>`;
    return;
  }

  const r = d.topup;
  const spec = PR_METHODS[r.method];

  /* Reuses admin.css's existing .detail-grid / .detail-item vocabulary rather
     than inventing a card class for one screen. */
  const item = (label, value) => `
    <div class="detail-item">
      <span class="detail-label">${prEsc(label)}</span>
      <span class="detail-value">${prEsc(value ?? '—') || '—'}</span>
    </div>`;

  const instructionRows = spec
    ? spec.fields.map(([name, label]) => item(label, r.instructions?.[name])).join('')
    : '';

  /* Which buttons exist is decided by status, and mirrors what the server will
     accept: an unpaid request can only be withdrawn, a paid one can only be
     approved or rejected, a decided one can be neither. */
  const canDecide = r.status === 'submitted';
  const canWithdraw = r.status === 'awaiting_payment';

  body.innerHTML = `
    <h2>${prEsc(r.topup_number)}</h2>
    <p class="ops-sub">
      ${prEsc(r.merchant_name || '')} · ${prStatusChip(r.status)}
    </p>

    <h3 class="ops-sub">Request</h3>
    <div class="detail-grid">
      ${item('Amount', prMoney(r.amount))}
      ${item('Method', spec?.label || r.method)}
      ${item('Manager', r.assigned_manager_name)}
      ${item('Raised by', r.raised_by_name)}
      ${item('Raised', prDateTime(r.submitted_at))}
    </div>

    <h3 class="ops-sub" style="margin-top:18px;">Payment instructions</h3>
    <div class="detail-grid">
      ${instructionRows}
      ${r.instructions?.note ? item('Note', r.instructions.note) : ''}
    </div>

    <h3 class="ops-sub" style="margin-top:18px;">Proof of payment</h3>
    <div class="detail-grid">
      ${item('UTR', r.utr)}
      ${item('Attachment', r.has_proof ? (r.proof_filename || 'Uploaded') : 'Not uploaded')}
      ${item('Resubmissions', String(r.resubmission_count || 0))}
    </div>
    ${r.has_proof
      ? '<button class="btn btn-sm btn-ghost" id="prProofBtn" style="margin-top:10px;">Download proof</button>'
      : ''}

    <h3 class="ops-sub" style="margin-top:18px;">Wallet</h3>
    <div class="detail-grid">
      ${item('Balance now', prMoney(d.wallet_balance))}
      ${item('Ledger entry', r.wallet_txn_number)}
      ${r.review_remarks ? item('Remarks', r.review_remarks) : ''}
      ${r.reviewed_at ? item('Decided', prDateTime(r.reviewed_at)) : ''}
    </div>

    ${canDecide ? `
      <div class="form-field" style="margin-top:16px;">
        <label>Remarks <span class="ops-sub">(required to reject)</span></label>
        <textarea id="prRemarks" rows="2" maxlength="500"
                  placeholder="What the merchant needs to know"></textarea>
      </div>` : ''}

    <div class="modal-actions">
      ${canDecide ? `
        <button class="btn btn-coral" id="prApprove">Approve &amp; Credit Wallet</button>
        <button class="btn btn-danger" id="prReject">Reject</button>` : ''}
      ${canWithdraw ? '<button class="btn btn-danger" id="prWithdraw">Withdraw Request</button>' : ''}
      <button class="btn btn-ghost" id="prDetailClose">Close</button>
    </div>`;

  document.getElementById('prDetailClose').addEventListener('click', close);

  document.getElementById('prProofBtn')?.addEventListener('click', async () => {
    try {
      const res = await axios.get(
        `${API_BASE}/api/admin/wallet/topups/${topupId}/proof`,
        { headers: authHeaders(), responseType: 'blob' },
      );
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.proof_filename || 'payment-proof';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(prErr(err, 'Could not download that proof.'), true);
    }
  });

  async function decide(action) {
    const remarks = (document.getElementById('prRemarks')?.value || '').trim();
    if (action === 'reject' && remarks.length < 3) {
      showToast('Say why it is being rejected — the merchant sees this.', true);
      document.getElementById('prRemarks')?.focus();
      return;
    }
    const ok = await confirmDialog({
      title: action === 'verify' ? 'Approve this payment?' : 'Reject this payment?',
      message: action === 'verify'
        ? `${prMoney(r.amount)} will be credited to ${r.merchant_name}. This cannot be undone.`
        : `${r.merchant_name} will be told: "${remarks}"`,
      confirmText: action === 'verify' ? 'Approve' : 'Reject',
    });
    if (!ok) return;

    try {
      await axios.post(
        `${API_BASE}/api/admin/wallet/topups/${topupId}/${action}`,
        action === 'verify' ? { remarks: remarks || null } : { remarks },
        { headers: authHeaders() },
      );
      close();
      showToast(action === 'verify' ? 'Approved — the wallet has been credited.' : 'Request rejected.');
      loadPaymentRequests(prPage);
    } catch (err) {
      showToast(prErr(err, 'Could not record that decision.'), true);
      /* A 409 means someone else decided it first, so the row on screen is
         stale — reload rather than leave a dead button. */
      if (err?.response?.status === 409) { close(); loadPaymentRequests(prPage); }
    }
  }

  document.getElementById('prApprove')?.addEventListener('click', () => decide('verify'));
  document.getElementById('prReject')?.addEventListener('click', () => decide('reject'));

  document.getElementById('prWithdraw')?.addEventListener('click', async () => {
    const reason = (document.getElementById('prRemarks')?.value || '').trim()
      || 'Withdrawn by the payments desk';
    const ok = await confirmDialog({
      title: 'Withdraw this request?',
      message: `${r.merchant_name} will see it as closed. Only possible while it is unpaid.`,
      confirmText: 'Withdraw',
    });
    if (!ok) return;
    try {
      await axios.post(
        `${API_BASE}/api/admin/wallet/payment-requests/${topupId}/cancel`,
        { remarks: reason }, { headers: authHeaders() },
      );
      close();
      showToast('Request withdrawn.');
      loadPaymentRequests(prPage);
    } catch (err) {
      showToast(prErr(err, 'Could not withdraw that request.'), true);
    }
  });
}

/* ---------- Wiring ---------- */
function initPaymentRequests() {
  document.getElementById('prRaiseBtn')?.addEventListener('click', openRaisePaymentRequestModal);

  let timer;
  document.getElementById('prSearch')?.addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => { prSearch = e.target.value.trim(); loadPaymentRequests(1); }, 300);
  });

  const filter = document.getElementById('prMerchantFilter');
  if (filter) {
    prMerchants().then(list => {
      filter.innerHTML = '<option value="">All</option>' + list.map(
        m => `<option value="${m.id}">${prEsc(m.merchant_name || m.company_name)}</option>`
      ).join('');
    }).catch(() => {});
    filter.addEventListener('change', e => {
      prMerchantFilter = e.target.value;
      loadPaymentRequests(1);
    });
  }

  document.querySelectorAll('#prRaiseOverlay, #prDetailOverlay').forEach(o => {
    o.addEventListener('click', e => {
      if (e.target === o) { o.classList.remove('open'); prReleaseTrap?.(); prReleaseTrap = null; }
    });
  });

  return loadPaymentRequests(1);
}
