/* Admin — B2C Analytics (Phase 8 of the B2C Admin Portal build-out)
   ==================================================================
   THE BROWSER ONLY DRAWS. Every figure arrives from
   GET /api/admin/b2c-analytics/overview already computed, and each one is
   reproducible by a direct SQL query; the server also supplies the calendar
   months, so no bucket is computed here. The only arithmetic in this file is
   two labels derived from counts that arrived (a cancellation rate, a bar
   length) — never a stored or exported number.

   BOOKED VALUE IS NOT MONEY RECEIVED. "Booked value" is what is on the books;
   "Collected" is captured payments, the only money actually in. Both are shown
   and both are explained on the screen — calling the first "revenue" would
   overstate income by everything unpaid.

   CHARTS are hand-drawn inline SVG against theme tokens (so they re-theme with
   the portal): stacked columns for bookings by product (three products = the
   first three validated categorical slots), single-hue columns/bars elsewhere,
   a legend, a hover tooltip on every mark, and a "View as table" for each chart
   so nothing depends on colour alone.

   Loaded after admin.js and admin-b2c-catalogue-common.js (catErr, catE). */

const B2CA_PRODUCTS = [['flight', 'Flights'], ['hotel', 'Hotels'], ['package', 'Packages']];
const B2CA_LABEL = { flight: 'Flights', hotel: 'Hotels', package: 'Packages' };

let b2caWired = false;
let b2caMonths = 6;

const b2caMonth = k => {
  const [y, m] = k.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
};
const b2caMonthLong = k => {
  const [y, m] = k.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};
const b2caPct = (n, d) => (d ? `${(n / d * 100).toFixed(1)}%` : '—');

async function initB2CAnalytics() {
  if (!b2caWired) {
    b2caWired = true;
    document.getElementById('b2caMonths').addEventListener('change', e => { b2caMonths = Number(e.target.value); loadB2CAnalytics(); });
  }
  await loadB2CAnalytics();
}

async function loadB2CAnalytics() {
  const host = document.getElementById('b2caBody');
  host.innerHTML = statGridSkeleton(6);
  try {
    const { data: o } = await axios.get(`${API_BASE}/api/admin/b2c-analytics/overview`, {
      headers: authHeaders(), params: { months: b2caMonths },
    });
    host.innerHTML = b2caRender(o);
  } catch (err) {
    host.innerHTML = `<p class="empty-state">${escapeHtml(catErr(err, 'Could not load analytics.'))}</p>`;
  }
}

/* ---------- pieces ---------- */

const b2caTile = (label, value, sub, hint) => `
  <div class="b2ca-tile" ${hint ? `title="${catE(hint)}"` : ''}>
    <span class="detail-label">${escapeHtml(label)}</span>
    <span class="b2ca-hero">${value}</span>
    ${sub ? `<span class="cell-sub">${sub}</span>` : ''}
  </div>`;

