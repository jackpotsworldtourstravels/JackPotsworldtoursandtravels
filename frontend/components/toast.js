'use strict';
/* ==========================================================================
   toast.js — lightweight confirmation/error banner. Extracted from
   assets/js/app.js (used there since the beginning), now available to
   every portal that loads this file. Styled entirely with each portal's
   own existing CSS variables (--navy, --coral-dark, --shadow-lg), all of
   which are already defined in main.css/admin.css/partner-portal.css/
   super-admin.css, so it renders correctly wherever it's loaded without
   needing its own stylesheet.
   ========================================================================== */
function showToast(text, isError) {
  let toast = document.getElementById('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.style.cssText = 'position:fixed; bottom:26px; left:50%; transform:translateX(-50%) translateY(20px); z-index:400; background:var(--navy); color:#fff; padding:14px 26px; border-radius:100px; box-shadow:var(--shadow-lg); font-size:14px; font-weight:600; opacity:0; transition:opacity .3s ease, transform .3s ease; pointer-events:none; max-width:90vw; text-align:center;';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.style.background = isError ? 'var(--coral-dark)' : 'var(--navy)';
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 3200);
}
