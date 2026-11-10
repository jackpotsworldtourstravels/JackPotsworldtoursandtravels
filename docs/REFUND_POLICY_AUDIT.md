# Customer refund policy audit

**Date:** 2026-11-10 · **Branch inspected:** `main` @ `556ce23` (refund execution, migration `0094`)
**Scope:** read-only audit of `frontend/cancellation-refund-policy.html` against the code.
Nothing was deployed, migrated, merged or changed, and no refund was executed.

Classification used throughout: **Implemented** · **Partial** · **Not implemented** ·
**Decision** (business decision required) · **Verify** (needs verification).

---

## 1. Executive summary

The refund *machinery* is built and safe: the money can only go back to the captured
payment, once, with a second approver, and is confirmed by the provider. What is **not**
aligned is everything around it:

1. **The customer-facing flow contradicts the policy.** The policy promises *"Nothing is
   cancelled until you have confirmed the amount"* and that cancellation is requested by
   email. In the product, a signed-in customer's **Cancel** button cancels the booking
   **instantly** after a bare `confirm('Cancel this booking?')`, with no quote, no
   deductions and no refund (`account-center.js` → `POST .../cancel`).
2. **A self-cancelled paid booking has no path into the refund workflow.** The
   cancellation-request endpoint refuses a booking that is already cancelled
   (`"terminal"`), and the refund service starts only from an *approved* request. Only
   packages (and flights with a missing supplier reservation) leave an audit flag
   "refund owed"; **hotels leave nothing**.
3. **No refund amount is ever calculated.** The policy describes a 3-part deduction
   (supplier charge, non-refundable taxes, service fee) and a package scale (deposit /
   25 / 50 / 75 / 100 %). The code has none of it: the desk types a number, defaulting to
   the **full booking total**.
4. **Customers cannot see a refund.** There is no customer endpoint or screen for
   cancellation-request status, no refund notification, and the only refund wording a
   customer ever sees is a "Refunded" label once a payment is fully refunded.
5. **The 7-working-day processing promise is untracked**; the only clock is a 24 h
   "stale" tally in reconciliation.

**Production readiness:** the refund *engine* is ready to be used by staff once deployed
and a named approver is granted. The *customer-facing refund experience and policy
alignment are not ready*, and several policy statements are currently untrue of the product.

---

## 2. Existing policy analysis (what the page promises)

| # | Promise (section) | Nature |
|---|---|---|
| P1 | Nothing is cancelled until the customer confirms a written refundable amount (intro) | Process promise |
| P2 | Cancel by emailing support from the booking email; phone for <48 h (§3) | Channel |
| P3 | Cancellation time = when the written request reaches us, timestamped (§4) | Process |
| P4 | Refund = paid − supplier charge − non-refundable taxes − our service fee (§2) | Calculation |
| P5 | Service fee not refunded; optional separate cancellation-processing fee disclosed in the written quote (§2) | Calculation |
| P6 | Flights follow fare rules; refundable / non-refundable / partly used (§5) | Supplier rules |
| P7 | Hotels: flexible vs non-refundable; free-cancel deadline on voucher (§6) | Supplier rules |
| P8 | Package scale: deposit >45 d, 25 % 45–31 d, 50 % 30–16 d, 75 % 15–8 d, 100 % ≤7 d / no-show, plus airline charge (§7) | **Hard-coded business rule** |
| P9 | Full refund, no deduction, if we cannot confirm a paid booking (§10) | Calculation |
| P10 | Refund only to the original payment method, same currency (§11) | Payment rule |
| P11 | Instruct refund within 7 working days of supplier release / of confirming cancellation; bank 5–10 working days (§12) | SLA |
| P12 | Customer can ask which stage a refund is at; we give the provider reference (§12) | Visibility |
| P13 | Duplicate charge refunded in full within 7 working days of confirmation (§13) | SLA |
| P14 | Partial cancellations allowed, subject to supplier (§14) | Scope |
| P15 | Dispute → written workings line by line (§15) | Process |

