'use strict';
/* Operations Portal — Customers, Merchants, Users.
   ===========================================================================
   CUSTOMERS IS DERIVED, AND SAYS SO
   There is no customer or passenger endpoint in this API. Travellers exist only
   as passenger_data rows hanging off a request, and they are returned inside
   RequestResponse.passengers. So this screen aggregates travellers out of the
   request register: one row per distinct person, with their bookings counted.

   That has an honest boundary and the screen states it: the aggregate covers
   the requests actually fetched (one page, the API's 100-row ceiling), not the
   whole history. What is NOT approximate is the search — list_requests runs a
   subquery over passenger first name, last name and passport number, so typing
   a traveller's name reaches every request in the database, and the rows shown
   are the true matches. Search first, then read the aggregate.
   =========================================================================== */

/* ===========================================================================
   CUSTOMERS
   =========================================================================== */

function opsInitCustomers() {
  const host = $('ops-customers');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Customers</h1>
        <p>Travellers on file, assembled from booking records. Search reaches every request
           in the database by name or passport number.</p>
      </div>
    </div>
    <div id="opsCustomersGrid"></div>`;

  return OpsGrid({
    id: 'customers',
    mount: $('opsCustomersGrid'),
    title: 'Traveller directory',
    exportName: 'travellers',
    mode: 'client',
    searchable: true,
    searchPlaceholder: 'Passenger name or passport number…',
    filters: [
      { key: 'passenger_type', label: 'Type', type: 'select', anyLabel: 'Any',
        options: ['adult', 'child', 'infant'].map(t => ({ value: t, label: opsLabel(t) })),
        match: (r, v) => r.passenger_type === v },
      { key: 'travel_type', label: 'Travel', type: 'select', anyLabel: 'Any',
        options: OPS_TRAVEL_TYPES.map(t => ({ value: t, label: opsLabel(t) })) },
      { key: 'doc', label: 'Passport', type: 'select', anyLabel: 'Any',
        options: [{ value: 'yes', label: 'On file' }, { value: 'no', label: 'Missing' }],
        match: (r, v) => (v === 'yes' ? !!r.passport_number : !r.passport_number) },
    ],
    columns: [
      { key: 'name', label: 'Traveller' },
      { key: 'passenger_type', label: 'Type', value: r => opsLabel(r.passenger_type) },
      { key: 'gender', label: 'Gender', value: r => opsLabel(r.gender) },
      OpsCol.date('dob', 'Date of birth'),
      { key: 'nationality', label: 'Nationality' },
      { key: 'passport_number', label: 'Passport', nowrap: true,
        render: r => (r.passport_number
          ? `<span class="ops-mono">${escapeHtml(r.passport_number)}</span>`
          : '<span class="ops-tag ops-tag-warn">Missing</span>'),
        text: r => r.passport_number || '' },
      OpsCol.date('passport_expiry', 'Passport expiry'),
      ...(opsIsStaff() ? [{ key: 'merchants', label: 'Booked by' }] : []),
      { key: 'bookings', label: 'Bookings', align: 'right' },
      OpsCol.date('last_travel', 'Latest travel'),
      { key: 'statuses', label: 'Latest status', render: r => opsTag(r.last_status), text: r => opsStatusLabel(r.last_status) },
      OpsCol.actions([{ act: 'open', label: 'Latest booking', primary: true }]),
    ],
    note: `<b>One row per traveller, counted across the requests loaded here</b> — there is no
      customer master table in this schema, so this is derived from
      <code>passenger_data</code> on each request. The <b>search box hits the server</b>
      (<code>/api/requests?search=</code> runs a subquery over passenger name and passport), so a
      name you type is matched against every request; the booking counts, however, only reflect
      the ${OPS_PAGE_MAX} requests in hand. A passport marked <b>Missing</b> will delay ticketing
      on an international sector.`,
    emptyText: 'No travellers found. Try a name, or clear the search to list recent travellers.',
    fetch: async ({ search, filters: f }) => {
      const params = { page_size: OPS_PAGE_MAX };
      if (search) params.search = search;
      if (f.travel_type) params.travel_type = f.travel_type;
      const d = await OpsApi.listRequests(params);
      const rows = opsAggregateTravellers(d.items || []);
      return { rows, total: rows.length };
    },
    actions: {
      open: row => opsOpenRequest(row.last_request_id),
    },
    onRow: row => opsOpenRequest(row.last_request_id),
  });
}

/* Key a traveller by passport when there is one, otherwise by name + date of
   birth. Two people can share a name; a passport number is the only identifier
   this data actually has, and merging on name alone would silently combine
   different travellers' booking histories. */
function opsAggregateTravellers(requests) {
  const map = new Map();
  requests.forEach(r => {
    (r.passengers || []).forEach(p => {
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
      if (!name) return;
      const key = p.passport_number
        ? `P:${p.passport_number.toUpperCase()}`
        : `N:${name.toLowerCase()}|${p.dob || ''}`;
      const at = r.travel_date || r.created_at;
      let row = map.get(key);
      if (!row) {
        row = {
          id: key, name,
          passenger_type: p.passenger_type, gender: p.gender, dob: p.dob,
          nationality: p.nationality, passport_number: p.passport_number,
          passport_expiry: p.passport_expiry,
          bookings: 0, merchantSet: new Set(),
          last_travel: null, last_status: r.status, last_request_id: r.id,
        };
        map.set(key, row);
      }
      row.bookings++;
      if (r.merchant_name) row.merchantSet.add(r.merchant_name);
      /* Keep the most recent booking as the representative one. */
      if (!row.last_travel || (at && new Date(at) > new Date(row.last_travel))) {
        row.last_travel = at;
        row.last_status = r.status;
        row.last_request_id = r.id;
      }
      /* Fill gaps from whichever record has the detail. */
      ['gender', 'dob', 'nationality', 'passport_number', 'passport_expiry'].forEach(k => {
        if (!row[k] && p[k]) row[k] = p[k];
      });
    });
  });
  return [...map.values()]
    .map(r => ({ ...r, merchants: [...r.merchantSet].join(', ') }))
    .sort((a, b) => new Date(b.last_travel || 0) - new Date(a.last_travel || 0));
}

/* ===========================================================================
   MERCHANTS
   =========================================================================== */

function opsInitMerchants() {
  const host = $('ops-merchants');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Merchants</h1>
        <p>Company records, wallets, staff and approval state.</p>
      </div>
      <div class="ops-page-actions">
        ${opsCan('merchant.create') ? '<button type="button" class="ops-btn ops-btn-primary" id="opsMcNew">+ New merchant</button>' : ''}
      </div>
    </div>
    <div id="opsMerchantsGrid"></div>`;

  let grid = null;
  $('opsMcNew')?.addEventListener('click', () => opsCreateMerchantDialog(() => grid.reload()));

  grid = OpsGrid({
    id: 'merchants',
    mount: $('opsMerchantsGrid'),
    title: 'Merchant register',
    exportName: 'merchants',
    mode: 'server',
    searchable: true,
    searchPlaceholder: 'Company name, code or email…',
    filters: [
      { key: 'status', label: 'Status', type: 'select', anyLabel: 'Any status',
        options: OPS_MERCHANT_STATUSES.map(s => ({ value: s, label: opsLabel(s) })) },
      { key: 'company_type', label: 'Type', type: 'select', anyLabel: 'Any type',
        options: OPS_COMPANY_TYPES.map(t => ({ value: t, label: opsLabel(t) })) },
    ],
    columns: [
      OpsCol.ref('merchant_code', 'Code'),
      { key: 'company_name', label: 'Company' },
      { key: 'merchant_name', label: 'Trading name', hidden: true },
      OpsCol.enumLabel('company_type', 'Type'),
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone', nowrap: true, hidden: true },
      { key: 'city', label: 'City' },
      { key: 'country', label: 'Country', hidden: true },
      OpsCol.money('wallet_balance', 'Wallet'),
      OpsCol.money('credit_limit', 'Credit limit'),
      { key: 'user_count', label: 'Users', align: 'right' },
      { key: 'reference_prefix', label: 'Ref. prefix', hidden: true },
      OpsCol.status(),
      OpsCol.dateTime('created_at', 'Registered'),
      OpsCol.actions([
        { act: 'open', label: 'Open', primary: true },
        { act: 'approve', label: 'Approve', when: r => r.status === 'pending_approval' && opsCan('merchant.approve') },
        { act: 'suspend', label: 'Suspend', danger: true, when: r => r.status === 'active' && opsCan('merchant.suspend') },
        { act: 'activate', label: 'Reactivate', when: r => ['suspended', 'inactive'].includes(r.status) && opsCan('merchant.suspend') },
      ]),
    ],
    note: `A merchant's staff cannot sign in until the company is <b>approved</b> and
      <b>active</b> — <code>auth._assert_merchant_tradeable</code> blocks the login with an
      explanatory 403, so suspending a company is an immediate access change, not just a label.`,
    emptyText: 'No merchants match these criteria.',
    fetch: async ({ page, pageSize, search, filters: f }) => {
      const params = { page, page_size: pageSize };
      if (search) params.search = search;
      if (f.status) params.status = f.status;
      if (f.company_type) params.company_type = f.company_type;
      const d = await OpsApi.listMerchants(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    onRow: r => opsOpenMerchant(r.id),
    actions: {
      open: row => opsOpenMerchant(row.id),
      approve: async row => {
        if (!await opsConfirm(`Approve ${row.company_name}? Its staff will be able to sign in immediately.`, 'Approve')) return;
        try {
          await OpsApi.approveMerchant(row.id);
          opsToast(`${row.company_name} approved.`, 'ok');
          opsInvalidate('dashboard', 'approvals');
          grid.reload();
          opsLoadBadges();
        } catch (err) { opsToast(opsError(err, 'Approval failed.'), 'err'); }
      },
      suspend: async row => {
        if (!await opsConfirm(
          `Suspend ${row.company_name}? Every one of its ${row.user_count} user(s) will be refused at sign-in.`,
          'Suspend', { danger: true })) return;
        try {
          await OpsApi.setMerchantStatus(row.id, 'suspended');
          opsToast(`${row.company_name} suspended.`, 'ok');
          opsInvalidate('dashboard');
          grid.reload();
        } catch (err) { opsToast(opsError(err, 'The change failed.'), 'err'); }
      },
      activate: async row => {
        try {
          await OpsApi.setMerchantStatus(row.id, 'active');
          opsToast(`${row.company_name} reactivated.`, 'ok');
          opsInvalidate('dashboard');
          grid.reload();
        } catch (err) { opsToast(opsError(err, 'The change failed.'), 'err'); }
      },
    },
  });

  const pending = opsTakePendingFilter('merchants');
  if (pending) {
    Object.entries(pending).forEach(([k, v]) => grid.setFilter(k, v, false));
    grid.reload();
  }
  return grid;
}

async function opsOpenMerchant(id) {
  const body = opsOpenModal('Merchant', opsSpinner('Loading merchant…'), '', { wide: true });
  try {
    const m = await OpsApi.getMerchant(id);
    $('opsModalTitle').textContent = `${m.merchant_code} — ${m.company_name}`;
    body.innerHTML = `
      <div class="ops-cols-2">
        <fieldset class="ops-fieldset"><legend>Company</legend><div class="ops-fieldset-body">
          <dl class="ops-dl ops-dl-rows">
            <div><dt>Code</dt><dd class="ops-ref">${escapeHtml(m.merchant_code)}</dd></div>
            <div><dt>Company name</dt><dd>${escapeHtml(m.company_name)}</dd></div>
            <div><dt>Trading name</dt><dd>${escapeHtml(m.merchant_name || '—')}</dd></div>
            <div><dt>Type</dt><dd>${escapeHtml(opsLabel(m.company_type))}</dd></div>
            <div><dt>Status</dt><dd>${opsTag(m.status)}</dd></div>
            <div><dt>Email</dt><dd>${escapeHtml(m.email || '—')}</dd></div>
            <div><dt>Phone</dt><dd>${escapeHtml(m.phone || '—')}</dd></div>
            <div><dt>City</dt><dd>${escapeHtml(m.city || '—')}</dd></div>
            <div><dt>Country</dt><dd>${escapeHtml([m.country, m.country_code].filter(Boolean).join(' / ') || '—')}</dd></div>
            <div><dt>Address</dt><dd>${escapeHtml(m.address || '—')}</dd></div>
            <div><dt>Registered</dt><dd>${escapeHtml(fmtDateTime(m.created_at))}</dd></div>
          </dl>
        </div></fieldset>
        <fieldset class="ops-fieldset"><legend>Account</legend><div class="ops-fieldset-body">
          <dl class="ops-dl ops-dl-rows">
            <div><dt>Wallet balance</dt><dd><b>${money(Number(m.wallet_balance))}</b></dd></div>
            <div><dt>Credit limit</dt><dd><b>${money(Number(m.credit_limit))}</b></dd></div>
            <div><dt>Users</dt><dd>${escapeHtml(String(m.user_count))}</dd></div>
            <div><dt>Reference prefix</dt><dd class="ops-ref">${escapeHtml(m.reference_prefix || '—')}</dd></div>
            <div><dt>Booking sequence</dt><dd>${escapeHtml(String(m.booking_sequence ?? '—'))}</dd></div>
          </dl>
          <div class="ops-form-actions">
            ${opsCan('ticket.view') ? `<button type="button" class="ops-btn ops-btn-sm" id="opsMdRequests">Requests</button>` : ''}
            ${opsCan('payment.view') && opsIsStaff() ? `<button type="button" class="ops-btn ops-btn-sm" id="opsMdPayments">Payments</button>` : ''}
            ${opsCan('notification.send') ? `<button type="button" class="ops-btn ops-btn-sm" id="opsMdComms">Communication</button>` : ''}
          </div>
        </div></fieldset>
      </div>
      ${opsCan('merchant_user.manage') ? `
        <fieldset class="ops-fieldset"><legend>Users</legend>
          <div class="ops-fieldset-body" style="padding:0" id="opsMdUsers">${opsSpinner()}</div>
        </fieldset>` : ''}
      <div class="ops-msg" id="opsMdMsg"></div>`;

    $('opsModalFoot').innerHTML = `
      ${opsCan('merchant.edit') ? '<button type="button" class="ops-btn" id="opsMdEdit">Edit</button>' : ''}
      ${m.status === 'pending_approval' && opsCan('merchant.approve') ? '<button type="button" class="ops-btn ops-btn-primary" id="opsMdApprove">Approve</button>' : ''}
      <span class="ops-spacer"></span>
      <button type="button" class="ops-btn" id="opsMdClose">Close</button>`;

    $('opsMdClose').addEventListener('click', opsCloseModal);
    $('opsMdEdit')?.addEventListener('click', () => opsEditMerchantDialog(m));
    $('opsMdApprove')?.addEventListener('click', async () => {
      try {
        await OpsApi.approveMerchant(m.id);
        opsToast(`${m.company_name} approved.`, 'ok');
        opsInvalidate('merchants', 'dashboard', 'approvals');
        opsOpenMerchant(m.id);
      } catch (err) { opsMsg($('opsMdMsg'), opsError(err, 'Approval failed.'), 'err'); }
    });
    $('opsMdRequests')?.addEventListener('click', () => {
      opsCloseModal();
      opsPendingFilter.bookings = { merchant_id: String(m.id) };
      opsInvalidate('bookings');
      opsGo('bookings');
    });
    $('opsMdPayments')?.addEventListener('click', () => {
      opsCloseModal();
      opsGo('payments');
      opsToast(`Filter the payment ledger by merchant ID ${m.id}.`);
    });
    $('opsMdComms')?.addEventListener('click', () => opsCommsDialog(m));

    if (opsCan('merchant_user.manage')) opsLoadMerchantUsers(m);
  } catch (err) {
    body.innerHTML = `<div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Could not load this merchant.'))}</div>`;
  }
}

async function opsLoadMerchantUsers(m) {
  const host = $('opsMdUsers');
  try {
    const d = await OpsApi.merchantUsers(m.id, { page_size: 50 });
    const rows = d.items || [];
    host.innerHTML = rows.length ? `
      <div class="ops-table-wrap"><table class="ops-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Merchant role</th>
          <th>Status</th><th>Online</th><th>Last login</th><th class="ops-actions"></th></tr></thead>
        <tbody>${rows.map(u => `<tr>
          <td>${escapeHtml(u.full_name)}</td>
          <td>${escapeHtml(u.email)}</td>
          <td>${escapeHtml(opsLabel(u.role))}</td>
          <td>${escapeHtml(opsLabel(u.merchant_role) || '—')}</td>
          <td>${opsTag(u.status)}</td>
          <td>${u.is_online ? '<span class="ops-tag ops-tag-ok">Online</span>' : '<span class="ops-muted">—</span>'}</td>
          <td class="ops-nowrap">${escapeHtml(u.last_login ? fmtDateTime(u.last_login) : 'never')}</td>
          <td class="ops-actions">
            <button type="button" class="ops-btn ops-btn-sm" data-ops-mu-reset="${u.id}"
              data-ops-mu-name="${escapeHtml(u.full_name)}">Reset password</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<div class="ops-empty">This merchant has no users.</div>';

    opsAll('[data-ops-mu-reset]', host).forEach(b =>
      b.addEventListener('click', async () => {
        if (!await opsConfirm(
          `Reset the password for ${b.dataset.opsMuName}? A temporary password is generated and `
          + `shown once — it cannot be retrieved afterwards.`, 'Reset password', { danger: true })) return;
        try {
          const res = await OpsApi.resetMerchantUserPassword(m.id, b.dataset.opsMuReset);
          opsShowTempPassword(res, b.dataset.opsMuName);
        } catch (err) { opsToast(opsError(err, 'The reset failed.'), 'err'); }
      }));
  } catch (err) {
    host.innerHTML = `<div class="ops-empty">${escapeHtml(opsError(err, 'Could not load users.'))}</div>`;
  }
}

/* A one-time secret must be impossible to lose by accident: it gets its own
   dialog with a copy button and an explicit warning, never a toast that
   disappears on a timer. */
function opsShowTempPassword(res, who) {
  const pw = res.temporary_password || '';
  opsOpenModal('Temporary password', `
    <div class="ops-msg ops-msg-warn" style="margin:0 0 10px">
      Shown once. There is no way to retrieve it again — copy it now and pass it to
      ${escapeHtml(who || 'the user')} through a channel you trust.
    </div>
    <div class="ops-form"><div class="ops-field ops-field-full">
      <label for="opsTpVal">Temporary password</label>
      <input type="text" id="opsTpVal" readonly value="${escapeHtml(pw)}" class="ops-mono">
    </div></div>
    ${res.message ? `<p class="ops-field-hint" style="margin-top:6px">${escapeHtml(res.message)}</p>` : ''}`,
    `<button type="button" class="ops-btn" id="opsTpCopy">Copy</button>
     <span class="ops-spacer"></span>
     <button type="button" class="ops-btn ops-btn-primary" id="opsTpDone">I have copied it</button>`);
  $('opsTpVal').select();
  $('opsTpCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pw);
      opsToast('Copied.', 'ok');
    } catch {
      /* Clipboard access needs a secure context; selecting the text is the
         fallback that always works. */
      $('opsTpVal').select();
      opsToast('Could not use the clipboard — the password is selected, press Ctrl+C.', 'err');
    }
  });
  $('opsTpDone').addEventListener('click', opsCloseModal);
}

