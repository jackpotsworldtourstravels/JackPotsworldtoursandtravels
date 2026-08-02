/* Admin — Provider Management (0039)
   =========================================================================
   The external suppliers the operations desk buys tickets from, and the named
   people at those suppliers who actually book them.

   A PROVIDER IS NOT A USER, AND THIS SCREEN NEVER IMPLIES OTHERWISE.
   There is no password field, no "send an invite", no role picker and no
   status wording borrowed from the merchant screens ("Suspended", "Approved").
   A provider is Active or Inactive, which is a statement about whether we still
   buy from them — not about an account.

   NOTHING HERE COMPUTES A TOTAL.
   `total_tickets`, `total_amount` and `average_ticket_value` are derived
   server-side from the bookings that carry the provider's foreign key, and are
   rendered exactly as sent. The same rule the wallet screen keeps: a figure
   computed in two places is a figure that eventually disagrees with itself.
   Amounts arrive as decimal STRINGS and go through `moneyStr()`, never
   `money()` — see shared/formatters.js.

   TWO PANES, ONE SECTION.
   The list and the detail live in one `#section-providers` and swap. The detail
   is not a modal: four statistics, a users table and a bookings table is a
   page's worth of content, and a dialog that scrolls is a dialog nobody can
   read. Going back does not re-fetch the list — it is still rendered underneath.

   Loaded after admin.js and reuses its API_BASE, authHeaders, escapeHtml,
   fmtDate, fmtDateTime, rowsSkeleton, showToast, confirmDialog and
   navigateToSection. Nothing here restates them. */

const PROV_PAGE_SIZE = 25;

let provState = {
  page: 1,
  search: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  sort: 'provider_code',
  direction: 'asc',
};
let provSearchTimer = null;
/* The provider currently open on the detail pane, so Add User and the status
   toggle know what they are acting on without re-reading the DOM. */
let provOpenId = null;

/* ---------------------------------------------------------------- helpers */

function provErr(err, fallback) {
  return err?.response?.data?.detail || fallback;
}

/* The API's status vocabulary is two words and both are plain. Rendered as a
   badge carrying its own text — colour is never the only carrier. */
function provStatusBadge(status) {
  const cls = status === 'active' ? 'confirmed' : 'cancelled';
  const label = status === 'active' ? 'Active' : 'Inactive';
  return `<span class="badge ${cls}">${label}</span>`;
}

function provEmpty(colspan, message, hint) {
  return `<tr><td colspan="${colspan}" class="empty-state">
    ${escapeHtml(message)}${hint ? `<div class="cell-sub">${escapeHtml(hint)}</div>` : ''}
  </td></tr>`;
}

/* ------------------------------------------------------------- the list */

