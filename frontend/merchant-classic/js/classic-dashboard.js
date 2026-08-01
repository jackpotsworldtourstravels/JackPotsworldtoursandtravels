'use strict';
/* Classic — Dashboard. GET /api/merchant/dashboard, once.
   ===========================================================================
   The figure strip is deliberately flat and clickable: every number a merchant
   sees should be reachable, so each KPI navigates to the screen that lists the
   rows behind it, with that screen's status filter pre-selected.

   Two counter distinctions that are easy to get wrong and are wrong in a way
   that costs the merchant money, so they are labelled explicitly here:

   - `requests_by_status.payment_pending` is MONEY OWED — requests waiting for
     the merchant to pay.
   - `pending_payments_count` is money ALREADY SENT and awaiting our
     verification. It is computed from Payment rows with payment_status PENDING.
     It is NOT money owed. Its KPI therefore links to `payment_pending`, because
     verify_payment is what moves a request on to Paid — so a payment awaiting
     verification still belongs to a request sitting in Payment Pending.

   A THIRD DISTINCTION, new with Ticket Enquiry. A ticket enquiry is a
   service_requests row like any other, so /api/merchant/dashboard's
   `requests_by_status` counts enquiries alongside bookings — an unanswered
   enquiry lands in `pending_approval` next to a booking awaiting approval.
   Those are not the same thing to a merchant, so the two enquiry figures are
   fetched separately from /api/enquiries and given their own KPIs, and the
   shared "Pending approval" tile says out loud that it spans both. The
   alternative was filtering enquiries out of a counter every other portal
   shares, which would have made the same number mean different things
   depending on which screen you read it from.

   NO CREDIT FIGURE. The dashboard used to carry a "Credit limit" tile beside
   the wallet. It is gone, here and on Profile & Settings: the wallet balance
   is the number a merchant spends against, and a second money figure that
   nothing on this portal actually spends only invited the question of which
   one was real. `credit_limit` is still on the merchant record and still
   returned by /api/merchant/dashboard — this portal simply does not show it.

   CHARTS, NOT A RECENT-REQUESTS TABLE. The "Recent requests" table that used
   to close this screen was five rows of exactly what My Requests already
   lists, one click away. In its place are three charts over the merchant's own
   booking history — where the volume is going, what it is worth, and where it
   is stuck. They are hand-rolled inline SVG rather than a charting library on
   purpose: this portal has a live light/dark/system switch, and SVG that
   references the same `--cl-` custom properties as everything else re-themes
   with the page instead of needing a redraw. */

let clDashData = null;

