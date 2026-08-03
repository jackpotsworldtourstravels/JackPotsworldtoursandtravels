'use strict';
/* ==========================================================================
   JACKPOTS — INTERNAL PORTAL LOGIN, one markup builder for all three.
   ==========================================================================
   Merchant, Admin and Super Admin now render the SAME sign-in from here. Only
   three things differ per portal: the title, the subtitle, and the `portal`
   value the page already sends to /api/auth/login. This file writes no network
   call and holds no credential — it returns markup and wires a password
   show/hide. Authentication stays where it already lived: partner-login.html's
   own script, assets/js/admin-auth.js, assets/js/super-admin-auth.js.

   WHY A BUILDER AND NOT THREE COPIES OF THE HTML
   The brief is "do not create different login layouts for each role". Three
   pasted copies satisfy that for exactly as long as it takes someone to fix a
   padding bug in one of them. One function is the only version of this that
   stays true.

   THE CALLER OWNS THE ELEMENT IDS, AND THAT IS THE WHOLE TRICK.
   admin-auth.js binds `adminEmail` / `adminLoginForm` / `adminAuthStep2Sub`;
   super-admin-auth.js binds `saUsername` / `saLoginForm` / `saAuthStep2Sub` —
   different names for the same fields, both already shipped and working. So the
   builder takes an `ids` map and stamps whatever it is given. Nothing in either
   auth module had to change, which is what makes this a UI change and not an
   authentication one.

   Both of those modules also drive `.auth-step` / `.auth-step-dot` by class, so
   that structure is reproduced exactly and the stepper is hidden in CSS rather
   than removed.
   ========================================================================== */

/* --------------------------------------------------------------- icons --- */
const JPL_ICONS = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21v-1a7.5 7.5 0 0 1 15 0v1"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 6 9 7 9-7"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
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
const jplIco = (name, cls = '') =>
  `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${JPL_ICONS[name] || ''}</svg>`;

/* ------------------------------------------------------- the travel scene
   ONE cinematic composition, not a row of logos: a coastal evening with far
   mountains, a skyline of world landmarks, an ocean with a cruise liner, and a
   resort with palms in front. Depth is what blends them — each layer sits
   behind or in front of the water and shares the same dusk palette.

   IT IS VECTOR BECAUSE THERE IS NO PHOTOGRAPHY IN THIS REPO. assets/images/
   holds a logo and two favicons; the hotel photography added in Phase 7 is
   remote and Commons-hosted, and a login screen that waits on a third-party
   image is a login screen that can render blank. Vector also stays sharp on any
   display and adds no request. */
