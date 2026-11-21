'use strict';
/* ===========================================================================
   Bugs 8 & 9 — the Contact Us and policy-page headers greet the signed-in
   customer by name instead of a generic "My Account".

   These pages render through service-shell.js and load no auth.js, so there is
   no getCustomerSession; the shell's fallback auth corner reads the session
   directly from the jpc_* namespace. It now also reads jpc_user_name (auth.js's
   CUSTOMER_KEYS.name) and shows it, falling back to "My Account" when the name
   is missing and "Login / Create" when signed out. The name is HTML-escaped.

   The pure fallback `renderAuth` is extracted and run in a VM against a mocked
   DOM and localStorage — the real code, in isolation (ProfileMenu is left
   undefined so the fallback branch runs).

   run:  node frontend/tests/service-shell-auth-name.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/service-shell.js');

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

const RENDER_AUTH = extractFn(SRC, 'function renderAuth(');

/* Run renderAuth with a fake slot + a controllable localStorage. escapeHtml is
   left undefined so the shell's own escape fallback (the hardened one) runs. */
function runRenderAuth(store) {
  const slot = { innerHTML: '', setAttribute() {}, get parentNode() { return null; } };
  const sandbox = {
    ProfileMenu: undefined,
    document: {
      getElementById: id => (id === 'shellAuth' ? slot : null),
      documentElement: { classList: { toggle() {} } },
    },
    localStorage: { getItem: k => (k in store ? store[k] : null) },
  };
  vm.createContext(sandbox);
  // Capture whatever renderAuth writes into the slot.
  let captured = '';
  Object.defineProperty(slot, 'innerHTML', {
    get() { return captured; }, set(v) { captured = v; },
  });
  /* The hardened esc fallback, lifted verbatim so the test exercises the real
     escaping path the shell uses when escapeHtml is absent. */
  const esc = `const esc = s => (typeof escapeHtml === 'function'`
    + ` ? escapeHtml(String(s ?? ''))`
    + ` : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));`;
  vm.runInContext(`${esc}\nfunction icon() { return ''; }\n${RENDER_AUTH}\nrenderAuth();`, sandbox);
  return captured;
}

/* Signed in, with a name -> the name is shown. */
{
  const html = runRenderAuth({ jpc_access: 'tok', jpc_user_name: 'Harsha Vardhan' });
  check(html.includes('Harsha Vardhan'), 'a signed-in customer sees their name');
  check(!html.includes('My Account'), 'the generic "My Account" is not shown when a name exists');
  check(html.includes('/?account=profile'), 'the name links into the account');
}

/* Signed in, no stored name -> safe "My Account" fallback. */
{
  const html = runRenderAuth({ jpc_access: 'tok' });
  check(html.includes('My Account'), 'a signed-in customer with no name falls back to "My Account"');
  check(html.includes('/?account=profile'), 'the fallback still links into the account');
}

/* Signed out -> login door. */
{
  const html = runRenderAuth({});
  check(html.includes('Login / Create'), 'a signed-out visitor is offered login');
  check(html.includes('/?signin=1'), 'the login link points at sign-in');
  check(!html.includes('My Account'), 'no account label when signed out');
}

/* A name containing HTML is escaped. */
{
  const html = runRenderAuth({ jpc_access: 'tok', jpc_user_name: '<img src=x onerror=1>' });
  check(!html.includes('<img'), 'a hostile stored name is escaped, not injected');
  check(html.includes('&lt;img'), 'the name is HTML-escaped');
}

/* STRUCTURAL: the real source reads the right key and escapes the label. */
check(/jpc_user_name/.test(SRC), 'renderAuth reads jpc_user_name');
check(/customerName \|\| 'My Account'/.test(SRC), 'label is the name with "My Account" fallback');
check(/<span>\$\{esc\(label\)\}<\/span>/.test(SRC), 'the label is escaped at injection');

if (failures.length) {
  console.error('FAIL — service-shell-auth-name.test.js');
  failures.forEach(f => console.error('  • ' + f));
  process.exit(1);
}
console.log('PASS — service-shell-auth-name.test.js (name shown, fallback, logged-out, escaping)');
