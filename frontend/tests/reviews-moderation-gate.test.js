'use strict';
/* ===========================================================================
   Reviews desk — moderation controls are gated on b2c.reviews.moderate.

   The review moderation PATCH is gated on the b2c.reviews.moderate scope on the
   backend (a view-only desk with only b2c.customers.view can READ reviews but
   NOT approve/reject/reply). The admin desk must therefore NOT show the
   Approve / Reject / Save-reply controls to an operator who would only get a
   403 — a dead button that also claims an action they cannot take.

   This is a STRUCTURAL regression guard (mirroring the ticket-reply wiring
   assertion): it reads admin-b2c-reviews.js and asserts the controls live
   inside the rvwCanModerate gate, which openReview() resolves via
   adminCan('b2c.reviews.moderate').

   run:  node frontend/tests/reviews-moderation-gate.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'js', 'admin-b2c-reviews.js'), 'utf8');

// 1. The permission is resolved per open, via the shared adminCan() helper
//    (which also returns true for a super admin).
assert.ok(
  /rvwCanModerate\s*=\s*typeof adminCan === 'function'\s*\?\s*await adminCan\('b2c\.reviews\.moderate'\)/.test(src),
  'openReview must resolve rvwCanModerate from adminCan("b2c.reviews.moderate")');

// 2. Each moderation control exists ONLY inside the rvwCanModerate gate: the
//    gate opens before any of them, and closes (its `:` branch) after them.
const gateOpen = src.indexOf('${rvwCanModerate ? `');
assert.ok(gateOpen !== -1, 'the moderation block must be wrapped in a ${rvwCanModerate ? ...} gate');

for (const id of ['rvwSaveReply', 'rvwReject', 'rvwApprove']) {
  const at = src.indexOf(`id="${id}"`);
  assert.ok(at !== -1, `control ${id} should still exist`);
  assert.ok(at > gateOpen, `control ${id} must be INSIDE the rvwCanModerate gate (found before it)`);
}

// 3. A view-only operator is told why the controls are absent...
assert.ok(src.includes('view-only access'),
  'view-only operators must be told why the moderation controls are absent');
// ...and the gate has a read-only else-branch (after the controls) that still
//    shows the existing public reply rather than leaving an empty space.
const readOnlyReply = src.indexOf('>Public reply<');
assert.ok(readOnlyReply > gateOpen,
  'the gate must have a read-only else-branch showing the public reply for view-only operators');

console.log('reviews moderation gate: all checks passed');
