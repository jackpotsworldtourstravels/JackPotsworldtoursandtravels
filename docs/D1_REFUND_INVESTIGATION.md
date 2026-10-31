# D1 — Payment Refund Lifecycle Investigation

**Date:** 2026-10-31 · **Branch:** `claude/jackpotsworld-competitor-audit-7fe581`
**Scope:** Read-only audit. No code changed, no refund executed, no production system touched.

---

## 1. Current implementation findings

### 1.1 The cancellation request lifecycle (what exists)

The B2C cancellation/refund workflow is in `customer_cancellation_admin_service.py` (Phase 3 of the B2C Admin Portal). It is a five-state machine:

```
Customer submits → requested
                      │
         approve ─────┼───→ approved    (booking.status set to "cancelled")
         reject ──────┘───→ rejected
                              │
            start_refund ─────┴───→ refund_processing
                                        │
               complete_refund ─────────┴───→ refunded
```

**The critical gap:** `start_refund` and `complete_refund` are manual admin actions — PATCH `/api/admin/cancellations/{id}` with `action: "start_refund"` or `action: "complete_refund"`. Neither calls any payment provider. The module's own docstring (line 5-11) states this explicitly:

> "NO NEW MONEY MOVEMENT. This module changes `CustomerCancellationRequest.status` … it never touches a payment row or calls a payment provider … Marking a request `refunded` here records the admin desk's word that the money actually went back — by bank transfer, by the provider's own dashboard, whatever the desk actually did — not an instruction to any gateway."

**What this means for customers:**
- A customer sees "refunded" when an admin clicks a button. No gateway refund is initiated.
- There is no `provider_refund_id`, no refund confirmation from any gateway, and no reconciliation that the money actually moved.
- The `refund_amount` field on `CustomerCancellationRequest` is set by the admin (nullable `Numeric(12,2)`), not computed from or verified against any gateway response.

### 1.2 The payment provider contract (what is built but unused)

Every payment provider implements the `PaymentProvider` protocol (`services/payments/base.py`), which includes:

```python
def refund(
    self,
    *,
    provider_payment_id: str,
    amount_minor: int,       # paise
    idempotency_key: str,
    notes: Mapping[str, Any] | None = None,
) -> ProviderRefund:
```

Returns a `ProviderRefund` dataclass:
```python
@dataclasses.dataclass(frozen=True)
class ProviderRefund:
    provider_refund_id: str
    status: str              # REFUNDED or PROCESSING
    provider_status: str     # vendor's own word
    amount_minor: int
    currency: str
    raw: Mapping[str, Any]
```

**This method exists on all four providers. None is ever called.**

A `grep -rn "\.refund(" backend/app` finds the method definitions and one docstring reference in `customer_package_booking_service.py:321`, but **zero call sites**.

### 1.3 Per-provider refund capabilities

| Provider | `refund()` implementation | Idempotency mechanism | Partial refund? | Status mapping | Notes |
|---|---|---|---|---|---|
| **Razorpay** | `POST /payments/{id}/refund` | `receipt` field = hashed idempotency key; Razorpay rejects duplicate receipts | Yes (any positive amount ≤ captured) | `processed` → REFUNDED; anything else → PROCESSING | Well-documented API; production-ready code |
| **HDFC SmartGateway** | `POST /orders/{order_id}/refunds` | `unique_request_id` = `"RF" + SHA256(key)[:28]` | Yes (amount in rupees, form-encoded) | Maps via `_REFUND_STATUS` dict (SUCCESS→REFUNDED, else PROCESSING) | Refunds only CHARGED orders; auto-capture means most orders are charged |
| **TrustBrick** | **Raises `PaymentProviderError("refund_unsupported")`** | N/A | N/A | N/A | TrustBrick's partner API exposes no refund endpoint; refunds are an operator action on TrustBrick's side |
| **Mock** | In-memory; checks payment is CAPTURED, amount ≤ captured | N/A (in-memory) | Yes | Always returns REFUNDED | For tests only |

### 1.4 Webhook and event handling for refunds

The `payment_event_service.py` already handles refund webhooks partially:

- `_NEEDS_VERIFICATION` includes `REFUNDED` (line 96-99), meaning a refund webhook is **deferred** for Phase 6 verification, not applied directly.
- `verify_payment_row()` dispatches to product-specific verifiers (`payment_verification_service`, `payment_verification_flight_service`, `payment_verification_hotel_service`).
- However, these verifiers are built for **capture** verification, not refund verification. They check amount/currency/ownership to confirm money **arrived**, not that it was **returned**.