Observations on the page itself: effective/updated date is 5 Sep 2026 (before the refund
engine existed); it names no approval step, no processing states, and does not say a
refund may need a second internal approval.

---

## 3. Existing implementation analysis

**Customer side**
* Three instant self-cancel endpoints (`/bookings|hotel-bookings|package-bookings/{ref}/cancel`)
  set `status=cancelled`, stamp `cancelled_at`, send a "Booking cancelled" notification
  and **issue no refund** (docstrings say so explicitly).
* `POST /api/customer/cancellation-requests` creates a `requested` row for admin review.
  **No frontend calls it.** There is no `GET` for a customer's own requests.
* Customer UI shows a **Cancel** button on every non-cancelled booking
  (`account-center.js:865,972`) → `cancelBookingById` → `confirm()` → instant cancel.

**Admin side (`556ce23`)**
* `requested → approved` (cancels the booking) `→ refund_processing → refunded`.
* Refund is started by `refund.execute`, approved by a *different* `refund.authorize`
  holder (default: every refund), executed through the provider that collected the money,
  confirmed by the provider's API, reconciled by the sweep.
* Amount: `refund_amount` set by the desk; if empty, **defaults to the booking total**.
* TrustBrick: `manual_required` → recorded with `admin_override`, reference, reason.

---

## 4. Policy-versus-code comparison

| Area | Existing policy | Current implementation | Gap | Class |
|---|---|---|---|---|
| Cancellation eligibility | Any booking; written request; phone if <48 h | Customer can self-cancel anything not cancelled/completed, instantly; request path blocked once cancelled | Policy channel (email) ≠ product (button); no eligibility rules (non-refundable fare, departed) | **Decision** |
| Customer confirms amount first (P1) | Required before anything is cancelled | Not implemented: button cancels first, no quote | Directly contradicted | **Not implemented** |
| Cancellation charges | Supplier + taxes + service fee (+ optional processing fee) | No fee, tax or service-fee fields in any cancellation/refund table | Nothing computes or stores deductions | **Not implemented** |
| Refund calculation | Formula in §2; package scale in §7 | Desk types the amount; defaults to full booking total | No calculator; default is the *most generous* outcome | **Not implemented / Decision** |
| Partial refunds | Allowed (§14) | Engine supports partial amounts and multiple attempts; cap = captured balance across cancellations | Policy has no way to *choose* a partial amount (no calculator); partial *cancellation* of travellers/components not modelled | **Partial** |
| Full refunds | Case P9 (unconfirmed booking) | Engine can refund 100 %; nothing marks a booking "we failed to confirm" so no automatic route | Reason code needed | **Partial** |
| Flight cancellation | Fare-rule based; airline charge; partly-used tickets | No fare-rule data used; flags "refund owed" only when supplier reservation missing | No fare-rule/penalty source | **Not implemented / Decision** |
| Hotel cancellation | Flexible vs non-refundable; free-cancel deadline | `cancellation_policy` string and `free_cancellation` flag exist for display; **not used at cancel time**; hotel cancel leaves no refund-owed flag | Deadline never evaluated | **Partial** |
| Package cancellation | Date-based scale, deposit non-refundable | Scale not coded; package cancel frees seats and flags refund owed | Scale only exists as prose | **Not implemented** |
| Payment gateway processing | Original method only, same currency | Provider taken from the payment row (not current config); partial/full via provider API | Matches | **Implemented** |
| TrustBrick manual refunds | (silent) | Manual-record workflow with override | Policy says nothing; "original method" promise is operator-dependent | **Implemented** (policy gap) |
| Refund approval | (silent) | Maker-checker, default all refunds | Not disclosed; fine internally | **Implemented** |
| Refund status tracking | "Ask us which stage" (P12) | Staff see full history; customer sees nothing except a "Refunded" label on the payment | No customer-visible status | **Not implemented** |
| Refund processing timeline | 7 working days to instruct; 5–10 bank | No SLA clock, no working-day logic, no overdue alert (only 24 h stale tally) | Promise unmonitored | **Not implemented** |
| Failed refunds | (silent) | Failed vs uncertain vs processing distinguished; retry safe; uncertain needs operator | No customer or ops alert beyond the admin panel | **Partial** |
| Customer notifications | (silent) | Only "Booking cancelled"; none for approved/rejected/refund started/processed/failed | Whole refund journey is silent | **Not implemented** |
| Duplicate charge refund (P13) | Full refund in 7 working days | No duplicate-charge workflow; reconciliation tab exists separately | Needs verification | **Verify** |
| Duplicate cancellation requests | (silent) | One open request per booking; one open refund per cancellation | Good | **Implemented** |
| Booking modifications (§8) | Quote change fee, nothing altered until approved | Separate change-request module exists | Not audited here | **Verify** |

