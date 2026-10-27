'use strict';
/* ===========================================================================
   Account wishlist NOTES — render + save, in isolation.

   A saved item can carry a short customer note, shown under the item with an
   inline editor that PATCHes /api/customer/wishlist/{id}. account-center.js
   touches the DOM at module scope, so — like wishlist-account-enrichment.test.js
   — the two pure pieces are extracted and run in a VM:
     * wishlistNoteHtml(w)   — the note block markup (pure function of the row),
     * saveWishlistNote(id,note) — the PATCH call (verb + URL + body).
   escapeHtml is the REAL one from shared/formatters.js, so the escaping
   assertion tests production behaviour, not a stand-in.

   run:  node frontend/tests/wishlist-notes.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/account-center.js');
const FORMATTERS = read('shared/formatters.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

function extractFn(src, sig) {
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${sig} not found`); return ''; }
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  failures.push(`${sig} braces unbalanced`);
  return '';
}

const ESCAPE = extractFn(FORMATTERS, 'function escapeHtml(');
const NOTE_HTML = extractFn(SRC, 'function wishlistNoteHtml(');
const SAVE = extractFn(SRC, 'async function saveWishlistNote(');

const patchCalls = [];
function makeApi() {
  const sandbox = {
    console, Promise, String, Number,
    API_BASE: '',
    customerHeaders: () => ({ Authorization: 'Bearer test' }),
    axios: {
      patch: async (url, body, cfg) => { patchCalls.push({ url, body, cfg }); return { data: {} }; },
    },
  };
  const script = `
    ${ESCAPE}
    ${NOTE_HTML}
    ${SAVE}
    globalThis.__api = { wishlistNoteHtml, saveWishlistNote };
  `;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return sandbox.__api;
}

(async () => {
  const api = makeApi();

  /* ---- No note: an "Add a note" affordance, no note paragraph ---------- */
  {
    const html = api.wishlistNoteHtml({ id: 1, note: null });
    check(/data-edit-note="1"/.test(html), 'no-note row still offers an edit/add control');
    check(/Add a note/.test(html), 'no-note row labels the control "Add a note"');
    check(!/class="ar-note"/.test(html), 'no-note row shows no note paragraph');
    check(/maxlength="500"/.test(html), 'the editor textarea caps at 500 chars (matches the API)');
    check(/<label[^>]*for="acctNote-1"/.test(html), 'the textarea has an associated label (a11y)');
  }

  /* ---- With a note: shown, and the control says "Edit note" ------------ */
  {
    const html = api.wishlistNoteHtml({ id: 2, note: 'great rooftop pool' });
    check(/class="ar-note"[^>]*>great rooftop pool</.test(html), 'an existing note is displayed');
    check(/Edit note/.test(html), 'a row with a note labels the control "Edit note"');
    check(html.includes('>great rooftop pool</textarea>'), 'the editor is pre-filled with the current note');
  }

  /* ---- Blank/whitespace note is treated as no note --------------------- */
  {
    const html = api.wishlistNoteHtml({ id: 3, note: '   ' });
    check(!/class="ar-note"/.test(html) && /Add a note/.test(html),
      'a whitespace-only note renders as "no note" (consistent with the server)');
  }

  /* ---- XSS: the note is escaped through the real escapeHtml ------------ */
  {
    const html = api.wishlistNoteHtml({ id: 4, note: '<img src=x onerror=alert(1)>' });
    check(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'a note with HTML is escaped');
    check(!/<img src=x onerror/.test(html), 'the raw tag never reaches the markup');
  }

  /* ---- saveWishlistNote PATCHes the right URL with the note ------------ */
  {
    patchCalls.length = 0;
    await api.saveWishlistNote(42, 'ask about the May rate');
    check(patchCalls.length === 1, 'saveWishlistNote makes exactly one request');
    check(patchCalls[0].url === '/api/customer/wishlist/42', 'it PATCHes /api/customer/wishlist/{id}');
    check(patchCalls[0].body && patchCalls[0].body.note === 'ask about the May rate',
      'it sends the note in the body');
    check(patchCalls[0].cfg && patchCalls[0].cfg.headers && patchCalls[0].cfg.headers.Authorization,
      'it carries the customer auth header (owner-scoped on the server)');
  }

  /* ---- STRUCTURAL: render wires the note block; remove unchanged ------- */
  check(/\$\{wishlistNoteHtml\(w\)\}/.test(SRC),
    'loadAcctWishlist renders the note block for each row');
  check(/axios\.patch\(`\$\{API_BASE\}\/api\/customer\/wishlist\/\$\{id\}`/.test(SRC),
    'the note save targets PATCH /api/customer/wishlist/{id}');
  check(/data-remove-wishlist="\$\{w\.id\}"/.test(SRC),
    'the Remove button is unchanged (regression)');
  check(/axios\.delete\(`\$\{API_BASE\}\/api\/customer\/wishlist\/\$\{btn\.dataset\.removeWishlist\}`/.test(SRC),
    'Remove still DELETEs /api/customer/wishlist/{id} (regression)');

  /* --------------------------------------------------------------------- */
  if (failures.length) {
    console.error('FAIL — wishlist-notes.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — wishlist-notes.test.js (note render, escaping, save PATCH, a11y label, regression)');
})();
