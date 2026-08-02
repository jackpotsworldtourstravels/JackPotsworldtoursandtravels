'use strict';
/* Merchant Portal — Dashboard.
   ===========================================================================
   Two bands, in the order a merchant actually reads them:

     1. BOOKING OVERVIEW — five figures about the account right now. Every one
        is a button that opens the screen listing the rows behind it. A number
        a merchant cannot reach is a number they have to go looking for.
     2. CHARTS — volume, value and where they fly.

   THE LIFECYCLE BAND IS GONE, AND SO IS THE STATUS RING.
   Both said the same thing twice — a row of seven stage cards and a donut
   splitting the same statuses — and both said it a third time on screens that
   own it: Booking History filters by outcome and My Requests by working state,
   each with the rows attached. A dashboard that restates another screen's
   filter is a second place to keep correct, so the stages now live only where
   the rows do. `analytics.by_status` is still read here, but only to total the
   "Requests in progress" tile.

   WHERE EACH FIGURE COMES FROM, AND WHY IT IS NOT THE OBVIOUS ONE
   ---------------------------------------------------------------------------
   `GET /api/merchant/dashboard`'s `requests_by_status` counts EVERY
   ServiceRequest row the merchant owns — bookings, enquiries, service requests
   and live-chat threads all share that table (dashboard_service.py:33). So it
   is the right source for "payments pending", which spans them, and the wrong
   source for anything that claims to be about bookings.

   The booking figures therefore come from `GET /api/analytics/bookings`, which
   filters `request_type == BOOKING` in SQL and groups the merchant's WHOLE
   history — not a page of it. The enquiry figures come from the enquiry list,
   which is the only place enquiries are counted on their own. The service
   request total comes from `GET /api/analytics/change-requests`.

   Nothing on this screen adds up a column of money. `totals.value` and each
   month's `value` arrive already aggregated as decimal strings; `Number()`
   touches them only to compute an SVG coordinate and an abbreviated axis label
   (₹4.2L), never to state a figure.

   CREDIT IS GONE FROM THIS SCREEN.
   Credit limit, credit used, credit available and credit utilisation were all
   removed in the redesign. The wallet is now the single finance surface a
   merchant reads: one balance, one place it is settled. `financePosition()` is
   still the source of the wallet figure, because finance_service is the only
   thing allowed to compute money — the tiles that reported the *credit* half of
   its payload are what went, not the call.

   CHARTS ARE HAND-ROLLED INLINE SVG, deliberately. This portal has a live
   light/dark/system switch, and an SVG that references the same `--cl-` custom
   properties as the rest of the page re-themes with it instead of needing to be
   redrawn on every toggle. A charting library would also be a second network
   request for six drawings. */

let clDashData = null;