function opsMerchantFormFields(m) {
  const v = k => escapeHtml(String(m?.[k] ?? ''));
  return `
    <div class="ops-field"><label for="opsMfCompany">Company name<span class="ops-req">*</span></label>
      <input type="text" id="opsMfCompany" value="${v('company_name')}"></div>
    <div class="ops-field"><label for="opsMfTrading">Trading name<span class="ops-req">*</span></label>
      <input type="text" id="opsMfTrading" value="${v('merchant_name')}"></div>
    <div class="ops-field"><label for="opsMfType">Company type<span class="ops-req">*</span></label>
      <select id="opsMfType">${opsSelectOptions(OPS_COMPANY_TYPES, m?.company_type || 'travel_agency')}</select></div>
    <div class="ops-field"><label for="opsMfPhone">Phone</label>
      <input type="text" id="opsMfPhone" value="${v('phone')}"></div>
    <div class="ops-field"><label for="opsMfCountry">Country</label>
      <input type="text" id="opsMfCountry" value="${v('country')}"></div>
    <div class="ops-field"><label for="opsMfCC">Country code</label>
      <input type="text" id="opsMfCC" value="${v('country_code')}" placeholder="e.g. IN"></div>
    <div class="ops-field"><label for="opsMfCity">City</label>
      <input type="text" id="opsMfCity" value="${v('city')}"></div>
    <div class="ops-field"><label for="opsMfLimit">Credit limit (₹)</label>
      <input type="number" id="opsMfLimit" min="0" step="1000" value="${v('credit_limit') || '0'}"></div>
    <div class="ops-field ops-field-full"><label for="opsMfAddr">Address</label>
      <input type="text" id="opsMfAddr" value="${v('address')}"></div>`;
}