async function loadProviders() {
  /* Opening the section from the sidebar always lands on the list, even if a
     detail was left open from a previous visit. */
  provShowList();

  const body = document.querySelector('#provTable tbody');
  body.innerHTML = `<tr><td colspan="6">${rowsSkeleton(5)}</td></tr>`;

  const params = new URLSearchParams({
    page: String(provState.page),
    page_size: String(PROV_PAGE_SIZE),
    sort: provState.sort,
    direction: provState.direction,
  });
  if (provState.search) params.set('search', provState.search);
  if (provState.status) params.set('status', provState.status);
  if (provState.dateFrom) params.set('date_from', provState.dateFrom);
  if (provState.dateTo) params.set('date_to', provState.dateTo);

  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/providers?${params}`,
      { headers: authHeaders() });

    body.innerHTML = data.items.length
      ? data.items.map(p => `
        <tr>
          <td class="mono">${escapeHtml(p.provider_code)}</td>
          <td>
            ${escapeHtml(p.provider_name)}
            <div class="cell-sub">${p.user_count} ${p.user_count === 1 ? 'person' : 'people'}</div>
          </td>
          <td class="num">${p.total_tickets}</td>
          <td class="num">${escapeHtml(moneyStr(p.total_amount))}</td>
          <td>${provStatusBadge(p.status)}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-prov-view="${p.id}">View</button></td>
        </tr>`).join('')
      /* "no providers at all" and "none match your filters" are different
         answers, and the second one is wrong when nothing is filtered. */
      : provEmpty(6,
          provState.search || provState.status || provState.dateFrom || provState.dateTo
            ? 'No providers match these filters.'
            : 'No providers yet.',
          provState.search || provState.status || provState.dateFrom || provState.dateTo
            ? 'Clear the filters to see everything.'
            : 'Add the first supplier your team books through.');

    document.getElementById('provSummary').textContent = data.total
      ? `${data.total} provider${data.total === 1 ? '' : 's'}`
      : '';

    provRenderPagination(data);
    provMarkSort();

    body.querySelectorAll('[data-prov-view]').forEach(b =>
      b.addEventListener('click', () => openProvider(Number(b.dataset.provView))));
  } catch (err) {
    body.innerHTML = provEmpty(6, provErr(err, 'Could not load providers.'));
    document.getElementById('provSummary').textContent = '';
    document.getElementById('provPagination').innerHTML = '';
  }
}

function provRenderPagination({ total, page, page_size: size }) {
  const host = document.getElementById('provPagination');
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= size) { host.innerHTML = ''; return; }

  const first = (page - 1) * size + 1;
  const last = Math.min(total, page * size);
  host.innerHTML = `
    <span class="pagination-info">Showing ${first}–${last} of ${total}</span>
    <button type="button" class="btn btn-ghost btn-sm" id="provPrev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
    <button type="button" class="btn btn-ghost btn-sm" id="provNext" ${page >= pages ? 'disabled' : ''}>Next</button>`;

  document.getElementById('provPrev')?.addEventListener('click', () => {
    if (provState.page > 1) { provState.page -= 1; loadProviders(); }
  });
  document.getElementById('provNext')?.addEventListener('click', () => {
    if (provState.page < pages) { provState.page += 1; loadProviders(); }
  });
}

function provMarkSort() {
  document.querySelectorAll('[data-prov-sort]').forEach(th => {
    const on = th.dataset.provSort === provState.sort;
    th.setAttribute('aria-sort', on ? (provState.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    th.classList.toggle('sorted', on);
  });
}

/* ------------------------------------------------------------ the detail */

function provShowList() {
  document.getElementById('provListPane').style.display = '';
  document.getElementById('provDetailPane').style.display = 'none';
  provOpenId = null;
}

async function openProvider(id) {
  provOpenId = id;
  const list = document.getElementById('provListPane');
  const pane = document.getElementById('provDetailPane');
  list.style.display = 'none';
  pane.style.display = '';
  pane.innerHTML = `<div class="panel">${rowsSkeleton(6)}</div>`;
  window.scrollTo({ top: 0 });

  let data;
  try {
    data = (await axios.get(`${API_BASE}/api/admin/providers/${id}`,
      { headers: authHeaders() })).data;
  } catch (err) {
    pane.innerHTML = `<div class="panel">
      <div class="msg error">${escapeHtml(provErr(err, 'Could not load this provider.'))}</div>
      <button type="button" class="btn btn-ghost" data-prov-back>← Back to providers</button>
    </div>`;
    pane.querySelector('[data-prov-back]').addEventListener('click', provShowList);
    return;
  }

  const p = data.provider;
  const s = data.stats;
  const inactive = p.status !== 'active';

  pane.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>${escapeHtml(p.provider_name)} <span class="mono" style="font-weight:400;">${escapeHtml(p.provider_code)}</span></h2>
        <div style="display:flex; gap:8px; align-items:center;">
          <button type="button" class="btn btn-ghost btn-sm" data-prov-back>← Back</button>
          <button type="button" class="btn btn-ghost btn-sm" data-prov-edit>Edit</button>
          <button type="button" class="btn ${inactive ? 'btn-coral' : 'btn-ghost'} btn-sm" data-prov-toggle>
            ${inactive ? 'Reactivate' : 'Deactivate'}
          </button>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-item"><span class="detail-label">Provider Code</span>
          <span class="detail-value mono">${escapeHtml(p.provider_code)}</span></div>
        <div class="detail-item"><span class="detail-label">Provider Name</span>
          <span class="detail-value">${escapeHtml(p.provider_name)}</span></div>
        <div class="detail-item"><span class="detail-label">Created</span>
          <span class="detail-value">${escapeHtml(fmtDate(p.created_at))}</span></div>
        <div class="detail-item"><span class="detail-label">Status</span>
          <span class="detail-value">${provStatusBadge(p.status)}</span></div>
      </div>

      ${inactive ? `<div class="msg info" style="margin-top:14px;">
        This provider is inactive, so it cannot be chosen when a new ticket is issued.
        Everything already bought through it is still counted below.
      </div>` : ''}
    </div>

    <div class="stat-grid" style="margin-bottom:20px;">
      ${provStat('Total Tickets', String(s.total_tickets), 'bought through this provider')}
      ${provStat('Total Booking Amount', moneyStr(s.total_amount), 'across those tickets')}
      ${provStat('Average Ticket Value', moneyStr(s.average_ticket_value), 'per ticket')}
      ${provStat('Provider Users', String(s.provider_user_count), 'people listed here')}
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>Provider Users</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn-ghost btn-sm" data-prov-export-users>Export</button>
          <button type="button" class="btn btn-coral btn-sm" data-prov-add-user>+ Add User</button>
        </div>
      </div>
      <p class="ops-sub" style="margin:0 0 12px;">
        People at this supplier who book on our behalf. They have no login — these are contact
        records, and the totals are their own bookings.
      </p>
      <div class="table-wrap"><table><thead><tr>
        <th>Name</th><th>Email</th><th>Phone</th><th class="num">Tickets Booked</th>
        <th class="num">Total Amount</th><th>Status</th><th></th>
      </tr></thead><tbody>
        ${data.users.length ? data.users.map(u => `
          <tr>
            <td>${escapeHtml(u.user_name)}</td>
            <td>${escapeHtml(u.email)}</td>
            <td>${escapeHtml(u.phone_number || '—')}</td>
            <td class="num">${u.tickets_booked}</td>
            <td class="num">${escapeHtml(moneyStr(u.total_amount))}</td>
            <td>${provStatusBadge(u.status)}</td>
            <td><button type="button" class="btn btn-ghost btn-sm"
                  data-prov-edit-user="${u.id}">Edit</button></td>
          </tr>`).join('')
          : provEmpty(7, 'Nobody listed yet.',
              'Add the people at this supplier who book for us.')}
      </tbody></table></div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>Recent Bookings</h2>
        <button type="button" class="btn btn-ghost btn-sm" data-prov-export-bookings>Export</button>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>Booking Number</th><th>Passenger</th><th>Airline</th><th>Travel Date</th>
        <th class="num">Amount</th><th>Provider User</th><th>Ticket Issued</th>
      </tr></thead><tbody>
        ${data.recent_bookings.length ? data.recent_bookings.map(b => `
          <tr>
            <td class="mono">${escapeHtml(b.request_number)}</td>
            <td>${escapeHtml(b.passenger_name || '—')}</td>
            <td>${escapeHtml(b.airline || '—')}</td>
            <td>${escapeHtml(b.travel_date ? fmtDate(b.travel_date) : '—')}</td>
            <td class="num">${escapeHtml(moneyStr(b.amount))}</td>
            <td>${escapeHtml(b.provider_user_name || '—')}</td>
            <td>${escapeHtml(b.ticket_issued_at ? fmtDate(b.ticket_issued_at) : '—')}</td>
          </tr>`).join('')
          : provEmpty(7, 'Nothing has been bought through this provider yet.',
              'Bookings appear here once a ticket is issued against them.')}
      </tbody></table></div>
    </div>`;

  pane.querySelector('[data-prov-back]').addEventListener('click', provShowList);
  pane.querySelector('[data-prov-edit]').addEventListener('click', () => provOpenProviderForm(p));
  pane.querySelector('[data-prov-toggle]').addEventListener('click', () => provToggleStatus(p));
  pane.querySelector('[data-prov-add-user]').addEventListener('click', () => provOpenUserForm(id, null));
  pane.querySelector('[data-prov-export-users]').addEventListener('click',
    () => provExport('provider_users', 'csv', id));
  pane.querySelector('[data-prov-export-bookings]').addEventListener('click',
    () => provExport('booking_summary', 'csv', id));
  pane.querySelectorAll('[data-prov-edit-user]').forEach(b =>
    b.addEventListener('click', () => provOpenUserForm(
      id, data.users.find(u => String(u.id) === b.dataset.provEditUser))));
}