async function clInitDashboard() {
  const root = $('cl-dashboard');
  const name = (localStorage.getItem(PARTNER_KEYS.fullName) || '').split(' ')[0];

  root.innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>${name ? `Good ${clPartOfDay()}, ${escapeHtml(name)}` : 'Dashboard'}</h1>
        <p>Where your bookings, enquiries and money stand today. Every figure below opens
           the rows behind it.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clDashRefresh">
          ${clIco('refresh', { size: 15 })} Refresh
        </button>
      </div>
    </div>

    <div id="clDashKpis">${clDashSkeletonKpis()}</div>
    <div id="clDashCharts"></div>`;

  $('clDashRefresh').addEventListener('click', () => { clLoaded.add('dashboard'); clInitDashboard(); });

  await clLoadDashboard();
}

function clPartOfDay() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

/* The shape of the answer, while the answer is on its way. Five boxes, not a
   spinner, so the page does not grow by 400px when the data lands — and the
   same five-up class the real band uses, so it does not reflow either. */
function clDashSkeletonKpis() {
  return `<div class="cl-kpis cl-kpis-5">${'<div class="cl-kpi"><span class="cl-skel cl-skel-line w40"></span>'
    + '<span class="cl-skel cl-skel-line w80" style="height:26px"></span>'
    + '<span class="cl-skel cl-skel-line w60"></span></div>'.repeat(5)}</div>`;
}

/* ---------------------------------------------------------------- loading */

/* Enquiry counts, from the enquiry list rather than from the shared status
   counters — see the note at the head of this file.

   COUNTED BY THE SERVER, ONE STATUS AT A TIME. This used to fetch a single page
   of 100 enquiries and bucket the rows here, and on a real account that is a
   quiet undercount: the demo merchant has 1,633 enquiries, so "22 awaiting a
   fare" meant "22 among the 100 most recent" and an enquiry raised last month
   and never answered was invisible on the dashboard that exists to surface it.

   `page_size: 1` and read `total`: the enquiry router returns the same `Page`
   envelope every list uses, so the count is the database's COUNT(*) under that
   filter and not a length. Four cheap calls instead of one misleading one. */
async function clEnquiryCounts() {
  try {
    const [all, pending, review, quoted] = await Promise.all([
      MerchantApi.listEnquiries({ page_size: 1 }),
      MerchantApi.listEnquiries({ page_size: 1, status: 'pending_approval' }),
      MerchantApi.listEnquiries({ page_size: 1, status: 'in_review' }),
      MerchantApi.listEnquiries({ page_size: 1, status: 'approved' }),
    ]);
    return {
      total: all.total ?? 0,
      /* Both mean "no fare yet"; which desk is holding it is our problem, not
         the merchant's — the same grouping the enquiry filter offers. */
      awaiting: (pending.total ?? 0) + (review.total ?? 0),
      quoted: quoted.total ?? 0,
    };
  } catch {
    return null;   /* the rest of the dashboard still renders */
  }
}

/* Top airlines is the one figure on this screen with no server-side aggregate:
   there is no `by_airline` in /api/analytics/bookings, and the airline lives in
   the booking's `travel_details` JSON. It is counted here over one page of
   bookings, and the panel SAYS SO — an unlabelled client-side count that
   silently covers 100 of 300 bookings is exactly the class of quiet lie the
   monthly charts were moved off `listRequests` to avoid. */
async function clAirlineMix() {
  try {
    const data = await MerchantApi.listRequests({ request_type: 'booking', page_size: 100 });
    const rows = data.items || [];
    const counts = new Map();
    rows.forEach(r => {
      const d = r.travel_details || r.details || {};
      const airline = (d.airline || '').trim();
      if (!airline) return;
      counts.set(airline, (counts.get(airline) || 0) + 1);
    });
    return {
      rows: [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 6),
      sampled: rows.length,
      total: data.total ?? rows.length,
    };
  } catch {
    return null;
  }
}

async function clLoadDashboard() {
  const host = $('clDashKpis');
  try {
    /* One round of parallel calls. Only the first is required: every other one
       is caught to null, and its band renders a short "unavailable" note rather
       than taking the whole screen down with it. */
    const [data, position, enq, analytics, changes, airlines] = await Promise.all([
      MerchantApi.dashboard(),
      MerchantApi.financePosition().catch(() => null),
      clEnquiryCounts(),
      MerchantApi.bookingAnalytics({ dateField: 'created_at' }).catch(() => null),
      MerchantApi.changeRequestAnalytics().catch(() => null),
      clAirlineMix(),
    ]);
    clDashData = data;

    clRenderDashKpis(position, enq, analytics, changes);
    clRenderDashCharts(analytics, airlines);
  } catch (err) {
    host.innerHTML = `<div class="cl-panel"><div class="cl-panel-body">
      <div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Failed to load the dashboard.'))}</div>
    </div></div>`;
    $('clDashCharts').innerHTML = '';
  }
}

/* =============================================================== overview */

function clRenderDashKpis(position, enq, analytics, changes) {
  /* Bookings still moving: raised, approved, awaiting payment or paid but not
     yet ticketed. Drawn from the analytics status slices so it counts bookings
     and not enquiries — see the head of this file. */
  const byStatus = new Map((analytics?.by_status || []).map(r => [r.status, r.count]));
  const inProgress = ['draft', 'pending_approval', 'in_review', 'approved', 'payment_pending', 'paid']
    .reduce((n, k) => n + (byStatus.get(k) || 0), 0);

  /* FIVE, and the count is load-bearing: `.cl-kpis-5` lays them out three then
     two so the band never ends in a half-empty row. Adding a sixth here means
     revisiting that class. */
  const tiles = [
    {
      label: 'Wallet balance', icon: 'wallet', tone: 'accent',
      value: position ? moneyStr(position.wallet_balance) : '—',
      sub: position ? 'Available on your account' : 'Balance unavailable',
      to: 'wallet',
    },
    {
      label: 'Booking enquiries', icon: 'plane', tone: 'info',
      value: enq ? enq.total : '—',
      sub: enq ? `${enq.awaiting} awaiting a fare from us` : 'Enquiries unavailable',
      to: 'enquiry',
    },
    {
      label: 'Booking requests', icon: 'file', tone: '',
      value: analytics ? analytics.totals.bookings : '—',
      sub: analytics ? 'Raised to date' : 'Bookings unavailable',
      to: 'requests',
    },
    {
      label: 'Requests in progress', icon: 'activity', tone: 'warn',
      value: analytics ? inProgress : '—',
      sub: 'Not yet ticketed or closed',
      to: 'requests',
    },
    {
      label: 'Service requests', icon: 'swap', tone: '',
      value: changes ? changes.totals.requests : '—',
      sub: changes
        ? `${changes.totals.pending} awaiting a decision`
        : 'Changes to issued bookings',
      to: 'service-request',
    },
  ];

  $('clDashKpis').innerHTML = `<div class="cl-kpis cl-kpis-5">${tiles.map(clKpiCard).join('')}</div>`;
  clBindKpiNav($('clDashKpis'));
}

/* A KPI as a button. A tile with nowhere to go renders as a <div>, so a
   keyboard user never tabs onto a figure that does nothing. */
function clKpiCard({ label, value, sub, icon, tone, to, filter }) {
  const inner = `
    ${icon ? `<div class="cl-kpi-head"><span class="cl-kpi-ico ${tone || ''}">${clIco(icon)}</span></div>` : ''}
    <div class="cl-kpi-label">${escapeHtml(label)}</div>
    <div class="cl-kpi-value">${escapeHtml(String(value ?? '—'))}</div>
    <div class="cl-kpi-sub">${escapeHtml(sub || '')}</div>
    ${to ? `<span class="cl-kpi-arrow">${clIco('arrowRight', { size: 16 })}</span>` : ''}`;
  return to
    ? `<button type="button" class="cl-kpi" data-cl-kpi-to="${escapeHtml(to)}"
         data-cl-kpi-filter="${escapeHtml(filter || '')}"
         aria-label="${escapeHtml(`${label}: ${value}. Open ${CL_TITLES[to] || to}`)}">${inner}</button>`
    : `<div class="cl-kpi">${inner}</div>`;
}

/* Navigation for anything carrying `data-cl-kpi-to`. Pre-selects the
   destination's own status <select> and fires its change handler, so the
   merchant lands on exactly the rows the number counted rather than on an
   unfiltered table. */
function clBindKpiNav(scope) {
  scope.querySelectorAll('[data-cl-kpi-to]').forEach(btn => {
    btn.addEventListener('click', () => {
      const to = btn.dataset.clKpiTo;
      const filter = btn.dataset.clKpiFilter || '';
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
}

/* ================================================================ charts */

const CL_CHART_MONTHS = 6;

/* One fixed coordinate space, scaled to the panel by `width:100%`, so the text
   scales with the drawing rather than needing a resize observer. */
const CL_CH = { w: 360, h: 196, x0: 46, x1: 350, yTop: 18, yBase: 150, yLab: 170 };

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

/* Drop the server's `YYYY-MM` series into the last-N-months frame. Nothing is
   counted or added here — `count` and `value` arrive already aggregated over
   the merchant's whole history. `Number()` on the value is for the SVG's
   geometry and its abbreviated axis label; it is a drawing coordinate, not a
   total, and the exact figure is never rendered from it. */
function clBucketAnalytics(byMonth) {
  const buckets = clMonthBuckets(CL_CHART_MONTHS);
  const byKey = new Map(buckets.map(b => [b.key, b]));
  (byMonth || []).forEach(m => {
    const [year, month] = String(m.month).split('-');
    const bucket = byKey.get(`${Number(year)}-${Number(month) - 1}`);
    if (!bucket) return;                       // outside the window, or unscheduled
    bucket.count = m.count;
    bucket.value = Number(m.value) || 0;
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
                  stroke="var(--cl-line-2)" stroke-width="1"/>
            <text x="${x0 - 9}" y="${y + 3.5}" text-anchor="end" font-size="9.5"
                  font-weight="600" fill="var(--cl-text-muted)">${escapeHtml(fmt(max * f))}</text>`;
  }).join('');
  const labels = buckets.map((b, i) =>
    `<text x="${(x0 + band * (i + 0.5)).toFixed(1)}" y="${yLab}" text-anchor="middle"
           font-size="10.5" font-weight="700"
           fill="var(--cl-text-muted)">${escapeHtml(b.label)}</text>`).join('');
  return { grid: grid + labels, band };
}

