'use strict';
/* ===========================================================================
   Account "Saved travellers" — masking, row render, save routing, wiring.

   The Account Center manages the customer's saved-traveller address book over
   the existing /api/customer/travellers CRUD. This extracts the pure pieces
   (maskPassport, travellerRowHtml, saveTraveller) and runs them in a VM with
   the real escapeHtml, then makes structural assertions on the loader/wiring.

   run:  node frontend/tests/saved-travellers.test.js
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
const MASK = extractFn(SRC, 'function maskPassport(');
const ROW = extractFn(SRC, 'function travellerRowHtml(');
const SAVE = extractFn(SRC, 'async function saveTraveller(');

const calls = [];
function makeApi() {
  const sandbox = {
    console, String, JPIcon: undefined,
    API_BASE: '',
    customerHeaders: () => ({ Authorization: 'Bearer test' }),
    axios: {
      post: async (url, body, cfg) => { calls.push({ method: 'post', url, body, cfg }); return { data: {} }; },
      patch: async (url, body, cfg) => { calls.push({ method: 'patch', url, body, cfg }); return { data: {} }; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${ESCAPE}\n${MASK}\n${ROW}\n${SAVE}\nglobalThis.__m = { maskPassport, travellerRowHtml, saveTraveller };`, sandbox);
  return sandbox.__m;
}

(async () => {
  const m = makeApi();

  /* ---- maskPassport only ever reveals the last few chars ---------------- */
  check(m.maskPassport('M1234567') === '•••• 4567', 'a long passport is masked to the last 4');
  check(m.maskPassport('AB12') === 'AB12', 'a very short value is left as-is (nothing to hide)');
  check(m.maskPassport('') === '' && m.maskPassport(null) === '', 'empty/None masks to empty');

  /* ---- Row shows the masked passport, never the raw number -------------- */
  {
    const html = m.travellerRowHtml({
      customer_traveller_id: 5, first_name: 'Asha', last_name: 'Rao',
      traveller_type: 'adult', date_of_birth: '1990-04-02', nationality: 'Indian',
      passport_number: 'M7654321',
    });
    check(/class="ar-title"[^>]*>Asha Rao</.test(html), 'the traveller name is shown');
    check(html.includes('•••• 4321'), 'the passport is shown masked');
    check(!html.includes('M7654321'), 'the full passport number never reaches the markup');
    check(html.includes('data-traveller-edit="5"') && html.includes('data-traveller-del="5"'),
      'the row carries Edit and Delete controls bound to the traveller id');
  }

  /* ---- XSS: the name is escaped ---------------------------------------- */
  {
    const html = m.travellerRowHtml({ customer_traveller_id: 6, first_name: '<b>x', last_name: '</b>', passport_number: '' });
    check(html.includes('&lt;b&gt;x &lt;/b&gt;') || html.includes('&lt;b&gt;x'), 'the name is HTML-escaped');
    check(!/<b>x/.test(html), 'raw markup in a name never reaches the output');
  }

  /* ---- saveTraveller: POST to create, PATCH to update ------------------ */
  {
    calls.length = 0;
    await m.saveTraveller({ first_name: 'A', last_name: 'B' }, '');     // create
    await m.saveTraveller({ first_name: 'A', last_name: 'B' }, 9);      // update
    check(calls[0].method === 'post' && calls[0].url === '/api/customer/travellers',
      'no id -> POST /api/customer/travellers (create)');
    check(calls[1].method === 'patch' && calls[1].url === '/api/customer/travellers/9',
      'an id -> PATCH /api/customer/travellers/{id} (update)');
    check(calls[0].cfg.headers.Authorization && calls[1].cfg.headers.Authorization,
      'both carry the customer auth header (owner-scoped server-side)');
  }

  /* ---- STRUCTURAL: loader + wiring + delete ---------------------------- */
  check(/axios\.get\(`\$\{API_BASE\}\/api\/customer\/travellers`/.test(SRC), 'loader GETs /api/customer/travellers');
  check(/if \(name === 'travellers'\) return loadAcctTravellers\(\);/.test(SRC), 'the travellers tab is dispatched');
  check(/axios\.delete\(`\$\{API_BASE\}\/api\/customer\/travellers\/\$\{btn\.dataset\.travellerDel\}`/.test(SRC),
    'delete DELETEs /api/customer/travellers/{id}');
  check(/data-tab="travellers"/.test(SRC), 'the Saved Travellers tab is present in the nav');

  if (failures.length) {
    console.error('FAIL — saved-travellers.test.js');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('PASS — saved-travellers.test.js (masking, row, create/update routing, wiring)');
})();
