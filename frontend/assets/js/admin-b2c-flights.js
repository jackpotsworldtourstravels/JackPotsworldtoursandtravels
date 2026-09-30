/* Admin — B2C Catalogue: Flights (Phase 5 of the B2C Admin Portal build-out)
   ==================================================================
   THIS SCREEN HAS NO FORMS ON PURPOSE. Flights are supplier-driven: every
   search is answered live by whichever supplier is in force and nothing about
   a flight is stored, so there is no inventory to create, edit or price here
   — a table of flights would be a table of invented ones. What an admin can
   usefully see is the wiring: which supplier is answering, whether it is
   configured, and which suppliers exist at all.

   ENDPOINT:
     GET /api/admin/catalogue/flights/supplier     (reads config; never calls a supplier)

   Uses admin-b2c-catalogue-common.js (catApi/catErr) and admin.js's helpers. */

async function initB2CFlights() {
  const host = document.getElementById('catFlightsBody');
  host.innerHTML = rowsSkeleton(5);
  let s;
  try {
    s = await catApi('get', '/flights/supplier');
  } catch (err) {
    host.innerHTML = `<p class="empty-state">${escapeHtml(catErr(err, 'Could not load the flight supplier status.'))}</p>`;
    return;
  }

  const mode = s.live
    ? `<span class="badge confirmed">Live supplier</span>`
    : `<span class="badge pending">Demo data</span>`;

  host.innerHTML = `
    <div class="detail-grid">
      <div class="detail-item"><span class="detail-label">Answering flight searches</span>
        <span class="detail-value">${escapeHtml(s.active_provider)} ${mode}</span></div>
      <div class="detail-item"><span class="detail-label">Flight inventory stored</span>
        <span class="detail-value">${s.inventory_stored ? 'Yes' : 'None — by design'}</span></div>
    </div>
    <p class="cp-readonly-note" style="margin-top:14px;">${escapeHtml(s.summary)}</p>

    <h3 style="margin:22px 0 8px; font-size:14px;">${s.live
      ? 'How a flight reaches a customer'
      : 'How flights will reach customers once a live supplier is connected'}</h3>
    <ol style="margin:0 0 6px 18px; padding:0; font-size:13.5px; line-height:1.7;">
      ${s.flow.map(step => `<li>${escapeHtml(step)}</li>`).join('')}
    </ol>

    <h3 style="margin:22px 0 8px; font-size:14px;">Suppliers</h3>
    <div class="table-wrap"><table><thead><tr>
      <th>Supplier</th><th>Adapter built</th><th>Configured</th><th>Status</th><th>Notes</th>
    </tr></thead><tbody>
      ${s.suppliers.map(x => `<tr>
        <td><strong>${escapeHtml(x.label)}</strong><div class="cell-sub">${escapeHtml(x.code)}</div></td>
        <td>${x.integrated ? 'Yes' : '<span class="cell-sub">Not yet</span>'}</td>
        <td>${x.configured ? 'Yes' : '<span class="cell-sub">No</span>'}</td>
        <td>${x.active ? '<span class="badge confirmed">In force</span>' : '<span class="cell-sub">Not in use</span>'}</td>
        <td>${escapeHtml(x.note)}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
}