function clBarChart(buckets, pick, fmt, colour, title) {
  const max = clNiceMax(Math.max(...buckets.map(pick)));
  const { grid, band } = clChartFrame(buckets, max, fmt);
  const { w, h, x0, yTop, yBase } = CL_CH;
  const bw = Math.min(34, band * 0.52);

  const bars = buckets.map((b, i) => {
    const value = pick(b);
    const x = x0 + band * (i + 0.5) - bw / 2;
    /* An empty month draws its track anyway, so the eye reads six months and
       not "the months we happen to have data for". */
    const track = `<rect x="${x.toFixed(1)}" y="${yTop}" width="${bw.toFixed(1)}"
                         height="${(yBase - yTop).toFixed(1)}" rx="6" fill="var(--cl-line-2)" opacity=".5"/>`;
    if (!(value > 0)) return track;
    /* Floored at 3px: a real but tiny month must still be visible, or the chart
       says "nothing happened" when something did. */
    const height = Math.max(3, (yBase - yTop) * (value / max));
    return `${track}
            <rect x="${x.toFixed(1)}" y="${(yBase - height).toFixed(1)}"
                  width="${bw.toFixed(1)}" height="${height.toFixed(1)}" rx="6" fill="${colour}"/>
            <text x="${(x + bw / 2).toFixed(1)}" y="${(yBase - height - 6).toFixed(1)}"
                  text-anchor="middle" font-size="10" font-weight="800"
                  fill="var(--cl-text)">${escapeHtml(fmt(value))}</text>`;
  }).join('');

  return `<svg class="cl-chart-svg" viewBox="0 0 ${w} ${h}" role="img"
               aria-label="${escapeHtml(title)}">${grid}${bars}</svg>`;
}