function b2caTable(headers, rows, numFrom = 1) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h, i) =>
    `<th${i >= numFrom ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows.map(r => `<tr>${r.map((c, i) => `<td${i >= numFrom ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${headers.length}" class="empty-state">Nothing in this period.</td></tr>`}</tbody></table></div>`;
}

const b2caCard = (title, sub, inner) => `
  <section class="b2ca-card"><h3>${escapeHtml(title)}</h3>${sub ? `<p class="cell-sub">${escapeHtml(sub)}</p>` : ''}${inner}</section>`;

/* A "nice" axis: four equal steps, whole numbers for counts. */
function b2caAxis(max, money) {
  if (!(max > 0)) return { top: 4, ticks: [0, 1, 2, 3, 4] };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(x => x >= raw);
  if (!money) step = Math.max(1, Math.ceil(step));
  return { top: step * 4, ticks: [0, 1, 2, 3, 4].map(i => step * i) };
}

const b2caShortMoney = n => {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${+(v / 1e7).toFixed(1)}Cr`;
  if (v >= 1e5) return `₹${+(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `₹${+(v / 1e3).toFixed(1)}k`;
  return `₹${Math.round(v)}`;
};

/* Stacked (or single) columns by month. series: [{key, name, cls, values[]}]. */
function b2caColumns(frame, series, unit, money) {
  const W = 640, H = 250, L = money ? 54 : 38, R = 8, T = 10, B = 26;
  const totals = frame.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const { top, ticks } = b2caAxis(Math.max(0, ...totals), money);
  const bw = (W - L - R) / frame.length;
  const barW = Math.min(46, bw * 0.62);
  const y = v => T + (H - T - B) * (1 - v / top);
  const grid = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="b2ca-grid"/>
    <text x="${L - 6}" y="${y(t) + 3.5}" text-anchor="end" class="b2ca-axis">${money ? b2caShortMoney(t) : t}</text>`).join('');
  const bars = frame.map((m, i) => {
    let base = 0;
    const cx = L + bw * i + bw / 2;
    const segs = series.map(s => {
      const v = s.values[i];
      if (!v) return '';
      const y0 = y(base + v), h = y(base) - y0;
      base += v;
      return `<rect x="${cx - barW / 2}" y="${y0}" width="${barW}" height="${Math.max(0, h)}" rx="2" class="b2ca-bar ${s.cls}">
        <title>${escapeHtml(b2caMonthLong(m))} · ${escapeHtml(s.name)}: ${money ? escapeHtml(moneyStr(v)) : `${v} ${unit}`}</title></rect>`;
    }).join('');
    return `${segs}<text x="${cx}" y="${H - 8}" text-anchor="middle" class="b2ca-axis">${escapeHtml(b2caMonth(m))}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="b2ca-svg" role="img" aria-label="${catE(unit)} by month">${grid}${bars}</svg>`;
}

const b2caLegend = series => series.length > 1 ? `<div class="b2ca-legend">${series.map(s =>
  `<span><i class="b2ca-swatch ${s.cls}"></i>${escapeHtml(s.name)}</span>`).join('')}</div>` : '';

function b2caChart(title, sub, frame, series, unit, money) {
  const anyData = series.some(s => s.values.some(v => v > 0));
  const tableRows = frame.map((m, i) => [escapeHtml(b2caMonthLong(m)), ...series.map(s => (money ? moneyStr(s.values[i]) : String(s.values[i])))]);
  return b2caCard(title, sub, anyData
    ? `${b2caLegend(series)}${b2caColumns(frame, series, unit, money)}
       <details class="b2ca-table"><summary>View as table</summary>${b2caTable(['Month', ...series.map(s => s.name)], tableRows)}</details>`
    : '<p class="empty-state">Nothing in this period.</p>');
}

/* Horizontal bars: rows [{label, value}], one hue, value printed at the end. */
function b2caBars(rows, fmt) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return `<div class="b2ca-hbars">${rows.map(r => `
    <div class="b2ca-hrow" title="${catE(r.label)}: ${catE(fmt ? fmt(r.value) : r.value)}">
      <span class="b2ca-hlabel">${escapeHtml(r.label)}</span>
      <span class="b2ca-htrack"><span class="b2ca-hfill" style="width:${Math.round(r.value / max * 100)}%"></span></span>
      <span class="b2ca-hvalue">${escapeHtml(fmt ? fmt(r.value) : r.value)}</span></div>`).join('')}</div>`;
}

/* ---------- the page ---------- */