function jplScene() {
  return `
<svg class="jpl-scene" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="jplSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#071B33"/><stop offset="34%" stop-color="#123B63"/>
      <stop offset="63%" stop-color="#2E6285"/><stop offset="83%" stop-color="#7C7E86"/>
      <stop offset="100%" stop-color="#C98F4C"/>
    </linearGradient>
    <radialGradient id="jplSun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#FFD79A" stop-opacity="0.95"/>
      <stop offset="42%" stop-color="#F0A94E" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#E8A317" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="jplSea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#9E7B4E"/><stop offset="12%" stop-color="#3E5F79"/>
      <stop offset="52%" stop-color="#123B5C"/><stop offset="100%" stop-color="#08203A"/>
    </linearGradient>
    <linearGradient id="jplMtn" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4A6C8C"/><stop offset="100%" stop-color="#2B4A68"/>
    </linearGradient>
    <linearGradient id="jplSand" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#123049"/><stop offset="100%" stop-color="#050F1E"/>
    </linearGradient>
    <linearGradient id="jplGlass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3C6485"/><stop offset="100%" stop-color="#1B3A57"/>
    </linearGradient>
    <filter id="jplSoft" x="-6%" y="-6%" width="112%" height="112%"><feGaussianBlur stdDeviation="4.5"/></filter>
    <filter id="jplSofter" x="-6%" y="-6%" width="112%" height="112%"><feGaussianBlur stdDeviation="8"/></filter>
  </defs>

  <rect width="1600" height="1000" fill="url(#jplSky)"/>
  <ellipse cx="1180" cy="600" rx="380" ry="230" fill="url(#jplSun)"/>
  <circle cx="1180" cy="594" r="44" fill="#FFE3B0" opacity="0.78"/>
  <g fill="#FFFFFF" opacity="0.28">
    <circle cx="250" cy="130" r="1.9"/><circle cx="430" cy="86" r="1.5"/><circle cx="700" cy="150" r="1.6"/>
    <circle cx="980" cy="98" r="1.4"/><circle cx="1330" cy="168" r="1.7"/><circle cx="1500" cy="104" r="1.5"/>
  </g>

  <!-- far mountains -->
  <g filter="url(#jplSofter)" opacity="0.66">
    <path d="M0 640 L150 470 L250 545 L390 392 L520 540 L640 452 L760 620 Z" fill="url(#jplMtn)"/>
    <path d="M390 392 L432 430 L470 404 L520 452 L455 486 Z" fill="#DCE8F2" opacity="0.52"/>
  </g>

  <!-- SKYLINE OF LANDMARKS, left to right: a sail-shaped hotel, a supertall
       spire, a lattice tower, and a domed marble landmark. Silhouettes at
       distance, so they read as "the world" rather than as any one city. -->
  <g filter="url(#jplSoft)" opacity="0.92">
    <!-- sail hotel -->
    <path d="M120 660 L120 470 Q206 500 232 660 Z" fill="#1D3C58"/>
    <path d="M120 470 Q206 500 232 660" fill="none" stroke="#4E7DA2" stroke-width="2.5" opacity="0.7"/>
    <!-- supertall spire -->
    <path d="M300 660 L306 470 L312 430 L316 356 L320 430 L326 470 L332 660 Z" fill="#20415F"/>
    <!-- lattice tower -->
    <path d="M430 660 L458 500 L466 452 L474 500 L502 660 Z" fill="none" stroke="#22445F" stroke-width="9"/>
    <path d="M444 590 L488 590 M436 630 L496 630" stroke="#22445F" stroke-width="6"/>
    <path d="M466 452 L466 424" stroke="#22445F" stroke-width="4"/>
    <!-- domed landmark -->
    <g>
      <rect x="596" y="628" width="168" height="32" fill="#22445F"/>
      <path d="M640 628 L640 566 Q680 512 720 566 L720 628 Z" fill="#274B68"/>
      <path d="M680 500 L684 522 L676 522 Z" fill="#274B68"/>
      <rect x="606" y="556" width="7" height="72" rx="3.5" fill="#22445F"/>
      <rect x="747" y="556" width="7" height="72" rx="3.5" fill="#22445F"/>
    </g>
    <!-- blocks + bridge -->
    <rect x="820" y="574" width="52" height="86" fill="#1D3C58"/>
    <rect x="872" y="602" width="30" height="58" fill="#1A3752"/>
    <rect x="1100" y="590" width="46" height="70" fill="#1D3C58"/>
    <rect x="1152" y="558" width="34" height="102" fill="#20415F"/>
    <path d="M1252 660 L1252 560 M1420 660 L1420 560" stroke="#20415F" stroke-width="7" fill="none"/>
    <path d="M1252 566 Q1336 646 1420 566" stroke="#2B5478" stroke-width="4.5" fill="none"/>
    <path d="M1240 630 L1600 630" stroke="#20415F" stroke-width="6"/>
    <g fill="#FFD79A" opacity="0.52">
      <rect x="828" y="586" width="5" height="7"/><rect x="840" y="600" width="5" height="7"/>
      <rect x="1108" y="602" width="5" height="7"/><rect x="1160" y="574" width="5" height="7"/>
      <rect x="1160" y="596" width="5" height="7"/><rect x="306" y="520" width="5" height="7"/>
      <rect x="316" y="560" width="5" height="7"/><rect x="150" y="560" width="5" height="7"/>
    </g>
  </g>

  <!-- ocean -->
  <rect x="0" y="655" width="1600" height="200" fill="url(#jplSea)"/>
  <g opacity="0.42" fill="#FFD79A">
    <rect x="1120" y="668" width="122" height="3" rx="1.5"/><rect x="1136" y="684" width="92" height="3" rx="1.5"/>
    <rect x="1110" y="700" width="146" height="2.5" rx="1.25"/><rect x="1144" y="716" width="76" height="2.5" rx="1.25"/>
  </g>
  <g opacity="0.14" fill="#CFE2F0">
    <rect x="120" y="690" width="150" height="2.5" rx="1.25"/><rect x="330" y="716" width="210" height="2.5" rx="1.25"/>
    <rect x="60" y="748" width="240" height="2" rx="1"/><rect x="700" y="756" width="180" height="2" rx="1"/>
  </g>

  <!-- cruise liner -->
  <g opacity="0.95">
    <path d="M470 700 L742 700 L716 734 L496 734 Z" fill="#0E2B45"/>
    <rect x="512" y="672" width="196" height="28" rx="4" fill="#16385A"/>
    <rect x="536" y="652" width="148" height="20" rx="3" fill="#1B4066"/>
    <rect x="566" y="636" width="92" height="16" rx="3" fill="#1F4874"/>
    <rect x="596" y="620" width="26" height="16" rx="3" fill="#264F7C"/>
    <g fill="#FFD79A" opacity="0.70">
      <rect x="522" y="681" width="7" height="5"/><rect x="538" y="681" width="7" height="5"/>
      <rect x="554" y="681" width="7" height="5"/><rect x="570" y="681" width="7" height="5"/>
      <rect x="586" y="681" width="7" height="5"/><rect x="602" y="681" width="7" height="5"/>
      <rect x="618" y="681" width="7" height="5"/><rect x="634" y="681" width="7" height="5"/>
      <rect x="650" y="681" width="7" height="5"/><rect x="666" y="681" width="7" height="5"/>
      <rect x="546" y="659" width="7" height="5"/><rect x="576" y="659" width="7" height="5"/>
      <rect x="606" y="659" width="7" height="5"/><rect x="636" y="659" width="7" height="5"/>
    </g>
  </g>

  <!-- CLIFFSIDE VILLAGE — white cubes with blue domes, stepped down to the
       water on the right. The one warm-lit cluster in the scene. -->
  <g opacity="0.95">
    <path d="M980 1000 Q1010 880 1090 830 Q1180 780 1300 792 L1300 1000 Z" fill="#0B2136"/>
    ${[
      [1020, 880], [1068, 856], [1116, 838], [1164, 828], [1212, 836], [1258, 852],
      [1044, 924], [1092, 902], [1140, 884], [1188, 878], [1236, 890],
      [1068, 964], [1116, 946], [1164, 936], [1212, 944],
    ].map(([x, y], i) => `
      <g>
        <rect x="${x}" y="${y}" width="40" height="34" rx="3" fill="#E8EDF2" opacity="0.88"/>
        ${i % 3 === 0
          ? `<path d="M${x + 6} ${y} Q${x + 20} ${y - 17} ${x + 34} ${y} Z" fill="#1E6A9E" opacity="0.92"/>`
          : ''}
        <rect x="${x + 7}" y="${y + 11}" width="8" height="10" rx="1.5" fill="#FFCF8A" opacity="0.85"/>
        <rect x="${x + 25}" y="${y + 11}" width="8" height="10" rx="1.5" fill="#FFCF8A" opacity="0.6"/>
      </g>`).join('')}
  </g>

  <!-- foreground shore, resort, pool, palms -->
  <path d="M0 830 Q300 792 640 812 Q1020 834 1600 800 L1600 1000 L0 1000 Z" fill="url(#jplSand)"/>
  <g>
    <rect x="96" y="700" width="150" height="152" rx="7" fill="#0F2E4A"/>
    <rect x="246" y="742" width="104" height="110" rx="6" fill="#0C2740"/>
    <rect x="120" y="676" width="102" height="26" rx="6" fill="#143755"/>
    <rect x="96" y="700" width="150" height="152" rx="7" fill="url(#jplGlass)" opacity="0.32"/>
    <g fill="#FFD79A" opacity="0.60">
      <rect x="112" y="716" width="15" height="10" rx="1.5"/><rect x="137" y="716" width="15" height="10" rx="1.5"/>
      <rect x="187" y="716" width="15" height="10" rx="1.5"/><rect x="212" y="716" width="15" height="10" rx="1.5"/>
      <rect x="112" y="744" width="15" height="10" rx="1.5"/><rect x="162" y="744" width="15" height="10" rx="1.5"/>
      <rect x="212" y="744" width="15" height="10" rx="1.5"/><rect x="137" y="772" width="15" height="10" rx="1.5"/>
      <rect x="187" y="772" width="15" height="10" rx="1.5"/><rect x="112" y="800" width="15" height="10" rx="1.5"/>
      <rect x="262" y="762" width="13" height="9" rx="1.5"/><rect x="300" y="762" width="13" height="9" rx="1.5"/>
      <rect x="262" y="790" width="13" height="9" rx="1.5"/><rect x="320" y="790" width="13" height="9" rx="1.5"/>
    </g>
    <rect x="366" y="822" width="152" height="26" rx="12" fill="#1D5B7E" opacity="0.70"/>
    <rect x="378" y="828" width="128" height="4" rx="2" fill="#7FC4E2" opacity="0.40"/>
    <g fill="#0A2138" opacity="0.82">
      <rect x="544" y="836" width="34" height="7" rx="3"/><rect x="590" y="836" width="34" height="7" rx="3"/>
    </g>
    <path d="M640 838 L640 800 M614 802 Q640 780 666 802 Z" stroke="#0A2138" stroke-width="4" fill="#12405E" opacity="0.85"/>
  </g>
  <g fill="#04121F">
    <path d="M1372 1000 Q1358 900 1338 830 L1354 826 Q1376 902 1390 1000 Z"/>
    <path d="M1346 828 Q1276 780 1218 792 Q1284 762 1352 812 Z"/>
    <path d="M1346 826 Q1296 748 1230 720 Q1310 730 1358 810 Z"/>
    <path d="M1348 824 Q1372 742 1440 706 Q1394 776 1362 818 Z"/>
    <path d="M1350 828 Q1424 786 1494 796 Q1420 786 1358 840 Z"/>
    <path d="M1520 1000 Q1512 912 1498 848 L1512 845 Q1530 914 1538 1000 Z"/>
    <path d="M1506 846 Q1452 806 1404 812 Q1458 790 1512 834 Z"/>
    <path d="M1508 844 Q1528 782 1584 752 Q1546 812 1520 838 Z"/>
    <path d="M1510 848 Q1570 818 1600 826 Q1552 826 1518 862 Z"/>
  </g>
</svg>`;
}

