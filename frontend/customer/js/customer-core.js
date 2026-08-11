'use strict';
/* ==========================================================================
   JACKPOTS — CUSTOMER PORTAL (V1), shared runtime
   ==========================================================================
   API base, token storage, the fetch wrapper, the auth guard, icons and the
   bits of shell every customer screen builds from.

   THE STORAGE KEYS ARE NAMESPACED, AND THAT IS LOAD-BEARING
   The merchant and admin portals store their session under `jwt_access` /
   `jwt_refresh` / `jwt_user_*`. localStorage is per-ORIGIN, and every portal in
   this product is served from the same origin — so if this file wrote
   `jwt_access` too, signing into the Customer Portal in a browser that already
   had a merchant session would overwrite it, and signing out of one would sign
   the other out. Worse, `assets/js/auth.js` reads `jwt_access` and would then
   attach a CUSTOMER token to merchant API calls, producing a stream of 401s
   that look like a broken merchant portal.

   Everything here is under `jpc_`. Nothing else in the product reads that
   prefix, so the two sessions coexist in one browser and neither can see the
   other's token.

   THE API BASE IS DERIVED, NEVER HARDCODED
   assets/js/auth.js hardcodes an absolute production URL for its sign-out
   redirect, which means a sign-out on localhost navigates to the live site.
   Nothing in this file may do that: every URL below is same-origin or built
   from location.origin, so a local session stays local.
   ========================================================================== */

/* The backend serves this frontend itself on :8000, so same-origin is the
   normal case and '' is correct. A separate static server (Live Server on
   :5500) is the development exception, and only then do we point at the API's
   own port — still on THIS host, never at production. */
const CX_API = (function () {
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const onApiPort = location.port === '8000' || location.port === '';
  return isLocal && !onApiPort ? `${location.protocol}//${location.hostname}:8000` : '';
})();

const CX_KEYS = {
  access: 'jpc_access',
  refresh: 'jpc_refresh',
  customer: 'jpc_customer',
  remember: 'jpc_remember_identifier',
};

/* ------------------------------------------------------------- session --- */
const cxSession = {
  get token() { return localStorage.getItem(CX_KEYS.access); },
  get refresh() { return localStorage.getItem(CX_KEYS.refresh); },

  get customer() {
    try { return JSON.parse(localStorage.getItem(CX_KEYS.customer) || 'null'); }
    catch { return null; }
  },

  save(tokens) {
    localStorage.setItem(CX_KEYS.access, tokens.access_token);
    localStorage.setItem(CX_KEYS.refresh, tokens.refresh_token);
    if (tokens.customer) this.saveCustomer(tokens.customer);
  },

  saveCustomer(customer) {
    localStorage.setItem(CX_KEYS.customer, JSON.stringify(customer));
  },

  /* Clears THIS portal's keys only. A merchant session in the same browser is
     none of our business and must survive a customer sign-out. */
  clear() {
    [CX_KEYS.access, CX_KEYS.refresh, CX_KEYS.customer].forEach(k => localStorage.removeItem(k));
  },
};

/* ----------------------------------------------------------------- api --- */
/* One reader for every error this API can produce. FastAPI validation errors
   come back as a LIST of {loc, msg} under `detail`, not a string — rendering
   that list directly puts "[object Object]" in front of the user, which is
   what happens when a form field fails its schema. 429 is handled by status
   because the rate limiter's body is not the {detail} shape at all. */
function cxError(payload, status, fallback) {
  if (status === 429) return 'Too many attempts from this network. Wait a minute and try again.';
  const d = payload && payload.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && d.length) {
    // Pydantic prefixes its messages with "Value error, " — unhelpful to read.
    return d.map(e => (e.msg || '').replace(/^Value error,\s*/, '')).filter(Boolean).join('. ')
        || fallback;
  }
  return fallback;
}

class CxApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function cxFetch(path, { method = 'GET', body = null, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = cxSession.token;
    if (t) headers.Authorization = `Bearer ${t}`;
  }

  let res;
  try {
    res = await fetch(CX_API + path, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CxApiError('Cannot reach the server. Check your connection and try again.', 0, null);
  }

  let payload = null;
  if (res.status !== 204) {
    try { payload = await res.json(); } catch { payload = null; }
  }

  if (!res.ok) {
    throw new CxApiError(
      cxError(payload, res.status, 'Something went wrong. Please try again.'),
      res.status,
      payload,
    );
  }
  return payload;
}

/* --------------------------------------------------------------- guard --- */
/* Send an unauthenticated visitor to the login, and a signed-in one away from
   it. `me` is called rather than trusting the stored blob: a token can have
   been revoked (logout elsewhere, password reset) while localStorage still
   holds it, and the stored customer is a cache, not the truth. */
async function cxRequireSession(redirectTo = 'index.html') {
  if (!cxSession.token) { location.replace(redirectTo); return null; }
  try {
    const me = await cxFetch('/api/customer/auth/me', { auth: true });
    cxSession.saveCustomer(me);
    return me;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      cxSession.clear();
      location.replace(redirectTo);
      return null;
    }
    // A network blip or a 500 is not a reason to throw someone out of their
    // session — fall back to the cached profile and let the screen render.
    return cxSession.customer;
  }
}

function cxRedirectIfSignedIn(to = 'dashboard.html') {
  if (cxSession.token) location.replace(to);
}

/* --------------------------------------------------------------- icons --- */
const CX_ICONS = {
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.5v-.8a7.2 7.2 0 0 1 14.4 0v.8"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 6 9 7 9-7"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  phone: '<path d="M7 2.5h10a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V4A1.5 1.5 0 0 1 7 2.5Z"/><path d="M10.5 18.5h3"/>',
  cake: '<path d="M4 20.5h16v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Z"/><path d="M12 12.5V9"/><path d="M12 6.5V5"/><path d="M4 16.5c1.6 0 1.6 1.2 3.2 1.2S8.8 16.5 10.4 16.5s1.6 1.2 3.2 1.2 1.6-1.2 3.2-1.2"/>',
  key: '<circle cx="8" cy="14" r="4.5"/><path d="m11.2 10.8 8-8"/><path d="m16.5 5.5 2.5 2.5"/><path d="m14 8 2.5 2.5"/>',
  check: '<circle cx="12" cy="12" r="9.2"/><path d="m8 12.3 2.8 2.8L16.2 9.7"/>',
  eye: '<path d="M1.5 12s4-7.5 10.5-7.5S22.5 12 22.5 12s-4 7.5-10.5 7.5S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.6 6.2A9.7 9.7 0 0 1 12 6c6.5 0 10.5 6 10.5 6a17 17 0 0 1-3.3 3.8M6.4 8.1A17 17 0 0 0 1.5 12S5.5 18 12 18a9.6 9.6 0 0 0 3.8-.8"/><path d="m2 2 20 20"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  plane: '<path d="M10.2 3.2a1.6 1.6 0 0 1 3.1 0L14.6 9l6.6 3a1 1 0 0 1 0 1.8L14.6 16l-1.3 5.2a1 1 0 0 1-1.9 0L10.1 16l-6.6-2.2a1 1 0 0 1 0-1.8L10.1 9Z"/>',
  hotel: '<path d="M4 21V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16"/><path d="M2 21h20"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/>',
  ship: '<path d="M3 17.5 5 11h14l2 6.5"/><path d="M3.5 17.5c1.8 0 1.8 1.5 3.6 1.5s1.8-1.5 3.6-1.5 1.8 1.5 3.6 1.5 1.8-1.5 3.6-1.5"/><path d="M8 11V6.5h8V11M12 3v3.5"/>',
  bag: '<rect x="2.5" y="7" width="19" height="13" rx="2.5"/><path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.4-3.1 8.2-7.5 9.5-4.4-1.3-7.5-5.1-7.5-9.5V6Z"/>',
  users: '<path d="M15.5 20v-1.5a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.5a4 4 0 0 0-3-3.85"/><path d="M15.5 4.15a4 4 0 0 1 0 7.7"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>',
  pin: '<path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
};
const cxIco = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${CX_ICONS[name] || ''}</svg>`;

const CX_SERVICES = [
  ['plane', 'Flights'], ['hotel', 'Hotels'], ['ship', 'Cruises'],
  ['bag', 'Holidays'], ['globe', 'Visa &amp; More'],
];

/* --------------------------------------------------------------- shell --- */
/* The art panel, built once. Each screen supplies only the card body — the
   same trick jp-login.js uses for the internal portals, which is what makes
   login -> forgot -> reset feel like one flow rather than four pages. */
/* `heading` is the first line and `headingAccent` the violet second line. Both
   are supplied by the caller — an earlier version hardcoded "starts here." as
   the second line, which read correctly under "Your next journey" on the login
   and became "Travel made simple / starts here." on the register screen. */
function cxAuthShell(cardHtml, { heading, headingAccent, tagline } = {}) {
  return `
