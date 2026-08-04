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
  reschedule_fee: 'Reschedule fee',
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
    <!-- THE WALLET IS A READ-ONLY LEDGER NOW.
         "Add money" is gone, and with it the merchant-initiated top-up. Money
         reaches this account one way only: an Admin raises a payment request on
         Payment Management, the merchant pays and uploads proof, an Admin
         approves it, and the wallet is credited at that point. Nothing on this
         screen writes.

         clOpenAddMoney() and the whole top-up submit path below are LEFT IN
         PLACE and still work — POST /api/wallet/top-ups is unchanged and the
         Admin's Wallet & Top-ups desk still processes what is already in
         flight. Only the way in from this screen is gone. -->
    <div class="cl-page-head">
      <div>
        <h1>Wallet</h1>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clWalletRefresh">
          ${clIco('refresh', { size: 15 })} Refresh
        </button>
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

    <div id="clWalletTrend"></div>

    <!-- "Money you have added" MOVED TO PAYMENT MANAGEMENT, not deleted.
         It listed top-up requests including pending and rejected ones, and this
         screen is now defined as completed wallet movement only — a pending
         request is not money on the account, and showing it here is how a
         balance gets read as larger than it is. Every state of a request now
         lives on Payment Management, which is the screen about requests.
         clLoadTopups, clTopupBody and clTopupNote still exist in this module;
         they simply have no host element on this screen, and clLoadTopups
         returns early when that is the case. (No backticks in this comment: it
         sits inside a template literal and one would close it.) -->

    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Wallet History</h2>
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
            <!-- A FULL STATEMENT LINE, in the order a statement is read:
                 when, what it is called, what kind of movement, which
                 direction, what it stood at, how much moved, what it stands at
                 now, whether it settled, and what it settled.

                 Opening and Closing are BOTH shown, and both are the server's
                 stored balance_before / balance_after — never a running total
                 accumulated in the browser, which would disagree with the
                 wallet the moment a page boundary fell mid-day.

                 Status is on every row and is always Completed, because
                 wallet_transactions only ever holds money that has actually
                 moved. It is stated rather than assumed so the column means the
                 same thing here as on Payment Management, where a request can
                 genuinely still be pending.
                 (No backticks in this comment: it sits inside a template
                 literal and one would close it.) -->
            <thead><tr>
              <th>Date &amp; time</th><th>Reference</th><th>Transaction type</th>
              <th>Debit / credit</th>
              <th class="cl-num">Opening</th><th class="cl-num">Amount</th>
              <th class="cl-num">Closing</th>
              <th>Status</th><th>Payment request</th>
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
      <div class="cl-panel-head"><h2>${clIco('info')}How your account works</h2></div>
      <div class="cl-panel-body">
        <ol style="margin:0;padding-left:20px;font-size:13px;color:var(--cl-text-2);line-height:1.85;">
          <li>You book as usual. Nothing is charged while a booking is being arranged.</li>
          <li>When we issue the ticket, its fare is <b>debited from this wallet</b>.</li>
          <li>The balance may go <b>negative</b> — that is simply what you owe. You can keep
              booking while it is, within whatever headroom your account carries.</li>
          <li>Money reaches this account through a payment request our team raises.
              You settle it and upload proof on <b>Payment Management</b>; the wallet
              is credited once that payment has been approved.</li>
        </ol>
      </div>
    </div>`;

  /* No Add-money and no top-up table on this screen any more, so neither
     control is bound and clLoadTopups is not called from here. */
  $('clWalletRefresh').addEventListener('click', () => {
    clLoadWalletSummary(); clLoadWalletLedger(); clLoadWalletTrend();
  });
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

  /* clLoadTopups() WAS IN THIS LIST AND IT SHOULD NOT HAVE BEEN.
     The comment three lines above already said "clLoadTopups is not called from
     here" — the call simply outlived the conversion to a read-only ledger. It
     writes to `#clTopupBody`, which went with the "Money you have added" panel,
     so every FIRST visit to this screen raised an unhandled rejection
     (`Cannot set properties of null`) after the other three loaders had already
     been kicked off. Nothing rendered wrong, which is exactly why it survived. */
  return Promise.all([
    clLoadWalletSummary(), clLoadWalletLedger(), clLoadWalletTrend(),
  ]);
}

/* ----------------------------------------------------------------- trend */

