# Refund Architecture Corrections

**Date:** 2026-10-31
**Scope:** Design only. No code changed.

---

## Correction 1 — Payment-level cumulative refund protection

### The problem

The original D1 design validates that a single refund amount does not exceed
the captured amount: `amount_minor ≤ captured_amount_minor`. This prevents a
single over-refund but does NOT prevent over-refunding across multiple
cancellations linked to the same payment.

**Example:**
- Captured payment: ₹10,000.
- Cancellation A: admin refunds ₹7,000 → succeeds (₹7,000 ≤ ₹10,000).
- Cancellation B: admin refunds ₹5,000 → would also pass the single check
  (₹5,000 ≤ ₹10,000), but the cumulative ₹12,000 exceeds the captured ₹10,000.

This is the highest-severity financial bug possible in a refund system.

### Design: payment-level accounting

The protection must operate at the **payment row** level, not the cancellation
level. Two cancellations can legitimately reference the same payment (e.g. a
group booking with separate cancellation requests for different travellers, or
a cancellation that was rejected and resubmitted).

#### 1. What counts toward the total

| Attempt status | Counts toward cumulative total? | Why |
|---|---|---|
| `succeeded` | **Yes** | Money has left the account |
| `processing` | **Yes** | Money may already be in transit; the provider has accepted the request |
| `pending` | **No** | Not yet submitted to the provider |
| `failed` | **No** | Provider rejected it; no money moved |
| `manual_required` | **No** | TrustBrick; no gateway call was made |

**Critical:** `processing` attempts MUST count. If we exclude them, two
concurrent requests whose first hasn't completed yet could both pass the check.

#### 2. The validation function

```python
def _remaining_refundable(
    db: Session,
    payment_table: str,
    payment_row_id: int,
    captured_amount_minor: int,
) -> int:
    """How many paise can still be refunded against this payment row.

    Sums all attempts that have already moved or may be moving money
    (succeeded + processing). Returns the remainder against the captured
    amount. Can return 0 (fully refunded) or negative (over-refunded —
    should never happen, but if it does, the caller must refuse).
    """
    committed = db.execute(
        select(func.coalesce(func.sum(CustomerRefundAttempt.amount_minor), 0))
        .where(
            CustomerRefundAttempt.payment_table == payment_table,
            CustomerRefundAttempt.payment_row_id == payment_row_id,
            CustomerRefundAttempt.status.in_(("succeeded", "processing")),
        )
    ).scalar()

    return captured_amount_minor - committed
```

#### 3. The validation in execute_refund

```python
def execute_refund(db, cancellation_ref, admin_user_id):
    # ... resolve cancellation, booking, payment row ...

    # Lock the payment row to serialise concurrent refund attempts.
    # This prevents two admins from reading the same "remaining" value
    # and both proceeding.
    payment_row = db.execute(
        select(PaymentModel)
        .where(PaymentModel.id == payment_row_id)
        .with_for_update()
    ).scalar_one()

    captured = payment_row.amount_minor  # what the provider confirmed
    remaining = _remaining_refundable(
        db, payment_table, payment_row_id, captured
    )

    if remaining <= 0:
        raise RefundFullyExhausted(
            f"Payment {payment_row_id} is fully refunded or has "
            f"processing refunds covering the full amount."
        )

    if amount_minor > remaining:
        raise RefundExceedsRemaining(
            f"Requested {amount_minor} paise but only {remaining} "
            f"remains (captured={captured}, already committed="
            f"{captured - remaining})."
        )

    # ... proceed with provider call ...
```

#### 4. Concurrency protection

**Layer 1 — `SELECT FOR UPDATE` on the payment row:**
Before reading the remaining amount, the payment row is locked with
`FOR UPDATE`. Any concurrent `execute_refund` for the same payment blocks
here until the first transaction commits or rolls back. This serialises all
refund attempts against the same payment.

**Layer 2 — `UNIQUE(provider, idempotency_key)` on `customer_refund_attempts`:**
Even if two transactions somehow both proceed (which `FOR UPDATE` prevents),
the unique index on the idempotency key ensures only one row is inserted. The
second transaction gets an `IntegrityError` and rolls back.

**Layer 3 — Provider-side idempotency:**
- Razorpay: `receipt` field rejects duplicate refunds.
- HDFC: `unique_request_id` rejects duplicate refunds.
- TrustBrick: raises before any HTTP call.

These three layers are independent. Any single layer failing does not result
in a double-refund.

#### 5. Failed and retryable attempts

When a refund attempt fails (`provider raises PaymentFailed`), the attempt is
recorded as `failed`. It does NOT count toward the cumulative total, so a
retry is permitted.