/* --------------------------------------------------------------- builder ---
   `ids` carries the element names the CALLING portal's auth module already
   binds — see the header. `base` is the path prefix to the frontend root ('' on
   a root-level page, '../' inside admin/ or super-admin/). */
function jpLoginShell({
  title,
  subtitle,
  portalName,
  ids,
  base = '',
  emailLabel = 'Email / Username',
  emailPlaceholder = 'Enter your email or username',
  emailType = 'email',
  submitLabel = 'Login',
  supportHref = null,
  showRemember = true,
} = {}) {
  const support = supportHref || `${base}index.html#contact`;
  const year = new Date().getFullYear();

  return `
<div class="jpl-art">
  ${jplScene()}
  <img class="jpl-logo" src="${base}assets/images/jackpots-logo-full.png"
       alt="JackPots World Tours &amp; Travels">

  <div class="jpl-copy">
    <!-- The one line of left-panel copy that is portal-specific. "Welcome Back,
         Merchant Portal" over an Admin sign-in would be simply wrong, and the
         brief's "only the portal-specific text changes" covers it. -->
    <h2 class="jpl-welcome">Welcome Back,<span>${portalName || 'Partner Portal'}</span></h2>
    <div class="jpl-rule"></div>
    <p class="jpl-tag">Professional B2B Travel Platform</p>
    <p class="jpl-tag-sub">All Travel Solutions. One Partner.</p>

    <div class="jpl-services">
      <span class="jpl-service">${jplIco('plane')}Flights</span>
      <span class="jpl-service">${jplIco('hotel')}Hotels</span>
      <span class="jpl-service">${jplIco('ship')}Cruises</span>
      <span class="jpl-service">${jplIco('bag')}Holidays</span>
      <span class="jpl-service">${jplIco('globe')}Visa &amp; More</span>
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

      <!-- Kept because admin-auth.js / super-admin-auth.js drive these dots.
           Hidden in CSS rather than deleted — removing it would mean editing
           authentication JS. -->
      <div class="auth-stepper" id="${ids.stepper}">
        <div class="auth-step-dot active" data-step-dot="1">1</div>
        <div class="auth-step-line"></div>
        <div class="auth-step-dot" data-step-dot="2">2</div>
      </div>

      <!-- ---------------------------------------- step 1: credentials ---- -->
      <div class="auth-step active" id="${ids.step1}">
        <div class="jpl-avatar">${jplIco('user')}</div>
        <h1 class="jpl-title">${title}</h1>
        <p class="jpl-sub">${subtitle}</p>
        <div class="jpl-div"><i></i></div>

        <form id="${ids.form}" novalidate>
          <div class="jpl-field">
            <label for="${ids.email}">${emailLabel}</label>
            <div class="jpl-input">
              ${jplIco('mail')}
              <input id="${ids.email}" type="${emailType}" autocomplete="username"
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
            ${showRemember ? `<label class="jpl-remember">
              <input type="checkbox" id="${ids.remember}"> Remember me
            </label>` : '<span></span>'}
            <a class="jpl-forgot" href="${base}forgot-password.html">Forgot Password?</a>
          </div>

          <button type="submit" class="jpl-btn">${submitLabel} ${jplIco('arrow')}</button>
          <div class="msg" id="${ids.msg}"></div>
        </form>
      </div>

      <!-- ------------------------------ step 2: the second factor -------- -->
      <div class="auth-step" id="${ids.step2}">
        <div class="jpl-avatar">${jplIco('lock')}</div>
        <h1 class="jpl-title">Verify it's you</h1>
        <p class="jpl-sub" id="${ids.otpSub}">Enter the 6-digit code sent to your email.</p>
        <div class="jpl-div"><i></i></div>

        <div class="jpl-field jpl-otp">
          <label for="${ids.otp}">One-Time Code</label>
          <div class="jpl-input">
            <input id="${ids.otp}" type="text" inputmode="numeric" autocomplete="one-time-code"
                   maxlength="6" placeholder="••••••">
          </div>
        </div>

        <button type="button" class="jpl-btn" id="${ids.verify}">Verify &amp; Continue ${jplIco('arrow')}</button>
        <div class="msg" id="${ids.otpMsg}"></div>
        <button type="button" class="jpl-btn jpl-btn-ghost" id="${ids.resend}">Resend code</button>
        <button type="button" class="jpl-btn jpl-btn-ghost" id="${ids.back}">← Use a different account</button>
      </div>

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

/* Password show/hide for every field the builder stamped. Delegated from the
   shell so it survives the markup being written after this script runs. */
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
   The three auth modules know nothing about this checkbox, and they do not need
   to: remembering is a convenience about what is typed into a field, not about
   who is signed in. This stores THE ADDRESS ONLY under a per-portal key —
   never the password, and never a token, which already lives in its own
   namespace with its own expiry.

   The submit listener is added at mount, so it runs BEFORE the auth module's
   (registered when that file loads, which is after). Both still fire: one
   listener calling preventDefault does not cancel the others on the same
   element. */
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

/* Render into an existing shell element and wire what the builder owns.
   Called by admin/ and super-admin/ BEFORE their auth module loads, so every id
   that module binds already exists in the document. */
function jpLoginMount(shellId, config) {
  const shell = document.getElementById(shellId);
  if (!shell) return null;
  shell.classList.add('jpl');
  shell.innerHTML = jpLoginShell(config);
  jpLoginBindEyes(shell);
  if (config.rememberKey) jpLoginBindRemember(config.ids, config.rememberKey);
  return shell;
}
