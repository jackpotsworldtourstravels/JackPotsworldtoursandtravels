'use strict';
/* Admin Portal — Analytics (M6).
   ===========================================================================
   Four panels over three endpoints, and not one number computed here:

     GET /api/analytics/operations       — the desk's own queue health
     GET /api/analytics/bookings         — volume, value and mix
     GET /api/analytics/change-requests  — cancellations, reschedules, money

   The rule this screen is written to is M6's: every tile must be reproducible
   by a direct SQL query. So the browser's job is drawing, never arithmetic.
   Where a figure is a sum it arrived summed; where it is a percentage it is
   computed from two figures that arrived, and is a *label*, never a stored or
   exported number.

   Money crosses the wire as decimal strings and is rendered with `moneyStr`.
   `money()` (which floats and rounds to whole rupees) is deliberately not used
   on anything from these endpoints — see shared/formatters.js.

   Charts are hand-rolled inline SVG against the admin CSS custom properties,
   matching the Classic portal's approach: this portal has a live theme and an
   SVG referencing the same tokens re-themes with it. Chart.js is loaded by this
   page for the dashboard, but a library that paints to a canvas cannot do that.
*/

const AA_MONTHS = 6;
const AA_CH = { w: 340, h: 176, x0: 46, x1: 330, yTop: 16, yBase: 136, yLab: 154 };

let aaLoaded = false;

function aaShortMoney(n) {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(v % 1e7 ? 1 : 0)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(v % 1e5 ? 1 : 0)}L`;
  if (v >= 1e3) return `₹${Math.round(v / 1e3)}k`;
  return `₹${Math.round(v)}`;
}

function aaNiceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude;
}

/* The last N calendar months ending with this one, oldest first. Stepped by
   month index, not by subtracting 30 days — a 31-day month would let a bucket
   be skipped entirely. */
function aaMonthFrame(byMonth) {
  const now = new Date();
  const out = [];
  for (let i = AA_MONTHS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-IN', { month: 'short' }),
      count: 0, value: 0,
    });
  }
  const byKey = new Map(out.map(b => [b.key, b]));
  (byMonth || []).forEach(m => {
    const bucket = byKey.get(m.month);
    if (!bucket) return;                     // outside the window, or unscheduled
    bucket.count = m.count;
    /* Number() for the drawing's geometry and its abbreviated axis label only.
       The exact figure is never rendered from it. */
    bucket.value = Number(m.value) || 0;
  });
  return out;
}

function aaFrame(buckets, max, fmt) {
  const { x0, x1, yTop, yBase, yLab } = AA_CH;
  const band = (x1 - x0) / buckets.length;
  const grid = [0, 0.5, 1].map(f => {
    const y = yBase - (yBase - yTop) * f;
    return `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"
                  stroke="var(--border-color, #d9dee8)" stroke-width="1"/>
            <text x="${x0 - 7}" y="${y + 3.5}" text-anchor="end" font-size="9"
                  fill="var(--text-muted, #64748b)">${escapeHtml(fmt(max * f))}</text>`;
  }).join('');
  const labels = buckets.map((b, i) =>
    `<text x="${(x0 + band * (i + 0.5)).toFixed(1)}" y="${yLab}" text-anchor="middle"
           font-size="10" font-weight="700"
           fill="var(--text-muted, #64748b)">${escapeHtml(b.label)}</text>`).join('');
  return { grid: grid + labels, band };
}

function aaBarChart(buckets, pick, fmt, colour, title) {
  const max = aaNiceMax(Math.max(...buckets.map(pick)));
  const { grid, band } = aaFrame(buckets, max, fmt);
  const { w, h, x0, yTop, yBase } = AA_CH;
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
                  fill="var(--text-primary, #0f172a)">${escapeHtml(fmt(value))}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;" role="img"
               aria-label="${escapeHtml(title)}">${grid}${bars}</svg>`;
}