function opsCreateMerchantDialog(after) {
  opsOpenModal('New merchant', `
    <p style="margin:0 0 10px;font-size:12px">
      Creates the company <b>and its first login</b>, returning a one-time temporary password.
      The company starts at <b>Pending Approval</b>, so its staff cannot sign in until it is
      approved.
    </p>
    <fieldset class="ops-fieldset"><legend>Company</legend>
      <div class="ops-fieldset-body"><div class="ops-form ops-form-2">
        ${opsMerchantFormFields(null)}
        <div class="ops-field"><label for="opsMfEmail">Company email<span class="ops-req">*</span></label>
          <input type="email" id="opsMfEmail"></div>
        <div class="ops-field"><label for="opsMfCode">Merchant code</label>
          <input type="text" id="opsMfCode" placeholder="auto-generated if blank"></div>
        <div class="ops-field"><label for="opsMfPrefix">Reference prefix</label>
          <input type="text" id="opsMfPrefix" placeholder="auto-generated if blank"></div>
      </div></div>
    </fieldset>
    <fieldset class="ops-fieldset"><legend>First login (contact person)</legend>
      <div class="ops-fieldset-body"><div class="ops-form ops-form-2">
        <div class="ops-field"><label for="opsMfContact">Contact person<span class="ops-req">*</span></label>
          <input type="text" id="opsMfContact"></div>
        <div class="ops-field"><label for="opsMfContactEmail">Contact email<span class="ops-req">*</span></label>
          <input type="email" id="opsMfContactEmail">
          <span class="ops-field-hint">This becomes the sign-in address for the company's first user.</span></div>
      </div></div>
    </fieldset>
    <div class="ops-msg" id="opsMfMsg"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsMfCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-primary" id="opsMfSave">Create merchant</button>`, { wide: true });

  $('opsMfCancel').addEventListener('click', opsCloseModal);
  $('opsMfSave').addEventListener('click', async () => {
    const msg = $('opsMfMsg');
    const payload = {
      company_name: $('opsMfCompany').value.trim(),
      merchant_name: $('opsMfTrading').value.trim(),
      company_type: $('opsMfType').value,
      email: $('opsMfEmail').value.trim(),
      phone: $('opsMfPhone').value.trim() || undefined,
      contact_person: $('opsMfContact').value.trim(),
      contact_email: $('opsMfContactEmail').value.trim(),
      country: $('opsMfCountry').value.trim() || undefined,
      country_code: $('opsMfCC').value.trim() || undefined,
      city: $('opsMfCity').value.trim() || undefined,
      address: $('opsMfAddr').value.trim() || undefined,
      credit_limit: Number($('opsMfLimit').value || 0),
      merchant_code: $('opsMfCode').value.trim() || undefined,
      reference_prefix: $('opsMfPrefix').value.trim() || undefined,
    };
    for (const [k, label] of [['company_name', 'Company name'], ['merchant_name', 'Trading name'],
      ['email', 'Company email'], ['contact_person', 'Contact person'], ['contact_email', 'Contact email']]) {
      if (!payload[k]) return opsMsg(msg, `${label} is required.`, 'err');
    }
    $('opsMfSave').disabled = true;
    opsMsg(msg, 'Creating…', 'muted');
    try {
      const res = await OpsApi.createMerchant(payload);
      opsInvalidate('merchants', 'dashboard', 'approvals');
      after?.();
      opsShowTempPassword({
        temporary_password: res.temporary_password,
        message: `${res.merchant?.company_name} created as ${res.merchant?.merchant_code}. `
          + `First login: ${res.first_user?.email}. The company is Pending Approval.`,
      }, res.first_user?.full_name);
      opsLoadBadges();
    } catch (err) {
      opsMsg(msg, opsError(err, 'The merchant could not be created.'), 'err');
      $('opsMfSave').disabled = false;
    }
  });
}

