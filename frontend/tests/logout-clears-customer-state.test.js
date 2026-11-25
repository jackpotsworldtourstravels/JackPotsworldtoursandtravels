'use strict';
/* ===========================================================================
   Issue #10 — the profile-dropdown Logout must RESET customer-owned state, not
   just drop the tokens, and every logout entry point must route through the one
   shared boundary so none of them leaves a prior customer's state behind.

   THE DEFECT (reproduced live on the #10 worktree): profile-menu.js's dropdown
   Logout checks `AccountCenter.logout` and, finding it undefined, fell through
   to a token-only fallback. The real teardown — doAccountLogout() — was bound
   only to #profileLogoutBtn and never exposed, so signing out from the dropdown
   left the wishlist map + badge/hearts, the cached profile + account tabs, and
   the customer's support chat (conversation, unread badge, live socket) in place.

   THIS TARGET already carried its own newer #10 / #17 work: a wishlist-count
   badge driven by a `wishlist:change` event, an account-switch owner guard, and
   Wishlist.reset() wired into doAccountLogout. The surgical merge added the two
   pieces that were still missing here:
     1. `logout: doAccountLogout` on the public AccountCenter object, and
     2. chat teardown — LiveChat.reset() — wired into the shared boundary and the
        Account-Center-less fallback paths, WITHOUT disturbing the ChatOutbox.

   This test pins all of that. No DOM runner in this project — self-contained
   Node harness with a VM, same shape as the other frontend suites.

   run:  node --test frontend/tests/logout-clears-customer-state.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const ACCT = read('assets/js/account-center.js');
const APP = read('assets/js/app.js');
const PM = read('assets/js/profile-menu.js');
const LC = read('assets/js/live-chat.js');
const WL = read('assets/js/wishlist.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* Pull one `function <name>(...) { ... }` out of a source by brace-matching. */
function extractFn(src, sig, label) {
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${label}: ${sig} not found`); return null; }
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  failures.push(`${label}: ${sig} braces did not balance`);
  return null;
}

/* Strip comments so we assert about executable code, not explanatory prose. */
const stripComments = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* --- 1. BEHAVIOURAL: doAccountLogout() clears every customer-owned surface -- */
const logoutSrc = extractFn(ACCT, 'function doAccountLogout(', 'account-center.js');

function runLogout() {
  const calls = {
    clearCustomerAuth: 0, clearStoredAuth: 0, resetWishlist: 0, wishlistModuleReset: 0,
    chatReset: 0, closeAccountCenter: 0, renderAuthNav: 0, logoutPost: null,
  };
  const sandbox = {
    console, Map, Set, String, Boolean,
    API_BASE: '',
    axios: { post: (url) => { calls.logoutPost = url; return { catch: () => {} }; } },
    customerSession: () => ({ access: 'CUSTOMER_JPC' }),
    clearCustomerAuth: () => { calls.clearCustomerAuth++; },
    clearStoredAuth: () => { calls.clearStoredAuth++; },
    resetWishlist: () => { calls.resetWishlist++; },
    Wishlist: { reset: () => { calls.wishlistModuleReset++; } },
    LiveChat: { reset: () => { calls.chatReset++; } },
    closeAccountCenter: () => { calls.closeAccountCenter++; },
    renderAuthNav: () => { calls.renderAuthNav++; },
    acctCurrentUser: { id: 1, name: 'Customer A' },
    acctCacheOwner: 1,
    acctLoadedTabs: new Set(['profile', 'wishlist']),
  };
  const script = `
    ${logoutSrc}
    globalThis.__user = () => acctCurrentUser;
    globalThis.__owner = () => acctCacheOwner;
    globalThis.__tabs = () => acctLoadedTabs;
    doAccountLogout();
  `;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { calls, user: sandbox.__user(), owner: sandbox.__owner(), tabsSize: sandbox.__tabs().size };
}

if (logoutSrc) {
  const { calls, user, owner, tabsSize } = runLogout();
  check(calls.logoutPost === '/api/customer/auth/logout', 'doAccountLogout() tells the server to end the session');
  check(calls.clearCustomerAuth === 1, 'doAccountLogout() clears the customer (jpc_*) auth');
  check(calls.clearStoredAuth === 1, 'doAccountLogout() clears the shared stored auth');
  check(user === null, 'doAccountLogout() drops the cached customer profile (acctCurrentUser = null)');
  check(owner === null, 'doAccountLogout() clears the cache owner (acctCacheOwner = null)');
  check(tabsSize === 0, 'doAccountLogout() forgets the loaded account tabs');
  check(calls.resetWishlist === 1, 'doAccountLogout() resets the app.js wishlist (resetWishlist)');
  check(calls.wishlistModuleReset === 1, 'doAccountLogout() resets the service-page wishlist module + count (Wishlist.reset)');
  check(calls.chatReset === 1, 'doAccountLogout() tears down the customer chat (LiveChat.reset)');
  check(calls.closeAccountCenter === 1, 'doAccountLogout() closes the Account Center');
  check(calls.renderAuthNav === 1, 'doAccountLogout() repaints the signed-out nav');
}

/* --- 2. STRUCTURAL: the shared boundary is exposed and used ----------------- */

/* 2a. account-center.js exposes logout bound to the real teardown — the fix. */
check(/\blogout:\s*doAccountLogout\b/.test(stripComments(ACCT)),
  'account-center.js must expose `logout: doAccountLogout` on the public AccountCenter object (the #10 one-liner)');

/* 2b. profile-menu.js prefers AccountCenter.logout, and its fallback tears down chat + wishlist. */
const pmLogout = extractFn(PM, 'function logout(', 'profile-menu.js');
if (pmLogout) {
  const code = stripComments(pmLogout);
  check(/AccountCenter\.logout/.test(code), 'profile-menu.js logout() must call AccountCenter.logout when present');
  const guard = code.indexOf('AccountCenter.logout');
  const fallback = code.indexOf('clearStoredAuth');
  check(guard !== -1 && fallback !== -1 && guard < fallback,
    'profile-menu.js must try AccountCenter.logout BEFORE the token-only fallback (the #10 regression)');
  check(/LiveChat\.reset/.test(code), 'profile-menu.js fallback must also tear down chat (LiveChat.reset)');
  check(/Wishlist\.reset/.test(code), 'profile-menu.js fallback must also reset the wishlist module');
}

/* 2c. app.js auth-nav "Sign Up"-slot sign-out tears down chat + wishlist too. */
check((stripComments(APP).match(/LiveChat\.reset/g) || []).length >= 1,
  'app.js auth-nav sign-out fallback must tear down chat (LiveChat.reset)');
check((stripComments(APP).match(/Wishlist\.reset/g) || []).length >= 1,
  'app.js must reset the wishlist module on sign-out');

/* --- 3. STRUCTURAL: LiveChat.reset exists, tears chat down, keeps ChatOutbox -- */
check(/return\s*\{[^}]*\breset\b[^}]*isSignedIn/.test(stripComments(LC)),
  'live-chat.js must expose reset() on the public LiveChat object');
const lcReset = extractFn(LC, 'function reset(', 'live-chat.js');
if (lcReset) {
  const code = stripComments(lcReset);
  check(/\bdisconnect\(\)/.test(code), 'LiveChat.reset() must drop the live socket (disconnect)');
  check(/state\.conversation\s*=\s*null/.test(code), 'LiveChat.reset() must forget the conversation');
  check(/state\.messages\s*=\s*\[\]/.test(code), 'LiveChat.reset() must forget the message history');
  check(/paintBadge\(\)/.test(code), 'LiveChat.reset() must repaint the (now empty) unread badge');
  check(/state\.booted\s*=\s*false/.test(code), 'LiveChat.reset() must unboot so the next customer gets a fresh mount');
  /* Preserve ChatOutbox: reset() must NOT reach into the persisted outbox. */
  check(!/outbox\s*\(|ChatOutbox/.test(code),
    'LiveChat.reset() must leave the ChatOutbox untouched (persisted per conversation_id — no cross-account leak)');
}
/* And the ChatOutbox integration itself must still be present in the file. */
check(/function outbox\(/.test(LC) && /ChatOutbox/.test(LC),
  'live-chat.js must still carry its ChatOutbox integration (the merge preserved it)');

/* --- 4. STRUCTURAL: the Wishlist module keeps reset AND the count/event work - */
check(/button,\s*has,\s*toggle,\s*paint,\s*count,\s*reset/.test(stripComments(WL)),
  'wishlist.js must still export reset() alongside the count engine (button,has,toggle,paint,count,reset)');
check(/wishlist:change/.test(WL),
  'wishlist.js must still fire the wishlist:change event that drives the count badge (Issue #17 preserved)');
const wlReset = extractFn(WL, 'function reset(', 'wishlist.js');
if (wlReset) {
  const code = stripComments(wlReset);
  check(/saved\.clear\(\)/.test(code), 'Wishlist.reset() must clear its saved-set');
  check(/loaded\s*=\s*false/.test(code), 'Wishlist.reset() must re-arm load() for the next account (loaded = false)');
  check(/paint\(/.test(code), 'Wishlist.reset() must repaint (empty) the hearts for the previously-saved items');
  check(/emitChange\(\)/.test(code), 'Wishlist.reset() must fire wishlist:change so the count badge zeroes (Issue #17)');
}

report();

function report() {
  if (failures.length) {
    console.error('FAIL — logout-clears-customer-state.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — logout-clears-customer-state.test.js (#10: dropdown Logout resets tokens, wishlist+count, profile, tabs & chat via one shared boundary; ChatOutbox preserved)');
}
