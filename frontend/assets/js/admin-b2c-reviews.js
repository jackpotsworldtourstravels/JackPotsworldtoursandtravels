/* Admin — B2C Reviews & Ratings (Phase 6 of the B2C Admin Portal build-out)
   ==================================================================
   Moderates the reviews customers write from their account page. Approving or
   rejecting decides what OTHER visitors see: the public review list serves only
   approved reviews, new reviews start pending, and a customer editing theirs
   sends it back to pending. The desk can also leave one public reply per
   review. It can never edit the customer's rating or words.

   PRODUCT FILTERS: Flight, Hotel, Tour Package, Gaming Package (a package in
   the gaming category), Cruise. Flights and cruises have no catalogue table, so
   they show as "Flight #n" rather than an invented name.

   ANALYTICS COUNT APPROVED REVIEWS ONLY — the same set customers can see — and
   the panel says so.

   ENDPOINTS:
     GET   /api/admin/reviews              paged, filterable list (+ per-status counts)
     GET   /api/admin/reviews/analytics    rating analytics
     PATCH /api/admin/reviews/{id}         {status?, admin_reply?}

   Loaded after admin.js and admin-b2c-catalogue-common.js, whose shared modal,
   field builders and error formatter it reuses. */

const RVW_TABS = [['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']];
const RVW_TONE = { pending: 'pending', approved: 'confirmed', rejected: 'cancelled' };
const RVW_PRODUCTS = [['', 'All products'], ['flight', 'Flights'], ['hotel', 'Hotels'],
  ['package', 'Tour Packages'], ['gaming', 'Gaming Packages'], ['cruise', 'Cruises']];
const RVW_PRODUCT_LABEL = { flight: 'Flight', hotel: 'Hotel', package: 'Tour Package', gaming: 'Gaming Package', cruise: 'Cruise' };

const rvwState = { status: '', product: '', rating: '', search: '', page: 1 };
let rvwWired = false;
let rvwCurrent = null;

async function rvwApi(method, path = '', { params, data } = {}) {
  const res = await axios({ method, url: `${API_BASE}/api/admin/reviews${path}`, headers: authHeaders(), params, data });
  return res.data;
}

const rvwStars = n => `<span title="${n} out of 5" style="color:#e6a100; letter-spacing:1px;">${'★'.repeat(n)}<span style="color:rgba(10,37,64,.2)">${'★'.repeat(5 - n)}</span></span>`;
const rvwPill = s => `<span class="badge ${RVW_TONE[s] || 'pending'}">${escapeHtml(s[0].toUpperCase() + s.slice(1))}</span>`;
const rvwDate = v => v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

async function initB2CReviews() {
  if (!rvwWired) {
    rvwWired = true;
    const search = document.getElementById('rvwSearch');
    search.addEventListener('input', catDebounce(() => { rvwState.search = search.value.trim(); rvwState.page = 1; loadB2CReviews(); }));
    const product = document.getElementById('rvwProductFilter');
    product.innerHTML = RVW_PRODUCTS.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
    product.addEventListener('change', e => { rvwState.product = e.target.value; rvwState.page = 1; loadB2CReviews(); });
    document.getElementById('rvwRatingFilter').addEventListener('change', e => { rvwState.rating = e.target.value; rvwState.page = 1; loadB2CReviews(); });
    document.getElementById('rvwTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-rvw-tab]');
      if (!b) return;
      rvwState.status = b.dataset.rvwTab; rvwState.page = 1; loadB2CReviews();
    });
    document.getElementById('rvwTable').addEventListener('click', e => {
      const b = e.target.closest('[data-rvw-open]');
      if (b) openReview(b.dataset.rvwOpen);
    });
  }
  loadReviewAnalytics();
  await loadB2CReviews();
}

/* ---------- analytics ---------- */