async function clInitDashboard() {
  const root = $('cl-dashboard');
  root.innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Dashboard</h1>
        <p>Account position and the queues that need attention.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clDashRefresh">Refresh</button>
        <button type="button" class="cl-btn cl-btn-primary" id="clDashNew">Enquire ticket</button>
      </div>
    </div>
    <div id="clDashKpis"><div class="cl-panel"><div class="cl-panel-body">
      <span class="cl-spin"></span> Loading account summary…
    </div></div></div>
    <div id="clDashCharts"></div>
    <div id="clDashAccount"></div>`;

  $('clDashRefresh').addEventListener('click', () => { clLoaded.add('dashboard'); clInitDashboard(); });
  /* Straight into the Enquire Ticket form: every booking now starts there. */
  $('clDashNew').addEventListener('click', () => clGo('enquiry', () => clOpenEnquiryForm()));

  await clLoadDashboard();
}

/* Enquiry counts, from the enquiry list itself rather than from the shared
   status counters — see the note at the head of this file. One page of 100 is
   the router's ceiling and is far more than a merchant has open at once; if it
   ever were not, `total` is reported so the tile cannot quietly undercount. */
async function clEnquiryCounts() {
  try {
    const data = await MerchantApi.listEnquiries({ page_size: 100 });
    const rows = data.items || [];
    return {
      open: rows.filter(r => ['pending_approval', 'in_review'].includes(r.status)).length,
      ready: rows.filter(r => r.status === 'approved' && !r.booking_request_id).length,
      partial: (data.total ?? rows.length) > rows.length,
    };
  } catch {
    /* The dashboard must still render if this one call fails. */
    return null;
  }
}

/* The booking rows the charts are drawn from. One page of 100, newest first,
   which is the same ceiling every other list on this portal uses. Charted from
   the rows themselves rather than from `requests_by_status`, because that
   counter also carries enquiries — see the note at the head of this file. */
async function clChartBookings() {
  try {
    const data = await MerchantApi.listRequests({ request_type: 'booking', page_size: 100 });
    return data.items || [];
  } catch {
    return null;   /* the rest of the dashboard still renders */
  }
}

async function clLoadDashboard() {
  const kpis = $('clDashKpis');
  try {
    const [data, enq, bookings] = await Promise.all([
      MerchantApi.dashboard(), clEnquiryCounts(), clChartBookings(),
    ]);
    clDashData = data;
    const s = data.requests_by_status || {};

    /* `pending_approval + in_review` mirrors Premium: both are "with our team,
       not yet actionable by the merchant". Enquiries are in this figure too,
       which is why the sub-label says so and the two tiles beside it break the
       enquiry side out on its own. */
    const awaiting = (s.pending_approval || 0) + (s.in_review || 0);

    kpis.innerHTML = `<div class="cl-kpis">
      ${clKpi('Wallet balance', money(data.wallet_balance), 'Available to spend', 'payments')}
      ${clKpi('Enquiries open', enq ? enq.open : '—', 'Awaiting our answer', 'enquiry')}
      ${clKpi('Ready to book', enq ? enq.ready : '—', 'Answered — request a ticket', 'enquiry')}
      ${clKpi('Pending approval', awaiting, 'Bookings + enquiries with us', 'requests', 'pending_approval')}
      ${clKpi('Payment pending', s.payment_pending || 0, 'You owe payment', 'payments', 'payment_pending')}
      ${clKpi('Ticketed', s.ticket_issued || s.ticketed || 0, 'Tickets issued', 'requests', 'ticketed')}
      ${clKpi('Completed', s.completed || 0, 'Closed requests', 'requests', 'completed')}
      ${clKpi('Awaiting verification', data.pending_payments_count || 0, 'Payments you have sent', 'payments', 'payment_pending')}
      ${clKpi('Unread notices', data.unread_notifications_count || 0, 'Notification centre', 'notifications')}
    </div>`;

    kpis.querySelectorAll('[data-cl-kpi-to]').forEach(btn => {
      btn.addEventListener('click', () => {
        const to = btn.dataset.clKpiTo;
        const filter = btn.dataset.clKpiFilter || '';
        /* Pre-select the destination's own status <select> and fire its change
           handler, so the merchant lands on exactly the rows the number counted
           rather than on an unfiltered table. */
        clGo(to, () => {
          if (!filter) return;
          const sel = $(`cl-${to}`)?.querySelector('[data-cl-status-filter]');
          if (!sel) return;
          if ([...sel.options].some(o => o.value === filter)) {
            sel.value = filter;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      });
    });

    clRenderDashCharts(bookings);
    clRenderDashAccount(data);
  } catch (err) {
    kpis.innerHTML = `<div class="cl-panel"><div class="cl-panel-body">
      <div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Failed to load the dashboard.'))}</div>
    </div></div>`;
  }
}

/* A non-clickable KPI omits data-cl-kpi-to and renders as a <div>, so a keyboard
   user never tabs onto a figure that does nothing. */
function clKpi(label, value, sub, to, filter) {
  const inner = `<div class="cl-kpi-label">${escapeHtml(label)}</div>
    <div class="cl-kpi-value">${escapeHtml(String(value ?? '—'))}</div>
    <div class="cl-kpi-sub">${escapeHtml(sub || '')}</div>`;
  return to
    ? `<button type="button" class="cl-kpi" data-cl-kpi-to="${escapeHtml(to)}"
         data-cl-kpi-filter="${escapeHtml(filter || '')}"
         title="Open ${escapeHtml(CL_TITLES[to] || to)}">${inner}</button>`
    : `<div class="cl-kpi">${inner}</div>`;
}

function clRenderDashAccount(data) {
  $('clDashAccount').innerHTML = `
    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Account</h2></div>
      <div class="cl-panel-body">
        <dl class="cl-dl">
          <div><dt>Company</dt><dd>${escapeHtml(data.company_name || localStorage.getItem(PARTNER_KEYS.companyName) || '—')}</dd></div>
          <div><dt>Merchant code</dt><dd class="cl-ref">${escapeHtml(data.merchant_code || '—')}</dd></div>
          <div><dt>Wallet balance</dt><dd>${money(data.wallet_balance)}</dd></div>
          <div><dt>Support contact</dt><dd>${escapeHtml(data.support_contact || data.support_email || '—')}</dd></div>
        </dl>
      </div>
    </div>`;
}

/* ================================================================ charts */

/* Three views of one array of bookings, in the space the Recent Requests table
   used to occupy: how many were raised, what they were worth, and where they
   have got to. They deliberately read the SAME rows — two charts on one screen
   that disagree are worse than no charts, and sharing the source is the only
   way to guarantee they cannot.

   Everything below is inline SVG built against the `--cl-` custom properties.
   No charting library: this portal has a live light / dark / system switch, and
   an SVG that references the same tokens as the rest of the page re-themes with
   it instead of needing to be redrawn on every toggle. */

const CL_CHART_MONTHS = 6;

/* One fixed coordinate space, scaled to the panel by `width:100%`, so the text
   scales with the drawing rather than needing a resize observer. */
const CL_CH = { w: 340, h: 176, x0: 42, x1: 330, yTop: 16, yBase: 136, yLab: 154 };

/* An axis ceiling a person would have chosen: 1, 2 or 5 times a power of ten.
   Scaling to the raw maximum puts the tallest bar flush against the frame and
   labels the middle gridline "3.5". */
function clNiceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude;
}

/* Axis money, short enough to fit: ₹4.2L rather than ₹4,20,000. Indian units,
   because every amount in this portal is rupees. */
function clShortMoney(n) {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(v % 1e7 ? 1 : 0)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(v % 1e5 ? 1 : 0)}L`;
  if (v >= 1e3) return `₹${Math.round(v / 1e3)}k`;
  return `₹${Math.round(v)}`;
}

