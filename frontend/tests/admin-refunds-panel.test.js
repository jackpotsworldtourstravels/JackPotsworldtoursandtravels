'use strict';
/* ===========================================================================
   Admin refund panel - what it SAYS and which action it offers.

   admin-b2c-refunds.js touches the DOM at call time, so (like the other
   frontend tests) the pure renderers are extracted and run in a VM with the
   REAL escapeHtml / moneyStr from shared/formatters.js:
     * cxlAttemptLabel(a)            - the wording for an attempt
     * cxlRefundPanelHtml(o, status) - figures + history + the one legal action

   The rule under test: nothing says "Refunded" unless the refund is confirmed
   (provider-confirmed or an audited manual record); a pending, processing or
   unknown refund never does, and no "mark completed" control exists.

   run:  node frontend/tests/admin-refunds-panel.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/admin-b2c-refunds.js');
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

/* For top-level functions whose signature itself contains braces (moneyStr's
   destructured options): from the signature to the first closing brace in
   column 0 - or to the end of line for a one-liner. */
function extractTop(src, sig) {
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${sig} not found`); return ''; }
  const NL = String.fromCharCode(10);
  const eol = src.indexOf(NL, at);
  if (/}\s*$/.test(src.slice(at, eol))) return src.slice(at, eol);
  const end = src.indexOf(NL + '}', at);
  return src.slice(at, end + 2);
}

const code = [
  extractFn(FORMATTERS, 'function escapeHtml('),
  extractTop(FORMATTERS, 'function moneyStr('),
  extractTop(FORMATTERS, 'function fmtDateTime('),
  'const CXL_ATTEMPT_TONE = { pending: "pending", processing: "pending", succeeded: "refunded", failed: "cancelled", manual_required: "pending" };',
  extractFn(SRC, 'function cxlAttemptLabel('),
  extractFn(SRC, 'function cxlWho('),
  extractFn(SRC, 'function cxlAttemptRowHtml('),
  extractFn(SRC, 'function cxlOpenAttempt('),
  extractFn(SRC, 'function cxlRefundPanelHtml('),
  extractFn(SRC, 'function cxlRefundActionsHtml('),
].join('\n');

const sandbox = {};
vm.createContext(sandbox);
try {
  vm.runInContext(code + '\nthis.api = { cxlAttemptLabel, cxlRefundPanelHtml };', sandbox);
} catch (e) { failures.push('could not load renderers: ' + e.message); }
const api = sandbox.api || {};

const attempt = (o = {}) => ({
  attempt_id: 1, attempt_number: 1, status: 'processing', status_label: 'Processing', amount: '70.00', currency: 'INR',
  provider: 'razorpay', provider_refund_id: null, provider_status: null, failure_reason: null, is_manual: false,
  admin_override: false, manual_reference: null, manual_reason: null, approval_required: true, uncertain: false,
  initiated_by: { id: 1, name: 'Maker One' }, approved_by: null, completed_by: null,
  created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:00:00Z', completed_at: null, ...o,
});
const overview = (o = {}) => ({
  cancellation_id: 'CXL-1', provider: 'razorpay', currency: 'INR', manual_only: false,
  captured_amount: '100.00', previously_refunded: '0.00', in_progress: '0.00', remaining_refundable: '100.00',
  requested_amount: '100.00', cancellation_remaining: '100.00', approval_required: true, blocker: null,
  payment: {}, attempts: [], ...o,
});

if (api.cxlAttemptLabel) {
  // --- wording: "Refunded" only when confirmed -----------------------------
  const L = api.cxlAttemptLabel;
  check(L(attempt({ status: 'succeeded' })) === 'Refunded — confirmed by provider', 'gateway success label');
  check(L(attempt({ status: 'succeeded', is_manual: true })) === 'Refunded — manual record', 'manual success label');
  for (const a of [
    attempt({ status: 'pending' }), attempt({ status: 'processing' }),
    attempt({ status: 'processing', uncertain: true }), attempt({ status: 'failed' }),
    attempt({ status: 'manual_required' }),
  ]) {
    check(!/^Refunded/.test(L(a)), `${a.status}${a.uncertain ? '/uncertain' : ''} must not read as Refunded: ${L(a)}`);
  }
  check(/do not retry/i.test(L(attempt({ uncertain: true }))), 'uncertain outcome says not to retry');

  // --- the panel -------------------------------------------------------------
  const P = api.cxlRefundPanelHtml;
  const none = P(null, 'approved');
  check(/refund\.view/.test(none), 'no access -> says refund.view is needed');

  const fresh = P(overview(), 'approved');
  for (const label of ['Requested refund', 'Original captured amount', 'Previously refunded', 'Remaining refundable', 'Provider']) {
    check(fresh.includes(label), `figures include "${label}"`);
  }
  check(fresh.includes('id="cxlStartRefundBtn"') && fresh.includes('Request refund (needs approver)'),
    'approval-required refund offers "Request refund (needs approver)"');
  check(!/Mark (Refund )?Completed/i.test(fresh), 'no status-only completion control');
  check(fresh.includes('id="cxlRefundAmount"'), 'amount for this cancellation can be set before any money moves');

  const direct = P(overview({ approval_required: false }), 'approved');
  check(direct.includes('>Start refund<'), 'no approver needed -> "Start refund"');

  const manual = P(overview({ manual_only: true, provider: 'trustbrick' }), 'approved');
  check(manual.includes('Prepare manual refund') && /no refund API/.test(manual), 'TrustBrick is labelled manual');

  const pending = P(overview({ attempts: [attempt({ status: 'pending' })] }), 'refund_processing');
  check(pending.includes('id="cxlAuthorizeBtn"') && /Awaiting approval/.test(pending), 'pending attempt offers approval');
  check(/Maker One/.test(pending) && /Not yet approved/.test(pending), 'shows who initiated, and that nobody approved yet');
  check(!pending.includes('cxlStartRefundBtn'), 'cannot start a second refund while one is open');

  const manualDue = P(overview({ manual_only: true, provider: 'trustbrick', attempts: [attempt({ status: 'manual_required', provider: 'trustbrick' })] }), 'refund_processing');
  check(manualDue.includes('id="cxlManualOverride"') && manualDue.includes('id="cxlManualRef"') && manualDue.includes('id="cxlManualReason"'),
    'manual record needs reference, reason and an explicit override confirmation');
  check(/outside any payment gateway/.test(manualDue), 'override wording says no gateway is involved');

  const processing = P(overview({ in_progress: '70.00', remaining_refundable: '30.00',
    attempts: [attempt({ provider_refund_id: 'rfnd_X', provider_status: 'pending' })] }), 'refund_processing');
  check(processing.includes('rfnd_X') && processing.includes('Provider status: pending'), 'shows provider reference and status');
  check(processing.includes('id="cxlReconcileBtn"') && !processing.includes('cxlResolveBtn'), 'processing: reconcile, not "close"');

  const unknown = P(overview({ attempts: [attempt({ uncertain: true, failure_reason: 'Outcome unknown: timed out' })] }), 'refund_processing');
  check(unknown.includes('id="cxlResolveBtn"') && /NOT be retried/.test(unknown) && /timed out/.test(unknown),
    'unknown outcome: no retry, shows reason, operator can close after checking');

  const failed = P(overview({ attempts: [attempt({ status: 'failed', failure_reason: 'Razorpay refused: bad amount' })] }), 'refund_processing');
  check(/Razorpay refused: bad amount/.test(failed) && /safe to try again/.test(failed) && failed.includes('cxlStartRefundBtn'),
    'failed attempt shows its reason and allows a safe retry');

  const done = P(overview({ previously_refunded: '100.00', remaining_refundable: '0.00', cancellation_remaining: '0.00',
    blocker: { code: 'fully_refunded', message: 'This payment is fully refunded.' },
    attempts: [attempt({ status: 'succeeded', provider_refund_id: 'rfnd_OK', approved_by: { id: 3, name: 'Checker' } })] }), 'refunded');
  check(done.includes('Refunded — confirmed by provider') && /Checker/.test(done) && !done.includes('Btn"'), 'completed: history only, no actions');

  const xss = P(overview({ attempts: [attempt({ failure_reason: '<img src=x onerror=alert(1)>', provider_refund_id: '<b>' })] }), 'refund_processing');
  check(!/<img src=x/.test(xss) && !/<b>/.test(xss.replace(/<\/?(b|strong)>/g, m => m)) , 'provider text is escaped');
}

if (failures.length) {
  console.error('FAIL admin-refunds-panel\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('PASS admin-refunds-panel');
