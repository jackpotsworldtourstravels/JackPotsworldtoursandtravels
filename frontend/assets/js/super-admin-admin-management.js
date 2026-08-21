'use strict';
/* Super Admin Portal — Admin Management.
   Create / Edit / Suspend / Activate / Reset Password / Delete, against
   /api/super-admin/admins (app/routers/super_admin.py).

   Destructive actions use confirmDialog() (components/confirm-dialog.js)
   rather than the native confirm(): it's the same .modal-overlay markup the
   rest of the portal uses, and unlike a native dialog it stays operable
   under automation, so these paths can actually be walked in a browser
   test instead of only via the API. */

let saAdminsPage = 1;
let saAdminsSearch = '';
let saAdminsRole = '';
/* Cached by id so Edit can prefill from the row already on screen rather
   than re-fetching a single admin the list just returned. */
const saAdminsById = new Map();

/* This screen owns every staff account the Super Admin creates. Manager joined
   the list with CR-2; it approves submitted booking requests and is
   deliberately NOT an Admin, so the desk that answers a ticket enquiry cannot
   also sign off the booking that came out of it. */
const SA_STAFF_ROLES = {
  admin: {
    label: 'Admin',
    badge: 'role-admin',
    hint: 'Manages merchants, answers ticket enquiries, handles payments and issues tickets. Signs in at /admin/.',
  },
  manager: {
    label: 'Manager',
    badge: 'role-manager',
    hint: 'Reviews submitted booking requests and approves them for ticketing, or returns them to the merchant. Cannot answer enquiries, take payments or issue tickets. Signs in at /manager/.',
  },
};

function saRoleBadge(role) {
  const meta = SA_STAFF_ROLES[role];
  if (!meta) return saEscapeHtml(role || '—');
  return `<span class="badge ${meta.badge}">${saEscapeHtml(meta.label)}</span>`;
}

function saAdminRow(a) {
  const isActive = a.status === 'active';
  return `
    <tr>
      <td class="jp-truncate" title="${saEscapeHtml(a.full_name)}"><strong>${saEscapeHtml(a.full_name)}</strong></td>
      <td class="jp-truncate" title="${saEscapeHtml(a.email)}">${saEscapeHtml(a.email)}</td>
      <td>${saRoleBadge(a.role)}</td>
      <td>${saStatusBadge(a.status)}</td>
      <td>${a.last_login ? fmtDateTime(a.last_login) : 'Never'}</td>
      <td>${saFmtDate(a.created_at)}</td>
      <td>
          <button class="btn btn-ghost btn-sm" data-sa-edit="${a.id}">Edit</button>
          <button class="btn ${isActive ? 'btn-danger' : 'btn-navy'} btn-sm"
                  data-sa-status="${a.id}" data-next="${isActive ? 'suspended' : 'active'}">
            ${isActive ? 'Suspend' : 'Activate'}
          </button>
          <button class="btn btn-ghost btn-sm" data-sa-reset="${a.id}">Reset Password</button>
          <button class="btn btn-danger btn-sm" data-sa-delete="${a.id}">Delete</button>
      </td>
    </tr>`;
}

async function loadSaAdmins(page = saAdminsPage) {
  saAdminsPage = page;
  const tbody = document.querySelector('#saAdminsTable tbody');
  saTableError(tbody, 7, 'Loading…');
  try {
    const { data } = await axios.get(`${API_BASE}/api/super-admin/admins`, {
      params: {
        page, page_size: SA_PAGE_SIZE,
        search: saAdminsSearch || undefined,
        role: saAdminsRole || undefined,
      },
      headers: saAuthHeaders(),
    });
    saAdminsById.clear();
    data.items.forEach(a => saAdminsById.set(String(a.id), a));

    tbody.innerHTML = data.items.map(saAdminRow).join('')
      || `<tr><td colspan="7" class="empty-state">${saAdminsSearch || saAdminsRole
            ? 'No staff accounts match that filter.'
            : 'No staff accounts yet — click “+ Add Admin” to create one.'}</td></tr>`;

    saRenderPagination('saAdminsPagination', data.page, data.total_pages, data.total, loadSaAdmins);
    saWireAdminRowActions(tbody);
  } catch (err) {
    saTableError(tbody, 7, saErrorText(err, 'Failed to load staff accounts.'));
  }
}

/* Any mutation changes the Dashboard's admin counts and the permission
   screen's admin picker, so drop them from the loaded set to force a
   refresh next time they're opened. */
function saInvalidateAdminDependentSections() {
  saLoadedSections.delete('dashboard');
  saLoadedSections.delete('roles');
}

