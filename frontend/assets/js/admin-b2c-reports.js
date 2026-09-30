/* Admin — B2C Reports (Phase 8 of the B2C Admin Portal build-out)
   ==================================================================
   Pick a report, narrow it, see what a download will contain, download it.

   FIVE REPORTS: Bookings, Payments, Cancellations & Refunds, Customers,
   Reviews — CSV, Excel or PDF. The preview and the file are built by the same
   server code, so the row count and total shown here ARE the file's.

   DATES ARE INDIA-TIME DAYS on the field the report names ("booked on",
   "registered on", ...): the same calendar day for every report.

   TOTALS: shown only where money is the point (bookings, payments,
   cancellations) and withheld if the rows span more than one currency — a sum
   across currencies would be a meaningless number.

   CUSTOMER-TYPED TEXT IS DEFUSED IN THE FILE (a name beginning "=" would run as
   a spreadsheet formula), so a leading apostrophe on such a cell is deliberate.

   ENDPOINTS: GET /api/admin/b2c-reports/{types,preview,export}

   Loaded after admin.js and admin-b2c-catalogue-common.js (catErr, catE). */

let rprWired = false;
let rprTypes = [];

function rprParams() {
  const v = id => document.getElementById(id).value;
  return {
    type: v('rprType'), date_from: v('rprFrom') || undefined, date_to: v('rprTo') || undefined,
    status: v('rprStatus') || undefined, product: v('rprProduct') || undefined,
  };
}

async function initB2CReports() {
  if (!rprWired) {
    try {
      rprTypes = (await axios.get(`${API_BASE}/api/admin/b2c-reports/types`, { headers: authHeaders() })).data;
    } catch (err) {
      document.getElementById('rprPreview').innerHTML = `<p class="empty-state">${escapeHtml(catErr(err, 'Could not load the reports.'))}</p>`;
      return;
    }
    rprWired = true;
    document.getElementById('rprType').innerHTML = rprTypes.map(t => `<option value="${t.type}">${escapeHtml(t.label)}</option>`).join('');
    document.getElementById('rprType').addEventListener('change', () => { rprShapeFilters(); rprLoad(); });
    ['rprFrom', 'rprTo', 'rprStatus', 'rprProduct'].forEach(id => document.getElementById(id).addEventListener('change', rprLoad));
    [['rprCsv', 'csv'], ['rprXlsx', 'xlsx'], ['rprPdf', 'pdf']].forEach(([id, fmt]) =>
      document.getElementById(id).addEventListener('click', e => rprDownload(fmt, e.currentTarget)));
    rprShapeFilters();
  }
  rprLoad();
}

/* The filters a report actually has: its own statuses, and a product filter only
   where the report has one. Changing report clears the old choices. */
function rprShapeFilters() {
  const t = rprTypes.find(x => x.type === document.getElementById('rprType').value);
  document.getElementById('rprStatus').innerHTML = '<option value="">Any status</option>' +
    t.statuses.map(s => `<option value="${s}">${escapeHtml(catCap(s))}</option>`).join('');
  document.getElementById('rprProduct').innerHTML = '<option value="">All services</option>' +
    t.products.map(p => `<option value="${p}">${escapeHtml(catCap(p))}</option>`).join('');
  document.getElementById('rprProductField').hidden = !t.products.length;
  document.getElementById('rprDateLabel').textContent = `Dates filter on: ${t.date_field} (India time)`;
}

async function rprLoad() {
  const host = document.getElementById('rprPreview');
  host.innerHTML = rowsSkeleton(4);
  rprMsg('');
  try {
    const d = (await axios.get(`${API_BASE}/api/admin/b2c-reports/preview`, { headers: authHeaders(), params: rprParams() })).data;
    const shown = d.rows.length;
    host.innerHTML = `
      <div class="detail-grid" style="margin-top:0;">
        <div class="detail-item"><span class="detail-label">Rows in this report</span><span class="detail-value" style="font-size:22px;">${d.row_count.toLocaleString('en-IN')}</span></div>
        ${d.value_label ? `<div class="detail-item"><span class="detail-label">${escapeHtml(d.value_label)}</span>
          <span class="detail-value" style="font-size:22px;">${d.total_value != null ? moneyStr(d.total_value) : '—'}</span>
          ${d.total_value == null && d.row_count ? '<span class="cell-sub">Not shown: the rows use more than one currency.</span>' : ''}</div>` : ''}
      </div>
      ${d.truncated ? `<p class="msg error">Only the first ${d.row_cap.toLocaleString('en-IN')} rows are included. Narrow the dates to see the rest.</p>` : ''}
      <p class="cell-sub" style="margin:10px 0 6px;">${shown ? `First ${shown} of ${d.row_count.toLocaleString('en-IN')} — the download has every row.` : ''}</p>
      <div class="table-wrap"><table><thead><tr>${d.columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${shown ? d.rows.map(r => `<tr>${d.columns.map(c => `<td>${escapeHtml(r[c.key] == null ? '' : r[c.key])}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="${d.columns.length}" class="empty-state">No rows match these filters.</td></tr>`}</tbody></table></div>`;
    ['rprCsv', 'rprXlsx', 'rprPdf'].forEach(id => { document.getElementById(id).disabled = !d.row_count; });
  } catch (err) {
    host.innerHTML = `<p class="empty-state">${escapeHtml(catErr(err, 'Could not build this report.'))}</p>`;
  }
}

function rprMsg(text, isError) {
  const el = document.getElementById('rprMsg');
  el.textContent = text || '';
  el.className = 'msg' + (isError ? ' error' : '');
}

async function rprDownload(format, btn) {
  btn.disabled = true;
  rprMsg('');
  try {
    const res = await axios.get(`${API_BASE}/api/admin/b2c-reports/export`, {
      headers: authHeaders(), params: { ...rprParams(), format }, responseType: 'blob',
    });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    const name = (res.headers['content-disposition'] || '').match(/filename="([^"]+)"/);
    a.href = url; a.download = name ? name[1] : `b2c-report.${format}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (typeof showToast === 'function') showToast('Report downloaded.');
  } catch (err) {
    /* A failed download arrives as a Blob, so its JSON error has to be read out of it. */
    let text = 'Could not download this report.';
    try { const j = JSON.parse(await err.response.data.text()); if (typeof j.detail === 'string') text = j.detail; } catch { /* keep default */ }
    rprMsg(text, true);
  } finally {
    btn.disabled = false;
  }
}
