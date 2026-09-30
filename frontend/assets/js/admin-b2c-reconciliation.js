/* Admin — B2C Payment Reconciliation (Phase 4 of the B2C Admin Portal
   build-out)
   ==================================================================
   Verifies that the money a gateway says moved is the money we recorded —
   the last link in Customer -> Booking -> Payment -> Cancellation -> Refund.

   DOES NOT TOUCH CUSTOMER PAYMENTS. Reads the same three payment tables that
   screen reads, through the same admin-side query; nothing here writes to a
   payment row, creates a refund, or moves money. The one action (Verify)
   calls the payment's own gateway adapter live — Razorpay, HDFC or whichever
   collected it — and reports what it says, matched or not.

   EVERY ROW STARTS "Not Checked". Reconciliation status is never guessed
   from our own stored status; it is only ever the answer to a live call this
   screen made, which is why it resets on every page load rather than being
   remembered — see the service module's docstring for why that's correct,
   not a missing feature.

   ENDPOINTS:
     GET  /api/admin/payment-reconciliation                    paged list
     POST /api/admin/payment-reconciliation/{product}/{id}/verify

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDateTime, rowsSkeleton, renderPagination, PAGE_SIZE) and
   moneyStr from shared/formatters.js. Nothing here restates them. */

const RCN_RECON_LABEL = {
  not_checked: 'Not Checked', matched: 'Matched', mismatch: 'Review Required',
  no_reference: 'No Gateway Reference', not_configured: 'Gateway Not Configured',
  gateway_unavailable: 'Gateway Unavailable',
};
const RCN_RECON_TONE = {
  not_checked: 'pending', matched: 'confirmed', mismatch: 'cancelled',
  no_reference: 'pending', not_configured: 'pending', gateway_unavailable: 'cancelled',
};
/* Reuses Customer Payments' own vocabulary for the Payment Status column —
   see CP_STATUS_LABEL/CP_STATUS_TONE in admin-customer-payments.js, which
   this file does not restate but does mirror, so the same word means the
   same thing on both screens. */
const RCN_STATUS_LABEL = {
  pending: 'Pending', processing: 'Processing', authorized: 'Authorized',
  captured: 'Paid', failed: 'Failed', cancelled: 'Cancelled',
  expired: 'Expired', refunded: 'Refunded',
};

const rcnState = { product: '', search: '', page: 1 };
let rcnWired = false;

function rcnEsc(s) { return escapeHtml(s); }
function rcnOr(v) { return (v === null || v === undefined || v === '') ? '—' : escapeHtml(v); }

function rcnPill(label, tone) {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

async function initB2CReconciliation() {
  if (!rcnWired) {
    rcnWired = true;
    const search = document.getElementById('rcnSearch');
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        rcnState.search = search.value.trim();
        rcnState.page = 1;
        loadB2CReconciliation();
      }, 300);
    });
    document.getElementById('rcnProductFilter').addEventListener('change', e => {
      rcnState.product = e.target.value;
      rcnState.page = 1;
      loadB2CReconciliation();
    });
    document.getElementById('rcnTable').addEventListener('click', e => {
      const btn = e.target.closest('[data-rcn-verify]');
      if (btn) verifyReconciliationRow(btn);
    });
  }
  await loadB2CReconciliation();
}

function rcnRowHtml(r) {
  const txnId = r.provider_payment_id || r.provider_order_id;
  return `
    <tr data-rcn-row="${escapeHtml(r.product)}:${r.payment_id}">
      <td class="mono">${rcnOr(txnId)}</td>
      <td>${escapeHtml(r.booking_ref)}</td>
      <td>${escapeHtml(r.customer_name)}<div class="cell-sub">${escapeHtml(r.customer_email)}</div></td>
      <td>${escapeHtml(r.product)}</td>
      <td class="num" data-rcn-expected>${moneyStr(r.amount)}</td>
      <td class="num" data-rcn-gateway>—</td>
      <td>${rcnPill(RCN_STATUS_LABEL[r.status] || r.status, r.status === 'captured' ? 'confirmed' : 'pending')}</td>
      <td data-rcn-status>${rcnPill(RCN_RECON_LABEL[r.reconciliation_status] || r.reconciliation_status, RCN_RECON_TONE[r.reconciliation_status] || 'pending')}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-rcn-verify
            data-rcn-product="${escapeHtml(r.product)}" data-rcn-id="${r.payment_id}">Verify</button></td>
    </tr>`;
}

async function loadB2CReconciliation(page = rcnState.page) {
  rcnState.page = page;
  const tbody = document.querySelector('#rcnTable tbody');
  tbody.innerHTML = `<tr><td colspan="9">${rowsSkeleton(6)}</td></tr>`;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/payment-reconciliation`, {
      headers: authHeaders(),
      params: {
        search: rcnState.search || undefined, product: rcnState.product || undefined,
        page, page_size: PAGE_SIZE,
      },
    });
    if (!data.items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No payments match this filter.</td></tr>`;
    } else {
      tbody.innerHTML = data.items.map(rcnRowHtml).join('');
    }
    renderPagination('rcnPagination', data.page, data.total_pages, data.total, loadB2CReconciliation);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Failed to load payments.</td></tr>`;
  }
}

async function verifyReconciliationRow(btn) {
  const row = btn.closest('tr');
  const product = btn.dataset.rcnProduct;
  const paymentId = btn.dataset.rcnId;
  const gatewayCell = row.querySelector('[data-rcn-gateway]');
  const statusCell = row.querySelector('[data-rcn-status]');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const { data } = await axios.post(
      `${API_BASE}/api/admin/payment-reconciliation/${encodeURIComponent(product)}/${encodeURIComponent(paymentId)}/verify`,
      {}, { headers: authHeaders() },
    );
    gatewayCell.textContent = data.gateway_amount != null ? moneyStr(data.gateway_amount) : '—';
    statusCell.innerHTML = rcnPill(
      RCN_RECON_LABEL[data.reconciliation_status] || data.reconciliation_status,
      RCN_RECON_TONE[data.reconciliation_status] || 'pending',
    );
    if (data.detail) {
      statusCell.innerHTML += `<div class="cell-sub" title="${escapeHtml(data.detail)}">${escapeHtml(data.detail)}</div>`;
    }
  } catch (err) {
    statusCell.innerHTML = rcnPill('Check Failed', 'cancelled');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
}
