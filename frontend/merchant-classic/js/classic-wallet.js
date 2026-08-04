'use strict';
/* Classic — Wallet (CR-4c).
   ===========================================================================
   The merchant's running account: what it holds, what it owes, everything that
   ever moved the balance, and the form for telling us money has been sent.

   THREE RULES THIS SCREEN EXISTS TO KEEP, ALL OF WHICH ARE EASY TO BREAK

   1. THE BALANCE MAY BE NEGATIVE, AND THAT IS NOT AN ERROR.
      A negative wallet IS the outstanding balance — the whole point of CR-4.
      It is rendered as an amount owed rather than a minus sign in a box that
      looks broken, but it is never clamped, hidden, or turned into zero.

   2. A SUBMITTED TOP-UP IS NOT MONEY.
      `pending_topups` comes back as its own field precisely so it cannot be
      added to the balance. Submitting credits nothing; an admin verifies it
      and the wallet moves then. This screen therefore shows two separate
      numbers and never a total of them — if it summed them, a merchant could
      raise its own spending power by typing a number into a form.

   3. NOTHING HERE COMPUTES MONEY.
      Every figure is rendered from the payload exactly as sent. The running
      balance in the ledger is `balance_after`, which the server stored at the
      moment the balance moved — this file does not accumulate one, because the
      order the client thinks rows are in can disagree with the order they
      actually happened in (WALLET_ARCHITECTURE §6). No `Number()` touches an
      amount anywhere in this file; money arrives as a decimal STRING and
      `moneyStr()` formats the string. The one exception is the Add Money form's
      own input, which is a user-typed value being validated before it is sent
      as a string — it never round-trips through a float on its way back. */

const CL_WALLET_PAGE_SIZE = 25;

let clWalletState = { page: 1, dateFrom: '', dateTo: '' };
let clWalletAccounts = [];
let clWalletQrUrl = null;   /* object URL; revoked before the next one is made */

/* Ledger type -> how it reads to a merchant. The server's enum values are
   internal; a merchant should not have to know that its booking charge is
   called `booking_debit`. Unknown types fall back to the humanised enum rather
   than rendering blank, so a type added later still says something. */
const CL_TXN_LABELS = {
  booking_debit: 'Ticket booked',
  wallet_recharge: 'Money added',
  refund_credit: 'Refund',
  manual_adjustment: 'Adjustment',
  credit_note: 'Credit note',
  cancellation_charge: 'Cancellation charge',
};

const CL_TOPUP_TONE = { submitted: 'warn', verified: 'ok', rejected: 'err' };
const CL_TOPUP_LABEL = {
  submitted: 'Awaiting verification', verified: 'Verified', rejected: 'Rejected',
};

const CL_METHOD_LABEL = {
  bank_transfer: 'Bank transfer', upi: 'UPI', qr: 'QR code',
  cash: 'Cash', other: 'Other',
};