function provStat(label, value, sub) {
  return `<div class="stat-card">
    <div class="stat-body">
      <div class="stat-value">${escapeHtml(value)}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="cell-sub">${escapeHtml(sub)}</div>
    </div>
  </div>`;
}

/* --------------------------------------------------------------- modals */

function provCloseModal() {
  document.getElementById('provModalOverlay').classList.remove('open');
}

function provOpenModal(title, bodyHtml, footHtml) {
  const overlay = document.getElementById('provModalOverlay');
  document.getElementById('provModalBody').innerHTML = `
    <h2 id="provModalTitle">${escapeHtml(title)}</h2>
    ${bodyHtml}
    <div class="msg" id="provModalMsg" aria-live="polite"></div>
    <div class="modal-actions">${footHtml}</div>`;
  overlay.classList.add('open');
  document.getElementById('provModalBody')
    .querySelectorAll('[data-prov-cancel]')
    .forEach(b => b.addEventListener('click', provCloseModal));
}

function provModalMsg(text, kind) {
  const el = document.getElementById('provModalMsg');
  if (el) { el.textContent = text; el.className = `msg ${kind || ''}`; }
}

/* `provider` null = create. The code is never on this form: it is allocated by
   the server and is not editable by anybody, so showing it as a disabled input
   would only invite the question. */