---

## 5. Missing business rules (decisions required)

Not decided here and not to be guessed:

1. **Channel of record:** is cancellation by email/phone (policy) or self-service button
   (product)? Or button *requests* and desk quotes?
2. **Who may cancel instantly, if anyone:** unpaid / pre-payment bookings only? Paid bookings
   must go through a request?
3. **Default refund when the desk enters no amount:** keep "full total", require an
   explicit amount, or compute?
4. **Service fee:** amount or percentage; is it stored per booking; is the convenience fee
   ever refundable?
5. **Cancellation-processing fee:** exists or not; amount.
6. **Package scale (P8):** confirm the 45/30/15/7-day thresholds and 25/50/75/100 % are
   the real, current terms; define "deposit" per package; behaviour when a package's own
   terms differ.
7. **Flights:** where do airline penalties and refundable-tax figures come from (supplier
   API, fare rules text, manual entry)? What happens for non-refundable fares?
8. **Hotels:** treat `free_cancellation` + deadline as binding? No-show charge rule?
   Who enters the hotel's penalty?
9. **Supplier penalties:** who records the amount the supplier actually charged, and when
   is the customer refund finalised relative to supplier release?
10. **Partial cancellations:** per-traveller / per-component rules; supplement for
    remaining travellers.
11. **Processing SLA:** confirm "7 working days"; what is a working day (calendar, holidays);
    who is alerted on breach; clock start (request, approval, supplier release).
12. **Customer communication:** channels (email/SMS/in-app), which events, wording; whether
    to show provider refund reference to the customer.
13. **Failed gateway refunds:** customer-visible handling and fallback (manual bank
    transfer?) — and the policy's "original payment method only" promise if the gateway
    cannot refund.
14. **TrustBrick refunds:** disclose that these are manual and may take longer?
15. **Approval threshold:** keep "every refund needs a second approver" or set a rupee
    threshold (`REFUND_APPROVAL_THRESHOLD_MINOR`)? Who are the named approvers?
16. **Policy versioning:** the page says the version in force at confirmation applies —
    is the version recorded on the booking? (Currently not.)
17. **Full refund when we fail to confirm (P9):** what triggers it and who authorises it.
18. **Legal review** of the final policy text (consumer-protection, payment-network rules).

---

## 6. Review of the ten architecture rules

| # | Rule | Result | Evidence |
|---|---|---|---|
| 1 | Refund ≤ remaining captured balance | **Implemented** | `_check_against_payment`; tests `exceeds_remaining`, cross-cancellation |
| 2 | Succeeded + processing count | **Implemented** | `COMMITTED = (SUCCEEDED, PROCESSING)`; test `processing_refund_counts` |
| 3 | Maker-checker needs a different authorised user | **Implemented** | `authorize_refund`, `self_approval`; HTTP tests. Default threshold 0 = all refunds |
| 4 | TrustBrick uses manual recording | **Implemented** | `MANUAL_ONLY_PROVIDERS`; TrustBrick adapter raises, never called |
| 5 | Provider API confirms gateway refunds | **Implemented** | Webhook → `fetch_refund`; webhook-only test stays `processing` |
| 6 | Uncertain timeouts stay processing, no auto-resubmit | **Implemented** | `_record_uncertain`; repeat returns the open attempt |
| 7 | Failed distinguishable from processing | **Implemented** | `status` + `uncertain` flag; Razorpay `failed`→FAILED fix |
| 8 | Reconciliation checks unresolved refunds | **Implemented** | `reconcile_pending_refunds`, sweep + endpoint. *Verify:* the sweep only starts when a payment provider is configured (production has `PAYMENT_PROVIDER=none`, so the periodic sweep may not run there; the manual endpoint still works) |
| 9 | Legacy status-only completion cannot mark success | **Implemented** | `complete_refund` returns 400; `decide()` refuses refund actions |
| 10 | Self-cancel does not execute a refund | **Implemented** — but see §7 | Self-cancel only cancels; this is the source of gaps 1–2 |