/* A horizontal bar per row — used for the status mix and for operator load,
   where the category labels are words rather than months. */
function aaBarList(rows, { max, fmt = String, colour = 'var(--coral, #ef6461)' } = {}) {
  const ceiling = max || Math.max(1, ...rows.map(r => r.value));
  return `<div class="aa-barlist">${rows.map(r => `
    <div class="aa-barlist-row">
      <span class="aa-barlist-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
      <span class="aa-barlist-track">
        <span class="aa-barlist-fill"
              style="width:${Math.max(2, (r.value / ceiling) * 100).toFixed(1)}%;background:${colour}"></span>
      </span>
      <span class="aa-barlist-value">${escapeHtml(fmt(r.value))}</span>
    </div>`).join('')}</div>`;
}

function aaStat(value, label, sub, tone) {
  return `<div class="aa-stat${tone ? ' aa-stat-' + tone : ''}">
    <div class="aa-stat-value">${escapeHtml(String(value ?? '—'))}</div>
    <div class="aa-stat-label">${escapeHtml(label)}</div>
    ${sub ? `<div class="aa-stat-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

function aaHours(h) {
  const v = Number(h) || 0;
  if (v >= 48) return `${(v / 24).toFixed(1)} days`;
  if (v >= 1) return `${v.toFixed(1)} h`;
  return `${Math.round(v * 60)} min`;
}

function aaPanel(title, sub, body) {
  return `<div class="panel">
    <div class="panel-head">
      <h2>${escapeHtml(title)}</h2>
      ${sub ? `<span class="aa-panel-sub">${escapeHtml(sub)}</span>` : ''}
    </div>
    ${body}
  </div>`;
}

/* ---------- loading ---------- */

/* The server's own message where there is one. A 403 here is meaningful — the
   operations panel is Admin-only — so it is shown rather than replaced with a
   generic failure. */
function aaErrorText(err) {
  return err?.response?.data?.detail || 'Could not load this section.';
}

async function loadAnalytics() {
  const host = document.getElementById('analyticsBody');
  host.innerHTML = '<div class="empty-state">Loading analytics…</div>';

  /* Each panel is independent: one endpoint failing must not blank the other
     two. `Promise.all` over already-caught promises gives that without
     `allSettled`'s wrapper objects at every read site. */
  const [ops, bookings, changes] = await Promise.all([
    axios.get(`${API_BASE}/api/analytics/operations`, { headers: authHeaders() })
      .then(r => r.data).catch(err => ({ _error: aaErrorText(err) })),
    axios.get(`${API_BASE}/api/analytics/bookings`, {
      headers: authHeaders(), params: { date_field: 'created_at' },
    }).then(r => r.data).catch(err => ({ _error: aaErrorText(err) })),
    axios.get(`${API_BASE}/api/analytics/change-requests`, { headers: authHeaders() })
      .then(r => r.data).catch(err => ({ _error: aaErrorText(err) })),
  ]);

  host.innerHTML = [
    aaOperationsPanel(ops),
    aaBookingsPanel(bookings),
    aaChangeRequestsPanel(changes),
  ].join('');
  aaLoaded = true;
}

function aaError(message) {
  return `<div class="panel-body"><div class="empty-state">${escapeHtml(message)}</div></div>`;
}

/* ---------- operations ---------- */

function aaOperationsPanel(d) {
  if (d._error) return aaPanel('Operations desk', '', aaError(d._error));

  const w = d.waiting;
  const breach = d.sla.breached;
  const body = `<div class="panel-body">
    <div class="aa-stats">
      ${aaStat(w.count, 'Bookings waiting', 'Approved, awaiting payment or paid')}
      ${aaStat(d.queue.unassigned, 'Unassigned', 'Nobody is working these',
               d.queue.unassigned ? 'warn' : null)}
      ${aaStat(aaHours(w.oldest_hours), 'Oldest wait', 'Longest-waiting booking')}
      ${aaStat(aaHours(w.median_hours), 'Median wait', 'Half wait less than this')}
      ${aaStat(breach, `Over ${d.sla.threshold_hours}h`, 'Past the ageing threshold',
               breach ? 'bad' : 'good')}
      ${aaStat(aaHours(d.time_to_issue.median_hours), 'Median time to ticket',
               `${d.time_to_issue.sample} issued in ${d.time_to_issue.window_days} days`)}
    </div>

    <div class="aa-split">
      <div>
        <h3 class="aa-sub">How long the queue has been waiting</h3>
        ${aaBarList([
          { label: 'Under 24 hours', value: w.buckets.under_24h },
          { label: '24 – 72 hours', value: w.buckets.h24_to_72h },
          { label: `Over ${d.sla.threshold_hours} hours`, value: w.buckets.over_72h },
        ], { colour: 'var(--gold, #d4a017)' })}
        <p class="aa-note">
          Measured over ${escapeHtml(d.waiting.stages.join(', ').replace(/_/g, ' '))} only.
          A ticketed booking is no longer waiting, so counting its age would make this number
          grow for ever.
        </p>
      </div>
      <div>
        <h3 class="aa-sub">Operator load</h3>
        ${d.operators.length
          ? aaBarList(d.operators.map(o => ({ label: o.full_name, value: o.active_load })),
                      { colour: 'var(--sky, #38bdf8)' })
          : '<div class="empty-state">No active operators.</div>'}
        <div class="aa-scroll"><table class="aa-mini"><thead><tr>
          <th>Operator</th><th class="aa-num">Working</th><th class="aa-num">Issued (30d)</th>
        </tr></thead><tbody>
          ${d.operators.map(o => `<tr>
            <td>${escapeHtml(o.full_name)}</td>
            <td class="aa-num">${o.active_load}</td>
            <td class="aa-num">${o.issued_last_30d}</td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>

    <p class="aa-note">
      Time to ticket is measured from the booking being raised to the status history entry
      that recorded <b>Ticket Issued</b> — the same history the Activity Timeline renders, so
      every figure here can be checked against a booking on screen.
      Average ${escapeHtml(aaHours(d.time_to_issue.average_hours))} ·
      median ${escapeHtml(aaHours(d.time_to_issue.median_hours))} ·
      90th percentile ${escapeHtml(aaHours(d.time_to_issue.p90_hours))}.
    </p>
  </div>`;

  return aaPanel('Operations desk', `${d.queue.total} bookings in the queue`, body);
}

/* ---------- bookings ---------- */

function aaBookingsPanel(d) {
  if (d._error) return aaPanel('Bookings', '', aaError(d._error));

  const buckets = aaMonthFrame(d.by_month);
  const span = `${buckets[0].label} – ${buckets[buckets.length - 1].label}`;
  const statusRows = d.by_status.map(s => ({ label: s.label, value: s.count }));

  const body = `<div class="panel-body">
    <div class="aa-stats">
      ${aaStat(d.totals.bookings, 'Bookings', 'Every booking on the platform')}
      ${aaStat(moneyStr(d.totals.value), 'Total value', 'What they were booked at')}
      ${aaStat(moneyStr(d.totals.average_value), 'Average booking', 'Value ÷ bookings')}
    </div>

    <div class="aa-split">
      <div>
        <h3 class="aa-sub">Bookings raised · last ${AA_MONTHS} months (${escapeHtml(span)})</h3>
        ${aaBarChart(buckets, b => b.count, n => String(Math.round(n)),
                     'var(--coral, #ef6461)', 'Bookings raised per month')}
      </div>
      <div>
        <h3 class="aa-sub">Booking value · last ${AA_MONTHS} months</h3>
        ${aaBarChart(buckets, b => b.value, aaShortMoney,
                     'var(--sky, #38bdf8)', 'Booking value per month')}
      </div>
    </div>

    <h3 class="aa-sub">Where they are</h3>
    ${aaBarList(statusRows, { colour: 'var(--navy-3, #274b73)' })}

    <h3 class="aa-sub">Busiest routes</h3>
    ${d.top_routes.length ? `<div class="aa-scroll"><table class="aa-mini"><thead><tr>
      <th>Route</th><th class="aa-num">Bookings</th><th class="aa-num">Value</th>
    </tr></thead><tbody>
      ${d.top_routes.map(r => `<tr>
        <td>${escapeHtml(r.route)}</td>
        <td class="aa-num">${r.count}</td>
        <td class="aa-num">${moneyStr(r.value)}</td>
      </tr>`).join('')}
    </tbody></table></div>` : '<div class="empty-state">No routed bookings yet.</div>'}

    <p class="aa-note">
      Grouped on the date each booking was <b>raised</b>. Filtering and grouping always use the
      same column, so the monthly series and the totals above it describe the same set —
      the Reports screen's date filter is a different column (travel date) and says so there.
    </p>
  </div>`;

  return aaPanel('Bookings', `${d.totals.bookings} bookings · ${moneyStr(d.totals.value)}`, body);
}

/* ---------- change requests ---------- */

function aaChangeRequestsPanel(d) {
  if (d._error) return aaPanel('Cancellations, reschedules & refunds', '', aaError(d._error));

  const m = d.money;
  const body = `<div class="panel-body">
    <div class="aa-stats">
      ${aaStat(d.totals.requests, 'Requests raised', 'Every service request type')}
      ${aaStat(d.totals.pending, 'Awaiting a decision', 'Pending or under review',
               d.totals.pending ? 'warn' : null)}
      ${aaStat(moneyStr(m.cancellation_charges), 'Cancellation charges', 'Retained on approval')}
      ${aaStat(moneyStr(m.refunds_due), 'Refunds due', 'Net of charges')}
      ${aaStat(moneyStr(m.refunds_settled), 'Refunds settled', 'Already returned')}
      ${aaStat(moneyStr(m.refunds_outstanding), 'Still to settle', 'Due less settled',
               moneyIsPositive(m.refunds_outstanding) ? 'bad' : 'good')}
    </div>

    <h3 class="aa-sub">By type</h3>
    <div class="aa-scroll"><table class="aa-mini"><thead><tr>
      <th>Type</th><th class="aa-num">Raised</th><th class="aa-num">Approved</th>
      <th class="aa-num">Rejected</th><th class="aa-num">Pending</th>
    </tr></thead><tbody>
      ${d.by_type.length ? d.by_type.map(t => `<tr>
        <td>${escapeHtml(t.label)}</td>
        <td class="aa-num">${t.total}</td>
        <td class="aa-num">${t.approved}</td>
        <td class="aa-num">${t.rejected}</td>
        <td class="aa-num">${t.pending}</td>
      </tr>`).join('')
        : '<tr><td colspan="5" class="empty-state">No service requests raised yet.</td></tr>'}
    </tbody></table></div>

    <p class="aa-note">
      Money covers <b>${escapeHtml(m.basis)}</b>. A rejected cancellation charged nothing and
      refunded nothing, so including it would report money that never moved.
      <b>Still to settle</b> is refunds due less refunds settled — everything still owed, whether
      the cancellation has been settled at all or was settled short.
      Of it, ${escapeHtml(moneyStr(m.refunds_short_settled))} is a recorded shortfall: a
      settlement that ran but could not be covered by the booking's own payments, so it needs a
      manual disbursement rather than time.
      Fare differences on approved date changes: ${escapeHtml(moneyStr(m.fare_differences))}.
    </p>
  </div>`;

  return aaPanel('Cancellations, reschedules & refunds',
                 `${d.totals.requests} raised · ${d.totals.approved} approved`, body);
}
