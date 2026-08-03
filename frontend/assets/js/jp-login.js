'use strict';
/* ==========================================================================
   JACKPOTS — INTERNAL PORTAL AUTHENTICATION, one shell for every screen.
   ==========================================================================
   Fifteen screens render from this file:

     Merchant / Admin / Super Admin  ×  Login · Forgot · Reset · Done

   The shell — photograph, logo, welcome copy, service strip, feature row, card
   frame, support block and footer — is built once by jpAuthShell(). Each screen
   supplies only the CONTENTS of the card. That is what makes moving from Login
   to Forgot to Reset feel like one flow rather than four pages: it is literally
   one page with a different card body.

   THERE IS NO ARTWORK IN HERE ANY MORE.
   An earlier pass drew the travel scene as inline SVG. That was rejected: the
   design calls for a photographic collage, and vector cannot imitate one
   convincingly. The photograph is now a CSS background
   (`--jpl-bg` → assets/images/login-collage.jpg) and this file is markup only.

   AUTHENTICATION LIVES ELSEWHERE AND WAS NOT TOUCHED.
   partner-login.html's own script, assets/js/admin-auth.js and
   assets/js/super-admin-auth.js each still own their flow and their endpoint.

   THE CALLER OWNS THE ELEMENT IDS, AND THAT IS THE WHOLE TRICK.
   admin-auth.js binds `adminEmail` / `adminLoginForm` / `adminAuthStep2Sub`;
   super-admin-auth.js binds `saUsername` / `saLoginForm` / `saAuthStep2Sub` —
   different names for the same fields, both already shipped and working. So the
   builder takes an `ids` map and stamps whatever it is given, and neither auth
   module had to be renamed to share a layout. Both also drive `.auth-step` and
   `.auth-step-dot` by class, so that structure is reproduced exactly and the
   stepper is hidden in CSS rather than removed.
   ========================================================================== */