function saWireAdminRowActions(tbody) {
  tbody.querySelectorAll('[data-sa-edit]').forEach(btn => {
    btn.addEventListener('click', () => saOpenEditAdmin(btn.dataset.saEdit));
  });

  tbody.querySelectorAll('[data-sa-status]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.saStatus;
      const next = btn.dataset.next;
      const admin = saAdminsById.get(id);
      const suspending = next === 'suspended';
      const ok = await confirmDialog({
        title: suspending ? 'Suspend this administrator?' : 'Reactivate this administrator?',
        message: suspending
          ? `${admin?.full_name || 'This admin'} will be signed out immediately and every outstanding token revoked.`
          : `${admin?.full_name || 'This admin'} will be able to sign in again.`,
        confirmText: suspending ? 'Suspend' : 'Activate',
        danger: suspending,
      });
      if (!ok) return;
      try {
        await axios.patch(`${API_BASE}/api/super-admin/admins/${id}/status`, { status: next },
                          { headers: saAuthHeaders() });
        showToast(suspending ? 'Administrator suspended.' : 'Administrator reactivated.');
        saInvalidateAdminDependentSections();
        loadSaAdmins();
      } catch (err) {
        showToast(saErrorText(err, 'Failed to update the administrator.'), true);
      }
    });
  });

  tbody.querySelectorAll('[data-sa-reset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.saReset;
      const admin = saAdminsById.get(id);
      const ok = await confirmDialog({
        title: 'Reset this password?',
        message: `A new password will be issued for ${admin?.email || 'this admin'} and their existing sessions revoked. It is shown once.`,
        confirmText: 'Reset Password',
        danger: true,
      });
      if (!ok) return;
      try {
        const { data } = await axios.post(`${API_BASE}/api/super-admin/admins/${id}/reset-password`, {},
                                          { headers: saAuthHeaders() });
        saShowCredentials('Password Reset', data);
        loadSaAdmins();
      } catch (err) {
        showToast(saErrorText(err, 'Failed to reset the password.'), true);
      }
    });
  });

  tbody.querySelectorAll('[data-sa-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.saDelete;
      const admin = saAdminsById.get(id);
      const ok = await confirmDialog({
        title: 'Delete this administrator?',
        message: `${admin?.full_name || 'This admin'} will be removed permanently. An admin who has handled requests cannot be deleted — suspend them instead.`,
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await axios.delete(`${API_BASE}/api/super-admin/admins/${id}`, { headers: saAuthHeaders() });
        showToast('Administrator deleted.');
        saInvalidateAdminDependentSections();
        loadSaAdmins();
      } catch (err) {
        showToast(saErrorText(err, 'Failed to delete the administrator.'), true);
      }
    });
  });
}

/* ---------- Search (debounced) + role filter ---------- */
let saAdminSearchTimer;
document.getElementById('saAdminSearch')?.addEventListener('input', e => {
  clearTimeout(saAdminSearchTimer);
  saAdminSearchTimer = setTimeout(() => {
    saAdminsSearch = e.target.value.trim();
    loadSaAdmins(1);
  }, 300);
});
document.getElementById('saAdminRoleFilter')?.addEventListener('change', e => {
  saAdminsRole = e.target.value;
  loadSaAdmins(1);
});

/* One place that keeps a role <select> and its explanation in step, so the
   Super Admin reads what the role actually grants before creating it rather
   than after. */
function saWireRoleHint(selectId, hintId) {
  const select = document.getElementById(selectId);
  const hint = document.getElementById(hintId);
  if (!select || !hint) return;
  const apply = () => { hint.textContent = SA_STAFF_ROLES[select.value]?.hint || ''; };
  select.addEventListener('change', apply);
  apply();
}
saWireRoleHint('saAddRole', 'saAddRoleHint');
saWireRoleHint('saEditRole', 'saEditRoleHint');

/* ---------- Credentials-shown-once modal ---------- */
const saCredentialsModalOverlay = document.getElementById('saCredentialsModalOverlay');
function saShowCredentials(title, payload) {
  document.getElementById('saCredentialsTitle').textContent = title;
  document.getElementById('saCredentialsEmail').textContent = payload.account.email;
  document.getElementById('saCredentialsPassword').textContent = payload.temporary_password;
  saCredentialsModalOverlay.classList.add('open');
}
document.getElementById('saCredentialsCloseBtn')?.addEventListener('click', () => {
  saCredentialsModalOverlay.classList.remove('open');
  /* Clear the plaintext out of the DOM once it's been acknowledged. */
  document.getElementById('saCredentialsPassword').textContent = '—';
});