function clInitWallet() {
  $('cl-wallet').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Wallet</h1>
        <p>Your running account with us. Tickets are charged to it when they are
           issued; add money any time to settle what is owed.</p>
      </div>
      <div>
        <button type="button" class="cl-btn cl-btn-primary" id="clWalletAddBtn">Add money</button>
      </div>
    </div>

    <!-- Two message slots, not one, and the split is deliberate. clWalletFlash
         is the transient "we recorded your payment" confirmation; clWalletAlert
         is the persistent credit-limit state, which clLoadWalletSummary owns and
         rewrites on every load, including setting it empty when nothing is
         wrong. Sharing one element meant the reload that follows a successful
         submission silently erased the confirmation the merchant had just
         earned. Found by driving the screen, not by reading it.
         (No backticks in this comment: it sits inside a template literal.) -->
    <div class="cl-msg" id="clWalletFlash"></div>
    <div class="cl-msg" id="clWalletAlert"></div>

    <div class="cl-kpis" id="clWalletKpis">
      <div class="cl-kpi"><div class="cl-kpi-label">Wallet</div>
        <div class="cl-kpi-value"><span class="cl-spin"></span></div>
        <div class="cl-kpi-sub">Loading…</div></div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Money you have added</h2>
        <div class="cl-panel-tools">
          <button type="button" class="cl-btn cl-btn-sm" id="clTopupRefresh">Refresh</button>
        </div>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Reference</th><th>Sent on</th><th>Method</th><th>Paid into</th>
              <th>UTR</th><th class="cl-num">Amount</th><th>Status</th>
              <th class="cl-actions">Proof</th>
            </tr></thead>
            <tbody id="clTopupBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-panel-note" id="clTopupNote"></div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Transaction history</h2>
        <div class="cl-panel-tools">
          <label class="cl-sr" for="clWalletFrom">From date</label>
          <input type="date" id="clWalletFrom">
          <label class="cl-sr" for="clWalletTo">To date</label>
          <input type="date" id="clWalletTo">
          <button type="button" class="cl-btn cl-btn-sm" id="clWalletApply">Apply</button>
          <button type="button" class="cl-btn cl-btn-sm" id="clWalletClear">Clear</button>
        </div>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Date</th><th>Reference</th><th>Type</th><th>Details</th>
              <th class="cl-num">Debit</th><th class="cl-num">Credit</th>
              <th class="cl-num">Balance</th>
            </tr></thead>
            <tbody id="clWalletBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-pager">
        <span class="cl-pager-info" id="clWalletCount">—</span>
        <button type="button" class="cl-btn cl-btn-sm" id="clWalletPrev">Previous</button>
        <button type="button" class="cl-btn cl-btn-sm" id="clWalletNext">Next</button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>How your account works</h2></div>
      <div class="cl-panel-body">
        <ol style="margin:0;padding-left:17px;font-size:12.5px;color:var(--cl-ink-soft);line-height:1.7;">
          <li>You book as usual. Nothing is charged while a booking is being arranged.</li>
          <li>When we issue the ticket, its fare is <b>debited from this wallet</b>.</li>
          <li>The balance may go <b>negative</b> — that is simply what you owe, and you
              can keep booking up to your credit limit.</li>
          <li>Add money any time. We verify the transfer before it is credited, so a
              submission shows as <b>awaiting verification</b> until then.</li>
        </ol>
      </div>
    </div>`;

  $('clWalletAddBtn').addEventListener('click', () => clOpenAddMoney());
  $('clTopupRefresh').addEventListener('click', () => clLoadTopups());
  $('clWalletApply').addEventListener('click', () => {
    clWalletState.dateFrom = $('clWalletFrom').value;
    clWalletState.dateTo = $('clWalletTo').value;
    clWalletState.page = 1;
    clLoadWalletLedger();
  });
  $('clWalletClear').addEventListener('click', () => {
    $('clWalletFrom').value = '';
    $('clWalletTo').value = '';
    clWalletState = { page: 1, dateFrom: '', dateTo: '' };
    clLoadWalletLedger();
  });
  $('clWalletPrev').addEventListener('click', () => {
    if (clWalletState.page > 1) { clWalletState.page -= 1; clLoadWalletLedger(); }
  });
  $('clWalletNext').addEventListener('click', () => {
    clWalletState.page += 1; clLoadWalletLedger();
  });

  return Promise.all([clLoadWalletSummary(), clLoadTopups(), clLoadWalletLedger()]);
}

/* --------------------------------------------------------------- summary */

async function clLoadWalletSummary() {
  const box = $('clWalletKpis');
  const alert = $('clWalletAlert');
  try {
    const w = await MerchantApi.wallet();

    /* `moneyIsPositive` on the outstanding rather than a sign test on the
       balance: outstanding is the server's own floored-at-zero figure, so the
       two cannot disagree about whether anything is owed. */
    const owes = moneyIsPositive(w.outstanding);

    const tiles = [
      owes
        ? ['Outstanding', moneyStr(w.outstanding), 'owed on your account']
        : ['Wallet balance', moneyStr(w.balance), 'available on account'],
      ['Total added', moneyStr(w.total_credits), 'credited to date'],
      ['Total booked', moneyStr(w.total_debits), 'charged to date'],
    ];

    if (w.pending_topup_count > 0) {
      /* Its own tile, never folded into the balance — see rule 2 at the top. */
      tiles.push(['Awaiting verification', moneyStr(w.pending_topups),
                  `${w.pending_topup_count} submission${w.pending_topup_count === 1 ? '' : 's'} being checked`]);
    }

    tiles.push(w.has_credit_limit
      ? ['Credit available', moneyStr(w.credit_available),
         `of a ${moneyStr(w.credit_limit)} limit`]
      : ['Credit limit', 'Not set', 'no standing credit on this account']);

    if (w.transaction_count > 0 && w.last_transaction_at) {
      tiles.push(['Last movement', fmtDate(w.last_transaction_at),
                  `${w.transaction_count} transaction${w.transaction_count === 1 ? '' : 's'} in total`]);
    }

    box.innerHTML = tiles.map(([label, value, sub]) => `
      <div class="cl-kpi">
        <div class="cl-kpi-label">${escapeHtml(label)}</div>
        <div class="cl-kpi-value">${escapeHtml(value)}</div>
        <div class="cl-kpi-sub">${escapeHtml(sub)}</div>
      </div>`).join('');

    /* The warning states the server's own conclusion (`is_over_limit`,
       `is_low_balance`) rather than re-deriving a threshold here. A screen with
       its own idea of "low" is a screen that eventually disagrees with the gate
       that actually blocks the booking. */
    if (w.is_over_limit) {
      clMsg(alert,
        `You have reached your credit limit of ${moneyStr(w.credit_limit)}. `
        + 'New bookings will be declined until you add money to the wallet, '
        + 'or ask us to raise the limit.', 'err');
    } else if (w.is_low_balance) {
      clMsg(alert,
        `Only ${moneyStr(w.credit_available)} of credit remains against your `
        + `${moneyStr(w.credit_limit)} limit. Add money soon to avoid bookings being declined.`,
        'warn');
    } else {
      clMsg(alert, '');
    }
  } catch (err) {
    box.innerHTML = `<div class="cl-kpi"><div class="cl-kpi-label">Wallet</div>
      <div class="cl-kpi-value">—</div>
      <div class="cl-kpi-sub">${escapeHtml(clError(err, 'Could not load your wallet.'))}</div></div>`;
  }
}

/* ---------------------------------------------------------------- ledger */

async function clLoadWalletLedger() {
  const body = $('clWalletBody');
  const count = $('clWalletCount');
  body.innerHTML = clLoadingRow(7, 'Loading transactions…');

  try {
    const p = await MerchantApi.walletTransactions({
      dateFrom: clWalletState.dateFrom, dateTo: clWalletState.dateTo,
      page: clWalletState.page, pageSize: CL_WALLET_PAGE_SIZE,
    });

    if (!p.items.length) {
      body.innerHTML = clEmptyRow(7, clWalletState.page > 1
        ? 'No more transactions.'
        : 'Nothing has moved on your wallet yet.');
    } else {
      body.innerHTML = p.items.map(t => `
        <tr>
          <td class="cl-nowrap">${escapeHtml(fmtDate(t.created_at))}</td>
          <td class="cl-nowrap"><code>${escapeHtml(t.txn_number)}</code></td>
          <td>${escapeHtml(CL_TXN_LABELS[t.txn_type] || clLabel(t.txn_type))}</td>
          <td>${escapeHtml(clWalletDetail(t))}</td>
          <td class="cl-num">${moneyIsPositive(t.debit) ? escapeHtml(moneyStr(t.debit)) : '—'}</td>
          <td class="cl-num">${moneyIsPositive(t.credit) ? escapeHtml(moneyStr(t.credit)) : '—'}</td>
          <td class="cl-num">${escapeHtml(moneyStr(t.balance_after))}</td>
        </tr>`).join('');
    }

    const first = (p.page - 1) * p.page_size + 1;
    const last = (p.page - 1) * p.page_size + p.items.length;
    count.textContent = p.total
      ? `Showing ${first}–${last} of ${p.total}`
      : 'No transactions';
    $('clWalletPrev').disabled = p.page <= 1;
    $('clWalletNext').disabled = last >= p.total;
  } catch (err) {
    body.innerHTML = clEmptyRow(7, clError(err, 'Could not load your transactions.'));
    count.textContent = '—';
  }
}

/* The booking number when there is one, otherwise the reason staff recorded.
   Never the internal id — WALLET_ARCHITECTURE §2.5. */
function clWalletDetail(t) {
  if (t.request_number) return t.request_number;
  return t.reason || '—';
}

/* --------------------------------------------------------------- top-ups */

async function clLoadTopups() {
  const body = $('clTopupBody');
  const note = $('clTopupNote');
  body.innerHTML = clLoadingRow(8, 'Loading…');
  note.textContent = '';

  try {
    const p = await MerchantApi.listTopups({ pageSize: 10 });
    if (!p.items.length) {
      body.innerHTML = clEmptyRow(8,
        'You have not told us about any payments yet. Use “Add money” when you have sent one.');
      return;
    }
    body.innerHTML = p.items.map(t => `
      <tr>
        <td class="cl-nowrap"><code>${escapeHtml(t.topup_number)}</code></td>
        <td class="cl-nowrap">${escapeHtml(fmtDate(t.submitted_at))}</td>
        <td>${escapeHtml(CL_METHOD_LABEL[t.method] || clLabel(t.method))}</td>
        <td>${escapeHtml(t.payment_account_label || '—')}</td>
        <td>${escapeHtml(t.utr || '—')}</td>
        <td class="cl-num">${escapeHtml(moneyStr(t.amount))}</td>
        <td>
          <span class="cl-tag cl-tag-${CL_TOPUP_TONE[t.status] || 'info'}">${escapeHtml(CL_TOPUP_LABEL[t.status] || clLabel(t.status))}</span>
          ${t.status === 'verified' && t.wallet_txn_number
            ? `<br><small>${escapeHtml(t.wallet_txn_number)}</small>` : ''}
          ${t.status === 'rejected' && t.review_remarks
            ? `<br><small>${escapeHtml(t.review_remarks)}</small>` : ''}
        </td>
        <td class="cl-actions">${t.has_proof
          ? `<button type="button" class="cl-btn cl-btn-sm" data-cl-proof="${escapeHtml(String(t.topup_id))}">View</button>`
          : '—'}</td>
      </tr>`).join('');

    if (p.total > p.items.length) {
      note.textContent = `Showing your ${p.items.length} most recent of ${p.total} submissions.`;
    }

    body.querySelectorAll('[data-cl-proof]').forEach(b => {
      b.addEventListener('click', () => clOpenProof(b.dataset.clProof));
    });
  } catch (err) {
    body.innerHTML = clEmptyRow(8, clError(err, 'Could not load your payments.'));
  }
}

/* Downloads are authenticated, so a plain href cannot fetch them — pulled as a
   blob with the bearer token, opened, and the object URL revoked. */
async function clOpenProof(topupId) {
  let url = null;
  try {
    url = await MerchantApi.downloadTopupProof(topupId);
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    clMsg($('clWalletFlash'), clError(err, 'Could not open that file.'), 'err');
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

/* ------------------------------------------------------------ add money */

async function clOpenAddMoney() {
  clOpenModal('Add money', `
    <div class="cl-msg cl-msg-info" style="margin:0 0 14px;">
      Send the money using one of the accounts below, then tell us about it here.
      <b>Your wallet is credited once we have verified the transfer</b> — usually
      the same working day.
    </div>
    <div id="clTopupAccounts"><span class="cl-spin"></span> Loading payment details…</div>
    <form class="cl-form" id="clTopupForm" style="margin-top:16px;" novalidate>
      <div class="cl-field cl-field-wide">
        <label for="clTopupAmount">Amount sent <span class="cl-req">*</span></label>
        <input type="number" id="clTopupAmount" min="0.01" step="0.01" inputmode="decimal"
               placeholder="0.00" required aria-describedby="clTopupAmountHelp">
        <small id="clTopupAmountHelp">Exactly what you transferred, in rupees.</small>
      </div>
      <div class="cl-field cl-field-wide">
        <label for="clTopupMethod">How did you pay? <span class="cl-req">*</span></label>
        <select id="clTopupMethod" required>
          <option value="bank_transfer">Bank transfer (NEFT / RTGS / IMPS)</option>
          <option value="upi">UPI</option>
          <option value="qr">QR code</option>
        </select>
      </div>
      <div class="cl-field cl-field-full">
        <label for="clTopupAccount">Which account did you pay into?</label>
        <select id="clTopupAccount" aria-describedby="clTopupAccountHelp">
          <option value="">— Select —</option>
        </select>
        <small id="clTopupAccountHelp">Helps us find your payment faster.</small>
      </div>
      <div class="cl-field cl-field-wide">
        <label for="clTopupUtr">UTR / reference number <span class="cl-req" id="clTopupUtrReq">*</span></label>
        <input type="text" id="clTopupUtr" maxlength="64" autocomplete="off"
               aria-describedby="clTopupUtrHelp">
        <small id="clTopupUtrHelp">The reference from your bank or UPI app.</small>
      </div>
      <div class="cl-field cl-field-wide">
        <label for="clTopupProof">Payment screenshot</label>
        <input type="file" id="clTopupProof" accept="image/png,image/jpeg,image/webp,application/pdf"
               aria-describedby="clTopupProofHelp">
        <small id="clTopupProofHelp">PNG, JPEG, WebP or PDF. Optional if you have entered a UTR.</small>
      </div>
    </form>
    <div class="cl-msg" id="clTopupMsg" style="margin:12px 0 0;"></div>`,
    `<button type="button" class="cl-btn" data-cl-close="1">Cancel</button>
     <button type="button" class="cl-btn cl-btn-primary" id="clTopupSubmit">Submit payment</button>`);

  $('clModalFoot').querySelector('[data-cl-close]')
    .addEventListener('click', () => clCloseModal());
  $('clTopupSubmit').addEventListener('click', () => clSubmitTopup());

  /* The UTR is mandatory for a bank transfer and merely recommended otherwise —
     the same rule the server enforces, mirrored here so the form does not offer
     a submission the server will refuse. */
  $('clTopupMethod').addEventListener('change', () => {
    const bank = $('clTopupMethod').value === 'bank_transfer';
    $('clTopupUtrReq').style.display = bank ? '' : 'none';
    $('clTopupUtrHelp').textContent = bank
      ? 'Required for a bank transfer — it is how we match your payment.'
      : 'Enter it if you have one, or attach a screenshot instead.';
  });

  /* Released when the modal closes, so a QR blob does not leak on every open. */
  clModalOnClose = () => {
    if (clWalletQrUrl) { URL.revokeObjectURL(clWalletQrUrl); clWalletQrUrl = null; }
  };

  await clLoadPaymentAccounts();
}

async function clLoadPaymentAccounts() {
  const box = $('clTopupAccounts');
  const select = $('clTopupAccount');
  try {
    clWalletAccounts = await MerchantApi.paymentAccounts();

    if (!clWalletAccounts.length) {
      /* An honest empty state. The alternative — an empty box — leaves the
         merchant guessing whether the screen is broken or the platform simply
         has not published its details yet. */
      box.innerHTML = `<div class="cl-msg cl-msg-warn" style="margin:0;">
        No payment details have been published yet. Please contact us for the account
        to pay into — you can still record the payment below once you have sent it.
      </div>`;
      return;
    }

    box.innerHTML = clWalletAccounts.map(a => `
      <div class="cl-note cl-wallet-acct" style="margin-bottom:8px;">
        <b>${escapeHtml(a.label)}</b>
        <span class="cl-tag cl-tag-info">${escapeHtml(CL_METHOD_LABEL[a.account_type] || clLabel(a.account_type))}</span>
        <dl class="cl-dl" style="margin-top:8px;">
          ${Object.entries(a.details || {}).map(([k, v]) => `
            <div><dt>${escapeHtml(clLabel(k))}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}
        </dl>
        ${a.has_qr_image
          ? `<button type="button" class="cl-btn cl-btn-sm" data-cl-qr="${escapeHtml(String(a.account_id))}">Show QR code</button>
             <div data-cl-qr-box="${escapeHtml(String(a.account_id))}"></div>`
          : ''}
      </div>`).join('');

    select.innerHTML = '<option value="">— Select —</option>'
      + clWalletAccounts.map(a =>
          `<option value="${escapeHtml(String(a.account_id))}">${escapeHtml(a.label)}</option>`).join('');

    box.querySelectorAll('[data-cl-qr]').forEach(b => {
      b.addEventListener('click', () => clShowQr(b.dataset.clQr, b));
    });
  } catch (err) {
    box.innerHTML = `<div class="cl-msg cl-msg-err" style="margin:0;">${escapeHtml(
      clError(err, 'Could not load payment details.'))}</div>`;
  }
}