/* --------------------------------------------------------------- icons --- */
const JPL_ICONS = {
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.5v-.8a7.2 7.2 0 0 1 14.4 0v.8"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 6 9 7 9-7"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  key: '<circle cx="8" cy="14" r="4.5"/><path d="m11.2 10.8 8-8"/><path d="m16.5 5.5 2.5 2.5"/><path d="m14 8 2.5 2.5"/>',
  check: '<circle cx="12" cy="12" r="9.2"/><path d="m8 12.3 2.8 2.8L16.2 9.7"/>',
  eye: '<path d="M1.5 12s4-7.5 10.5-7.5S22.5 12 22.5 12s-4 7.5-10.5 7.5S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.6 6.2A9.7 9.7 0 0 1 12 6c6.5 0 10.5 6 10.5 6a17 17 0 0 1-3.3 3.8M6.4 8.1A17 17 0 0 0 1.5 12S5.5 18 12 18a9.6 9.6 0 0 0 3.8-.8"/><path d="m2 2 20 20"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  headset: '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2.5" y="13" width="4.5" height="6.5" rx="2"/><rect x="17" y="13" width="4.5" height="6.5" rx="2"/><path d="M19.2 19.5A3.5 3.5 0 0 1 15.8 22H13"/>',
  plane: '<path d="M10.2 3.2a1.6 1.6 0 0 1 3.1 0L14.6 9l6.6 3a1 1 0 0 1 0 1.8L14.6 16l-1.3 5.2a1 1 0 0 1-1.9 0L10.1 16l-6.6-2.2a1 1 0 0 1 0-1.8L10.1 9Z"/>',
  hotel: '<path d="M4 21V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16"/><path d="M2 21h20"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/>',
  ship: '<path d="M3 17.5 5 11h14l2 6.5"/><path d="M3.5 17.5c1.8 0 1.8 1.5 3.6 1.5s1.8-1.5 3.6-1.5 1.8 1.5 3.6 1.5 1.8-1.5 3.6-1.5"/><path d="M8 11V6.5h8V11M12 3v3.5"/>',
  bag: '<rect x="2.5" y="7" width="19" height="13" rx="2.5"/><path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.4-3.1 8.2-7.5 9.5-4.4-1.3-7.5-5.1-7.5-9.5V6Z"/>',
  users: '<path d="M15.5 20v-1.5a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.5a4 4 0 0 0-3-3.85"/><path d="M15.5 4.15a4 4 0 0 1 0 7.7"/>',
};
const jplIco = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${JPL_ICONS[name] || ''}</svg>`;

/* Five services, evenly distributed. "Buses" is deliberately absent and the row
   is flex with `flex:1 1 0` items, so there is no gap where it used to be. */
const JPL_SERVICES = [
  ['plane', 'Flights'], ['hotel', 'Hotels'], ['ship', 'Cruises'],
  ['bag', 'Holidays'], ['globe', 'Visa &amp; More'],
];

/* ------------------------------------------------------------- the shell ---
   `card` is the markup that goes inside the white card. Everything around it is
   fixed, which is the point. */
function jpAuthShell({ portalName, card, base = '', supportHref = null } = {}) {
  const support = supportHref || `${base}index.html#contact`;
  const year = new Date().getFullYear();

  return `
<div class="jpl-art">
  <img class="jpl-logo" src="${base}assets/images/jackpots-logo-full.png"
       alt="JackPots World Tours &amp; Travels">

  <div class="jpl-copy">
    <!-- The one line of left-panel copy that is portal-specific. "Welcome Back,
         Merchant Portal" over an Admin sign-in would simply be wrong. -->
    <h2 class="jpl-welcome">Welcome Back,<span>${portalName || 'Partner Portal'}</span></h2>
    <div class="jpl-rule"></div>
    <p class="jpl-tag">Professional B2B Travel Platform</p>
    <p class="jpl-tag-sub">All Travel Solutions. One Partner.</p>

    <div class="jpl-services">
      ${JPL_SERVICES.map(([ico, label]) =>
        `<span class="jpl-service">${jplIco(ico)}${label}</span>`).join('')}
    </div>
  </div>

  <p class="jpl-trust">
    <span>${jplIco('globe')}Global Reach</span><i></i>
    <span>${jplIco('shield')}Premium Experience</span><i></i>
    <span>${jplIco('users')}Trusted by Travel Professionals</span>
  </p>
</div>

<div class="jpl-side">
  <div class="jpl-side-inner">
    <div class="jpl-card">
      ${card}

      <div class="jpl-or">OR</div>

      <div class="jpl-support">
        <span class="jpl-support-ico">${jplIco('headset')}</span>
        <span class="jpl-support-txt">
          <b>Need Help?</b>
          <span>We're here to assist you</span>
        </span>
        <a href="${support}">Support Center ${jplIco('chevron')}</a>
      </div>
    </div>

    <p class="jpl-foot">© ${year} JackPots World Tours &amp; Travels. All rights reserved.</p>
  </div>
</div>`;
}

/* A card head — icon, title, subtitle, gold diamond rule. Every screen opens
   with exactly this, which is most of why they feel like one flow. */
function jplHead(icon, title, subtitle, { subId = '', done = false } = {}) {
  return `
    <div class="jpl-avatar${done ? ' is-done' : ''}">${jplIco(icon)}</div>
    <h1 class="jpl-title">${title}</h1>
    <p class="jpl-sub"${subId ? ` id="${subId}"` : ''}>${subtitle}</p>
    <div class="jpl-div"><i></i></div>`;
}

/* ------------------------------------------------------------- login card --
   Two panes, because password → code is one flow with two steps. The
   `.auth-step` / `.auth-step-dot` structure is what admin-auth.js and
   super-admin-auth.js already drive. */