/* ---------- Add Admin ---------- */
const saAddAdminModalOverlay = document.getElementById('saAddAdminModalOverlay');
document.getElementById('saAddAdminBtn')?.addEventListener('click', () => {
  document.getElementById('saAddAdminForm').reset();
  document.getElementById('saAddAdminMsg').textContent = '';
  document.getElementById('saAddAdminMsg').className = 'msg';
  saAddAdminModalOverlay.classList.add('open');
});
document.getElementById('saAddAdminCancelBtn')?.addEventListener('click',
  () => saAddAdminModalOverlay.classList.remove('open'));

document.getElementById('saAddAdminForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const msg = document.getElementById('saAddAdminMsg');
  const fail = text => { msg.className = 'msg error'; msg.textContent = text; };

  if (!f.full_name.value.trim()) return fail('Full Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) return fail('A valid email address is required.');
  /* Blank is meaningful here — the backend generates a strong password and
     returns it once (CreateAdminRequest.password is optional). */
  if (f.password.value && f.password.value.length < 8) return fail('A password, if given, must be at least 8 characters.');

  const role = f.role.value;
  try {
    const { data } = await axios.post(`${API_BASE}/api/super-admin/admins`, {
      full_name: f.full_name.value.trim(),
      email: f.email.value.trim(),
      phone: f.phone.value.trim() || null,
      password: f.password.value || null,
      role,
    }, { headers: saAuthHeaders() });
    saAddAdminModalOverlay.classList.remove('open');
    saShowCredentials(`${SA_STAFF_ROLES[role]?.label || 'Account'} Created`, data);
    saInvalidateAdminDependentSections();
    loadSaAdmins(1);
  } catch (err) {
    fail(saErrorText(err, 'Failed to create the account.'));
  }
});

/* ---------- Edit Admin ---------- */
const saEditAdminModalOverlay = document.getElementById('saEditAdminModalOverlay');
function saOpenEditAdmin(id) {
  const admin = saAdminsById.get(String(id));
  if (!admin) return;
  const f = document.getElementById('saEditAdminForm').elements;
  f.admin_id.value = admin.id;
  f.full_name.value = admin.full_name;
  f.email.value = admin.email;
  f.phone.value = admin.phone || '';
  f.role.value = admin.role in SA_STAFF_ROLES ? admin.role : 'admin';
  f.role.dispatchEvent(new Event('change'));   // refresh the hint under it
  const msg = document.getElementById('saEditAdminMsg');
  msg.textContent = '';
  msg.className = 'msg';
  saEditAdminModalOverlay.classList.add('open');
}
document.getElementById('saEditAdminCancelBtn')?.addEventListener('click',
  () => saEditAdminModalOverlay.classList.remove('open'));

document.getElementById('saEditAdminForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const msg = document.getElementById('saEditAdminMsg');
  const fail = text => { msg.className = 'msg error'; msg.textContent = text; };

  if (!f.full_name.value.trim()) return fail('Full Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) return fail('A valid email address is required.');

  const current = saAdminsById.get(String(f.admin_id.value));
  const roleChanged = current && current.role !== f.role.value;

  /* A role change rewrites what this person may do and signs them out, so it is
     confirmed separately from an ordinary detail edit rather than slipping
     through on a Save. */
  if (roleChanged) {
    const to = SA_STAFF_ROLES[f.role.value]?.label || f.role.value;
    const ok = await confirmDialog({
      title: `Change this account to ${to}?`,
      message: `${current.full_name} will be signed out immediately and their permissions replaced with the ${to} set. `
             + 'A Manager still reviewing a booking request cannot be changed until those are decided.',
      confirmText: `Change to ${to}`,
      danger: true,
    });
    if (!ok) return;
  }

  try {
    await axios.put(`${API_BASE}/api/super-admin/admins/${f.admin_id.value}`, {
      full_name: f.full_name.value.trim(),
      email: f.email.value.trim(),
      phone: f.phone.value.trim() || null,
      /* Sent only when it actually changed: an unchanged role is `null`, which
         the API reads as "leave it alone". */
      role: roleChanged ? f.role.value : null,
    }, { headers: saAuthHeaders() });
    saEditAdminModalOverlay.classList.remove('open');
    showToast(roleChanged ? 'Account updated and role changed.' : 'Account updated.');
    saInvalidateAdminDependentSections();
    loadSaAdmins();
  } catch (err) {
    fail(saErrorText(err, 'Failed to update the account.'));
  }
});