The payment status vocabulary already includes `REFUNDED` with rank 4 (above CAPTURED at rank 3), so `is_forward(CAPTURED, REFUNDED)` returns True — a refund status would correctly advance a captured payment.

### 1.5 Reconciliation

`reconcile_stale_pending()` in `payment_verification_service.py` re-verifies payments whose webhook may not have arrived. It runs on a periodic sweep (`_payment_sweep_loop` in `main.py`). Currently it handles only HDFC (`providers: tuple[str, ...] = ("hdfc",)`). **There is no refund reconciliation sweep.**

### 1.6 The parallel self-cancel path

Separately from the admin-reviewed path, customers can self-cancel instantly via:
- `POST /api/customer/bookings/{ref}/cancel` (flights)
- `POST /api/customer/hotel-bookings/{ref}/cancel` (hotels)
- `POST /api/customer/package-bookings/{ref}/cancel` (packages)

These set `booking.status = "cancelled"` with **no refund attempt at all**. The admin-reviewed path (`/api/customer/cancellation-requests`) was added as a second track for cases requiring review (past free-cancellation window, partial refund, special fare).

### 1.7 Database schema for refunds

**What exists:**
- `customer_cancellation_requests.refund_amount` — admin-entered nullable Numeric
- `customer_cancellation_requests.status` — includes `refund_processing`, `refunded`
- `payment_provider_events` — records webhook deliveries (has `provider_payment_id`, `provider_order_id`, `processing_status`)
- Payment tables (`CustomerBookingPayment`, `CustomerHotelBookingPayment`, `CustomerPackageBookingPayment`) — all carry `provider`, `provider_payment_id`, `provider_order_id`, `status`

**What does NOT exist:**
- No `refund_attempts` or `refund_requests` table
- No `provider_refund_id` column on any table
- No link between a `CustomerCancellationRequest` and the payment row it should refund
- No refund idempotency key stored anywhere

---

## 2. Proposed changes

### 2.1 New: `customer_refund_attempts` table (migration 0094)

```
customer_refund_attempts
├── refund_attempt_id          SERIAL PK
├── cancellation_ref           FK → customer_cancellation_requests
├── payment_table              VARCHAR(40)   — which of the 3 payment tables
├── payment_row_id             INT           — PK in that table
├── provider                   VARCHAR(20)   — razorpay / hdfc / trustbrick
├── provider_refund_id         VARCHAR(120)  — from ProviderRefund
├── idempotency_key            VARCHAR(80)   UNIQUE
├── amount_minor               INT           — paise
├── currency                   VARCHAR(10)   — INR
├── status                     VARCHAR(20)   — pending / processing / succeeded / failed
├── provider_status            VARCHAR(40)
├── failure_reason             TEXT
├── raw_response               JSONB
├── created_at                 TIMESTAMPTZ
├── updated_at                 TIMESTAMPTZ
├── UNIQUE(provider, idempotency_key)
```

### 2.2 Refund execution service: `customer_refund_service.py`

A new service with these functions:

1. **`execute_refund(db, cancellation_ref, admin_user_id)`**
   - Finds the cancellation request (must be `approved` or `refund_processing`)
   - Finds the payment row via the booking reference
   - Checks the payment is `captured` (you cannot refund what was never captured)
   - Determines the provider via the payment row's `provider` field
   - Generates a deterministic idempotency key: `f"rfnd-{cancellation_ref}-{payment_row_id}-{attempt_number}"`
   - Calls `provider.refund()` within a try/except
   - Records a `customer_refund_attempts` row regardless of outcome
   - On success: updates cancellation status to `refund_processing` (if provider returned PROCESSING) or `refunded` (if provider returned REFUNDED)
   - On failure: records the error, leaves status as `refund_processing`, creates an alert
   - **Does NOT auto-retry** — a failed attempt requires admin review

2. **`complete_refund_from_webhook(db, provider, provider_refund_id)`**
   - Called when a provider webhook reports a refund completed
   - Looks up the `customer_refund_attempts` row by `provider_refund_id`
   - Advances the attempt to `succeeded`
   - Advances the cancellation to `refunded`
   - Only transitions if the cancellation is currently `refund_processing`