The retry generates a **new** `attempt_number` and therefore a **new**
idempotency key. This is correct: the original key is burned at the provider
(Razorpay remembers `receipt` values even for failed attempts), so a retry
with the same key would fail at the provider. A new key with the same amount
is a new request.

Before the retry, `_remaining_refundable` is re-evaluated. If the original
attempt actually succeeded at the provider (the failure was on our side — e.g.
a timeout where the provider processed the request but we didn't receive the
response), the reconciliation sweep will have moved it to `succeeded`,
and the remaining amount will reflect that. The retry will see less available
and either proceed (if partial) or be rejected (if full).

#### 6. Partial and full refunds

**Full refund:** `amount_minor == captured_amount_minor` after subtracting
prior committed amounts. After this succeeds, `remaining` is 0, and any
further refund attempt against this payment is rejected.

**Partial refund:** `amount_minor < remaining`. The leftover can be refunded
by a future cancellation request.

**One-refund-per-cancellation rule (Q2):** In addition to the payment-level
check, the service also checks that this specific cancellation does not already
have a `succeeded` attempt. This prevents an admin from accidentally clicking
"start refund" twice on the same cancellation. The payment-level check handles
the cross-cancellation case.

#### 7. Per-provider behaviour

| Provider | Payment-level check | Provider-side guard | What happens if our check fails |
|---|---|---|---|
| **Razorpay** | `_remaining_refundable` as above | Razorpay enforces: "Refund amount exceeds the payment amount" (HTTP 400). Also enforces per-refund receipt uniqueness. | Double protection. Even without our check, Razorpay rejects the over-refund. But relying solely on the provider is fragile (different providers, different error codes). |
| **HDFC** | Same | HDFC enforces: refund amount cannot exceed the order's charged amount minus prior refunds. Also enforces `unique_request_id`. | Double protection. Same reasoning. |
| **TrustBrick** | Same check runs, but `refund()` raises `refund_unsupported` before any HTTP call | N/A — no gateway call | The TrustBrick path records `manual_required`. When the admin later uses `complete_refund` with `admin_override: true`, the system records a `succeeded` attempt with the amount the admin specifies. This amount is validated against `_remaining_refundable` at the time of the override. |
| **Mock** | Same check runs | Mock checks `amount ≤ captured` but has no cross-refund memory | Tests must set up prior attempts to exercise the cumulative check. |

#### 8. Tests

| Test | What it verifies |
|---|---|
| `test_refund_single_full` | One full refund succeeds; second attempt is rejected |
| `test_refund_two_partials` | Two partial refunds that sum to captured amount both succeed |
| `test_refund_partial_then_over` | Partial succeeds; second attempt exceeding remainder is rejected |
| `test_refund_cross_cancellation` | Two cancellations, same payment; cumulative check prevents over-refund |
| `test_refund_processing_blocks_second` | First attempt in `processing`; second attempt for remaining amount only |
| `test_refund_failed_does_not_block` | Failed attempt does not reduce available balance |
| `test_refund_concurrent_locked` | Two concurrent calls serialised by `FOR UPDATE`; second sees first's committed amount |
| `test_trustbrick_override_respects_cumulative` | Admin override on TrustBrick validates against prior refunds |

---

## Correction 2 — Robust refund webhook correlation

### The problem

The original D1 design says `complete_refund_from_webhook(db, provider,
provider_refund_id)` looks up the attempt by `provider_refund_id`. This has
two flaws:

1. **Not all webhooks carry a refund id at the top level.** Razorpay's
   `refund.processed` webhook carries `entity.id` (the refund id) and
   `entity.payment_id` (the payment id) inside a nested structure. HDFC's
   webhook carries the `order_id` and may or may not include a refund-specific
   id.

