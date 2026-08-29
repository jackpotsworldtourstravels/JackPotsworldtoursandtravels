'use strict';
/* ==========================================================================
   CUSTOMER PORTAL — account home
   ==========================================================================
   Identity card, profile form, change password, and the customer's own live
   sessions.

   WHAT IS DELIBERATELY NOT HERE
   No bookings, no wallet, no payments. Those are the "future scalability"
   items in the brief and have no endpoint yet — a panel reading "0 bookings"
   from nothing would be a claim the API cannot make. The module is built so
   they drop in as further panels without touching what is here.
   ========================================================================== */

const CXD = {
  name: 'cxdName', mobile: 'cxdMobile', dob: 'cxdDob', gender: 'cxdGender',
  addr1: 'cxdAddr1', addr2: 'cxdAddr2', city: 'cxdCity', state: 'cxdState',
  country: 'cxdCountry', postal: 'cxdPostal',
  profileMsg: 'cxdProfileMsg', profileForm: 'cxdProfileForm',
  current: 'cxdCurrent', newPw: 'cxdNewPw', confirmPw: 'cxdConfirmPw',
  pwMsg: 'cxdPwMsg', pwForm: 'cxdPwForm',
};

let cxdCustomer = null;

/* ---------------------------------------------------------------- render */
function cxdRenderHeader(c) {
  document.getElementById('cxdTopChip').innerHTML = `
    <span class="cx-ava">${cxInitials(c.full_name)}</span>
    <span class="cx-chip-name">${c.full_name}</span>`;

  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  // First name only. The greeting is the widest thing on the page and a long
  // full name truncates on a phone — the portal-wide fix was to shorten the
  // content, not to add a breakpoint.
  const first = (c.full_name || '').trim().split(/\s+/)[0] || 'there';
  document.getElementById('cxdHello').textContent = `${part}, ${first}`;

  document.getElementById('cxdIdCard').innerHTML = `
    <span class="cx-ava">${cxInitials(c.full_name)}</span>
    <div>
      <p class="cx-id-name">${c.full_name}</p>
      <p class="cx-id-code">${c.customer_code}</p>
    </div>
    <div class="cx-top-spacer"></div>
    <span class="cx-badge ${c.email_verified ? 'is-ok' : 'is-warn'}">
      ${c.email_verified ? 'Email verified' : 'Email unverified'}
    </span>
    <span class="cx-badge ${c.status === 'active' ? 'is-ok' : 'is-warn'}">${c.status}</span>`;
}

function cxdFillForm(c) {
  const set = (id, v) => { document.getElementById(id).value = v == null ? '' : v; };
  set(CXD.name, c.full_name);
  set(CXD.mobile, c.mobile);
  set(CXD.dob, c.date_of_birth);
  set(CXD.gender, c.gender);
  set(CXD.addr1, c.address_line1);
  set(CXD.addr2, c.address_line2);
  set(CXD.city, c.city);
  set(CXD.state, c.state);
  set(CXD.country, c.country);
  set(CXD.postal, c.postal_code);
  document.getElementById('cxdEmailShown').value = c.email;
}

function cxdRenderSessions(rows) {
  const box = document.getElementById('cxdSessions');
  if (!rows.length) {
    box.innerHTML = '<p class="cx-empty">No other active sessions.</p>';
    return;
  }
  box.innerHTML = `<ul class="cx-sessions">${rows.map(s => `
    <li>
      <span class="cx-sess-ico">${cxIco('monitor')}</span>
      <span class="cx-sess-main">
        <b>${s.browser || 'Unknown browser'}${s.device ? ` &middot; ${s.device}` : ''}</b>
        <span>${s.ip_address || 'Unknown address'} &middot; signed in ${cxFormatDateTime(s.login_at)}</span>
      </span>
    </li>`).join('')}</ul>`;
}

/* ------------------------------------------------------------------ boot */
(async function cxdBoot() {
  const me = await cxRequireSession();
  if (!me) return;           // cxRequireSession has already redirected
  cxdCustomer = me;
  cxdRenderHeader(me);
  cxdFillForm(me);
  document.getElementById('cxdDob').max = new Date().toISOString().slice(0, 10);
  document.body.classList.add('is-ready');

  try {
    cxdRenderSessions(await cxFetch('/api/customer/profile/sessions', { auth: true }));
  } catch {
    document.getElementById('cxdSessions').innerHTML =
      '<p class="cx-empty">Could not load your sessions right now.</p>';
  }
})();