function jplLoginCard({
  title, subtitle, ids,
  base = '',
  emailLabel = 'Email / Username',
  emailPlaceholder = 'Enter your email or username',
  submitLabel = 'Login',
} = {}) {
  return `
      <div class="auth-stepper" id="${ids.stepper}">
        <div class="auth-step-dot active" data-step-dot="1">1</div>
        <div class="auth-step-line"></div>
        <div class="auth-step-dot" data-step-dot="2">2</div>
      </div>

      <div class="auth-step active" id="${ids.step1}">
        ${jplHead('user', title, subtitle)}
        <form id="${ids.form}" novalidate>
          <div class="jpl-field">
            <label for="${ids.email}">${emailLabel}</label>
            <div class="jpl-input">
              ${jplIco('mail')}
              <input id="${ids.email}" type="email" autocomplete="username"
                     placeholder="${emailPlaceholder}" spellcheck="false">
            </div>
          </div>

          <div class="jpl-field jpl-has-eye">
            <label for="${ids.password}">Password</label>
            <div class="jpl-input">
              ${jplIco('lock')}
              <input id="${ids.password}" type="password" autocomplete="current-password"
                     placeholder="Enter your password">
              <button type="button" class="jpl-eye" data-jpl-eye="${ids.password}"
                      aria-label="Show password">${jplIco('eye')}</button>
            </div>
          </div>

          <div class="jpl-row">
            <label class="jpl-remember">
              <input type="checkbox" id="${ids.remember}"> Remember me
            </label>
            <a class="jpl-forgot" href="${base}forgot-password.html?portal=${ids.portalKey || ''}">Forgot Password?</a>
          </div>

          <button type="submit" class="jpl-btn">${submitLabel} ${jplIco('arrow')}</button>
          <div class="msg" id="${ids.msg}"></div>
        </form>
      </div>

      <div class="auth-step" id="${ids.step2}">
        ${jplHead('lock', "Verify it's you", 'Enter the 6-digit code sent to your email.',
                  { subId: ids.otpSub })}
        <div class="jpl-field jpl-otp">
          <label for="${ids.otp}">One-Time Code</label>
          <div class="jpl-input">
            <input id="${ids.otp}" type="text" inputmode="numeric" autocomplete="one-time-code"
                   maxlength="6" placeholder="••••••">
          </div>
        </div>
        <button type="button" class="jpl-btn" id="${ids.verify}">Verify OTP ${jplIco('arrow')}</button>
        <div class="msg" id="${ids.otpMsg}"></div>
        <button type="button" class="jpl-btn jpl-btn-ghost" id="${ids.resend}">Resend OTP</button>
        <button type="button" class="jpl-btn jpl-btn-ghost" id="${ids.back}">← Back to Login</button>
      </div>`;
}

/* ------------------------------------------------- forgot / reset / done ---
   THERE IS NO OTP STEP IN THIS FLOW, and that is the backend's design, not an
   omission. /api/auth/forgot-password takes an email and mails a tokenised
   LINK; /api/auth/reset-password takes {token, new_password}. There is no
   endpoint that would verify a code here, so a code screen would be a form with
   nothing to submit to. Adding one means changing authentication. */
function jplForgotCard(ids) {
  return `
      <div class="auth-step active" id="${ids.step1}">
        ${jplHead('key', 'Forgot Password',
                  'Enter your registered email to reset your password.')}
        <form id="${ids.form}" novalidate>
          <div class="jpl-field">
            <label for="${ids.email}">Email Address</label>
            <div class="jpl-input">
              ${jplIco('mail')}
              <input id="${ids.email}" type="email" autocomplete="username"
                     placeholder="Enter your registered email" spellcheck="false">
            </div>
          </div>
          <button type="submit" class="jpl-btn">Send Reset Link ${jplIco('arrow')}</button>
          <div class="msg" id="${ids.msg}"></div>
          <a class="jpl-btn jpl-btn-ghost" href="${ids.loginHref}">← Back to Login</a>
        </form>
      </div>

      <div class="auth-step" id="${ids.step2}">
        ${jplHead('check', 'Check Your Email',
                  'If that address is registered we have sent a reset link to it.',
                  { subId: ids.sentSub, done: true })}
        <div class="msg" id="${ids.sentMsg}"></div>
        <a class="jpl-btn" href="${ids.loginHref}">Go to Login ${jplIco('arrow')}</a>
      </div>`;
}