function opsEditMerchantDialog(m) {
  opsOpenModal(`Edit ${m.company_name}`, `
    <div class="ops-form ops-form-2">${opsMerchantFormFields(m)}</div>
    <p class="ops-field-hint" style="margin-top:8px">
      Only the fields present in the request body change server-side. The merchant code,
      reference prefix, booking sequence and email are not editable through this endpoint.
    </p>
    <div class="ops-msg" id="opsMeMsg"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsMeCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-primary" id="opsMeSave">Save changes</button>`, { wide: true });

  $('opsMeCancel').addEventListener('click', () => opsOpenMerchant(m.id));
  $('opsMeSave').addEventListener('click', async () => {
    const payload = {
      company_name: $('opsMfCompany').value.trim(),
      merchant_name: $('opsMfTrading').value.trim(),
      company_type: $('opsMfType').value,
      phone: $('opsMfPhone').value.trim() || undefined,
      country: $('opsMfCountry').value.trim() || undefined,
      country_code: $('opsMfCC').value.trim() || undefined,
      city: $('opsMfCity').value.trim() || undefined,
      address: $('opsMfAddr').value.trim() || undefined,
      credit_limit: Number($('opsMfLimit').value || 0),
    };
    if (!payload.company_name) return opsMsg($('opsMeMsg'), 'Company name is required.', 'err');
    $('opsMeSave').disabled = true;
    try {
      await OpsApi.updateMerchant(m.id, payload);
      opsToast('Merchant updated.', 'ok');
      opsInvalidate('merchants', 'wallet');
      opsOpenMerchant(m.id);
    } catch (err) {
      opsMsg($('opsMeMsg'), opsError(err, 'The update failed.'), 'err');
      $('opsMeSave').disabled = false;
    }
  });
}