async function clShowQr(accountId, button) {
  const target = $('clTopupAccounts').querySelector(`[data-cl-qr-box="${accountId}"]`);
  if (!target) return;
  button.disabled = true;
  try {
    if (clWalletQrUrl) URL.revokeObjectURL(clWalletQrUrl);
    clWalletQrUrl = await MerchantApi.paymentAccountQr(accountId);
    target.innerHTML = `<img class="cl-wallet-qr" src="${clWalletQrUrl}"
      alt="QR code for this payment account">`;
  } catch (err) {
    target.innerHTML = `<div class="cl-msg cl-msg-err" style="margin:8px 0 0;">${escapeHtml(
      clError(err, 'Could not load the QR code.'))}</div>`;
  } finally {
    button.disabled = false;
  }
}

async function clSubmitTopup() {
  const msg = $('clTopupMsg');
  const amountEl = $('clTopupAmount');
  const methodEl = $('clTopupMethod');
  const utrEl = $('clTopupUtr');
  const fileEl = $('clTopupProof');
  const btn = $('clTopupSubmit');

  /* Validated here only to save a round trip and to put the cursor back in the
     offending field. The server enforces every one of these rules again — this
     is convenience, not security, and the two must not disagree. */
  const amount = amountEl.value.trim();
  if (!amount || !(Number(amount) > 0)) {
    clMsg(msg, 'Enter the amount you have paid.', 'err');
    amountEl.focus();
    return;
  }
  const method = methodEl.value;
  const utr = utrEl.value.trim();
  const file = fileEl.files && fileEl.files[0];

  if (method === 'bank_transfer' && !utr) {
    clMsg(msg, 'Enter the UTR or reference number from your bank transfer.', 'err');
    utrEl.focus();
    return;
  }
  if (!utr && !file) {
    clMsg(msg, 'Add the UTR, or attach a screenshot of the payment.', 'err');
    utrEl.focus();
    return;
  }

  btn.disabled = true;
  clMsg(msg, 'Submitting…', 'info');
  try {
    /* `amount` is sent as the STRING the user typed. It is never parsed into a
       float on the way out — the server's field is a Decimal, and M4's rule is
       that money does not become a float anywhere on the path. */
    const t = await MerchantApi.submitTopup({
      amount,
      method,
      paymentAccountId: $('clTopupAccount').value || null,
      utr: utr || null,
      proof: file || null,
    });
    clCloseModal();
    clMsg($('clWalletFlash'),
      `Thank you — ${t.topup_number} for ${moneyStr(t.amount)} has been recorded and is `
      + 'awaiting verification. Your wallet will be credited once we confirm the transfer.',
      'ok');
    /* The dashboard shows a wallet figure too, so it is stale the moment this
       succeeds — even though the balance has not moved, the pending total has. */
    clInvalidate('dashboard');
    await Promise.all([clLoadWalletSummary(), clLoadTopups()]);
  } catch (err) {
    clMsg(msg, clError(err, 'Could not record that payment.'), 'err');
    btn.disabled = false;
  }
}