Mismatches with the customer-facing policy: rules 3, 4, 8 and 10 are internal behaviours
the policy does not mention; rule 10 is the opposite of what the policy implies to the customer.

---

## 7. Security and compliance considerations

* **Silent loss of the audit trail:** a self-cancelled paid hotel (and non-package,
  supplier-reserved flight) booking leaves no "refund owed" trace and no route to the
  refund workflow. Customer money can be held with no operational signal. *Severity: high.*
* **Over-generous default:** an empty amount defaults to the full booking total; combined
  with the 7-day promise this pressures staff toward over-refunding the service fee and
  supplier charges the policy says are retained. Second approver mitigates, does not remove.
* **Misleading customer statements** (P1, P3) may be an unfair-practice / consumer-law
  issue if the product behaves differently; needs legal review.
* **"Original payment method only"** relies on the provider; for TrustBrick it is an
  operator promise recorded after the fact.
* **Payment data in refund records:** provider bodies are stored in `raw_response`
  (Razorpay refund entity; HDFC body is passed through the adapter's redaction). Verify
  retention and access (`refund.view`) with the data-protection owner.
* **Refund approver provisioning:** `refund.authorize` is held by no role; until named
  users are granted it nothing can complete — operationally safe, but must be planned.
* **Migration/rollback:** `0094` is additive; production DB retention is 1 day, so a
  manual snapshot is the restore point (see `REFUND_IMPLEMENTATION.md`, deployment notes).

---

## 8. Customer experience gaps

1. Cancel is instant and irreversible with a one-line confirm and no money information.
2. No quote of refundable amount or deductions before or after cancelling.
3. No place to see: request status, refund status, expected date, provider reference.
4. No emails/notifications for: request received, approved/rejected, refund started,
   processed, failed, manual refund sent.
5. The cancellation-request path exists in the API but has no screen.
6. Hotels show a free-cancellation badge but the cancel flow never uses it.
7. Policy page date (5 Sep 2026) and wording predate the refund engine.

---

## 9. Required business decisions

See §5 (18 items). The blocking ones for any implementation are **1, 2, 3, 6, 11, 12, 15**.

---

## 10. Proposed changes (not implemented)

### 10.1 Policy wording (draft for legal/business approval — *no figures invented*)
* Replace "Nothing is cancelled until you have confirmed the amount" with wording that
  matches the **decided** flow (request → quote → confirm, or instant cancel + refund
  calculated afterwards).
* Add a "How we process your refund" section: request received → reviewed → approved
  (internal second approval) → sent to your original payment method → bank credit.
* State that refunds to some partners are processed manually and may take longer (if decided).
* Replace hard-coded numbers only after §5 items 6 and 11 are confirmed.
* Add policy version/effective date and record the version on each booking.

### 10.2 Refund calculation rules
Introduce a `refund_quote` (per cancellation): `paid`, `supplier_charge`, `taxes_retained`,
`service_fee`, `processing_fee`, `refundable` (≥ 0), `basis` (fare rule / hotel deadline /
package scale / full-refund reason), `entered_by`, `version`. The package scale and hotel
deadline become configuration, flights/hotels penalties are entered or imported per §5.7–5.9.
No default-to-full-total.

### 10.3 Customer refund status tracking
`GET /api/customer/cancellation-requests` (own requests) and a status timeline in the
account Bookings view: Requested → Approved → Refund initiated → Processing → Refunded /
Needs attention, with amount, expected date and reference. Never show "Refunded" until
the server says so.

### 10.4 Admin workflow improvements
Quote editor with line-by-line deductions; SLA clock and "overdue" queue; reason codes
(e.g. unconfirmed booking); show the customer-visible quote beside the refund panel;
bulk reconcile button status; named-approver management guidance.

### 10.5 Customer notifications
Templates (email + in-app) for the events in §8.4, reusing `notification_service`.

### 10.6 Backend changes (files)
* `backend/app/routers/customer_bookings.py`, `customer_hotel_bookings.py`,
  `customer_package_bookings.py` — gate/replace instant cancel for paid bookings; flag refund-owed
  uniformly.
* `backend/app/services/customer_booking_service.py`, `customer_hotel_booking_service.py`,
  `customer_package_booking_service.py` (`cancel`), `supplier_guard.py` — uniform refund-owed flag.
* `backend/app/services/customer_cancellation_admin_service.py` — allow requests on
  cancelled-with-payment bookings; remove default-to-total.
* New `backend/app/services/refund_quote_service.py`, migration `0095_*`, model + schema.
* `backend/app/routers/customer_cancellations.py` — list/get own requests.
* `backend/app/services/customer_refund_service.py` — consume the quote; SLA timestamps.
* `backend/app/services/notification_templates.py` / `notification_service.py` — refund events.
* `backend/app/main.py` — sweep condition (run refund reconciliation without a payment provider).

### 10.7 Frontend changes (files)
`frontend/assets/js/account-center.js` (cancel flow, status timeline),
`frontend/assets/js/admin-b2c-refunds.js` (quote editor, SLA),
`frontend/cancellation-refund-policy.html` (wording, after approval).

### 10.8 Tests
Cancel-paid-booking routes into the request flow for all three products; no instant cancel
with captured payment; quote arithmetic (never negative; package scale boundaries on the
exact day); customer sees only own requests; notifications fire once per event; SLA overdue;
sweep runs with `PAYMENT_PROVIDER=none`; regression: existing refund suites.

---

## 11. Recommended implementation plan (priority order)

| P | Item | Why |
|---|---|---|
| P0 | Decide §5 blockers (1, 2, 3, 6, 11, 12, 15) | Everything else depends on them |
| P0 | Stop paid bookings being self-cancelled with no trace (uniform refund-owed flag; route to request flow) | Money held with no signal |
| P1 | Remove default-to-full-total; require explicit amount | Over-refund risk |
| P1 | Customer request status + notifications | Policy P12 and CX |
| P1 | Align policy wording to the decided flow | Misleading statements |
| P2 | Refund quote/calculator (package scale, hotel deadline) | Policy fidelity |
| P2 | SLA clock + overdue queue; sweep without provider | 7-day promise |
| P3 | Flight penalties source; partial cancellations by traveller/component | Needs supplier data |

---

## 12. Acceptance criteria

1. A paid booking cannot be cancelled without creating a request/trace that reaches the refund desk, on all three products.
2. No product text says "refunded" or promises an amount that the server has not confirmed.
3. A customer sees the status of their cancellation and refund and receives a notification for each event.
4. A refund amount is always an explicit, itemised figure; it is never silently the full total.
5. Every policy sentence on the page maps to a tested behaviour or is removed.
6. The processing-time promise is measurable and breaches are visible to staff.
7. All existing refund, payment and cancellation tests still pass; new tests cover the above.

---

## 13. Ready / not ready for production

| Ready (once deployed and approvers granted) | Not ready |
|---|---|
| Refund engine, caps, idempotency, maker-checker, TrustBrick manual record, reconciliation endpoint, admin panel | Policy-aligned customer cancellation flow; refund calculation; customer status and notifications; SLA tracking; hotel/flight refund-owed trace; policy wording |

*This audit changes no behaviour. Implementation waits for approval and the decisions in §5.*