function provOpenProviderForm(provider) {
  const editing = !!provider;
  provOpenModal(
    editing ? `Edit ${provider.provider_code}` : 'Add Provider',
    `<div class="form-field" style="max-width:none;">
       <label for="provNameInput">Provider Name</label>
       <input type="text" id="provNameInput" maxlength="200" autocomplete="off"
              value="${editing ? escapeHtml(provider.provider_name) : ''}"
              placeholder="e.g. Sky Travels">
       <span class="cell-sub">${editing
         ? 'The provider code never changes — it is what past bookings are recorded against.'
         : 'A provider code (PRD001, PRD002, …) is assigned automatically.'}</span>
     </div>`,
    `<button type="button" class="btn btn-ghost" data-prov-cancel>Cancel</button>
     <button type="button" class="btn btn-navy" id="provSaveBtn">${editing ? 'Save' : 'Add Provider'}</button>`);

  const input = document.getElementById('provNameInput');
  input.focus();
  document.getElementById('provSaveBtn').addEventListener('click', async () => {
    const name = input.value.trim();
    if (name.length < 2) {
      provModalMsg('Enter the provider name.', 'error');
      input.focus();
      return;
    }
    const btn = document.getElementById('provSaveBtn');
    btn.disabled = true;
    provModalMsg('Saving…');
    try {
      if (editing) {
        await axios.patch(`${API_BASE}/api/admin/providers/${provider.id}`,
          { provider_name: name }, { headers: authHeaders() });
        showToast('Provider updated.');
        provCloseModal();
        openProvider(provider.id);
      } else {
        const { data } = await axios.post(`${API_BASE}/api/admin/providers`,
          { provider_name: name }, { headers: authHeaders() });
        showToast(`${data.provider_code} added.`);
        provCloseModal();
        loadProviders();
      }
    } catch (err) {
      btn.disabled = false;
      provModalMsg(provErr(err, 'Could not save the provider.'), 'error');
    }
  });
}