async function loadReviewAnalytics() {
  const host = document.getElementById('rvwAnalytics');
  try {
    const a = await rvwApi('get', '/analytics');
    const max = Math.max(1, ...a.distribution.map(b => b.count));
    const item = x => `<tr><td>${escapeHtml(x.item_name)}<div class="cell-sub">${escapeHtml(RVW_PRODUCT_LABEL[x.product] || x.product)}</div></td>
      <td class="num">${Number(x.average).toFixed(2)} ★</td><td class="num">${x.count}</td></tr>`;
    const list = (title, rows) => `<div><h3 style="font-size:13px; margin:0 0 6px;">${title}</h3>${rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Avg</th><th class="num">Reviews</th></tr></thead><tbody>${rows.map(item).join('')}</tbody></table></div>`
      : '<span class="cell-sub">Nothing to show yet.</span>'}</div>`;
    host.innerHTML = `
      <div class="detail-grid" style="margin-top:4px;">
        <div class="detail-item"><span class="detail-label">Average rating</span>
          <span class="detail-value" style="font-size:22px;">${a.average != null ? Number(a.average).toFixed(2) : '—'} <span style="color:#e6a100;">★</span></span></div>
        <div class="detail-item"><span class="detail-label">Approved</span><span class="detail-value">${a.approved}</span></div>
        <div class="detail-item"><span class="detail-label">Pending</span><span class="detail-value">${a.pending}</span></div>
        <div class="detail-item"><span class="detail-label">Rejected</span><span class="detail-value">${a.rejected}</span></div>
      </div>
      <p class="cell-sub" style="margin:6px 0 14px;">${escapeHtml(a.basis)}</p>
      <div class="form-grid" style="align-items:start;">
        <div><h3 style="font-size:13px; margin:0 0 6px;">Ratings breakdown</h3>
          ${a.distribution.map(b => `<div style="display:flex; align-items:center; gap:8px; margin:4px 0; font-size:12.5px; font-weight:600;">
            <span style="width:26px;">${b.rating} ★</span>
            <span style="flex:1; height:10px; border-radius:6px; background:rgba(10,37,64,.07); overflow:hidden;">
              <span style="display:block; height:100%; width:${Math.round(b.count / max * 100)}%; background:#e6a100;"></span></span>
            <span style="width:28px; text-align:right;">${b.count}</span></div>`).join('')}</div>
        <div><h3 style="font-size:13px; margin:0 0 6px;">By product</h3>${a.by_product.length
          ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Avg</th><th class="num">Reviews</th></tr></thead><tbody>${
              a.by_product.map(p => `<tr><td>${escapeHtml(RVW_PRODUCT_LABEL[p.product] || p.product)}</td><td class="num">${Number(p.average).toFixed(2)} ★</td><td class="num">${p.count}</td></tr>`).join('')}</tbody></table></div>`
          : '<span class="cell-sub">No approved reviews yet.</span>'}</div>
        ${list('Highest rated', a.top_items)}
        ${list('Lowest rated', a.lowest_items)}
      </div>
      ${a.monthly.length ? `<p class="cell-sub" style="margin-top:12px;">Last months (approved): ${a.monthly.map(m =>
        `${escapeHtml(m.month)} — ${m.count} review${m.count === 1 ? '' : 's'}, ${Number(m.average).toFixed(2)} ★`).join(' · ')}</p>` : ''}`;
  } catch (err) {
    host.innerHTML = `<p class="empty-state">${escapeHtml(catErr(err, 'Could not load rating analytics.'))}</p>`;
  }
}

/* ---------- list ---------- */