3. **`reconcile_pending_refunds(db, limit)`**
   - Periodic sweep for refund attempts stuck in `processing`
   - Re-queries the provider via `provider.fetch_payment()` or a refund status endpoint
   - Updates status based on provider response

### 2.3 Modified: cancellation admin transitions

The `start_refund` action in `customer_cancellation_admin_service.decide()` should **call the gateway** instead of being a status-only change:

```
Current:  start_refund  → sets status to "refund_processing" (manual)
Proposed: start_refund  → calls execute_refund() → sets status based on gateway response
```

The `complete_refund` action becomes **admin-only override** for cases where:
- The provider is TrustBrick (no refund API — the admin manually refunded via TrustBrick dashboard)
- The gateway call failed but the admin confirmed the refund was completed out-of-band
- An explicit `admin_override: true` flag is required in the request

### 2.4 Modified: customer-facing status labels

| Internal status | Current customer label | Proposed customer label |
|---|---|---|
| `requested` | Cancellation requested | Cancellation requested |
| `approved` | Approved | Cancellation approved |
| `refund_processing` | Refund processing | Refund initiated — being processed by payment provider |
| `refunded` | Refunded | Refunded ✓ (with refund reference if available) |

**Interim (before implementation):** relabel customer-facing "refunded" as "Refund initiated" until gateway refunds are wired — this is a frontend-only change and is the safest immediate action.

### 2.5 Provider-specific refund routing

The refund service must resolve the correct provider for each payment, using the `provider` column already on the payment row — **not** `get_provider()`, which returns the currently configured provider. A payment collected by Razorpay 6 months ago must be refunded through Razorpay even if the deployment has since switched to HDFC.

TrustBrick payments: `refund()` raises `refund_unsupported`. The refund service catches this specifically, records the attempt as `manual_required`, and the admin must refund via TrustBrick's dashboard, then use `complete_refund` with `admin_override: true`.

---

## 3. Files that would be affected

| File | Change | Risk |
|---|---|---|
| `backend/alembic/versions/0094_refund_attempts.py` | **New** migration | Low — additive table, nullable FK |
| `backend/app/models_customer.py` | New `CustomerRefundAttempt` model | Low — additive |
| `backend/app/services/customer_refund_service.py` | **New** refund execution service | Medium — calls payment gateway |
| `backend/app/services/customer_cancellation_admin_service.py` | `start_refund` calls gateway via new service | Medium — changes existing state machine behaviour |
| `backend/app/routers/admin_cancellations.py` | Error handling for gateway failures on `start_refund` | Low |
| `backend/app/services/payment_event_service.py` | Handle refund webhook events | Medium — extends existing webhook processing |
| `backend/app/services/payment_verification_service.py` | Refund verification path | Medium |
| `backend/app/main.py` | Add refund reconciliation to sweep | Low |
| `frontend/*/js/cancellation*.js` or equivalent | Customer-facing status labels | Low — display only |
| `backend/tests/test_refund_service.py` | **New** test suite | N/A |
| `backend/tests/test_cancellation_refund_integration.py` | **New** integration tests | N/A |

---

## 4. Security and operational risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RF1 | **Double refund** — retried gateway call creates two refunds | Medium | High | Idempotency key per attempt stored in DB and sent to provider; both Razorpay (`receipt`) and HDFC (`unique_request_id`) honour it |
| RF2 | **Refund more than captured** — admin enters wrong amount | Low | High | Service validates `amount_minor ≤ captured_amount_minor` from the payment row before calling the provider |
| RF3 | **Wrong provider** — refund sent to a different provider than collected | Low | High | Provider resolved from the payment row's `provider` column, not from current config |
| RF4 | **TrustBrick refund gap** — no API, admin must act manually | High (for TrustBrick payments) | Medium | Clear error message; `manual_required` status; audit trail |
| RF5 | **Refund webhook not received** — provider refunded but we don't know | Medium | Medium | Reconciliation sweep re-checks `processing` attempts |
| RF6 | **Stale refund_processing** — attempt stuck with no resolution | Medium | Medium | Alert on attempts older than 24h; admin dashboard shows stuck refunds |
| RF7 | **Race: two admins click start_refund simultaneously** | Low | High | DB-level unique constraint on idempotency key; `SELECT FOR UPDATE` on cancellation row |
| RF8 | **Payment row not found** — booking has no payment (demo mode, default none) | High (for current prod) | Low | Service checks payment exists and is `captured` before attempting; clear error "No captured payment found for this booking" |