/* `person` null = add. A person cannot be moved between providers, so the
   provider is fixed context rather than a field on this form. */
function provOpenUserForm(providerId, person) {
  const editing = !!person;
  provOpenModal(
    editing ? `Edit ${person.user_name}` : 'Add Provider User',
    `<p class="ops-sub" style="margin:0 0 14px;">
       This is a contact record, not a login — no password is set and this person cannot sign in.
     </p>
     <div class="form-field" style="max-width:none;">
       <label for="provUserName">Name</label>
       <input type="text" id="provUserName" maxlength="150" autocomplete="off"
              value="${editing ? escapeHtml(person.user_name) : ''}" placeholder="e.g. John">
     </div>
     <div class="form-field" style="max-width:none;">
       <label for="provUserEmail">Email</label>
       <input type="email" id="provUserEmail" maxlength="255" autocomplete="off"
              value="${editing ? escapeHtml(person.email) : ''}" placeholder="john@skytravels.com">
     </div>
     <div class="form-field" style="max-width:none;">
       <label for="provUserPhone">Phone Number <span class="cell-sub">(optional)</span></label>
       <input type="text" id="provUserPhone" maxlength="30" autocomplete="off"
              value="${editing ? escapeHtml(person.phone_number || '') : ''}">
     </div>
     ${editing ? `<div class="form-field" style="max-width:none;">
       <label for="provUserStatus">Status</label>
       <select id="provUserStatus">
         <option value="active"${person.status === 'active' ? ' selected' : ''}>Active</option>
         <option value="inactive"${person.status === 'inactive' ? ' selected' : ''}>Inactive</option>
       </select>
       <span class="cell-sub">An inactive person is not offered when a ticket is issued.
         Their past bookings still count.</span>
     </div>` : ''}`,
    `<button type="button" class="btn btn-ghost" data-prov-cancel>Cancel</button>
     <button type="button" class="btn btn-navy" id="provUserSaveBtn">${editing ? 'Save' : 'Add User'}</button>`);

  document.getElementById('provUserName').focus();
  document.getElementById('provUserSaveBtn').addEventListener('click', async () => {
    const name = document.getElementById('provUserName').value.trim();
    const email = document.getElementById('provUserEmail').value.trim();
    const phone = document.getElementById('provUserPhone').value.trim();
    if (name.length < 2) return provModalMsg('Enter the person’s name.', 'error');
    if (!email) return provModalMsg('Enter an email address.', 'error');

    const btn = document.getElementById('provUserSaveBtn');
    btn.disabled = true;
    provModalMsg('Saving…');
    try {
      if (editing) {
        await axios.patch(`${API_BASE}/api/admin/provider-users/${person.id}`, {
          user_name: name, email, phone_number: phone,
          status: document.getElementById('provUserStatus').value,
        }, { headers: authHeaders() });
        showToast('Provider user updated.');
      } else {
        await axios.post(`${API_BASE}/api/admin/providers/${providerId}/users`, {
          user_name: name, email, phone_number: phone || null,
        }, { headers: authHeaders() });
        showToast(`${name} added.`);
      }
      provCloseModal();
      openProvider(providerId);
    } catch (err) {
      btn.disabled = false;
      provModalMsg(provErr(err, 'Could not save this person.'), 'error');
    }
  });
}

/* Deactivate rather than delete, and the confirmation says why in as many
   words — an operator looking for a Delete button should learn where it went
   rather than conclude the screen is unfinished. */