<div class="cx-art">
  <a class="cx-brand" href="../index.html">
    <img src="../assets/images/jackpots-logo-full.png" alt="JackPots World Tours &amp; Travels">
  </a>

  <div class="cx-art-copy">
    <h1>${heading || 'Your next journey'}<span>${headingAccent || 'starts here.'}</span></h1>
    <div class="cx-rule"></div>
    <p>${tagline || 'Book flights, hotels, cruises and holidays &mdash; and keep every trip, traveller and document in one place.'}</p>
    <div class="cx-services">
      ${CX_SERVICES.map(([i, l]) => `<span class="cx-service">${cxIco(i)}${l}</span>`).join('')}
    </div>
  </div>

  <p class="cx-trust">
    <span>${cxIco('globe')}Worldwide Destinations</span>
    <span>${cxIco('shield')}Secure Booking</span>
    <span>${cxIco('users')}Trusted by Travellers</span>
  </p>
</div>

<div class="cx-side">
  <div class="cx-side-inner">
    <div class="cx-card">
      <div class="cx-card-brand">
        <img src="../assets/images/jackpots-logo-full.png" alt="JackPots World Tours &amp; Travels">
      </div>
      ${cardHtml}
    </div>
  </div>
</div>`;
}

function cxHead(icon, title, subtitle, { subId = '', done = false } = {}) {
  return `
    <div class="cx-avatar${done ? ' is-done' : ''}">${cxIco(icon)}</div>
    <h1 class="cx-title">${title}</h1>
    <p class="cx-sub"${subId ? ` id="${subId}"` : ''}>${subtitle}</p>
    <div class="cx-div"><i></i></div>`;
}

/* A labelled input with a leading icon. `extra` carries type/autocomplete/etc. */
function cxField(id, label, icon, extra = '', { hint = '', eye = false } = {}) {
  return `
    <div class="cx-field${eye ? ' cx-has-eye' : ''}" data-field="${id}">
      <label for="${id}">${label}</label>
      <div class="cx-input">
        ${cxIco(icon)}
        <input id="${id}" ${extra}>
        ${eye ? `<button type="button" class="cx-eye" data-cx-eye="${id}" aria-label="Show password">${cxIco('eye')}</button>` : ''}
      </div>
      ${hint ? `<p class="cx-hint">${hint}</p>` : ''}
      <p class="cx-err" data-err="${id}"></p>
    </div>`;
}

/* The OTP pane. Identical on login and signup, so it is written once. */
function cxOtpStep(ids) {
  return `
    <div class="cx-step" id="${ids.step2}">
      ${cxHead('lock', "Verify it's you", 'Enter the 6-digit code we sent you.', { subId: ids.otpSub })}
      <div class="cx-field">
        <label for="${ids.otp}">One-Time Code</label>
        <div class="cx-input cx-bare">
          <input id="${ids.otp}" type="text" inputmode="numeric" autocomplete="one-time-code"
                 maxlength="6" placeholder="000000">
        </div>
        <p class="cx-err" data-err="${ids.otp}"></p>
      </div>
      <button type="button" class="cx-btn" id="${ids.verify}">Verify &amp; Continue ${cxIco('arrow')}</button>
      <div class="cx-msg" id="${ids.otpMsg}"></div>
      <div id="${ids.devBox}"></div>
      <button type="button" class="cx-btn cx-btn-ghost" id="${ids.resend}">Resend Code</button>
      <button type="button" class="cx-btn cx-btn-ghost" id="${ids.back}">&larr; Back</button>
    </div>`;
}

/* ----------------------------------------------------------- behaviour --- */
function cxBindEyes(root) {
  (root || document).querySelectorAll('[data-cx-eye]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.cxEye);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.innerHTML = cxIco(show ? 'eyeOff' : 'eye');
      input.focus();
    });
  });
}

function cxStep(stepId) {
  document.querySelectorAll('.cx-step').forEach(s => s.classList.remove('is-active'));
  document.getElementById(stepId)?.classList.add('is-active');
  document.querySelectorAll('.cx-dot').forEach(d => {
    d.classList.toggle('is-active', Number(d.dataset.dot) <= Number(
      document.getElementById(stepId)?.dataset.stepNo || 1));
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cxMsg(id, text, kind = 'is-error') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = `cx-msg ${text ? kind : ''}`;
}

/* Per-field error, cleared on the next edit of that field. */
function cxFieldError(inputId, text) {
  const wrap = document.querySelector(`[data-field="${inputId}"]`);
  const err = document.querySelector(`[data-err="${inputId}"]`);
  if (!wrap || !err) return;
  err.textContent = text || '';
  wrap.classList.toggle('is-invalid', Boolean(text));
}

function cxClearFieldErrors(root) {
  (root || document).querySelectorAll('.cx-field.is-invalid').forEach(f => {
    f.classList.remove('is-invalid');
    f.querySelector('.cx-err').textContent = '';
  });
}

function cxBindClearOnInput(root) {
  (root || document).querySelectorAll('.cx-field input').forEach(input => {
    input.addEventListener('input', () => cxFieldError(input.id, ''));
  });
}

/* Dev-mode OTP. The API returns `dev_otp` only when SMTP is unconfigured, so
   this box appears in development and simply never renders in production. */
function cxDevOtp(boxId, code) {
  const el = document.getElementById(boxId);
  if (!el) return;
  el.innerHTML = code
    ? `<div class="cx-devbox">Email is not configured on this server, so the code is shown here:<br><b>${code}</b></div>`
    : '';
}

/* Buttons that fire a request must not be clickable twice — a double-submitted
   signup is two accounts, or one account and a confusing duplicate error. */
function cxBusy(btn, busy, labelWhenBusy = 'Please wait…') {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = labelWhenBusy;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

/* Remember me — stores THE IDENTIFIER ONLY, never the password, never a token. */
function cxBindRemember(formId, inputId, boxId) {
  const form = document.getElementById(formId);
  const input = document.getElementById(inputId);
  const box = document.getElementById(boxId);
  if (!form || !input || !box) return;

  const saved = localStorage.getItem(CX_KEYS.remember);
  if (saved) { input.value = saved; box.checked = true; }

  form.addEventListener('submit', () => {
    const v = input.value.trim();
    if (box.checked && v) localStorage.setItem(CX_KEYS.remember, v);
    else localStorage.removeItem(CX_KEYS.remember);
  });
}

function cxInitials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase();
}

function cxFormatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