/* THE CLOSING BALANCE AT EACH MONTH END, over the last six months.
   ---------------------------------------------------------------------------
   Every point is a `balance_after` the server stored at the moment the balance
   moved. Nothing here accumulates a running total — rule 3 at the top of this
   file — so this chart cannot disagree with the statement below it.

   IT ASKS THE LEDGER ONE MONTH AT A TIME, AND ONLY FOR THAT MONTH'S LAST ROW.
   The endpoint is oldest-first, capped at 100 rows a page, and has no
   aggregate, so neither end of a whole-window fetch is the answer: page 1 is
   the oldest 100 movements, and the final pages are all from the most recent
   day. The first build walked back from the end and, on an account whose 976
   movements sit in a two-day span, saw only August — it drew one point and
   reported "one month of history" about a wallet with two.

   So: per month, `page_size: 1` to read `total` (the database's COUNT(*) under
   that date filter), then `page: total` to fetch exactly the last row. Twelve
   one-row calls, exact at any volume, and the count in the caption is the
   server's own rather than a length.

   A month with no movement inherits the previous month's close — not an
   assumption, but what a balance does when nothing touches it. A month BEFORE
   the earliest movement is left out rather than drawn at zero, which would show
   a merchant a wallet it never had. */
const CL_TREND_MONTHS = 6;