function clAreaChart(buckets, pick, fmt, colour, title) {
  const max = clNiceMax(Math.max(...buckets.map(pick)));
  const { grid, band } = clChartFrame(buckets, max, fmt);
  const { w, h, x0, yTop, yBase } = CL_CH;
  /* A gradient id must be unique on the page, or a second chart re-using the
     name silently inherits the first one's stops. */
  const gid = `clg${Math.random().toString(36).slice(2, 8)}`;

  const points = buckets.map((b, i) => [
    x0 + band * (i + 0.5),
    yBase - (yBase - yTop) * (pick(b) / max),
  ]);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${points[0][0].toFixed(1)},${yBase} ${line} `
    + `${points[points.length - 1][0].toFixed(1)},${yBase}`;
  const dots = points.map(([x, y], i) => {
    const v = pick(buckets[i]);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="var(--cl-surface)"
                    stroke="${colour}" stroke-width="2.5"/>
            ${v > 0 ? `<text x="${x.toFixed(1)}" y="${(y - 11).toFixed(1)}" text-anchor="middle"
                  font-size="9.5" font-weight="800" fill="var(--cl-text)">${escapeHtml(fmt(v))}</text>` : ''}`;
  }).join('');

  return `<svg class="cl-chart-svg" viewBox="0 0 ${w} ${h}" role="img"
               aria-label="${escapeHtml(title)}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${colour}" stop-opacity=".34"/>
      <stop offset="100%" stop-color="${colour}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <polygon points="${area}" fill="url(#${gid})"/>
    <polyline points="${line}" fill="none" stroke="${colour}" stroke-width="2.5"
              stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;
}

/* Statuses grouped into the six stages a merchant actually distinguishes.
   Grouped rather than one slice per status because several of the raw values
   mean the same thing to whoever is reading — "approved" and "payment_pending"
   are both "you owe us money" — and a ring with two identically-coloured slices
   explains nothing. Every status this portal can see is in exactly one group.

   THE DASHBOARD NO LONGER DRAWS THIS RING; **REPORTS DOES** ("Status mix", over
   the date range and filters that screen is holding). The three helpers below
   stay here because this file is the chart toolkit the whole portal draws from
   and it loads first — moving them would only mean loading them earlier. */
const CL_STAGE_GROUPS = [
  { label: 'With our team', colour: 'var(--cl-gold)',
    of: ['draft', 'submitted', 'pending_approval', 'in_review'] },
  { label: 'Payment due', colour: 'var(--cl-orange)', of: ['approved', 'payment_pending'] },
  { label: 'Paid', colour: 'var(--cl-info)', of: ['paid'] },
  { label: 'Ticketed', colour: 'var(--cl-success)', of: ['ticket_issued', 'ticketed'] },
  { label: 'Completed', colour: 'var(--cl-navy-500)', of: ['completed'] },
  { label: 'Closed', colour: 'var(--cl-text-muted)', of: ['cancelled', 'rejected'] },
];

/* Grouped from the server's per-status counts. Adding six numbers that arrived
   as six numbers is not "computing a figure on the client" — the population,
   the counting and the status vocabulary are all the server's. What this does
   is decide which statuses a merchant reads as one thing. */
function clStageMix(byStatus) {
  const counts = new Map((byStatus || []).map(s => [s.status, s.count]));
  return CL_STAGE_GROUPS
    .map(g => ({ ...g, value: g.of.reduce((n, s) => n + (counts.get(s) || 0), 0) }))
    .filter(g => g.value > 0);
}

/* A ring, drawn as one dashed circle per slice: `stroke-dasharray` set to the
   arc length and the remainder is what places a slice, and rotating -90° starts
   it at twelve o'clock rather than at three. */
function clDonut(slices, centreValue, centreLabel) {
  const R = 58;
  const C = 2 * Math.PI * R;
  const total = slices.reduce((n, s) => n + s.value, 0);

  let offset = 0;
  const arcs = slices.map(s => {
    const length = total ? (s.value / total) * C : 0;
    const arc = `<circle cx="75" cy="75" r="${R}" fill="none" stroke="${s.colour}"
                         stroke-width="18" stroke-linecap="butt"
                         stroke-dasharray="${length.toFixed(2)} ${(C - length).toFixed(2)}"
                         stroke-dashoffset="${(-offset).toFixed(2)}"
                         transform="rotate(-90 75 75)"/>`;
    offset += length;
    return arc;
  }).join('');

  return `<div class="cl-donut">
    <svg viewBox="0 0 150 150" role="img" aria-label="Bookings by stage">
      <circle cx="75" cy="75" r="${R}" fill="none" stroke="var(--cl-line-2)" stroke-width="18"/>
      ${arcs}
      <text x="75" y="72" text-anchor="middle" font-size="26" font-weight="800"
            fill="var(--cl-text)">${escapeHtml(String(centreValue))}</text>
      <text x="75" y="89" text-anchor="middle" font-size="9" font-weight="700"
            letter-spacing="0.6" fill="var(--cl-text-muted)">${escapeHtml(centreLabel.toUpperCase())}</text>
    </svg>
    <ul class="cl-legend">
      ${slices.map(s => `<li><i style="background:${s.colour}"></i>
        <span>${escapeHtml(s.label)}</span><b>${s.value}</b></li>`).join('')}
    </ul>
  </div>`;
}

/* A ranked horizontal bar list. Used for both Top Destinations and Top
   Airlines: a dozen named things read far better lying down than rotated 45°
   under an x-axis. */
function clRankList(rows, { valueLabel = n => String(n) } = {}) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map(r => r.count)) || 1;
  return `<ul class="cl-rank">${rows.map(r => `<li>
    <div class="cl-rank-top">
      <span class="cl-rank-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
      <span class="cl-rank-val">${escapeHtml(valueLabel(r.count))}</span>
      ${r.sub ? `<span class="cl-rank-sub">${escapeHtml(r.sub)}</span>` : ''}
    </div>
    <div class="cl-rank-bar"><i style="width:${((r.count / max) * 100).toFixed(1)}%"></i></div>
  </li>`).join('')}</ul>`;
}

function clChartPanel(title, sub, body, { icon = '' } = {}) {
  return `<div class="cl-panel cl-chart">
    <div class="cl-panel-head">
      <h2>${icon ? clIco(icon) : ''}${escapeHtml(title)}</h2>
    </div>
    <div class="cl-panel-sub">${escapeHtml(sub)}</div>
    <div class="cl-panel-body">${body}</div>
  </div>`;
}

function clRenderDashCharts(analytics, airlines) {
  const host = $('clDashCharts');

  /* null means the one call these charts need failed. Said out loud rather than
     drawn as an empty chart, which would read as "you have no bookings". */
  if (analytics === null) {
    host.innerHTML = `<div class="cl-panel"><div class="cl-panel-body">
      <div class="cl-msg cl-msg-info" style="margin-top:0">
        Your booking history could not be loaded, so the charts are not shown. Everything else
        on this page is up to date.
      </div></div></div>`;
    return;
  }

  const total = analytics.totals?.bookings || 0;
  if (!total) {
    host.innerHTML = `<div class="cl-panel" style="margin-top:26px;">
      <div class="cl-blank">
        <span class="cl-blank-ico">${clIco('chart', { size: 26 })}</span>
        <b>No booking activity yet</b>
        <p>Start with a booking enquiry. Once our team answers it with a fare you can turn it
           into a booking request, and this page fills in.</p>
        <button type="button" class="cl-btn cl-btn-primary" id="clDashBlankCta">
          ${clIco('plus', { size: 15 })} Raise your first enquiry</button>
      </div></div>`;
    $('clDashBlankCta').addEventListener('click', () => clGo('enquiry'));
    return;
  }

  const buckets = clBucketAnalytics(analytics.by_month);
  const span = `${buckets[0].label} – ${buckets[buckets.length - 1].label}`;

  const routes = (analytics.top_routes || []).slice(0, 6)
    .map(r => ({ name: r.route, count: r.count }));

  host.innerHTML = `
    <div class="cl-page-head" style="margin:30px 0 16px;">
      <div><h2 style="font-size:18px;">Your activity</h2>
        <p style="font-size:12.5px;margin-top:3px;color:var(--cl-text-muted);font-weight:500;">
          Volume, value and where you fly, across every booking you have raised.</p></div>
    </div>

    <div class="cl-charts">
      ${clChartPanel('Monthly bookings', `Last ${CL_CHART_MONTHS} months · ${span}`,
        clBarChart(buckets, b => b.count, n => String(Math.round(n)),
          'var(--cl-orange)', 'Bookings raised per month'), { icon: 'chart' })}
      ${clChartPanel('Monthly revenue', `Last ${CL_CHART_MONTHS} months · ${span}`,
        clAreaChart(buckets, b => b.value, clShortMoney,
          'var(--cl-info)', 'Booking value per month'), { icon: 'trend' })}
    </div>

    <div class="cl-charts">
      ${clChartPanel('Top destinations', 'Routes you book most, across your whole history',
        routes.length
          ? clRankList(routes, { valueLabel: n => `${n} booking${n === 1 ? '' : 's'}` })
          : '<p class="cl-muted" style="font-size:13px;margin:0;">No routes recorded yet.</p>',
        { icon: 'route' })}

      ${clChartPanel('Top airlines',
        airlines && airlines.rows.length
          ? (airlines.total > airlines.sampled
            ? `From your ${airlines.sampled} most recent bookings of ${airlines.total}`
            : `Across all ${airlines.sampled} booking${airlines.sampled === 1 ? '' : 's'}`)
          : 'Carriers on your bookings',
        airlines === null
          ? '<p class="cl-muted" style="font-size:13px;margin:0;">Airline mix is unavailable just now.</p>'
          : airlines.rows.length
            ? clRankList(airlines.rows, { valueLabel: n => `${n} booking${n === 1 ? '' : 's'}` })
            : '<p class="cl-muted" style="font-size:13px;margin:0;">No airline recorded on your bookings yet.</p>',
        { icon: 'plane' })}
    </div>`;
}