/* The last N calendar months ending with this one, oldest first. Stepped by
   month index rather than by subtracting 30 days — a 31-day month would
   otherwise let a bucket be skipped entirely. */
function clMonthBuckets(n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      label: d.toLocaleDateString('en-IN', { month: 'short' }),
      count: 0, value: 0,
    });
  }
  return out;
}

function clBucketBookings(rows) {
  const buckets = clMonthBuckets(CL_CHART_MONTHS);
  const byKey = new Map(buckets.map(b => [b.key, b]));
  rows.forEach(r => {
    const at = r.created_at ? new Date(r.created_at) : null;
    if (!at || Number.isNaN(at.getTime())) return;
    const bucket = byKey.get(`${at.getFullYear()}-${at.getMonth()}`);
    if (!bucket) return;                       // older than the window
    bucket.count += 1;
    bucket.value += Number(r.total_amount) || 0;
  });
  return buckets;
}

/* Gridlines, their values and the month labels. Shared by the bar and the area
   chart so the pair reads as one figure rather than two drawings that happen to
   sit beside each other. */
function clChartFrame(buckets, max, fmt) {
  const { x0, x1, yTop, yBase, yLab } = CL_CH;
  const band = (x1 - x0) / buckets.length;
  const grid = [0, 0.5, 1].map(f => {
    const y = yBase - (yBase - yTop) * f;
    return `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"
                  stroke="var(--cl-border-color)" stroke-width="1"/>
            <text x="${x0 - 7}" y="${y + 3.5}" text-anchor="end" font-size="9"
                  fill="var(--cl-text-muted)">${escapeHtml(fmt(max * f))}</text>`;
  }).join('');
  const labels = buckets.map((b, i) =>
    `<text x="${(x0 + band * (i + 0.5)).toFixed(1)}" y="${yLab}" text-anchor="middle"
           font-size="10" font-weight="700"
           fill="var(--cl-text-muted)">${escapeHtml(b.label)}</text>`).join('');
  return { grid: grid + labels, band };
}