async function provToggleStatus(provider) {
  const goingInactive = provider.status === 'active';
  const ok = await confirmDialog({
    title: goingInactive ? `Deactivate ${provider.provider_code}?` : `Reactivate ${provider.provider_code}?`,
    message: goingInactive
      ? `${provider.provider_name} will no longer be selectable when a ticket is issued. `
        + 'Everything already bought through it stays recorded and still counts towards its '
        + 'totals — this is how a provider is retired, because a purchase record is never deleted.'
      : `${provider.provider_name} will be selectable again when issuing tickets.`,
    confirmText: goingInactive ? 'Deactivate' : 'Reactivate',
    danger: goingInactive,
  });
  if (!ok) return;

  try {
    await axios.patch(`${API_BASE}/api/admin/providers/${provider.id}`,
      { status: goingInactive ? 'inactive' : 'active' }, { headers: authHeaders() });
    showToast(goingInactive ? 'Provider deactivated.' : 'Provider reactivated.');
    openProvider(provider.id);
  } catch (err) {
    showToast(provErr(err, 'Could not change the status.'), true);
  }
}

/* --------------------------------------------------------------- exports */

/* Authenticated, so a plain href cannot fetch it — pulled as a blob with the
   bearer token, saved, and the object URL revoked. Same shape as the merchant
   portal's proof download. */
async function provExport(kind, format, providerId) {
  const params = new URLSearchParams({ kind, format });
  if (providerId) params.set('provider_id', String(providerId));
  let url = null;
  try {
    const res = await axios.get(`${API_BASE}/api/admin/providers/export?${params}`,
      { headers: authHeaders(), responseType: 'blob' });
    url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kind}-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Export downloaded.');
  } catch (err) {
    showToast(provErr(err, 'Could not build that export.'), true);
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function provOpenExportMenu() {
  provOpenModal('Export',
    `<div class="form-field" style="max-width:none;">
       <label for="provExportKind">What to export</label>
       <select id="provExportKind">
         <option value="providers">Provider list</option>
         <option value="provider_users">Provider users</option>
         <option value="booking_summary">Booking summary</option>
       </select>
     </div>
     <div class="form-field" style="max-width:none;">
       <label for="provExportFormat">Format</label>
       <select id="provExportFormat">
         <option value="csv">CSV</option>
         <option value="xlsx">Excel</option>
       </select>
     </div>`,
    `<button type="button" class="btn btn-ghost" data-prov-cancel>Cancel</button>
     <button type="button" class="btn btn-navy" id="provExportGo">Download</button>`);

  document.getElementById('provExportGo').addEventListener('click', () => {
    const kind = document.getElementById('provExportKind').value;
    const format = document.getElementById('provExportFormat').value;
    provCloseModal();
    provExport(kind, format, null);
  });
}

/* ---------------------------------------------------------------- wiring */

/* Bound once at load, not per render: these controls live in the static markup
   in index.html, so rebinding on every load would stack duplicate handlers and
   fire one request per past visit. */
document.getElementById('provAddBtn')?.addEventListener('click', () => provOpenProviderForm(null));
document.getElementById('provExportBtn')?.addEventListener('click', provOpenExportMenu);
document.getElementById('provRefreshBtn')?.addEventListener('click', () => loadProviders());

document.getElementById('provSearch')?.addEventListener('input', e => {
  clearTimeout(provSearchTimer);
  provSearchTimer = setTimeout(() => {
    provState.search = e.target.value.trim();
    provState.page = 1;          /* a new search starts at page 1, not page 4 */
    loadProviders();
  }, 300);
});

['provStatusFilter', 'provDateFrom', 'provDateTo'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', () => {
    provState.status = document.getElementById('provStatusFilter').value;
    provState.dateFrom = document.getElementById('provDateFrom').value;
    provState.dateTo = document.getElementById('provDateTo').value;
    provState.page = 1;
    loadProviders();
  });
});

document.querySelectorAll('[data-prov-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const column = th.dataset.provSort;
    if (provState.sort === column) {
      provState.direction = provState.direction === 'asc' ? 'desc' : 'asc';
    } else {
      provState.sort = column;
      provState.direction = 'asc';
    }
    provState.page = 1;
    loadProviders();
  });
});

document.getElementById('provModalOverlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('provModalOverlay')) provCloseModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape'
      && document.getElementById('provModalOverlay')?.classList.contains('open')) {
    provCloseModal();
  }
});