/* Communication settings are per merchant and gated on notification.send. */
async function opsCommsDialog(m) {
  const body = opsOpenModal(`Communication — ${m.company_name}`, opsSpinner(),
    '<span class="ops-spacer"></span><button type="button" class="ops-btn" id="opsCsClose">Close</button>');
  $('opsCsClose').addEventListener('click', () => opsOpenMerchant(m.id));
  try {
    const s = await OpsApi.communicationSettings(m.id);
    body.innerHTML = `
      <div class="ops-form ops-form-2">
        ${[['email_enabled', 'Email'], ['sms_enabled', 'SMS'], ['whatsapp_enabled', 'WhatsApp'],
           ['otp_enabled', 'OTP at sign-in'], ['notification_enabled', 'In-portal notifications']]
          .map(([k, label]) => `<label class="ops-check">
            <input type="checkbox" data-ops-cs="${k}" ${s[k] ? 'checked' : ''}> ${escapeHtml(label)}
          </label>`).join('')}
        <div class="ops-field">
          <label for="opsCsLang">Preferred language</label>
          <input type="text" id="opsCsLang" value="${escapeHtml(s.preferred_language || '')}" placeholder="en">
        </div>
      </div>
      <p class="ops-field-hint" style="margin-top:8px">
        A merchant with <b>in-portal notifications</b> switched off is skipped by a broadcast
        rather than force-sent. Switching off <b>OTP</b> here does not remove the code step from
        sign-in — the login flow always issues one.
      </p>
      <div class="ops-msg" id="opsCsMsg"></div>`;
    $('opsModalFoot').innerHTML = `
      <span class="ops-spacer"></span>
      <button type="button" class="ops-btn" id="opsCsBack">Back</button>
      <button type="button" class="ops-btn ops-btn-primary" id="opsCsSave">Save</button>`;
    $('opsCsBack').addEventListener('click', () => opsOpenMerchant(m.id));
    $('opsCsSave').addEventListener('click', async () => {
      const payload = { preferred_language: $('opsCsLang').value.trim() || undefined };
      opsAll('[data-ops-cs]', body).forEach(cb => { payload[cb.dataset.opsCs] = cb.checked; });
      $('opsCsSave').disabled = true;
      try {
        await OpsApi.updateCommunicationSettings(m.id, payload);
        opsToast('Communication settings saved.', 'ok');
        opsOpenMerchant(m.id);
      } catch (err) {
        opsMsg($('opsCsMsg'), opsError(err, 'Save failed.'), 'err');
        $('opsCsSave').disabled = false;
      }
    });
  } catch (err) {
    body.innerHTML = `<div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Could not load the settings.'))}</div>`;
  }
}

/* ===========================================================================
   USERS
   ===========================================================================
   Three populations, three endpoints, and each tab appears only when both the
   permission AND the account shape make it useful:

     Platform users   /api/admin/users          merchant_user.manage  (staff)
     My team          /api/merchant/team        merchant_user.manage  + a merchant
     Administrators   /api/super-admin/admins   admin.view            (super admin)

   The team endpoint scopes to the caller's own merchant_id, so it is useless to
   platform staff (whose merchant_id is null) — the tab is hidden rather than
   shown empty.
   =========================================================================== */

function opsInitUsers() {
  const host = $('ops-users');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Users</h1>
        <p>Accounts, roles and sign-in state.</p>
      </div>
    </div>
    <div id="opsUsersTabs"></div>`;

  OpsTabs($('opsUsersTabs'), [
    { id: 'platform', label: 'All users', when: opsCan('merchant_user.manage') && opsIsStaff(),
      render: body => opsPlatformUsersGrid(body) },
    { id: 'team', label: 'My team', when: opsCan('merchant_user.manage') && !!opsMerchantId(),
      render: body => opsTeamGrid(body) },
    { id: 'admins', label: 'Administrators', when: opsCan('admin.view'),
      render: body => opsAdminsGrid(body) },
  ], { hash: 'users' });
}

function opsPlatformUsersGrid(host) {
  return OpsGrid({
    id: 'users-all',
    mount: host,
    title: 'All users',
    exportName: 'users',
    mode: 'server',
    searchable: true,
    searchPlaceholder: 'Name or email…',
    filters: [
      { key: 'role', label: 'Role', type: 'select', anyLabel: 'Any role',
        options: OPS_USER_ROLES.map(r => ({ value: r, label: opsLabel(r) })) },
      { key: 'status', label: 'Status', type: 'select', anyLabel: 'Any status',
        options: OPS_USER_STATUSES.map(s => ({ value: s, label: opsLabel(s) })) },
      { key: 'merchant_id', label: 'Merchant ID', type: 'number', placeholder: 'any' },
    ],
    columns: [
      { key: 'full_name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone', nowrap: true },
      OpsCol.enumLabel('role', 'Role'),
      OpsCol.enumLabel('merchant_role', 'Merchant role'),
      { key: 'merchant_id', label: 'Merchant ID', align: 'right', hidden: true },
      OpsCol.status(),
      { key: 'is_online', label: 'Online', nowrap: true,
        render: r => (r.is_online ? '<span class="ops-tag ops-tag-ok">Online</span>' : '<span class="ops-muted">—</span>'),
        text: r => (r.is_online ? 'yes' : 'no') },
      { key: 'otp_enabled', label: 'OTP', nowrap: true, hidden: true,
        render: r => (r.otp_enabled ? 'On' : 'Off'), text: r => (r.otp_enabled ? 'on' : 'off') },
      { key: 'login_count', label: 'Logins', align: 'right', hidden: true },
      OpsCol.dateTime('last_login', 'Last login'),
      OpsCol.dateTime('created_at', 'Created'),
    ],
    note: `Search here matches <b>name and email only</b> — phone is not indexed by
      <code>/api/admin/users</code>. <b>Online</b> comes from the session heartbeat, so it means
      "active in the last few minutes", not "has a valid token". This list is read-only: a
      merchant's staff are edited from <b>My team</b> by that merchant, and their passwords are
      reset from the merchant's own record under Merchants.`,
    emptyText: 'No users match these criteria.',
    fetch: async ({ page, pageSize, search, filters: f }) => {
      const params = { page, page_size: pageSize };
      if (search) params.search = search;
      if (f.role) params.role = f.role;
      if (f.status) params.status = f.status;
      if (f.merchant_id) params.merchant_id = Number(f.merchant_id);
      const d = await OpsApi.listUsers(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
  });
}