function clBarChart(buckets, pick, fmt, colour, title) {
  const max = clNiceMax(Math.max(...buckets.map(pick)));
  const { grid, band } = clChartFrame(buckets, max, fmt);
  const { w, h, x0, yTop, yBase } = CL_CH;
  const bw = Math.min(30, band * 0.5);

  const bars = buckets.map((b, i) => {
    const value = pick(b);
    if (!(value > 0)) return '';
    /* Floored at 2px: a real but tiny month must still be visible, or the chart
       says "nothing happened" when something did. */
    const height = Math.max(2, (yBase - yTop) * (value / max));
    const x = x0 + band * (i + 0.5) - bw / 2;
    return `<rect x="${x.toFixed(1)}" y="${(yBase - height).toFixed(1)}"
                  width="${bw.toFixed(1)}" height="${height.toFixed(1)}" rx="4" fill="${colour}"/>
            <text x="${(x + bw / 2).toFixed(1)}" y="${(yBase - height - 5).toFixed(1)}"
                  text-anchor="middle" font-size="9.5" font-weight="800"
                  fill="var(--cl-text-primary)">${escapeHtml(fmt(value))}</text>`;
  }).join('');

  return `<svg class="cl-chart-svg" viewBox="0 0 ${w} ${h}" role="img"
               aria-label="${escapeHtml(title)}">${grid}${bars}</svg>`;
}

function clAreaChart(buckets, pick, fmt, colour, title) {
  const max = clNiceMax(Math.max(...buckets.map(pick)));
  const { grid, band } = clChartFrame(buckets, max, fmt);
  const { w, h, x0, yTop, yBase } = CL_CH;

  const points = buckets.map((b, i) => [
    x0 + band * (i + 0.5),
    yBase - (yBase - yTop) * (pick(b) / max),
  ]);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${points[0][0].toFixed(1)},${yBase} ${line} `
    + `${points[points.length - 1][0].toFixed(1)},${yBase}`;
  const dots = points.map(([x, y]) =>
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${colour}"/>`).join('');

  return `<svg class="cl-chart-svg" viewBox="0 0 ${w} ${h}" role="img"
               aria-label="${escapeHtml(title)}">
    ${grid}
    <polygon points="${area}" fill="${colour}" opacity=".14"/>
    <polyline points="${line}" fill="none" stroke="${colour}" stroke-width="2.5"
              stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;
}

/* Statuses grouped into the six stages a merchant actually distinguishes.
   Grouped rather than one slice per status because several of the raw values
   mean the same thing to whoever is reading — "approved" and "payment_pending"
   are both "you owe us money" — and a ring with two identically-coloured slices
   explains nothing. Every status this portal can see is in exactly one group. */
const CL_STAGE_GROUPS = [
  { label: 'With our team', colour: 'var(--cl-gold)',
    of: ['draft', 'submitted', 'pending_approval', 'in_review'] },
  { label: 'Payment due', colour: 'var(--cl-coral)', of: ['approved', 'payment_pending'] },
  { label: 'Paid', colour: 'var(--cl-sky)', of: ['paid'] },
  { label: 'Ticketed', colour: 'var(--cl-emerald)', of: ['ticket_issued', 'ticketed'] },
  { label: 'Completed', colour: 'var(--cl-navy-3)', of: ['completed'] },
  { label: 'Closed', colour: 'var(--cl-text-muted)', of: ['cancelled', 'rejected'] },
];

function clStageMix(rows) {
  return CL_STAGE_GROUPS
    .map(g => ({ ...g, value: rows.filter(r => g.of.includes(r.status)).length }))
    .filter(g => g.value > 0);
}

/* A ring, drawn as one dashed circle per slice: `stroke-dasharray` set to the
   arc length and the remainder is what places a slice, and rotating -90° starts
   it at twelve o'clock rather than at three. */
function clDonut(slices, centreValue, centreLabel) {
  const R = 54;
  const C = 2 * Math.PI * R;
  const total = slices.reduce((n, s) => n + s.value, 0);

  let offset = 0;
  const arcs = slices.map(s => {
    const length = total ? (s.value / total) * C : 0;
    const arc = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${s.colour}"
                         stroke-width="19"
                         stroke-dasharray="${length.toFixed(2)} ${(C - length).toFixed(2)}"
                         stroke-dashoffset="${(-offset).toFixed(2)}"
                         transform="rotate(-90 70 70)"/>`;
    offset += length;
    return arc;
  }).join('');

  return `<div class="cl-donut">
    <svg viewBox="0 0 140 140" role="img" aria-label="Bookings by stage">
      <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--cl-hover-bg)" stroke-width="19"/>
      ${arcs}
      <text x="70" y="68" text-anchor="middle" font-size="24" font-weight="800"
            fill="var(--cl-text-primary)">${escapeHtml(String(centreValue))}</text>
      <text x="70" y="84" text-anchor="middle" font-size="9" font-weight="700"
            fill="var(--cl-text-muted)">${escapeHtml(centreLabel)}</text>
    </svg>
    <ul class="cl-legend">
      ${slices.map(s => `<li><i style="background:${s.colour}"></i>
        <span>${escapeHtml(s.label)}</span><b>${s.value}</b></li>`).join('')}
    </ul>
  </div>`;
}