async function clLoadWalletTrend() {
  const host = $('clWalletTrend');
  if (!host) return;

  const now = new Date();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /* The six month windows, oldest first. The last one ends today, not at a
     month end that has not happened yet. */
  const windows = [];
  for (let i = CL_TREND_MONTHS - 1; i >= 0; i--) {
    const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const lastOfMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    windows.push({
      key: `${first.getFullYear()}-${first.getMonth()}`,
      label: first.toLocaleDateString('en-IN', { month: 'short' }),
      from: iso(first),
      to: iso(lastOfMonth > now ? now : lastOfMonth),
    });
  }

  let months;
  try {
    months = await Promise.all(windows.map(async win => {
      const head = await MerchantApi.walletTransactions({
        dateFrom: win.from, dateTo: win.to, page: 1, pageSize: 1,
      });
      const count = head.total ?? 0;
      if (!count) return { ...win, count: 0, close: null };
      /* page === total with page_size 1 is the month's LAST movement. */
      const tail = count === 1 ? head : await MerchantApi.walletTransactions({
        dateFrom: win.from, dateTo: win.to, page: count, pageSize: 1,
      });
      const row = (tail.items || [])[0];
      return { ...win, count, close: row ? row.balance_after : null };
    }));
  } catch {
    host.innerHTML = '';       /* the statement below is the real record */
    return;
  }

  const total = months.reduce((n, m) => n + m.count, 0);
  if (!total) {
    host.innerHTML = `<div class="cl-panel cl-chart">
      <div class="cl-panel-head"><h2>${clIco('trend')}Balance trend</h2></div>
      <div class="cl-panel-body">
        <p class="cl-kpi-sub" style="margin:0;">
          Nothing has moved on your wallet in the last ${CL_TREND_MONTHS} months, so there is no
          trend to draw yet.</p>
      </div></div>`;
    return;
  }

  const buckets = [];
  let carried = null;
  months.forEach(m => {
    const close = m.close != null ? m.close : carried;
    if (close == null) return;                /* before the earliest movement */
    carried = close;
    buckets.push({
      label: m.label,
      value: Number(close) || 0,
      exact: close,
      carried: m.close == null,
    });
  });

  if (buckets.length < 2) {
    host.innerHTML = `<div class="cl-panel cl-chart">
      <div class="cl-panel-head"><h2>${clIco('trend')}Balance trend</h2></div>
      <div class="cl-panel-body">
        <p class="cl-kpi-sub" style="margin:0;">
          Your wallet has one month of history so far. The trend appears once there are two.</p>
      </div></div>`;
    return;
  }

  /* `total` is the sum of six server-side COUNT(*)s, not a length — nothing was
     truncated to draw this, so there is no coverage caveat to state. */
  const caption = `Closing balance each month end · ${total} movement${total === 1 ? '' : 's'}`;

  host.innerHTML = `<div class="cl-panel cl-chart">
    <div class="cl-panel-head">
      <h2>${clIco('trend')}Balance trend</h2>
      <div class="cl-panel-tools"><span class="cl-kpi-sub">${escapeHtml(caption)}</span></div>
    </div>
    <div class="cl-panel-body">
      ${clBalanceChart(buckets)}
      ${buckets.some(b => b.carried) ? `<p class="cl-kpi-sub" style="margin:10px 0 0;">
        A month with no movement carries the previous month's closing balance forward.</p>` : ''}
    </div>
  </div>`;
}

/* A signed area chart. The portal's other charts all measure counts and money
   that cannot go below zero, so they scale 0..max and draw up from the floor.
   A WALLET CAN BE NEGATIVE — that is the whole of CR-4 — so this one finds its
   own baseline: the zero line sits wherever zero falls in the range, the fill
   runs from the line to the balance in either direction, and a month in the
   red is drawn in the danger tone rather than as a point below the frame. */
/* clShortMoney() is written for figures that cannot go below zero, so a
   negative lands in none of its branches and renders as a raw "₹-250000".
   The sign is carried by a real minus glyph, outside the abbreviation. */
function clSignedShort(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '−' : '') + clShortMoney(Math.abs(v));
}

function clBalanceChart(buckets) {
  const { w, h, x0, x1, yTop, yBase, yLab } = CL_CH;
  const values = buckets.map(b => b.value);
  const rawMax = Math.max(...values, 0);
  const rawMin = Math.min(...values, 0);
  /* A flat-zero wallet would give a zero-height range and divide by zero. */
  const span = (rawMax - rawMin) || 1;
  const pad = span * 0.12;
  const top = rawMax + pad;
  /* An account that has never gone negative gets zero as its floor. Padding
     below the lowest month would otherwise print a negative axis label under a
     wallet that has only ever been in credit — a range it never occupied. */
  const bottom = rawMin < 0 ? rawMin - pad : 0;
  const y = v => yBase - ((v - bottom) / (top - bottom)) * (yBase - yTop);
  const band = (x1 - x0) / buckets.length;
  const gid = `clw${Math.random().toString(36).slice(2, 8)}`;
  const zeroY = y(0);
  const negative = rawMin < 0;
  const colour = negative ? 'var(--cl-danger)' : 'var(--cl-success)';

  const grid = [top, (top + bottom) / 2, bottom].map(v =>
    `<line x1="${x0}" y1="${y(v).toFixed(1)}" x2="${x1}" y2="${y(v).toFixed(1)}"
           stroke="var(--cl-line-2)" stroke-width="1"/>
     <text x="${x0 - 9}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5"
           font-weight="600" fill="var(--cl-text-muted)">${escapeHtml(clSignedShort(v))}</text>`).join('');

  /* The zero line is drawn only when the range crosses it — on an account that
     has never gone negative it would just be the axis floor twice. */
  const zeroLine = negative
    ? `<line x1="${x0}" y1="${zeroY.toFixed(1)}" x2="${x1}" y2="${zeroY.toFixed(1)}"
             stroke="var(--cl-text-muted)" stroke-width="1.4" stroke-dasharray="4 4"/>`
    : '';

  const points = buckets.map((b, i) => [x0 + band * (i + 0.5), y(b.value)]);
  const line = points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${points[0][0].toFixed(1)},${zeroY.toFixed(1)} ${line} `
    + `${points[points.length - 1][0].toFixed(1)},${zeroY.toFixed(1)}`;

  const labels = buckets.map((b, i) =>
    `<text x="${(x0 + band * (i + 0.5)).toFixed(1)}" y="${yLab}" text-anchor="middle"
           font-size="10.5" font-weight="700"
           fill="var(--cl-text-muted)">${escapeHtml(b.label)}</text>`).join('');

  const dots = points.map(([px, py], i) => {
    const b = buckets[i];
    const below = b.value < 0;
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4"
                    fill="var(--cl-surface)" stroke="${below ? 'var(--cl-danger)' : colour}"
                    stroke-width="2.5"/>
      <text x="${px.toFixed(1)}" y="${(below ? py + 15 : py - 11).toFixed(1)}" text-anchor="middle"
            font-size="9.5" font-weight="800"
            fill="var(--cl-text)">${escapeHtml(clSignedShort(b.value))}</text>`;
  }).join('');

  const last = buckets[buckets.length - 1];
  const label = `Wallet balance at each month end, ${buckets[0].label} to ${last.label}`
    + `, ending at ${moneyStr(last.exact)}`;

  return `<svg class="cl-chart-svg" viewBox="0 0 ${w} ${h}" role="img"
               aria-label="${escapeHtml(label)}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${colour}" stop-opacity=".30"/>
      <stop offset="100%" stop-color="${colour}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <polygon points="${area}" fill="url(#${gid})"/>
    <polyline points="${line}" fill="none" stroke="${colour}" stroke-width="2.5"
              stroke-linejoin="round" stroke-linecap="round"/>
    ${zeroLine}
    ${labels}
    ${dots}
  </svg>`;
}

/* --------------------------------------------------------------- summary */

async function clLoadWalletSummary() {
  const box = $('clWalletKpis');
  const alert = $('clWalletAlert');
  try {
    const w = await MerchantApi.wallet();

    /* THE HERO IS ONE NUMBER, because the wallet answers one question: how do I
       stand. Everything else on this screen explains how it got there.

       The redesign removed the credit tiles that used to close this strip —
       credit limit, credit available and "of a X limit". A merchant reading a
       ceiling next to a balance reads it as money, and now that the wallet is
       the only finance surface in the portal it has to state one position
       without a second, softer number beside it. The `has_credit_limit`,
       `credit_available` and `credit_limit` fields still arrive in this payload
       and are still what the server gates a booking on — nothing about the
       business rule changed, only what this screen puts on the glass. */
    /* THE SIGN IS TAKEN FROM `balance`, ALWAYS — never from `outstanding`.
       `outstanding` is floored at zero by the server (a merchant in credit owes
       nothing), so it is positive in exactly the state the merchant is worst
       off. Colouring from it would paint a debt green. */
    const sign = moneySign(w.balance);
    const tone = sign < 0 ? 'is-neg' : sign > 0 ? 'is-pos' : 'is-zero';
    const stateWord = sign < 0 ? 'You owe' : sign > 0 ? 'In credit' : 'Nil balance';

    box.innerHTML = `
      <div class="cl-balance" style="grid-column:1/-1;">
        <div class="cl-balance-row">
          <div>
            <!-- ONE LABEL AND ONE SIGNED NUMBER, in every state.
                 This used to swap to "Outstanding balance" and print the
                 outstanding figure when the merchant was overdrawn — and
                 because the server floors outstanding at zero, that figure is
                 POSITIVE exactly when the money is owed. A merchant ₹1,00,000
                 down read "₹1,00,000", the same glyphs as ₹1,00,000 in hand,
                 with only a word and a colour to tell the two apart.

                 A wallet that goes below zero now says so with a minus sign:
                 ₹2,00,000 spent against a ₹3,00,000 booking reads -₹1,00,000.
                 The balance field is the signed figure, and moneyStr keeps the
                 sign in front of the symbol (-₹1,00,000, not ₹-1,00,000). -->
            <div class="cl-balance-label">Wallet balance</div>
            <div>
              <span class="cl-balance-value ${tone}">${escapeHtml(moneyStr(w.balance))}</span>
              <!-- The state in WORDS as well as in colour. A red number alone
                   is nothing to a colour-blind reader or a printed page. -->
              <span class="cl-balance-state ${tone}">${stateWord}</span>
            </div>
            <!-- LAST UPDATED — when the balance last MOVED, not when this page
                 was loaded. last_transaction_at is the timestamp of the most
                 recent ledger row; rendering new Date() here would show the
                 merchant a fresh time on every refresh and tell them nothing.
                 Falls back to a plain caption when the wallet has never moved,
                 because "Last updated: never" reads as a fault. -->
            <div class="cl-balance-sub">${w.last_transaction_at
              ? `Last updated ${escapeHtml(fmtDate(w.last_transaction_at))} at ${escapeHtml(fmtTime(w.last_transaction_at))}`
              : 'No movement on this account yet'}</div>
          </div>
          <div class="cl-balance-side">
            <div>
              <div class="cl-balance-label">Total added</div>
              <b>${escapeHtml(moneyStr(w.total_credits))}</b>
            </div>
            <div>
              <div class="cl-balance-label">Total booked</div>
              <b>${escapeHtml(moneyStr(w.total_debits))}</b>
            </div>
            <!-- The "Awaiting verification" figure was removed with the top-up
                 table. It is unapproved money and this screen is completed
                 movement only; it is shown on Payment Management instead, where
                 a pending request is the subject rather than a footnote on a
                 balance. pending_topups / pending_topup_count still arrive
                 in this payload and are still read there. -->
          </div>
        </div>
      </div>`;

    /* Two supporting tiles, and only ones that are facts about movement rather
       than second opinions about the balance. */
    const tiles = [];
    if (w.pending_topup_count > 0) {
      /* Its own tile, never folded into the balance — see rule 2 at the top. */
      tiles.push(['Awaiting verification', moneyStr(w.pending_topups),
                  `${w.pending_topup_count} submission${w.pending_topup_count === 1 ? '' : 's'} being checked`]);
    }
    if (w.transaction_count > 0 && w.last_transaction_at) {
      tiles.push(['Last movement', fmtDate(w.last_transaction_at),
                  `${w.transaction_count} transaction${w.transaction_count === 1 ? '' : 's'} in total`]);
    }
    box.innerHTML += tiles.map(([label, value, sub]) => `
      <div class="cl-kpi">
        <div class="cl-kpi-label">${escapeHtml(label)}</div>
        <div class="cl-kpi-value">${escapeHtml(value)}</div>
        <div class="cl-kpi-sub">${escapeHtml(sub)}</div>
      </div>`).join('');

    /* The warning states the server's own conclusion (`is_over_limit`,
       `is_low_balance`) rather than re-deriving a threshold here. A screen with
       its own idea of "low" is a screen that eventually disagrees with the gate
       that actually blocks the booking.

       The figures were taken out of the wording with the credit tiles; what a
       merchant has to ACT on is unchanged and is still said plainly — bookings
       will be declined, and adding money is what fixes it. */
    if (w.is_over_limit) {
      clMsg(alert,
        'Your account has reached its booking limit. New bookings will be declined until '
        + 'you add money to the wallet — or ask the partner desk to review the limit.', 'err');
    } else if (w.is_low_balance) {
      clMsg(alert,
        'Your account is close to its booking limit. Add money soon to avoid new bookings '
        + 'being declined.', 'warn');
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
  body.innerHTML = clLoadingRow(9, 'Loading transactions…');

  try {
    const p = await MerchantApi.walletTransactions({
      dateFrom: clWalletState.dateFrom, dateTo: clWalletState.dateTo,
      page: clWalletState.page, pageSize: CL_WALLET_PAGE_SIZE,
    });

    if (!p.items.length) {
      body.innerHTML = clEmptyRow(9, clWalletState.page > 1
        ? 'No more transactions.'
        : 'Nothing has moved on your wallet yet.');
    } else {
      /* THE LEDGER IS ALREADY COMPLETED MOVEMENT ONLY, so no filtering is
         needed here to satisfy "pending requests must not appear". A row in
         wallet_transactions is written by wallet_service at the moment the
         money actually moves — an unapproved top-up has no row at all, which is
         why the balance and this table can never disagree. What had to change
         was removing the separate top-up REQUEST table above, not filtering
         this one. */
      body.innerHTML = p.items.map(t => {
        const isCredit = moneyIsPositive(t.credit);
        const amount = isCredit ? t.credit : t.debit;
        return `
        <tr>
          <td class="cl-nowrap">${escapeHtml(fmtDate(t.created_at))}
              <small class="cl-cell-sub">${escapeHtml(fmtTime(t.created_at))}</small></td>
          <td class="cl-nowrap"><code>${escapeHtml(t.txn_number)}</code></td>
          <td>${escapeHtml(CL_TXN_LABELS[t.txn_type] || clLabel(t.txn_type))}
              <small class="cl-cell-sub">${escapeHtml(clWalletDetail(t))}</small></td>
          <td><span class="cl-tag ${isCredit ? 'cl-tag-ok' : 'cl-tag-warn'}">${isCredit ? 'Credit' : 'Debit'}</span></td>
          <!-- Opening and closing are coloured by SIGN, so a statement that
               crosses zero shows where it crossed. The amount is not: its
               direction is already the Debit/Credit tag beside it, and a second
               red/green on the same row would compete with the balance. -->
          <td class="cl-num ${moneyToneClass(t.balance_before)}">${escapeHtml(moneyStr(t.balance_before))}</td>
          <td class="cl-num">${isCredit ? '+' : '−'}${escapeHtml(moneyStr(amount))}</td>
          <td class="cl-num ${moneyToneClass(t.balance_after)}">${escapeHtml(moneyStr(t.balance_after))}</td>
          <td><span class="cl-tag cl-tag-ok">Completed</span></td>
          <td class="cl-nowrap">${t.topup_number
            ? `<code>${escapeHtml(t.topup_number)}</code>`
            : '<span class="cl-cell-sub">—</span>'}</td>
        </tr>`;
      }).join('');
    }

    const first = (p.page - 1) * p.page_size + 1;
    const last = (p.page - 1) * p.page_size + p.items.length;
    count.textContent = p.total
      ? `Showing ${first}–${last} of ${p.total}`
      : 'No transactions';
    $('clWalletPrev').disabled = p.page <= 1;
    $('clWalletNext').disabled = last >= p.total;
  } catch (err) {
    body.innerHTML = clEmptyRow(9, clError(err, 'Could not load your transactions.'));
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

/* NO HOST ELEMENT ON THE WALLET SCREEN — see the banner at the top of this
   file. The table this fills moved to Payment Management, but the submit path
   below is deliberately kept whole, and it ends by re-reading this list. So the
   function stays callable and simply does nothing when its table is not on the
   page, rather than throwing into whatever called it. It renders exactly as it
   always did wherever `#clTopupBody` is hosted again. */
async function clLoadTopups() {
  const body = $('clTopupBody');
  const note = $('clTopupNote');
  if (!body || !note) return;
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