---

## 5. Test plan

### 5.1 Unit tests (mock provider, no DB)

| Test | Description |
|---|---|
| `test_refund_happy_path` | Captured payment → refund() succeeds → attempt row = succeeded, cancellation = refunded |
| `test_refund_partial` | Amount < captured → provider accepts → records partial amount |
| `test_refund_idempotency_key_deterministic` | Same inputs produce same key; different attempt number produces different key |
| `test_refund_provider_returned_processing` | Provider returns PROCESSING → attempt = processing, cancellation stays refund_processing |
| `test_refund_provider_failure` | Provider raises PaymentFailed → attempt = failed, cancellation stays refund_processing |
| `test_refund_provider_timeout` | Provider raises PaymentTimeout → attempt = failed (retryable), not refunded |
| `test_refund_trustbrick_unsupported` | TrustBrick raises refund_unsupported → attempt = manual_required |
| `test_refund_amount_exceeds_captured` | Amount > captured → rejected before calling provider |
| `test_refund_payment_not_captured` | Payment status = pending → rejected |
| `test_refund_no_payment_row` | No payment for this booking → clear error |
| `test_refund_wrong_cancellation_status` | Cancellation not in approved/refund_processing → rejected |
| `test_double_refund_race` | Two concurrent calls with same idempotency key → one succeeds, one is idempotent |
| `test_refund_resolves_correct_provider` | Payment collected by razorpay, current config is hdfc → refund goes to razorpay |

### 5.2 Webhook / event tests

| Test | Description |
|---|---|
| `test_refund_webhook_completes_processing_attempt` | Refund webhook received → attempt succeeded, cancellation refunded |
| `test_refund_webhook_duplicate` | Same webhook twice → second is no-op |
| `test_refund_webhook_no_matching_attempt` | Webhook for unknown refund → ignored, logged |

### 5.3 Reconciliation tests

| Test | Description |
|---|---|
| `test_reconcile_processing_refund_now_succeeded` | Sweep finds processing attempt, provider says succeeded → attempt succeeded |
| `test_reconcile_processing_refund_still_processing` | Provider says still processing → no change |
| `test_reconcile_stale_alert` | Attempt > 24h old still processing → alert created |

### 5.4 Integration tests (mock provider, real DB on SQLite)

| Test | Description |
|---|---|
| `test_full_lifecycle` | Customer books → pays → requests cancel → admin approves → admin starts refund → gateway confirms → customer sees refunded |
| `test_lifecycle_trustbrick` | Same flow but TrustBrick → manual_required → admin overrides complete_refund |

All tests use the **mock provider**. No real gateway calls.

---

## 6. Rollback strategy

| Step | Rollback |
|---|---|
| Migration 0094 | `alembic downgrade 0093` drops the `customer_refund_attempts` table; no data in it yet |
| New service file | Delete `customer_refund_service.py`; no other file imports it until wired |
| Modified `start_refund` in cancellation service | Revert the one function; the state machine returns to manual-only |
| Webhook changes | Revert; refund events stay deferred (existing behaviour) |
| Frontend labels | Revert CSS/JS; labels return to current text |
| **Emergency:** if a deployed refund goes wrong | The idempotency key prevents double-refund; a failed attempt is recorded and can be inspected; the cancellation does NOT advance to `refunded` unless the provider confirmed |

---

## 7. Decisions requiring your approval

| ID | Decision | Recommendation |
|---|---|---|
| RD1 | **Interim label change:** rename customer-facing "refunded" to "Refund initiated" NOW, before any gateway work, as a frontend-only change? | **Yes** — this is the lowest-risk honest fix |
| RD2 | **Proceed with implementation** of the refund execution service, migration 0094, and test suite as described? | Recommend yes, on an isolated branch |
| RD3 | **TrustBrick policy:** accept that TrustBrick refunds remain manual, with an admin override path? Or block TrustBrick payments until a refund API exists? | Accept manual with audit trail |
| RD4 | **Self-cancel path:** should the instant self-cancel endpoints also trigger a gateway refund (for captured payments), or remain cancellation-only? | Defer — those endpoints are used for free-cancellation; a refund there adds complexity and risk |
| RD5 | **Reconciliation sweep:** add refund reconciliation to the existing payment sweep, or run it separately? | Same sweep, separate function, different cadence (every 30 min vs every 5 min for captures) |