function clChartPanel(title, sub, body) {
  return `<div class="cl-panel cl-chart">
    <div class="cl-panel-head">
      <h2>${escapeHtml(title)}</h2>
      <span class="cl-kpi-sub">${escapeHtml(sub)}</span>
    </div>
    <div class="cl-panel-body">${body}</div>
  </div>`;
}

function clRenderDashCharts(rows) {
  const host = $('clDashCharts');

  /* null means the one call these charts need failed. Said out loud rather than
     drawn as an empty chart, which would read as "you have no bookings". */
  if (rows === null) {
    host.innerHTML = `<div class="cl-panel"><div class="cl-panel-body">
      <div class="cl-msg cl-msg-info" style="margin-top:0">
        Your booking history could not be loaded, so the charts are not shown. Everything else
        on this page is up to date.
      </div></div></div>`;
    return;
  }

  if (!rows.length) {
    host.innerHTML = `<div class="cl-panel">
      <div class="cl-panel-head"><h2>Your booking activity</h2></div>
      <div class="cl-panel-body"><p style="margin:0;color:var(--cl-text-muted);font-size:12.5px;">
        Nothing raised yet, so there is nothing to chart. Start with a <b>Ticket Enquiry</b> —
        once our team answers it, you can turn it into a booking request.</p></div></div>`;
    return;
  }

  const buckets = clBucketBookings(rows);
  const span = `${buckets[0].label} – ${buckets[buckets.length - 1].label}`;

  host.innerHTML = `<div class="cl-charts">
    ${clChartPanel('Bookings raised', `Last ${CL_CHART_MONTHS} months · ${span}`,
      clBarChart(buckets, b => b.count, n => String(Math.round(n)),
        'var(--cl-coral)', 'Bookings raised per month'))}
    ${clChartPanel('Booking value', `Last ${CL_CHART_MONTHS} months · ${span}`,
      clAreaChart(buckets, b => b.value, clShortMoney,
        'var(--cl-sky)', 'Booking value per month'))}
    ${clChartPanel('Where your bookings are',
      `${rows.length} booking${rows.length === 1 ? '' : 's'}`,
      clDonut(clStageMix(rows), rows.length, 'bookings'))}
  </div>`;
}
