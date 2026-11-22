'use strict';
/* ===========================================================================
   Admin — Tour Package Enquiries (Phase 2 Bug 3).

   admin-tour-package-enquiries.js touches the DOM at call time, so (like the
   other admin frontend tests) the pure renderers are extracted and run in a VM
   with small escapeHtml / fmtDateTime stubs:
     * TPE_STATUS_LABELS / TPE_STATUS_BADGE  — the workflow the screen shows
     * tpeStatusLabel(s)                     — label, unknown passes through
     * tpeHistoryHtml(entries)               — the audit history panel

   Rules under test: the seven backend statuses each have a human label and a
   badge tone; the history panel shows the actor and the status transition, and
   says so plainly when there is nothing yet.

   run:  node frontend/tests/admin-tour-package-enquiries.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/admin-tour-package-enquiries.js');

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

/* The seven statuses the backend's STATUSES tuple allows (schemas/
   tour_package_enquiry.py). Pinned here so the screen and the API cannot
   drift: a status the API can store but this screen cannot label is a row an
   admin sees as a raw token. */
const BACKEND_STATUSES = ['NEW', 'ASSIGNED', 'CONTACTED', 'QUOTE_SENT', 'CONVERTED', 'CLOSED', 'CANCELLED'];

const code = [
  'const escapeHtml = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");',
  'const fmtDateTime = s => "DT(" + s + ")";',
  extractFn(SRC, 'const TPE_STATUS_LABELS ='),
  extractFn(SRC, 'const TPE_STATUS_BADGE ='),
  'const tpeStatusLabel = s => TPE_STATUS_LABELS[s] || s;',
  extractFn(SRC, 'function tpeHistoryHtml('),
].join('\n');

const sandbox = {};
vm.createContext(sandbox);
try {
  vm.runInContext(code + '\nthis.api = { TPE_STATUS_LABELS, TPE_STATUS_BADGE, tpeStatusLabel, tpeHistoryHtml };', sandbox);
} catch (e) { failures.push('could not load renderers: ' + e.message); }
const api = sandbox.api || {};

if (api.tpeStatusLabel) {
  // Every backend status has a label and a badge tone.
  for (const s of BACKEND_STATUSES) {
    check(api.TPE_STATUS_LABELS[s] !== undefined, `missing label for status ${s}`);
    check(api.TPE_STATUS_BADGE[s] !== undefined, `missing badge tone for status ${s}`);
  }
  // No extra labels beyond the backend set (the two must match exactly).
  check(Object.keys(api.TPE_STATUS_LABELS).sort().join(',') === [...BACKEND_STATUSES].sort().join(','),
    'label set must match the backend STATUSES exactly');

  check(api.tpeStatusLabel('QUOTE_SENT') === 'Quote Sent', 'QUOTE_SENT label');
  check(api.tpeStatusLabel('WHATEVER') === 'WHATEVER', 'unknown status passes through');
}

if (api.tpeHistoryHtml) {
  const empty = api.tpeHistoryHtml([]);
  check(/No changes recorded yet/.test(empty), 'empty history states there is nothing yet');

  const html = api.tpeHistoryHtml([
    { actor_name: 'Desk Ops', from_status: 'NEW', to_status: 'CONTACTED', at: '2026-11-22T10:00:00Z', description: 'Called' },
    { actor_name: null, from_status: null, to_status: null, at: '2026-11-22T09:00:00Z', description: 'Created' },
  ]);
  check(/Desk Ops/.test(html), 'history shows the actor name');
  check(/New\s*→\s*Contacted/.test(html), 'history shows the status transition');
  check(/System/.test(html), 'a null actor reads as System');
  check(/DT\(2026-11-22T10:00:00Z\)/.test(html), 'history shows the timestamp via fmtDateTime');

  // Actor text is escaped, not injected.
  const xss = api.tpeHistoryHtml([{ actor_name: '<img src=x onerror=alert(1)>', at: 't' }]);
  check(!/<img src=x/.test(xss), 'actor name is escaped');
}

if (failures.length) {
  console.error('FAIL admin-tour-package-enquiries\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('PASS admin-tour-package-enquiries');