/* --------------------------------------------------------------- profile */
document.getElementById(CXD.profileForm).addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  cxMsg(CXD.profileMsg, '');
  cxClearFieldErrors();

  const val = id => {
    const v = document.getElementById(id).value.trim();
    return v === '' ? null : v;
  };

  const body = {
    full_name: val(CXD.name),
    mobile: (val(CXD.mobile) || '').replace(/[\s-]/g, '') || null,
    date_of_birth: val(CXD.dob),
    gender: val(CXD.gender),
    address_line1: val(CXD.addr1),
    address_line2: val(CXD.addr2),
    city: val(CXD.city),
    state: val(CXD.state),
    country: val(CXD.country),
    postal_code: val(CXD.postal),
  };

  if (!body.full_name || body.full_name.length < 2) {
    cxFieldError(CXD.name, 'Enter your full name');
    return;
  }
  // The API requires a mobile on the record, so clearing it is not a thing the
  // form may do — say so here rather than letting the request 422.
  if (!body.mobile) {
    cxFieldError(CXD.mobile, 'A mobile number is required');
    return;
  }
  if (!/^\+?\d{8,15}$/.test(body.mobile)) {
    cxFieldError(CXD.mobile, 'Enter 8–15 digits, optionally starting with +');
    return;
  }

  cxBusy(btn, true, 'Saving…');
  try {
    const updated = await cxFetch('/api/customer/profile', {
      method: 'PATCH', body, auth: true,
    });
    cxdCustomer = updated;
    cxSession.saveCustomer(updated);
    cxdRenderHeader(updated);
    cxdFillForm(updated);
    cxMsg(CXD.profileMsg, 'Your profile has been saved.', 'is-ok');
  } catch (err) {
    if (err.status === 400 && err.message.toLowerCase().includes('mobile')) {
      cxFieldError(CXD.mobile, err.message);
    } else {
      cxMsg(CXD.profileMsg, err.message);
    }
  } finally {
    cxBusy(btn, false);
  }
});

/* -------------------------------------------------------------- password */
document.getElementById(CXD.pwForm).addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  cxMsg(CXD.pwMsg, '');
  cxClearFieldErrors();

  const current = document.getElementById(CXD.current).value;
  const next = document.getElementById(CXD.newPw).value;
  const confirm = document.getElementById(CXD.confirmPw).value;

  if (!current) { cxFieldError(CXD.current, 'Enter your current password'); return; }
  if (next.length < 8) { cxFieldError(CXD.newPw, 'Use at least 8 characters'); return; }
  if (next.length > 72) { cxFieldError(CXD.newPw, 'Use 72 characters or fewer'); return; }
  if (next === current) { cxFieldError(CXD.newPw, 'Choose a password different from the current one'); return; }
  if (next !== confirm) { cxFieldError(CXD.confirmPw, 'Passwords do not match'); return; }

  cxBusy(btn, true, 'Updating…');
  try {
    await cxFetch('/api/customer/auth/change-password', {
      method: 'POST',
      body: { current_password: current, new_password: next, confirm_password: confirm },
      auth: true,
    });
    e.target.reset();
    cxMsg(CXD.pwMsg, 'Password changed.', 'is-ok');
  } catch (err) {
    if (err.status === 400 && err.message.toLowerCase().includes('current password')) {
      cxFieldError(CXD.current, err.message);
    } else {
      cxMsg(CXD.pwMsg, err.message);
    }
  } finally {
    cxBusy(btn, false);
  }
});

/* --------------------------------------------------------------- signout */
document.getElementById('cxdSignOut').addEventListener('click', async () => {
  const btn = document.getElementById('cxdSignOut');
  cxBusy(btn, true, 'Signing out…');
  try {
    await cxFetch('/api/customer/auth/logout', { method: 'POST', auth: true });
  } catch {
    // A failed logout call still means this browser should forget the session.
    // The token may already be revoked, which is the most likely reason to be
    // here — nothing is gained by keeping it.
  }
  cxSession.clear();
  // Relative, so a local session goes to the LOCAL sign-in page. The merchant
  // portal's auth.js hardcodes an absolute production URL here, which is why a
  // sign-out on localhost lands on the live site.
  location.replace('index.html');
});