async function loadB2CReviews(page = rvwState.page) {
  rvwState.page = page;
  const tbody = document.querySelector('#rvwTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">${rowsSkeleton(5)}</td></tr>`;
  try {
    const data = await rvwApi('get', '', { params: {
      status: rvwState.status || undefined, product: rvwState.product || undefined,
      rating: rvwState.rating || undefined, search: rvwState.search || undefined, page, page_size: PAGE_SIZE,
    } });
    const counts = data.counts;
    const all = counts.pending + counts.approved + counts.rejected;
    const n = { '': all, ...counts };
    document.getElementById('rvwTabs').innerHTML = RVW_TABS.map(([v, l]) =>
      `<button type="button" role="tab" class="ops-tab${v === rvwState.status ? ' active' : ''}" data-rvw-tab="${v}">${escapeHtml(l)}
        <span class="ops-tab-count">${n[v]}</span></button>`).join('');
    tbody.innerHTML = data.items.length ? data.items.map(r => `
      <tr>
        <td>${escapeHtml(r.customer.name)}<div class="cell-sub">${escapeHtml(r.customer.email)}</div></td>
        <td>${escapeHtml(RVW_PRODUCT_LABEL[r.product] || r.product)}</td>
        <td>${escapeHtml(r.item_name)}</td>
        <td>${rvwStars(r.rating)}</td>
        <td class="jp-truncate" title="${catE(r.comment)}">${r.comment ? escapeHtml(r.comment) : '<span class="cell-sub">No comment</span>'}
          ${r.admin_reply ? '<div class="cell-sub">Replied</div>' : ''}</td>
        <td>${rvwPill(r.status)}</td>
        <td>${rvwDate(r.created_at)}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-rvw-open="${r.review_id}">Review</button></td>
      </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No reviews match this filter.</td></tr>`;
    renderPagination('rvwPagination', data.page, data.total_pages, data.total, loadB2CReviews);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${escapeHtml(catErr(err, 'Failed to load reviews.'))}</td></tr>`;
  }
}

/* ---------- moderation modal ---------- */

async function openReview(id) {
  catOpenModal(catModalShell('Review', rowsSkeleton(4)));
  try {
    rvwCurrent = await rvwApi('get', `/${encodeURIComponent(id)}`);
  } catch (err) {
    catOpenModal(catModalShell('Review', `<p class="msg error">${escapeHtml(catErr(err, 'Could not load this review.'))}</p>`));
    return;
  }
  renderReview();
}

function renderReview() {
  const r = rvwCurrent;
  const publicNote = r.status === 'approved'
    ? 'Visible to customers, together with your reply.'
    : r.status === 'rejected' ? 'Hidden from customers.' : 'Not yet visible to customers — approve it to publish.';
  const body = catOpenModal(`
    <div class="ops-modal-head"><h2>${rvwStars(r.rating)} ${rvwPill(r.status)}</h2>
      <button type="button" class="ops-modal-close" data-cat-close aria-label="Close">&times;</button></div>
    <div class="ops-modal-body">
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-label">Customer</span><span class="detail-value">${escapeHtml(r.customer.name)}</span>
          <span class="cell-sub">${escapeHtml(r.customer.email)}</span></div>
        <div class="detail-item"><span class="detail-label">${escapeHtml(RVW_PRODUCT_LABEL[r.product] || r.product)}</span>
          <span class="detail-value">${escapeHtml(r.item_name)}</span></div>
        <div class="detail-item"><span class="detail-label">Written</span><span class="detail-value">${rvwDate(r.created_at)}</span>
          ${r.updated_at !== r.created_at ? `<span class="cell-sub">Edited ${rvwDate(r.updated_at)}</span>` : ''}</div>
      </div>
      <div class="detail-item" style="margin-top:14px;"><span class="detail-label">Their review</span>
        <span class="detail-value" style="white-space:pre-wrap;">${r.comment ? escapeHtml(r.comment) : '—'}</span></div>
      <p class="cp-readonly-note">${escapeHtml(publicNote)} You can moderate and reply; the customer's rating and words are never editable.</p>
      <div class="msg" id="catMsg"></div>
      ${catField('Your public reply', catTextarea('rvwReply', r.admin_reply || '', 4),
        `Shown under the review while it is approved. Up to 1000 characters. Save it empty to remove.${r.replied_at ? ` Last replied ${rvwDate(r.replied_at)}.` : ''}`)}
      <div class="cat-actions">
        <button type="button" class="btn btn-ghost" id="rvwSaveReply">Save reply</button>
        ${r.status !== 'rejected' ? '<button type="button" class="btn btn-ghost" id="rvwReject">Reject</button>' : ''}
        ${r.status !== 'approved' ? '<button type="button" class="btn btn-navy" id="rvwApprove">Approve</button>' : ''}
      </div>
    </div>`);
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', () => fn(el)); };
  on('rvwSaveReply', btn => rvwPatch(btn, { admin_reply: catTrim('rvwReply') || null }, 'Reply saved.'));
  on('rvwApprove', btn => rvwPatch(btn, { status: 'approved', admin_reply: catTrim('rvwReply') || null }, 'Review approved.'));
  on('rvwReject', btn => {
    if (r.status === 'approved' && !confirm('Reject this review? It will be hidden from customers.')) return;
    rvwPatch(btn, { status: 'rejected' }, 'Review rejected.');
  });
  body.scrollTop = 0;
}

async function rvwPatch(btn, changes, done) {
  const updated = await catSave(btn, () => rvwApi('patch', `/${rvwCurrent.review_id}`, { data: changes }), done);
  if (updated) {
    rvwCurrent = updated;
    loadB2CReviews(rvwState.page);
    loadReviewAnalytics();
    renderReview();
  }
}
