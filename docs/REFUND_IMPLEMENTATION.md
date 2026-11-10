# B2C refund execution - implementation notes

Implements the design in `D1_REFUND_INVESTIGATION.md` as corrected by
`REFUND_ARCHITECTURE_CORRECTIONS.md`. Nothing here executes a refund by itself:
a refund moves only when a person holding `refund.execute` starts it against a
captured payment (and, by default, a second person approves it).

## What exists

| Piece | Where |
|---|---|
| Attempt table | `alembic/versions/0094_customer_refund_attempts.py`, `CustomerRefundAttempt` in `models_customer.py` |
| Service | `services/customer_refund_service.py` |
| Endpoints | `routers/admin_cancellations.py` (`/refund`, `/refund/attempts/{id}/authorize`, `/refund/manual`, `/refund/attempts/{id}/resolve-failed`, `/refunds/reconcile`) |
| Provider contract | `fetch_refund()` added; `PaymentProviderError.definitive`; `ProviderPayment.refunds` / `ProviderRefund.request_ref` (Razorpay, HDFC, TrustBrick, mock) |
| Webhook routing | `payment_event_service.apply_event` hands refund notices to `handle_refund_event` |
| Sweep | `main._run_payment_sweep` calls `reconcile_pending_refunds` last and isolated |
| Admin UI | `frontend/assets/js/admin-b2c-refunds.js` |

## Rules the service enforces

* **Balance** = captured amount - (`succeeded` + `processing` attempts), across every
  cancellation on that payment. Read under `SELECT ... FOR UPDATE` on the payment row.
* **One in-flight attempt per cancellation** (partial unique index); a repeat request
  returns the open attempt. A retry after a *clean* failure is a new attempt, new key.
* **Uncertain outcome** (timeout, dropped connection, 5xx, unreadable reply) stays
  `processing`, keeps counting, and is never re-sent. Reconciliation finds it by refund
  id or by the idempotency key (Razorpay `receipt`, HDFC `unique_request_id`). Only an
  operator with `refund.reconcile` can close one the provider never acknowledged.
* **Only a 4xx refusal is a clean failure** (`definitive`).
* **A webhook identifies, the provider's API confirms.** `succeeded` is set only from
  `fetch_refund()` / the refund call's own response, never from the webhook body.
  Unmatched, ambiguous or unverifiable events stay `deferred`.
* **TrustBrick** has no refund API: attempts are `manual_required` and become
  `succeeded` only through `/refund/manual` (`admin_override: true`, reference, reason).
* **Maker-checker**: refunds >= `REFUND_APPROVAL_THRESHOLD_MINOR` (default `0` = all)
  need a different user holding `refund.authorize` (granted per user via
  `users.permissions`; no role carries it).

## Settings (all optional)

`REFUND_APPROVAL_THRESHOLD_MINOR` (paise, default 0), `REFUND_RECONCILE_ENABLED`
(default true), `REFUND_RECONCILE_MIN_AGE_SECONDS` (120), `REFUND_STALE_HOURS` (24).

## Not changed

Customer self-cancel endpoints still only cancel (RD4); customer-facing status labels
are untouched; no provider configuration, TrustBrick pilot route or payment default
was modified.

## Tests

`tests/test_customer_refunds.py` (service, adapters, webhooks, reconciliation, DB
constraints), `tests/test_customer_refunds_http.py` (permissions, maker-checker over
HTTP), `tests/test_customer_refunds_postgres.py` (real-lock concurrency; needs
`REFUND_TEST_POSTGRES_URL`, run by the CI `postgres-migrations` job),
`frontend/tests/admin-refunds-panel.test.js`.