function opsTeamGrid(host) {
  host.innerHTML = `
    <div class="ops-panel"><div class="ops-panel-head">
      <h2>${escapeHtml(OpsSession.user?.merchant_name || 'My company')}</h2>
      <div class="ops-panel-tools">
        ${opsCan('merchant_user.create') ? '<button type="button" class="ops-btn ops-btn-sm ops-btn-primary" id="opsTmNew">+ New user</button>' : ''}
      </div>
    </div></div>
    <div id="opsTeamGrid"></div>`;

  let grid = null;
  $('opsTmNew')?.addEventListener('click', () => opsTeamMemberDialog(null, () => grid.reload()));

  grid = OpsGrid({
    id: 'users-team',
    mount: $('opsTeamGrid'),
    title: 'My team',
    exportName: 'team',
    mode: 'server',
    searchable: true,
    searchPlaceholder: 'Name or email…',
    filters: [],
    columns: [
      { key: 'full_name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone', nowrap: true },
      OpsCol.enumLabel('role', 'Role'),
      OpsCol.enumLabel('merchant_role', 'Merchant role'),
      OpsCol.status(),
      { key: 'is_online', label: 'Online', nowrap: true,
        render: r => (r.is_online ? '<span class="ops-tag ops-tag-ok">Online</span>' : '<span class="ops-muted">—</span>'),
        text: r => (r.is_online ? 'yes' : 'no') },
      OpsCol.dateTime('last_login', 'Last login'),
      OpsCol.actions([
        { act: 'edit', label: 'Edit' },
        { act: 'suspend', label: 'Suspend', danger: true, when: r => r.status === 'active' },
        { act: 'activate', label: 'Reactivate', when: r => r.status !== 'active' },
        { act: 'reset', label: 'Reset password' },
      ]),
    ],
    note: `A merchant role decides what a team member may do — the permission sets are in
      <code>rbac.MERCHANT_ROLE_PERMISSIONS</code>: <b>Manager</b> and <b>Supervisor</b> can raise
      and track requests, <b>Operator</b> can raise but not pay or report, <b>Finance</b> can pay
      and report but not raise, <b>Data operator</b> can search and view only.`,
    emptyText: 'No team members yet.',
    fetch: async ({ page, pageSize, search }) => {
      const params = { page, page_size: pageSize };
      if (search) params.search = search;
      const d = await OpsApi.listTeam(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    actions: {
      edit: row => opsTeamMemberDialog(row, () => grid.reload()),
      suspend: async row => {
        if (!await opsConfirm(`Suspend ${row.full_name}? They will be refused at sign-in.`, 'Suspend', { danger: true })) return;
        try {
          await OpsApi.setTeamMemberStatus(row.id, 'suspended');
          opsToast(`${row.full_name} suspended.`, 'ok');
          grid.reload();
        } catch (err) { opsToast(opsError(err, 'The change failed.'), 'err'); }
      },
      activate: async row => {
        try {
          await OpsApi.setTeamMemberStatus(row.id, 'active');
          opsToast(`${row.full_name} reactivated.`, 'ok');
          grid.reload();
        } catch (err) { opsToast(opsError(err, 'The change failed.'), 'err'); }
      },
      reset: async row => {
        if (!await opsConfirm(
          `Reset the password for ${row.full_name}? A temporary password is shown once and cannot `
          + `be retrieved afterwards.`, 'Reset password', { danger: true })) return;
        try {
          const res = await OpsApi.resetTeamMemberPassword(row.id);
          opsShowTempPassword(res, row.full_name);
        } catch (err) { opsToast(opsError(err, 'The reset failed.'), 'err'); }
      },
    },
  });
  return grid;
}

function opsTeamMemberDialog(user, after) {
  const editing = !!user;
  opsOpenModal(editing ? `Edit ${user.full_name}` : 'New team member', `
    <div class="ops-form ops-form-2">
      <div class="ops-field"><label for="opsTuName">Full name<span class="ops-req">*</span></label>
        <input type="text" id="opsTuName" value="${escapeHtml(user?.full_name || '')}"></div>
      <div class="ops-field"><label for="opsTuEmail">Email<span class="ops-req">*</span></label>
        <input type="email" id="opsTuEmail" value="${escapeHtml(user?.email || '')}" ${editing ? 'disabled' : ''}>
        ${editing ? '<span class="ops-field-hint">The sign-in address cannot be changed here.</span>' : ''}</div>
      <div class="ops-field"><label for="opsTuPhone">Phone</label>
        <input type="text" id="opsTuPhone" value="${escapeHtml(user?.phone || '')}"></div>
      ${editing ? '' : `
        <div class="ops-field"><label for="opsTuRole">Account role<span class="ops-req">*</span></label>
          <select id="opsTuRole">${opsSelectOptions(['merchant_user', 'merchant_admin'], 'merchant_user')}</select>
          <span class="ops-field-hint">A merchant admin manages the company's own users.</span></div>`}
      <div class="ops-field"><label for="opsTuMRole">Merchant role</label>
        <select id="opsTuMRole"><option value="">—</option>
          ${opsSelectOptions(OPS_MERCHANT_ROLES, user?.merchant_role || '')}</select>
        <span class="ops-field-hint">Decides what they may do day to day.</span></div>
      ${editing ? '' : `
        <div class="ops-field ops-field-full"><label for="opsTuPw">Initial password</label>
          <input type="password" id="opsTuPw" autocomplete="new-password" placeholder="leave blank to generate one">
          <span class="ops-field-hint">If left blank a temporary password is generated and shown once.</span></div>`}
    </div>
    <div class="ops-msg" id="opsTuMsg"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsTuCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-primary" id="opsTuSave">${editing ? 'Save changes' : 'Create user'}</button>`);

  $('opsTuCancel').addEventListener('click', opsCloseModal);
  $('opsTuSave').addEventListener('click', async () => {
    const msg = $('opsTuMsg');
    const full_name = $('opsTuName').value.trim();
    if (!full_name) return opsMsg(msg, 'A full name is required.', 'err');
    const phone = $('opsTuPhone').value.trim() || undefined;
    const merchant_role = $('opsTuMRole').value || undefined;
    $('opsTuSave').disabled = true;
    try {
      if (editing) {
        await OpsApi.updateTeamMember(user.id, { full_name, phone, merchant_role });
        opsCloseModal();
        opsToast('User updated.', 'ok');
      } else {
        const email = $('opsTuEmail').value.trim();
        if (!email) { $('opsTuSave').disabled = false; return opsMsg(msg, 'An email address is required.', 'err'); }
        const pw = $('opsTuPw').value;
        const res = await OpsApi.createTeamMember({
          full_name, email, phone, role: $('opsTuRole').value, merchant_role,
          password: pw || undefined,
        });
        if (res?.temporary_password) opsShowTempPassword(res, full_name);
        else { opsCloseModal(); opsToast(`${full_name} created.`, 'ok'); }
      }
      after?.();
    } catch (err) {
      opsMsg(msg, opsError(err, 'The user could not be saved.'), 'err');
      const b = $('opsTuSave');
      if (b) b.disabled = false;
    }
  });
}

/* ------------------------------------------------------------ administrators */

function opsAdminsGrid(host) {
  host.innerHTML = `
    <div class="ops-panel"><div class="ops-panel-head">
      <h2>Platform administrators</h2>
      <div class="ops-panel-tools">
        ${opsCan('admin.create') ? '<button type="button" class="ops-btn ops-btn-sm ops-btn-primary" id="opsAdNew">+ New administrator</button>' : ''}
      </div>
    </div></div>
    <div id="opsAdminsGrid"></div>`;

  let grid = null;
  $('opsAdNew')?.addEventListener('click', () => opsAdminDialog(null, () => grid.reload()));

  grid = OpsGrid({
    id: 'users-admins',
    mount: $('opsAdminsGrid'),
    title: 'Administrators',
    exportName: 'administrators',
    mode: 'server',
    searchable: true,
    searchPlaceholder: 'Name or email…',
    filters: [],
    columns: [
      { key: 'full_name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone', nowrap: true },
      OpsCol.status(),
      { key: 'is_online', label: 'Online', nowrap: true,
        render: r => (r.is_online ? '<span class="ops-tag ops-tag-ok">Online</span>' : '<span class="ops-muted">—</span>'),
        text: r => (r.is_online ? 'yes' : 'no') },
      { key: 'login_count', label: 'Logins', align: 'right' },
      OpsCol.dateTime('last_login', 'Last login'),
      OpsCol.dateTime('created_at', 'Created'),
      OpsCol.actions([
        { act: 'edit', label: 'Edit', when: () => opsCan('admin.edit') },
        { act: 'perms', label: 'Permissions', when: () => opsCan('admin.view') },
        { act: 'suspend', label: 'Suspend', danger: true, when: r => r.status === 'active' && opsCan('admin.suspend') },
        { act: 'activate', label: 'Reactivate', when: r => r.status !== 'active' && opsCan('admin.suspend') },
        { act: 'reset', label: 'Reset password', when: () => opsCan('admin.reset_password') },
        { act: 'delete', label: 'Delete', danger: true, when: () => opsCan('admin.delete') },
      ]),
    ],
    note: `An administrator's role permissions are fixed by design — the matrix in
      <code>rbac.ROLE_PERMISSIONS</code> is deliberately not editable, because the separation
      between Super Admin and Admin (a super admin cannot raise tickets; an admin cannot create
      admins) is the point rather than a gap. What <b>is</b> editable per person is an
      <b>extra grant</b> on top of the role default — that is what Permissions opens.`,
    emptyText: 'No administrators found.',
    fetch: async ({ page, pageSize, search }) => {
      const params = { page, page_size: pageSize };
      if (search) params.search = search;
      const d = await OpsApi.listAdmins(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    actions: {
      edit: row => opsAdminDialog(row, () => grid.reload()),
      perms: row => opsAdminPermsDialog(row),
      suspend: async row => {
        if (!await opsConfirm(`Suspend ${row.full_name}? They will be refused at sign-in.`, 'Suspend', { danger: true })) return;
        try {
          await OpsApi.setAdminStatus(row.id, 'suspended');
          opsToast(`${row.full_name} suspended.`, 'ok');
          grid.reload();
        } catch (err) { opsToast(opsError(err, 'The change failed.'), 'err'); }
      },
      activate: async row => {
        try {
          await OpsApi.setAdminStatus(row.id, 'active');
          opsToast(`${row.full_name} reactivated.`, 'ok');
          grid.reload();
        } catch (err) { opsToast(opsError(err, 'The change failed.'), 'err'); }
      },
      reset: async row => {
        if (!await opsConfirm(
          `Reset the password for ${row.full_name}? A temporary password is shown once.`,
          'Reset password', { danger: true })) return;
        try {
          const res = await OpsApi.resetAdminPassword(row.id);
          opsShowTempPassword(res, row.full_name);
        } catch (err) { opsToast(opsError(err, 'The reset failed.'), 'err'); }
      },
      delete: async row => {
        if (!await opsConfirm(
          `Delete the administrator ${row.full_name}? This is not a suspension — the account is `
          + `removed. Suspending is reversible; this is not.`, 'Delete', { danger: true })) return;
        try {
          await OpsApi.deleteAdmin(row.id);
          opsToast(`${row.full_name} deleted.`, 'ok');
          opsInvalidate('dashboard');
          grid.reload();
        } catch (err) { opsToast(opsError(err, 'The delete failed.'), 'err'); }
      },
    },
  });
  return grid;
}

function opsAdminDialog(admin, after) {
  const editing = !!admin;
  opsOpenModal(editing ? `Edit ${admin.full_name}` : 'New administrator', `
    <div class="ops-form ops-form-2">
      <div class="ops-field"><label for="opsAdName">Full name<span class="ops-req">*</span></label>
        <input type="text" id="opsAdName" value="${escapeHtml(admin?.full_name || '')}"></div>
      <div class="ops-field"><label for="opsAdEmail">Email<span class="ops-req">*</span></label>
        <input type="email" id="opsAdEmail" value="${escapeHtml(admin?.email || '')}"></div>
      <div class="ops-field"><label for="opsAdPhone">Phone</label>
        <input type="text" id="opsAdPhone" value="${escapeHtml(admin?.phone || '')}"></div>
      ${editing ? '' : `
        <div class="ops-field"><label for="opsAdPw">Initial password</label>
          <input type="password" id="opsAdPw" autocomplete="new-password" placeholder="leave blank to generate one">
        </div>`}
    </div>
    <p class="ops-field-hint" style="margin-top:8px">
      An administrator gets the full Admin permission set: merchants, approvals, payments,
      support and reports. It does not include creating other administrators.
    </p>
    <div class="ops-msg" id="opsAdMsg"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsAdCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-primary" id="opsAdSave">${editing ? 'Save changes' : 'Create administrator'}</button>`);

  $('opsAdCancel').addEventListener('click', opsCloseModal);
  $('opsAdSave').addEventListener('click', async () => {
    const msg = $('opsAdMsg');
    const full_name = $('opsAdName').value.trim();
    const email = $('opsAdEmail').value.trim();
    const phone = $('opsAdPhone').value.trim() || undefined;
    if (!full_name || !email) return opsMsg(msg, 'Name and email are both required.', 'err');
    $('opsAdSave').disabled = true;
    try {
      if (editing) {
        await OpsApi.updateAdmin(admin.id, { full_name, email, phone });
        opsCloseModal();
        opsToast('Administrator updated.', 'ok');
      } else {
        const pw = $('opsAdPw').value;
        const res = await OpsApi.createAdmin({ full_name, email, phone, password: pw || undefined });
        if (res?.temporary_password) opsShowTempPassword(res, full_name);
        else { opsCloseModal(); opsToast(`${full_name} created.`, 'ok'); }
        opsInvalidate('dashboard');
      }
      after?.();
    } catch (err) {
      opsMsg(msg, opsError(err, 'The administrator could not be saved.'), 'err');
      const b = $('opsAdSave');
      if (b) b.disabled = false;
    }
  });
}

async function opsAdminPermsDialog(admin) {
  const body = opsOpenModal(`Permissions — ${admin.full_name}`, opsSpinner(),
    '<span class="ops-spacer"></span><button type="button" class="ops-btn" id="opsApClose2">Close</button>', { wide: true });
  $('opsApClose2').addEventListener('click', opsCloseModal);
  try {
    const [p, matrix] = await Promise.all([
      OpsApi.adminPermissions(admin.id),
      OpsApi.permissionMatrix().catch(() => null),
    ]);
    const all = matrix?.all_codes || [...new Set([...p.role_defaults, ...p.extra_grants, ...p.effective])].sort();
    const defaults = new Set(p.role_defaults);
    const extras = new Set(p.extra_grants);

    /* Group by the part before the dot, which is how the codes are organised in
       rbac.P — one section per module rather than a flat list of forty. */
    const groups = {};
    all.forEach(code => {
      const g = code.split('.')[0];
      (groups[g] = groups[g] || []).push(code);
    });

    body.innerHTML = `
      <p style="margin:0 0 10px;font-size:12px">
        A code that comes with the Admin role is shown as <b>role default</b> and cannot be
        removed — the role matrix is fixed. Ticking anything else adds an <b>extra grant</b> for
        this person only, which is stored on their user row and included in the permissions the
        API enforces.
      </p>
      ${Object.entries(groups).map(([g, codes]) => `
        <fieldset class="ops-fieldset"><legend>${escapeHtml(opsLabel(g))}</legend>
          <div class="ops-fieldset-body"><div class="ops-form ops-form-wide">
            ${codes.map(c => `<label class="ops-check" title="${escapeHtml(c)}">
              <input type="checkbox" data-ops-perm="${escapeHtml(c)}"
                ${defaults.has(c) ? 'checked disabled' : extras.has(c) ? 'checked' : ''}>
              <span>${escapeHtml(c)}${defaults.has(c) ? ' <span class="ops-tag">role default</span>' : ''}</span>
            </label>`).join('')}
          </div></div>
        </fieldset>`).join('')}
      <div class="ops-msg" id="opsApMsg2"></div>`;

    $('opsModalFoot').innerHTML = `
      <span class="ops-muted">${p.effective.length} effective codes</span>
      <span class="ops-spacer"></span>
      <button type="button" class="ops-btn" id="opsApCancel2">Close</button>
      ${opsCan('admin.edit') ? '<button type="button" class="ops-btn ops-btn-primary" id="opsApSave2">Save extra grants</button>' : ''}`;
    $('opsApCancel2').addEventListener('click', opsCloseModal);
    $('opsApSave2')?.addEventListener('click', async () => {
      const grants = opsAll('[data-ops-perm]', body)
        .filter(cb => cb.checked && !cb.disabled)
        .map(cb => cb.dataset.opsPerm);
      $('opsApSave2').disabled = true;
      try {
        await OpsApi.setAdminPermissions(admin.id, grants);
        opsToast(`${grants.length} extra grant${grants.length === 1 ? '' : 's'} saved.`, 'ok');
        opsCloseModal();
      } catch (err) {
        opsMsg($('opsApMsg2'), opsError(err, 'Save failed.'), 'err');
        $('opsApSave2').disabled = false;
      }
    });
  } catch (err) {
    body.innerHTML = `<div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Could not load permissions.'))}</div>`;
  }
}