function jplResetCard(ids) {
  return `
      <div class="auth-step active" id="${ids.step1}">
        ${jplHead('lock', 'Reset Password',
                  'Choose a new password for your account.', { subId: ids.sub })}
        <form id="${ids.form}" novalidate>
          <div class="jpl-field jpl-has-eye">
            <label for="${ids.password}">New Password</label>
            <div class="jpl-input">
              ${jplIco('lock')}
              <input id="${ids.password}" type="password" autocomplete="new-password"
                     placeholder="Enter a new password">
              <button type="button" class="jpl-eye" data-jpl-eye="${ids.password}"
                      aria-label="Show password">${jplIco('eye')}</button>
            </div>
          </div>
          <div class="jpl-field jpl-has-eye">
            <label for="${ids.confirm}">Confirm Password</label>
            <div class="jpl-input">
              ${jplIco('lock')}
              <input id="${ids.confirm}" type="password" autocomplete="new-password"
                     placeholder="Re-enter the new password">
              <button type="button" class="jpl-eye" data-jpl-eye="${ids.confirm}"
                      aria-label="Show password">${jplIco('eye')}</button>
            </div>
          </div>
          <button type="submit" class="jpl-btn" id="${ids.submit}">Update Password ${jplIco('arrow')}</button>
          <div class="msg" id="${ids.msg}"></div>
          <a class="jpl-btn jpl-btn-ghost" href="${ids.loginHref}">← Back to Login</a>
        </form>
      </div>

      <div class="auth-step" id="${ids.step2}">
        ${jplHead('check', 'Password Updated Successfully',
                  'Your password has been changed successfully. You can now sign in using your new password.',
                  { done: true })}
        <a class="jpl-btn" href="${ids.loginHref}">Go to Login ${jplIco('arrow')}</a>
      </div>`;
}

/* ------------------------------------------------------------- behaviour --- */

/* One error reader for every authentication screen.
   429 is handled FIRST and by STATUS rather than by body: /api/auth/login,
   /forgot-password and /reset-password are all rate limited per IP, and the
   limiter's payload is not the {detail: "..."} shape the rest of the API uses.
   Without this it falls through to the generic fallback and tells someone to
   check their details when their details are fine and the only cure is waiting
   — which a shared office IP hits on ordinary use, not just under test. */
function jpAuthError(err, fallback) {
  if (err?.response?.status === 429) {
    return 'Too many attempts from this network. Wait a minute and try again.';
  }
  const d = err?.response?.data?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && d[0]?.msg) return d[0].msg;
  return fallback;
}

/* Password show/hide for every field the builder stamped. */
function jpLoginBindEyes(root) {
  (root || document).querySelectorAll('[data-jpl-eye]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.jplEye);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.innerHTML = jplIco(show ? 'eyeOff' : 'eye');
      input.focus();
    });
  });
}

/* REMEMBER ME, without touching a line of authentication.
   The three auth modules know nothing about this checkbox and do not need to:
   remembering is a fact about what was typed into a field, not about who is
   signed in. Stores THE ADDRESS ONLY, under a per-portal key — never the
   password, never a token.

   The submit listener is added at mount so it runs BEFORE the auth module's
   (registered when that file loads, which is later). Both still fire: one
   listener calling preventDefault does not cancel the others. */
function jpLoginBindRemember({ form, email, remember }, storageKey) {
  const formEl = document.getElementById(form);
  const emailEl = document.getElementById(email);
  const boxEl = document.getElementById(remember);
  if (!formEl || !emailEl || !boxEl || !storageKey) return;

  const saved = localStorage.getItem(storageKey);
  if (saved) { emailEl.value = saved; boxEl.checked = true; }

  formEl.addEventListener('submit', () => {
    const value = emailEl.value.trim();
    if (boxEl.checked && value) localStorage.setItem(storageKey, value);
    else localStorage.removeItem(storageKey);
  });
}

/* Move between the panes of a card, using the same class contract the Admin and
   Super Admin auth modules already use — so one CSS rule switches every screen
   in the product. */
function jpAuthStep(shellId, stepId) {
  document.querySelectorAll(`#${shellId} .auth-step`).forEach(s => s.classList.remove('active'));
  document.getElementById(stepId)?.classList.add('active');
}

/* Render a login into an existing shell element and wire what the builder owns.
   Called by admin/ and super-admin/ BEFORE their auth module loads, so every id
   that module binds already exists in the document. */
function jpLoginMount(shellId, config) {
  const shell = document.getElementById(shellId);
  if (!shell) return null;
  shell.classList.add('jpl');
  shell.innerHTML = jpAuthShell({
    portalName: config.portalName,
    base: config.base,
    supportHref: config.supportHref,
    card: jplLoginCard(config),
  });
  jpLoginBindEyes(shell);
  if (config.rememberKey) jpLoginBindRemember(config.ids, config.rememberKey);
  return shell;
}