function b2caRender(o) {
  const b = o.bookings, p = o.payments, c = o.customers;
  const monthly = Object.fromEntries(b.monthly.map(x => [x.product, x.series]));
  const bookingSeries = B2CA_PRODUCTS.map(([k, name], i) => ({
    key: k, name, cls: `s${i + 1}`, values: monthly[k].map(m => m.count),
  }));

  const warn = b.non_inr_bookings
    ? `<p class="msg error">${b.non_inr_bookings} booking(s) in this period are not in INR. Money figures add amounts as rupees, so they are not reliable until those are reviewed.</p>` : '';

  const tiles = `
    <div class="b2ca-tiles">
      ${b2caTile('Customers', c.total.toLocaleString('en-IN'), `+${c.new_in_period} new · ${c.registered} registered · ${c.guests} guests`)}
      ${b2caTile('Bookings', b.created.toLocaleString('en-IN'), `${b.cancelled} cancelled (${b2caPct(b.cancelled, b.created)})`)}
      ${b2caTile('Booked value', moneyStr(b.booked_value), 'On the books, paid or not', o.definitions.booked_value)}
      ${b2caTile('Confirmed value', moneyStr(b.confirmed_value), 'Confirmed or completed', o.definitions.confirmed_value)}
      ${b2caTile('Collected', moneyStr(p.collected), `${p.captured_count} captured payment${p.captured_count === 1 ? '' : 's'}`, o.definitions.collected)}
      ${b2caTile('Refunded', moneyStr(o.refunds.refunded), `${o.refunds.requests} request${o.refunds.requests === 1 ? '' : 's'}`, o.definitions.refunded)}
      ${b2caTile('Average rating', o.reviews.average != null ? `${Number(o.reviews.average).toFixed(2)} ★` : '—', `${o.reviews.approved} approved · ${o.reviews.pending} pending`)}
    </div>
    <p class="cell-sub" style="margin:8px 0 0;"><strong>Booked value</strong> is what customers have agreed to pay — not money received.
      <strong>Collected</strong> is captured payments, the only money actually in. Window: ${escapeHtml(b2caMonthLong(o.since))} to now.</p>`;

  const funnel = b2caCard('Booking to payment', 'Bookings created in the period, and how many reached each payment step.',
    b2caBars(o.funnel.map(f => ({ label: f.step, value: f.count }))) +
    `<p class="cell-sub" style="margin-top:6px;">${o.funnel[0].count ? `${b2caPct(o.funnel[2].count, o.funnel[0].count)} of bookings have a captured payment.` : ''}</p>`);

  const payStatus = b2caCard('Payments by status', 'Payment attempts created in the period.',
    p.by_status.length ? b2caBars(p.by_status.map(s => ({ label: catCap(s.status), value: s.count }))) +
      b2caTable(['Status', 'Payments', 'Amount'], p.by_status.map(s => [escapeHtml(catCap(s.status)), s.count, moneyStr(s.amount)]), 1)
      : '<p class="empty-state">No payments in this period.</p>');

  const byProduct = b2caCard('By service', 'Bookings created in the period.', b2caTable(
    ['Service', 'Bookings', 'Cancelled', 'Cancel rate', 'Booked value', 'Confirmed value'],
    b.by_product.map(x => [escapeHtml(B2CA_LABEL[x.product] || x.product), x.bookings, x.cancelled, b2caPct(x.cancelled, x.bookings), moneyStr(x.booked_value), moneyStr(x.confirmed_value)])));

  const status = b2caCard('Bookings by status', null, b2caTable(
    ['Status', 'Bookings', 'Value'], b.by_status.map(s => [escapeHtml(catCap(s.status)), s.count, moneyStr(s.value)])));

  const top = (title, rows) => b2caCard(title, 'By bookings, cancelled ones excluded.', b2caTable(['Name', 'Bookings', 'Value'],
    rows.map(r => [escapeHtml(r.name), r.bookings, moneyStr(r.value)]), 1));

  const refunds = b2caCard('Cancellation requests', 'Requests raised in the period.', o.refunds.by_status.length
    ? b2caTable(['Status', 'Requests', 'Refund amount'], o.refunds.by_status.map(s => [escapeHtml(catCap(s.status)), s.count, moneyStr(s.amount)]))
    : '<p class="empty-state">No cancellation requests in this period.</p>');

  return `${warn}${tiles}
    <div class="b2ca-grid2">
      ${b2caChart('Bookings by month', 'Created each month, by service.', o.frame, bookingSeries, 'bookings')}
      ${b2caChart('Booked value by month', 'What was booked each month, by service (not money received).', o.frame,
        B2CA_PRODUCTS.map(([k, name], i) => ({ key: k, name, cls: `s${i + 1}`, values: monthly[k].map(m => Number(m.value)) })),
        'rupees', true)}
      ${b2caChart('New customers by month', 'Registrations and guest sign-ups.', o.frame,
        [{ key: 'c', name: 'New customers', cls: 's1', values: c.by_month.map(m => m.count) }], 'new customers')}
      ${funnel}
      ${payStatus}
      ${byProduct}
      ${status}
      ${refunds}
      ${top('Top packages', o.top.packages)}
      ${top('Top hotels', o.top.hotels)}
      ${top('Top flight routes', o.top.flight_routes)}
    </div>`;
}