2. **Matching by refund id alone could match the wrong attempt** if a provider
   reuses ids (unlikely but defensive coding says: don't rely on one field).

3. **A single "find first processing attempt" match could advance the wrong
   cancellation** if two cancellations have processing refunds against the
   same payment (now possible with the payment-level accounting above).

### Design: multi-field correlation with ambiguity deferral

#### 1. The correlation function

```python
def correlate_refund_webhook(
    db: Session,
    *,
    provider: str,
    provider_payment_id: str | None,
    provider_order_id: str | None,
    provider_refund_id: str | None,
    webhook_amount_minor: int | None,
    webhook_currency: str | None,
) -> CustomerRefundAttempt | None:
    """Find the refund attempt this webhook is about, or None.

    Returns an attempt only when the match is unambiguous. If multiple
    processing attempts match, returns None (the caller defers the event
    for reconciliation rather than guessing).
    """
```

#### 2. Matching strategy (in order)

**Step A — Find the payment row:**
Use the existing `find_payment(db, provider, payment)` function. This resolves
by `provider_payment_id` first, then `provider_order_id` — the same logic
that capture webhooks already use. If no payment row is found, return None
(not our payment).

**Step B — Find candidate attempts:**
Query `customer_refund_attempts` for this payment row with status `processing`:

```python
candidates = db.execute(
    select(CustomerRefundAttempt)
    .where(
        CustomerRefundAttempt.payment_table == payment_table_name(row),
        CustomerRefundAttempt.payment_row_id == row.id,
        CustomerRefundAttempt.status == "processing",
    )
    .order_by(CustomerRefundAttempt.created_at)
).scalars().all()
```

**Step C — Narrow by provider_refund_id (strongest match):**
If the webhook provides a `provider_refund_id` AND an attempt already has
the same `provider_refund_id` stored → that is the match. Return it.

```python
if provider_refund_id:
    for c in candidates:
        if c.provider_refund_id == provider_refund_id:
            return c
```

**Step D — Narrow by amount (secondary match):**
If the webhook provides an amount, filter candidates to those whose
`amount_minor` matches:

```python
if webhook_amount_minor is not None:
    amount_matched = [
        c for c in candidates
        if c.amount_minor == webhook_amount_minor
    ]
    if len(amount_matched) == 1:
        # Unambiguous by amount. Store the refund id if the webhook
        # provided one.
        match = amount_matched[0]
        if provider_refund_id and not match.provider_refund_id:
            match.provider_refund_id = provider_refund_id
        return match
    if len(amount_matched) > 1:
        # Ambiguous — two processing attempts for the same amount
        # against the same payment. Defer.
        return None
```

**Step E — Single candidate fallback:**
If exactly one `processing` attempt exists for this payment, and no
contradicting data was found, that is the match:

```python
if len(candidates) == 1:
    match = candidates[0]
    if provider_refund_id and not match.provider_refund_id:
        match.provider_refund_id = provider_refund_id
    return match
```

**Step F — Ambiguous or no match → defer:**
If zero candidates or multiple candidates with no distinguishing data,
return None. The event is recorded as `deferred` and the reconciliation
sweep will resolve it.

#### 3. What happens when correlation returns None

The event is already recorded in `payment_provider_events` (the signature was
verified, the body is stored). The `apply_event` function currently returns
`DEFERRED` for `_NEEDS_VERIFICATION` statuses. The refund correlation is
called from this path:

```python
# In apply_event, when incoming status is REFUNDED:
if incoming == payment_providers.REFUNDED:
    attempt = correlate_refund_webhook(
        db,
        provider=provider,
        provider_payment_id=payment.provider_payment_id,
        provider_order_id=payment.provider_order_id,
        provider_refund_id=getattr(payment, 'provider_refund_id', None),
        webhook_amount_minor=getattr(payment, 'amount_minor', None),
        webhook_currency=getattr(payment, 'currency', None),
    )
    if attempt is None:
        return DEFERRED, (
            f"{event.event_type}: refund event received but could not be "
            f"unambiguously matched to a refund attempt. Deferred for "
            f"reconciliation."
        )
    # Advance the attempt and cancellation
    return _complete_refund_attempt(db, attempt, event)
```

The deferred event stays in the `payment_provider_events` table with
`processing_status = 'deferred'`. The reconciliation sweep picks it up and
re-attempts correlation after checking the provider's API directly.

#### 4. Advancing the attempt and cancellation

Once a match is confirmed:

```python
def _complete_refund_attempt(
    db: Session,
    attempt: CustomerRefundAttempt,
    event: ProviderEvent,
) -> tuple[str, str]:
    """Advance a matched refund attempt to succeeded."""
    # Lock the cancellation row to prevent concurrent state changes
    cancellation = db.execute(
        select(CustomerCancellationRequest)
        .where(
            CustomerCancellationRequest.cancellation_ref
            == attempt.cancellation_ref
        )
        .with_for_update()
    ).scalar_one()

    attempt.status = "succeeded"
    attempt.provider_status = event.payment.provider_status
    attempt.updated_at = now()

    # Store the refund id if not already stored
    if (
        event.payment.provider_refund_id
        and not attempt.provider_refund_id
    ):
        attempt.provider_refund_id = event.payment.provider_refund_id

    # Advance cancellation only if it is in refund_processing
    if cancellation.status == "refund_processing":
        cancellation.status = "refunded"
        cancellation.updated_at = now()
    # If cancellation is already "refunded" (admin override beat the webhook),
    # do nothing — the attempt is still marked succeeded for the audit trail.

    db.flush()
    return PROCESSED, (
        f"Refund webhook matched attempt {attempt.refund_attempt_id}; "
        f"cancellation {cancellation.cancellation_ref} → refunded."
    )
```

#### 5. TrustBrick safety

TrustBrick refunds are manual. The `complete_refund` admin action with
`admin_override: true` is the ONLY path to mark a TrustBrick cancellation as
"refunded". This path:

1. Does NOT call `correlate_refund_webhook` (it is not a webhook).
2. Directly sets the attempt status to `succeeded`.
3. Requires `admin_override: true` in the request body.
4. Logs the admin's user id, the override flag, and the timestamp.
5. Validates the amount against `_remaining_refundable`.

A TrustBrick webhook with `REFUNDED` status (if TrustBrick ever sends one)
would be deferred — there is no `processing` attempt for TrustBrick (all
TrustBrick attempts are `manual_required`), so `correlate_refund_webhook`
returns None.

**There is no code path by which a TrustBrick manual override is confused
with an automatic gateway confirmation.**

#### 6. Per-provider webhook anatomy

| Provider | Webhook event type | Payment ID field | Refund ID field | Amount field | How `correlate_refund_webhook` receives it |
|---|---|---|---|---|---|
| **Razorpay** | `refund.processed`, `refund.failed`, `refund.speed_changed` | `payload.refund.entity.payment_id` | `payload.refund.entity.id` | `payload.refund.entity.amount` (paise) | The Razorpay adapter's `parse_webhook` extracts these into a `ProviderEvent` with `payment.provider_payment_id`, `payment.provider_refund_id`, `payment.amount_minor` |
| **HDFC** | Order status notification with refund details | `order_id` in the notification | `refund_id` if present in the refund array | `refund_amount` | The HDFC adapter's `parse_webhook` extracts these similarly |
| **TrustBrick** | N/A — no refund webhooks expected | N/A | N/A | N/A | If one arrives, the adapter parses it; `correlate_refund_webhook` finds no `processing` attempt and defers |

#### 7. Idempotency of the webhook handler

A duplicate webhook is already handled by `record_event` in
`payment_event_service.py` — it raises `DuplicateEvent` from the unique
index on `(provider, provider_event_id)`. A duplicate delivery never reaches
`correlate_refund_webhook`.

If two different events both report the same refund as completed (some
providers send both a refund event and an order-level event), the second
call to `_complete_refund_attempt` finds the attempt already `succeeded` and
the cancellation already `refunded`. It records the event as `processed`
(for the audit trail) but makes no state change.

#### 8. Tests

| Test | What it verifies |
|---|---|
| `test_webhook_match_by_refund_id` | Webhook with provider_refund_id matches the attempt that has it |
| `test_webhook_match_by_amount_single` | One processing attempt, amount matches → succeeds |
| `test_webhook_match_single_candidate` | One processing attempt, no refund id → matches by elimination |
| `test_webhook_ambiguous_deferred` | Two processing attempts, same amount, no refund id → deferred |
| `test_webhook_no_processing_attempt` | No processing attempt for this payment → deferred |
| `test_webhook_stores_refund_id` | Webhook provides refund id that attempt didn't have → stored |
| `test_webhook_already_succeeded` | Attempt already succeeded (admin override or prior webhook) → no-op, still processed |
| `test_webhook_duplicate_event` | Same event id twice → DuplicateEvent on second, no double-advance |
| `test_webhook_razorpay_refund_processed` | Razorpay `refund.processed` payload → correctly extracted and matched |
| `test_webhook_hdfc_refund_in_order` | HDFC order notification with refund → correctly extracted and matched |
| `test_webhook_trustbrick_refund_deferred` | TrustBrick refund event (hypothetical) → no match, deferred |
| `test_webhook_wrong_payment_ignored` | Refund event for unknown payment → ignored |
| `test_webhook_amount_mismatch_deferred` | Refund event amount doesn't match any processing attempt → deferred |

---

## Summary of changes to the D1 design

| Original D1 design | Corrected design |
|---|---|
| Validates `amount ≤ captured` per call | Validates `amount ≤ remaining` across ALL attempts for this payment |
| Does not count `processing` attempts | Counts `processing` attempts toward committed total |
| No cross-cancellation check | Cross-cancellation cumulative check via payment-level accounting |
| `complete_refund_from_webhook(provider, refund_id)` | `correlate_refund_webhook(provider, payment_id, order_id, refund_id, amount, currency)` — multi-field, ambiguity → defer |
| Matches first processing attempt | Matches by refund id (best), then amount (if unique), then single-candidate (if only one), else defers |
| No lock on payment row | `SELECT FOR UPDATE` on payment row serialises concurrent attempts |
| TrustBrick override was implicit | TrustBrick override is a separate code path with explicit `admin_override: true`, amount validation, and audit logging |
