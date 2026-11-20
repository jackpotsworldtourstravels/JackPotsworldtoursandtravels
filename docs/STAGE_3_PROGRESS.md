# Stage 3 — B2C Admin Functional Completion — Progress

Local dev only · migration 0095 UNAPPLIED · no PostgreSQL connection · no DBA grants · no deploy · no commit/push · Gaming disabled · single DB preserved · B2B untouched.

## M0 — Audit readiness gate (2026-11-13) — COMPLETE

### Modified / new files
- `backend/app/auth/rbac.py` — added scopes `b2c.customers.manage`, `b2c.communication.send` to `P` + `B2C_SCOPES` (in NO role default).
- `backend/app/services/b2c_admin_readiness.py` (**new**) — `is_ready(bind)` (table existence + schema-compat vs the model's columns; fail-closed on any error; caches a ready engine, re-probes while not-ready), `assert_ready(bind)` (503), `require_audit_ready(db=Depends(get_db))` (503 dependency, bound to the request's own engine).
- `backend/app/services/customer_admin_audit_service.py` — `record_in_session` now calls `b2c_admin_readiness.assert_ready(db.get_bind())` BEFORE adding the row: a missing/incompatible audit table ⇒ 503 before any commit (centrally covers every in-session audited write — Stage 2 + Stage 3 — fail-closed, no swallow, atomicity preserved).
- `backend/app/routers/admin_cancellations.py` — door-gated the 5 refund endpoints (reconcile, start/maker, authorize/checker, manual, resolve-failed) with `dependencies=[Depends(require_audit_ready)]` (their audit write is the in-transaction Approach-C hook / independent path, NOT `record_in_session`; gating at the door also prevents a provider call that could not be audited).
- `backend/app/routers/admin_b2c_reports.py` — door-gated `preview` (uses `record_independently`).
- `backend/app/routers/admin_chat.py` — door-gated `download_attachment` (uses `record_independently`).
- `backend/app/main.py` — startup probe logging audit readiness (log-only; does not block startup).
- `backend/tests/test_b2c_admin_readiness.py` (**new**) — 11 tests.

### Coverage (how every audit-dependent op is protected)
- **In-session audited writes** (catalogue CRUD, booking update + detail-read, customer detail-read, payment detail-read, reconciliation verify/supplier-reservation, review moderation, report export, chat claim/transfer/set_status/attachment-send): covered centrally by the `record_in_session` gate.
- **In-transaction refund hook + independent-write audited reads** (refund endpoints, report preview, chat attachment download): covered by door-level `require_audit_ready`.
- **Unaudited reads** (lists, dashboards, analytics) and **all B2B**: NOT gated — unaffected.

### APIs / permissions
No new endpoints in M0. New scopes `b2c.customers.manage`, `b2c.communication.send` registered (used by M1/M2). The gate returns **503 "B2C admin audit unavailable — migration 0095 not applied or schema incompatible."**

### Test results (actual)
- M0 tests: **11 passed** (ready/absent/schema-incompat/fail-closed/assert/cache; writer-gate 503 vs works; door-gated endpoint 503 when absent vs not-503 when present; unaudited list read unaffected).
- Stage-2 + M0 regression set: **178 passed**. Import smoke: OK.
- Full backend suite: **1713 passed, 44 failed, 4 skipped** — all 44 in the pre-existing `test_token_revocation.py` / `test_admin_supplier_reservation_http.py` (no new regressions).

### Security / transaction verification
- No SUCCESS audit failure is swallowed; atomicity unchanged (the gate refuses before the business commit). FAILURE/DENIED independent writes still resilient.
- Fail-closed when the DB/audit storage is unavailable (probe exception ⇒ not ready).
- B2B and unaudited reads unaffected; Gaming disabled; single DB; 0095 unapplied.

### Remaining risks / notes
- The ready-engine cache keys on `id(engine)`; a long-lived process only ever has the one real engine, and the only table-less engines are in cache-cleared M0 tests, so a stale-id false-positive is not a practical risk. (Could switch to a WeakSet keyed on the engine object if desired.)
- M0 deliberately gates the audited **sensitive-detail reads** (customer/payment/booking detail, report preview, attachment download) — by design they are refused (503) when the audit store is absent, since we will not serve an access we are required to record but cannot. Unaudited list/overview reads stay available.

### Deployment dependency (unchanged)
The audited B2C admin operations (Stage 2 + Stage 3) require migration 0095 applied to the Postgres DB. Until then they return 503; applying 0095 (separate authorization) flips readiness true (lazy re-probe, no restart needed).

## M0 — Correctness corrections (2026-11-13) — COMPLETE

Two gaps the initial M0 left open were closed. No new endpoints; no schema change; 0095 still unapplied.

### Task 1 — Durable SUCCESS audit for sensitive reads
**Finding.** The door-gate (`require_audit_ready`) only proves the audit store was usable *before* the handler ran. The two sensitive SUCCESS reads — report **preview** and chat **attachment download** — then called `record_independently`, which **swallowed** any error. So if the audit INSERT failed *after* the gate passed (table dropped mid-request, connection lost, disk/txn error), the protected data was still returned **with no durable audit record**.

**Fix.**
- `customer_admin_audit_service.record_independently(*, required: bool = False, **kwargs)`:
  - `required=False` (default) — unchanged resilient behaviour for **FAILURE / DENIED** (logged + swallowed, never breaks the business path).
  - `required=True` — on write failure the error is logged and **re-raised as 503**; the protected read fails closed and returns nothing.
  - Either way the write uses a **fresh session** — no unrelated business transaction is ever committed.
- `admin_b2c_reports.preview_report` and `admin_chat.download_attachment` now pass `required=True` on their SUCCESS audit, placed **before** the response is returned. Report/attachment behaviour is unchanged whenever the audit store is writable.

### Task 2 — Readiness cache correctness
**Finding.** The old cache was a `set[int]` of `id(engine)` that, once an engine was ready, **never re-probed** it. Two defects: (a) a table dropped after a prior success would still read as ready (stale); (b) a garbage-collected engine's recycled `id()` could resurrect a stale "ready".

**Fix (`b2c_admin_readiness`).**
- Cache is now a `weakref.WeakKeyDictionary` keyed by the **engine object** (GC drops the entry; no `id()`-reuse false positive), storing the monotonic time it was last confirmed ready.
- `READY_TTL_SECONDS` (default **0.0**) ⇒ **revalidate on every call**. A not-ready result is **never cached**. Guarantees:
  - table exists → ready; table missing/incompatible → not ready; DB unavailable → not ready;
  - table removed after a prior success → **next** protected op re-probes and **fails closed**;
  - migration 0095 applied later → next call becomes ready **without a restart**.
- An optional positive TTL (> 0) is available as a bounded, documented staleness/throughput trade-off; a not-ready result is still never cached at any TTL. Thread-safe via a module lock.

### Modified files
- `backend/app/services/b2c_admin_readiness.py` — weak-keyed revalidating cache; `clear_cache()`; TTL knob.
- `backend/app/services/customer_admin_audit_service.py` — `record_independently(required=...)` + 503 on required failure (imports `HTTPException`/`status`).
- `backend/app/routers/admin_b2c_reports.py` — preview SUCCESS audit `required=True`.
- `backend/app/routers/admin_chat.py` — attachment-download SUCCESS audit `required=True`.
- `backend/tests/test_b2c_admin_readiness.py` — rewritten/expanded: 24 tests (cache revalidation, drop-after-ready, 0095-later, not-ready-never-cached, positive-TTL, `required=True` 503 / `required=False` swallow / fresh-session isolation, preview + attachment download end-to-end fail-closed and served-when-persisted).

### Test results (actual, 2026-11-13)
1. Focused readiness + audit-events: **34 passed**.
2. Independent-audit-writer tests: included above (required 503 / resilient swallow / fresh-session).
3. Report-preview + attachment-download + B2C/refund focused set: **214 passed, 3 skipped** (the only 2 failures in that `-k` slice are pre-existing `test_admin_supplier_reservation_http.py` cases).
4. Stage-2 regression: all B2C audit suites green within the focused run.
5. Full backend suite: **1723 passed, 44 failed, 4 skipped** — the 44 are exactly the pre-existing `test_token_revocation.py` + `test_admin_supplier_reservation_http.py` (those two files alone = 44 failed / 28 passed). **No new regressions** (M0 baseline was 1713 passed; +10 are the new readiness tests).

### Verification
- SUCCESS sensitive reads now disclose nothing unless the SUCCESS audit is durably persisted; FAILURE/DENIED stay resilient; no unrelated business txn committed; atomicity of in-session writes unchanged.
- Readiness fails closed on drop/unavailable on the very next call, and flips ready after 0095 with no restart.
- B2B, unaudited reads, and refund maker-checker behaviour untouched; Gaming disabled; single DB; 0095 unapplied; no commit/push.

## M1 — Customer block / unblock + email-link password reset (2026-11-13) — COMPLETE

Block/Unblock only (no Suspend). Reset uses the existing secure email-link flow; the admin never sees, generates or sets a password and no token is ever returned. No new table, no migration; 0095 still unapplied. All three actions require the explicit `b2c.customers.manage` scope (super-admin or explicit grant — in no role default), sit behind the readiness gate, and are audited.

### Endpoints (all `dependencies=[require_audit_ready]`, gated on `b2c.customers.manage`)
| Method/Path | Action | Behaviour |
|---|---|---|
| `POST /api/admin/customers/{id}/block` | `customer.block` | status→blocked **and** `auth.force_logout_at=now` (kills live sessions); reason **required**; idempotent; `record_in_session` SUCCESS atomic with the status change; 404 unknown customer. |
| `POST /api/admin/customers/{id}/unblock` | `customer.unblock` | status→active; `force_logout_at` left as-is (old tokens stay dead); reason optional; audited; idempotent. |
| `POST /api/admin/customers/{id}/password-reset` | `customer.reset_password_initiated` | **verified email required** → `customer_auth_service.start_password_reset` emails the standard link; optional `force_logout`; `record_in_session` SUCCESS; returns `{"status":"reset email sent"}` only. **No verified email → 422, no token minted, independent FAILURE audit.** SMTP failure → 502 + independent FAILURE audit. Never returns a token/link (even in debug). |

### Authorization & audit
- `_manage_gate(action)`: `get_current_admin` first rejects non-admins; then `User.has_permission("b2c.customers.manage")` (super-admin OR explicit grant, never a B2B role default). A denial writes an independent **DENIED** audit naming the action and 403s.
- SUCCESS of a mutation is `record_in_session` → committed in the SAME transaction as the change (atomic; readiness gate guarantees the table exists; any other commit failure rolls back both). FAILURE/DENIED use `record_independently` (resilient, own session, no partial commit).
- New sensitive actions added to the audit retention `security` class.

### Modified / new files
- `backend/app/services/customer_admin_account_service.py` (**new**) — `block_customer` / `unblock_customer` (mutate only; caller commits for atomic audit; no `models_v2` import).
- `backend/app/routers/customer_admin.py` — added the three POST endpoints + `_manage_gate` factory; imports for deps/readiness/settings/email/auth-service/new service/schemas.
- `backend/app/schemas/customer_admin.py` — `CustomerBlockRequest` (reason required), `CustomerUnblockRequest`, `CustomerPasswordResetRequest` (`force_logout`, no password field), `CustomerStatusChangeResponse`, `CustomerPasswordResetResponse`.
- `backend/app/services/customer_admin_audit_service.py` — added `customer.block` / `customer.unblock` / `customer.reset_password_initiated` to `_SECURITY_ACTIONS`.
- `backend/tests/test_b2c_customer_admin_actions.py` (**new**) — 12 tests (below).

### Tests (actual, 2026-11-13)
- M1 suite `test_b2c_customer_admin_actions.py`: **12 passed** — block sets blocked+force_logout+SUCCESS audit; block idempotent; block requires reason (422); unblock→active audited; 404; reset with verified email (link sent, no token in body, SUCCESS audit records `{channel,force_logout}` only); reset without verified email (422, no token minted, FAILURE audit); reset SMTP failure (502 + FAILURE audit); `force_logout` sets `force_logout_at`; action denied without scope (403 + DENIED audit, not mutated); super-admin allowed without explicit scope; block 503 when audit table absent (not mutated).
  - *Harness note:* the M1 tests use a temp-file SQLite DB, not StaticPool in-memory, so the readiness probe's `inspect(engine)` takes its own connection and does not disturb the request transaction — mirroring a real pooled Postgres engine. (No app-code change; a StaticPool shared connection is a test artifact only.)
- Focused Stage-2 + refund + M1 + gaming (`readiness`, `audit_events`, `audit_api`, `customer_refunds`, `customer_refunds_http`, `customer_admin_actions`, `gaming_fail_closed`): **160 passed**.
- Full backend suite: **1735 passed, 44 failed, 4 skipped** — the 44 are exactly the pre-existing `test_token_revocation.py` + `test_admin_supplier_reservation_http.py` (those two alone = 44 failed / 28 passed). **No new regressions** (M0-corrections baseline was 1723 passed; +12 are the new M1 tests).

### Verification against requirements
- Explicit `b2c.customers.manage`; no role default. ✔
- Block/Unblock only; no Suspend. ✔
- Email-link reset only; admin never sees/generates/sets a password; no token returned. ✔
- No verified email → 422, no token, FAILURE audit. ✔
- Sensitive mutations durably audited; fail-closed preserved (readiness gate + atomic SUCCESS audit; M0 corrections intact). ✔
- B2B, single Postgres DB, refund maker-checker, Gaming-disabled all preserved; no 0095 apply, no DB connection/change, no deploy/commit/push. ✔

## M1 — Correctness corrections (2026-11-13) — COMPLETE

Two confirmed defects fixed; no new endpoints; no schema change; 0095 still unapplied.

### Task 1 — Customer status preservation
**Findings (confirmed).** The first M1 cut set status unconditionally: `block` → BLOCKED from *any* status, `unblock` → ACTIVE from *any* status. Consequences:
- INACTIVE → block → BLOCKED → unblock → **ACTIVE** (wrongly reactivated).
- SUSPENDED → block → BLOCKED → unblock → **ACTIVE** (suspension silently bypassed).
- Blocking overwrote the prior status with no way to restore it (there is no column to remember it, and no Stage-3 migration is permitted).

**Fix (`customer_admin_account_service.py`).** Block is now defined strictly as `active→blocked`; unblock strictly as `blocked→active`:
- `block_customer`: ACTIVE → blocked (+`force_logout_at`); already BLOCKED → idempotent no-op; **INACTIVE/SUSPENDED → refused** (`CustomerActionError` → HTTP **409**, status left untouched).
- `unblock_customer`: BLOCKED → active; already ACTIVE → idempotent no-op; **INACTIVE/SUSPENDED → refused** (409) so unblock can **never reactivate** a customer who should stay inactive/suspended.
- Because block only ever runs from ACTIVE, the pre-block status is always ACTIVE and no information is lost. The router maps `CustomerActionError` to 409 and records an independent FAILURE audit. Rule documented in both the service and the endpoint descriptions.

### Task 2 — Password-reset failure handling
Flow traced: `endpoint → verified-email check → start_password_reset (mints+commits token) → build link → send email → audit → response`.

**Findings & fixes.**
- **SMTP failure left a usable token (confirmed).** `start_password_reset` commits the token *before* the email is attempted; on an SMTP failure the old code returned 502 but left that token live. Fix: new `customer_auth_service.invalidate_reset_token(db, raw_token)` marks the just-minted token **spent** (`used_at=now`, the same state `complete_password_reset` sets, so existing validation already rejects it) on the SMTP-failure path. An SMTP failure now leaves **no usable reset token**.
- **No token/link leakage.** The success response is only `{"status":"reset email sent"}`; the 502/500 details and all audit `reason`s contain no token or link; the raw token is never logged. Asserted by tests.
- **No success-without-audit.** SUCCESS is `record_in_session` committed before the 200 is returned; if that commit fails the handler does **not** return success.
- **Audit failure *after* the email was sent (external side effect) — now explicit.** The email cannot be un-sent and is **not** claimed to be rolled back. On a post-send audit-commit failure the handler: rolls back the (uncommitted) audit+force-logout, logs `CRITICAL` ("email sent but SUCCESS audit failed — manual reconciliation"), best-effort records an **independent FAILURE anomaly**, and returns **500** (no token leak). **Documented behaviour:** the emailed link stays valid for the customer (invalidating it would strand someone holding a working link); operators reconcile from the anomaly row + the critical log. No success is reported without a durable audit.
- **No unrelated transaction committed.** `start_password_reset` commits only the token; `invalidate_reset_token` only the spend; the final commit only the SUCCESS audit (+ optional force-logout); FAILURE/anomaly use independent sessions.
- **Public reset flow unchanged.** Only a new helper was added to `customer_auth_service`; `start_password_reset` / `complete_password_reset` / the public `customer_auth` router are untouched — the public forgot/reset tests stay green.

### Modified / new files
- `backend/app/services/customer_admin_account_service.py` — `CustomerActionError`; block/unblock rewritten with status-rule guards (409, no overwrite, no reactivation).
- `backend/app/routers/customer_admin.py` — block/unblock catch `CustomerActionError` → 409 + FAILURE audit (409 added to `responses`); reset path invalidates the token on SMTP failure and handles post-email audit-commit failure explicitly (module `logger` added).
- `backend/app/services/customer_auth_service.py` — new `invalidate_reset_token` (marks a token spent; public flow unchanged).
- `backend/tests/test_b2c_customer_admin_actions.py` — now **20 tests** (added: INACTIVE/SUSPENDED block refused + unchanged; INACTIVE/SUSPENDED unblock cannot reactivate; block→unblock round-trip cannot reactivate; unblock-active no-op; SMTP failure invalidates token; post-email audit-commit failure → 500 + anomaly, no success-without-audit, no leak).

### Test results (actual, 2026-11-13)
1. Focused M1 (`test_b2c_customer_admin_actions.py`): **20 passed**.
2. Stage-2 audit + refund + readiness + gaming + M1 focused: **168 passed**.
3. Public password-reset / customer-auth slice: passes (the only failures under that `-k` filter are 18 cases inside the pre-existing `test_token_revocation.py`).
4. Full backend suite: **1743 passed, 44 failed, 4 skipped** — the 44 are exactly the pre-existing `test_token_revocation.py` + `test_admin_supplier_reservation_http.py`. **No new regressions** (prior M1 baseline 1735 passed; +8 are the new correction tests).

### Restrictions honoured
M1 corrections only; M2 not started; 0095 unapplied; no PostgreSQL connection / DB change; no deploy/commit/push; Gaming disabled; B2B + refund maker-checker + single DB preserved; M0 readiness corrections intact.

## M1 — Final verification (2026-11-13) — COMPLETE

### Task 1 — Legacy BLOCKED customer records (provenance)
**Method.** Read-only code audit of every writer of a customer's status — `grep` for `CustomerStatus.BLOCKED` and for all `.status =` assignments across `backend/` (app, alembic, tests), then inspected each hit. No production DB accessed.

**Findings.**
- **Only one code path sets `CustomerStatus.BLOCKED`:** `customer_admin_account_service.block_customer` (the new M1 `active→blocked` path). Every other `CustomerStatus.BLOCKED` reference is a **read** that *refuses* a blocked customer (`customer_deps`, the `customer_auth` router, `customer_auth_service` login) — none writes it.
- The only other writers of a `customers.status` are `unblock_customer` (→ACTIVE) and `customer_guest_service` (guest→INACTIVE on migration). `customer_refund_service`'s `c.status = "refund_processing"/"refunded"` is a **cancellation** row, not a customer (confirmed by inspection); all other `.status =` hits are bookings, payments, B2B users, merchants, topups, etc. No migration or seed sets a customer BLOCKED (0044 only *defines* the enum; 0010's `is_blocked` is the separate B2B `users` table).
- **Could existing BLOCKED records come from the previous implementation?** The previous M1 cut (unconditional `status→BLOCKED`) existed only within this session, was never committed, never deployed, and never ran against production (0095 unapplied ⇒ the endpoints return 503 in production; it was exercised only against SQLite test DBs). So no production record can have originated from it.
- **Could the new unblock reactivate an originally-INACTIVE/SUSPENDED customer?** Only if a BLOCKED row exists whose pre-block status was inactive/suspended. Since the sole in-app producer of BLOCKED is the `active→blocked` path (which now refuses non-active), any application-created BLOCKED row necessarily had ACTIVE as its prior status, so `unblock→ACTIVE` is correct and cannot reactivate a should-stay-inactive/suspended customer.

**Limitation + safe handling rule.** Provenance of a BLOCKED row created *out of band* (a manual SQL `UPDATE`) cannot be established without reading production data, which is out of scope here. Documented rule:
1. There is no in-app path other than `active→blocked`, so at first deployment the ambiguity is effectively impossible; the feature has never run in production.
2. Going forward, every block records the pre-block status in the audit `previous_value` (`{"status": from_status}`), so provenance is captured and the ambiguity cannot recur.
3. `unblock` restores **ACTIVE only** (never guesses inactive/suspended) — the least-surprising safe default for any BLOCKED row, and correct for every application-created one.
4. **Pre-deployment check (when DB access is separately authorized):** a one-time read-only count of `customers` rows with `status='blocked'` to confirm none predate this feature. Not run now (no DB access).

**No code change required for Task 1** — current behaviour is already correct and minimal.

### Task 2 — Reset-token invalidation double failure
**Finding.** If SMTP failed *and* `invalidate_reset_token()` then also failed, the exception escaped the handler (unhandled 500) and the FAILURE audit was skipped; the token would remain live with no explicit record.

**Fix (`customer_admin.py`).** The SMTP-failure branch now wraps `invalidate_reset_token` in its own `try/except`. On a double failure it: rolls back the failed cleanup, logs `CRITICAL` ("reset email failed AND the unused token could NOT be invalidated; it remains usable until it expires"), and records the **true token state in the audit reason** (`"email delivery failed; token still live (invalidation failed)"`). The 502 response body states only the email outcome — it never claims the token was invalidated, and carries no token or link. The token is **not** falsely marked spent.

### Task 3 — Test commands & results (exact)
```
# 1. Public password-reset / customer-auth slice
python -m pytest tests/ -q -k "customer_auth or forgot or reset or password"
#   => 18 failed, 54 passed, 1 skipped, 1719 deselected
#   All 18 failures are in tests/test_token_revocation.py (pre-existing).

# 2. The two established pre-existing failing files alone
python -m pytest tests/test_token_revocation.py tests/test_admin_supplier_reservation_http.py
#   => 44 failed, 28 passed

# 3. Full backend suite
python -m pytest tests/ -q
#   => 44 failed, 1744 passed, 4 skipped
#   Failing files: 22 test_admin_supplier_reservation_http.py + 22 test_token_revocation.py
```
- **The 18 slice failures are all from `test_token_revocation.py`** (a subset of its 22, those whose names match the keywords) — confirmed by the file breakdown. That file was never modified by M1.
- **Full-suite 44 failures unchanged from baseline:** exactly `test_admin_supplier_reservation_http.py` (22) + `test_token_revocation.py` (22) — the same two files established pre-existing at the start of Stage 3. Passed count rose to 1744 (prior 1743 + the one new double-failure test). **No new regressions.**
- M1 action suite `test_b2c_customer_admin_actions.py`: **21 passed** (20 + the double-failure test).

### Files changed (this verification)
- `backend/app/routers/customer_admin.py` — double-failure handling in the reset SMTP-failure branch (honest token-state audit; no false invalidation claim; no leak).
- `backend/tests/test_b2c_customer_admin_actions.py` — added `test_password_reset_smtp_and_invalidation_double_failure_is_honest` (now 21 tests).
- (Task 1 is verification only — no code change.)

### Restrictions honoured
Verification + M1 correction only; M2 not started; 0095 unapplied; no PostgreSQL connection / DB read or change; no deploy/commit/push; Gaming disabled; B2B + refund maker-checker + single DB preserved.

## M1 — Takeover re-verification (2026-11-13, independent session)

A fresh session re-checked the prior session's M1 work against the actual repository (not the report). **All M1 code and the documentation above were confirmed saved to the working tree** (uncommitted): the three endpoints in `customer_admin.py`, `customer_admin_account_service.py`, `b2c_admin_readiness.py`, `customer_admin_audit_service.py`, migration `0095` (untracked, unapplied), and the test files.

**Code re-confirmed (read, not assumed):**
- Task 2 double-failure: `customer_admin.py` SMTP-failure branch wraps `invalidate_reset_token` in its own `try/except`; on double failure it `db.rollback()`, logs `CRITICAL`, sets the honest audit reason `"email delivery failed; token still live (invalidation failed)"`, and returns 502 with a generic body — **no false "invalidated" claim, no token/link leak**. The post-email audit-commit-failure path returns 500 + independent anomaly, email not un-sent.
- Task 1 provenance: `grep` confirms the **only** writer of `CustomerStatus.BLOCKED` is `customer_admin_account_service.block_customer` (`active→blocked`); all other references are read-guards / enum defs / list filters. Limitation + safe-handling rule (audit `previous_value` captures pre-block status; `unblock→ACTIVE` only; pre-deploy read-only count when DB access is authorized) stands.

**Tests re-run (exact commands & actual results, 2026-11-13):**
```
python -m pytest tests/test_b2c_customer_admin_actions.py -q
#   => 21 passed

python -m pytest -q tests/test_b2c_admin_readiness.py tests/test_b2c_customer_admin_actions.py \
    tests/test_b2c_audit_api.py tests/test_customer_refunds.py tests/test_customer_refunds_http.py \
    tests/test_gaming_fail_closed.py tests/test_rbac.py
#   => 169 passed   (= prior 168 + the double-failure test)

python -m pytest tests/ -q -k "customer_auth or forgot or reset or password"
#   => 18 failed, 54 passed, 1 skipped, 1719 deselected  (all 18 in test_token_revocation.py)

python -m pytest tests/test_token_revocation.py tests/test_admin_supplier_reservation_http.py -q
#   => 44 failed, 28 passed   (confirms the 44 are confined to these two pre-existing files)
```
**Full suite not re-run this turn** (cost; no change expected). The prior run established **1744 passed / 44 failed / 4 skipped**; the two-file run above independently confirms the 44 failures are confined to `test_token_revocation.py` + `test_admin_supplier_reservation_http.py`, so **no new regressions** attributable to M1.

**Conclusion:** M1 is implemented, documented, and verified; **ready to close** pending the usual deployment dependency (0095 applied so the readiness gate flips true). M2 not started.

## M2.1 — In-app customer notification (admin → one customer) (2026-11-13) — COMPLETE

Owner approved **M2.1 only** (in-app notification send). Email sending and support-ticket replies are **not** implemented (M2.2+). Built on the existing communication infrastructure — **no new table, no new enum value, no migration**; reuses `CustomerNotification` (type `general`), the single engine/session, the M0 readiness gate and the M1 audit pattern.

### Endpoint
| Method / path | Action | Behaviour |
|---|---|---|
| `POST /api/admin/communication/customers/{customer_id}/notify` | `customer.notify` | Creates ONE `CustomerNotification` (type `general`, title ≤150, message ≤500) for ONE customer. Gated on explicit `b2c.communication.send` (super-admin or explicit grant — **no role default**) via a `_send_gate` that records a **DENIED** audit + 403 when the scope is missing. Behind `require_audit_ready` (503 while 0095 unapplied → nothing created). SUCCESS audit is `record_in_session`, committed **atomically** with the notification insert. 404 unknown customer + independent FAILURE. The customer sees it through the existing `GET /api/customer/.../notifications` API/UI — no customer-side change. |

### Authorization, audit & privacy
- `_send_gate("customer.notify")`: `get_current_admin` first, then `User.has_permission("b2c.communication.send")`; denial → independent **DENIED** audit + 403. [rbac `B2C_COMMUNICATION_SEND` already existed, in `B2C_SCOPES`, no role default.]
- SUCCESS atomic with the insert (one `db.commit()`); 404/validation/denied → `record_independently` (own session, no partial commit).
- **Privacy:** the audit `new_value` stores **metadata only** — `notification_id`, `notification_type`, `title`, and `message_length` — **never the full message body**; the existing `redact_values` still masks any secret-looking key. No cross-customer access (one explicit `customer_id`, validated → 404 if unknown).

### Modified / new files
- `backend/app/routers/admin_communication.py` — added `_send_gate` + the `POST .../notify` endpoint; imports (`get_current_admin`, `AdminAuditOutcome`, `b2c_audit`, `require_audit_ready`, `Path`, schemas); module docstring updated (read-only → one approved send action).
- `backend/app/services/customer_communication_admin_service.py` — added `send_notification()` (mutate-only; `db.add`+`flush`, caller commits for atomic audit); docstring updated to record the owner-approved single-customer exception.
- `backend/app/schemas/customer_communication_admin.py` — `CustomerNotifyRequest` (title/message length + non-blank validators) and `CustomerNotifyResponse`.
- `frontend/admin/index.html` — "Send a notification" button in `#comPane-notifications` (+ updated hint).
- `frontend/assets/js/admin-b2c-communication.js` — `comOpenCompose` modal + `comSubmitNotification` (axios POST with `authHeaders`, toast, reloads the list).
- `backend/tests/test_b2c_communication_notify.py` (**new**) — 11 tests.

### Test results (actual, 2026-11-13)
- M2.1 suite `test_b2c_communication_notify.py`: **11 passed** — success (row + atomic SUCCESS audit, metadata-only, full body NOT stored); super-admin allowed without explicit scope; denied without scope → 403 + DENIED audit, nothing created; unknown customer → 404 + FAILURE audit; 5 validation cases (blank/whitespace title, title >150, blank message, message >500) → 422, nothing created; audit table absent → 503, nothing created; frontend send-UI wired (static check).
- Import smoke (`app.main` + the new route): **OK**.
- Focused regression (readiness, M1 actions, audit API, refunds, gaming, rbac): **169 passed** (unchanged).
- Full backend suite: **1755 passed, 44 failed, 4 skipped** — the +11 are the new M2.1 tests; the 44 are exactly the pre-existing `test_token_revocation.py` + `test_admin_supplier_reservation_http.py`. **No new regressions** (M1-final baseline 1744 passed).

### Restrictions honoured
M2.1 only — **no email send, no ticket reply** (M2.2+); 0095 unapplied; no PostgreSQL connection / DB data change; no deploy/commit/push; Gaming disabled; B2B, refund maker-checker, single DB, and M0/M1 audit controls all preserved.

## M2.1 — Correctness review (2026-11-13) — COMPLETE

Focused review before closing M2.1. One change made (audit privacy); everything else confirmed by inspection + tests.

### 1. Audit privacy — CHANGED (title no longer stored)
**Finding.** The SUCCESS audit `new_value` stored the notification **title**. Though admin-authored, a title can carry a customer's name/reference, so copying it into the audit trail accumulates customer-facing content.
**Fix.** `admin_communication.notify_customer` now stores **content-free metadata only**: `{notification_id, notification_type, message_length}` — **no title, no body**. Usefulness is preserved: the `notification_id` lets an auditor retrieve the actual content from `customer_notifications` under the usual customer-data access controls. Test updated to assert the title and body are absent from the audit (`"Welcome"`/body not in `new_value`; `"title" not in new_value`).

### 2. Frontend review (CODE INSPECTION ONLY — no visual verification performed)
`admin-b2c-communication.js` `comOpenCompose` / `comSubmitNotification`, `#section-b2c-communication` in `index.html`:
- **Single customer:** one numeric **Customer ID** field; no multi-select/list; the backend path takes a single `customer_id`. ✔ one customer per request.
- **Validation:** `required` + `maxlength` (150/500) on the inputs, plus an explicit JS guard that all three fields are present; the server is authoritative (422 on blank/over-length). ✔
- **Loading state / duplicate-submit:** the Send button is `disabled` synchronously before the `await` and re-enabled in `finally`, so a rapid second click/Enter is blocked. ✔
- **Success:** closes the modal (feature-detected `catCloseModal`, else a `[data-cat-close]` click), shows a toast, reloads the notifications list. **Error:** shown inline via `catErr`; the modal stays open for retry. ✔
- **Minor, non-defect notes:** on success it calls `comShow('notifications')` then `comLoadNotifications(1)` — one harmless extra reload; modal close is feature-detected (if neither close helper exists the modal could remain open after a successful send, but the toast + reload still fire). No functional bug found. **No browser/visual verification was done** (the admin SPA needs the running portal + an authorised session; out of scope under no-deploy/no-DB).

### 3. Backend confirmations (verified by the M2.1 tests)
- **Atomic:** notification insert + SUCCESS audit share one `db.commit()`; the success test asserts BOTH the `customer_notifications` row and exactly one SUCCESS audit row exist after a 200. ✔
- **Unauthorized (denied) and unknown-customer create NOTHING:** both tests assert `CustomerNotification` count == 0 (403 + DENIED audit / 404 + FAILURE audit). ✔
- **Readiness gate:** audit table absent → **503** and `CustomerNotification` count == 0 (nothing created). ✔
- **One customer per request:** single path `customer_id`; no bulk/list field in the request schema. ✔

### 4. Test results (actual, 2026-11-13)
- M2.1 suite `test_b2c_communication_notify.py`: **11 passed** (after the privacy change).
- Focused regression (readiness, M1 actions, audit API, rbac): **64 passed**.
- (Full-suite headline unchanged from the M2.1 run: 1755 passed / 44 pre-existing failures / 4 skipped; the privacy change only narrows the audit payload and its test.)

### Restrictions honoured
Review + one privacy fix only; **M2.2/M2.3 not implemented**; 0095 unapplied; no PostgreSQL connection / DB change; no deploy/commit/push; Gaming disabled; B2B, refund maker-checker, single DB, M0/M1 controls preserved.

## M2.2 — Admin-to-customer email (2026-11-13) — COMPLETE

Owner approved **M2.2 only** (individual email to one customer). Reuses the existing SMTP service — **no second SMTP system**, no new table/migration. M2.1 in-app notifications are untouched; M2.3 (ticket replies) not implemented.

### Endpoint
`POST /api/admin/communication/customers/{customer_id}/email` — gated on explicit `b2c.communication.send` (via the shared `_send_gate`, DENIED audit + 403 when missing), behind `require_audit_ready` (503 while 0095 unapplied → nothing sent). Sends to the customer's **own verified address** (resolved server-side — the admin cannot set the recipient). Request: `{subject ≤200, message ≤5000}` (non-blank). Response: `{outcome, customer_id, delivered}`.

### Behaviour & failure handling
- **Verified email required:** no `email`/`email_verified` → **422**, nothing sent, independent **FAILURE** audit.
- **Unknown customer:** **404**, nothing sent, FAILURE audit.
- **SMTP failure** (`email_service.send_admin_customer_email` returns False — `_send` never raises): **502**, FAILURE audit, no external side effect.
- **SUCCESS:** audit `record_in_session` written then committed **before** 200 is returned.
- **Email sent but SUCCESS-audit commit fails (external side effect):** the email cannot be un-sent and is **not** claimed unsent — the handler rolls back the uncommitted audit, logs `CRITICAL`, records an **independent FAILURE anomaly**, and returns **500** (reconciliation marker). Mirrors the M1 password-reset post-send rule.
- **Privacy (#8):** the SUCCESS audit `new_value` is **metadata only** — `{channel:"email", subject_length, message_length}` — **never** the subject text or the body.

### Modified / new files
- `backend/app/services/email_service.py` — added `send_admin_customer_email(to, subject, body)` reusing `_send` (text + escaped-HTML wrapper); returns the delivery bool.
- `backend/app/services/customer_communication_admin_service.py` — added `get_customer(db, id)` accessor (recipient lookup + verified-email check).
- `backend/app/schemas/customer_communication_admin.py` — `CustomerEmailRequest` (subject/message length + non-blank validators) and `CustomerEmailResponse`.
- `backend/app/routers/admin_communication.py` — added the `POST .../email` endpoint (verified-email, SMTP, and post-send audit-failure handling); imports `email_service` + a module `logger`.
- `frontend/admin/index.html` — "Send an email" button in `#comPane-notifications`.
- `frontend/assets/js/admin-b2c-communication.js` — `comOpenEmail` modal + `comSubmitEmail` (axios POST, disabled-during-submit, toast, inline errors).
- `backend/tests/test_b2c_communication_email.py` (**new**) — 14 tests.

### Test results (actual, 2026-11-13)
- M2.2 suite `test_b2c_communication_email.py`: **14 passed** — success (sent to the verified address; SUCCESS audit metadata-only; subject/body NOT stored); super-admin; denied → 403 + DENIED, nothing sent; 404 + FAILURE; unverified email → 422 + FAILURE, nothing sent; SMTP failure → 502 + FAILURE; email-sent-but-audit-commit-fails → 500 + independent FAILURE anomaly, email NOT falsely claimed unsent, no SUCCESS row; 5 validation cases → 422, nothing sent; audit table absent → 503, nothing sent; frontend email-UI wired (static).
- Import smoke (both `/notify` and `/email` routes registered): **OK**.
- M2.1 + focused regression (readiness, M1, audit API, rbac): **75 passed** (M2.1 unchanged).
- Full backend suite: **1769 passed, 44 failed, 4 skipped** — the +14 are the new email tests; the 44 are exactly the pre-existing `test_token_revocation.py` + `test_admin_supplier_reservation_http.py`. **No new regressions** (M2.1 baseline 1755 passed).

### Restrictions honoured
M2.2 only — **M2.3 ticket replies not implemented**; reused the existing SMTP service (no duplicate); 0095 unapplied; no PostgreSQL connection / DB data change; no deploy/commit/push; Gaming disabled; M2.1 notifications, B2B, refund maker-checker, single DB, and M0/M1 audit controls all preserved. (Frontend wired + static-tested; no browser/visual verification performed.)

## M2.3 — Admin support-ticket replies (2026-11-13) — COMPLETE

Owner approved **M2.3 only**. Reuses the existing `CustomerSupportTicket` / `CustomerSupportMessage` models — no new table/migration. B2B support tickets (`support_tickets.py`, `models_v2`) are **not** touched. M2.1/M2.2 untouched.

### Endpoint
`POST /api/admin/communication/tickets/{ticket_id}/reply` — gated on explicit `b2c.communication.send` (via `_ticket_send_gate`, DENIED audit + 403 when missing), behind `require_audit_ready` (503 while 0095 unapplied → nothing added). Request `{message ≤5000}` (non-blank). Response: `TicketDetail` — **that ticket's own thread only** (no cross-ticket/customer exposure).

### Behaviour (inspected existing workflow first, per the requirement)
- **Staff representation:** the reply is a `CustomerSupportMessage` with `is_staff=True` and `author_name = admin.full_name` — the same shape the customer path (`customer_account_service.add_ticket_message`) uses with `is_staff=False`.
- **Status rule PRESERVED:** the only existing reply-time transition is "a reply to a **resolved** ticket reopens it to **open**" (`customer_account_service.add_ticket_message`). The admin reply applies that **same** rule and nothing else — an `open`/`in_progress` ticket's status is unchanged. **No new transition introduced.**
- **Correct ticket/customer (#6):** the message is inserted under the path `ticket_id`; the ticket owns `customer_id`. Unknown ticket → 404.
- **No cross-customer exposure (#9):** the response is built by `get_ticket(ticket_id)` which returns only that ticket's rows; a test confirms replying to ticket A neither mutates nor returns ticket B.
- **Customer visibility:** the reply **is visible to the customer** — the customer-facing `GET /api/customer/.../support-tickets/{id}` (`SupportTicketResponse.messages`) returns the full thread, scoped to the owner. (This corrects the older admin-screen docstring that treated tickets as unanswerable; the customer ticket endpoints in `customer_account.py` are still live.)
- **No auto email/SMS (#13):** the reply sends **no** email or SMS — no existing ticket workflow requires one, so none is triggered. (If a notify-on-reply workflow is wanted later it needs explicit approval.)
- **Audit:** SUCCESS `record_in_session` atomic with the message insert; metadata only — `{message_length, author:"staff"}`, entity `customer_support_ticket`/`ticket_id` — **never the body** (the admin identity is in the audit actor snapshot). 404 → independent FAILURE; missing scope → independent DENIED.

### Modified / new files
- `backend/app/services/customer_communication_admin_service.py` — added `reply_ticket()` (mutate-only; `is_staff=True`; mirrors the existing resolved→open rule).
- `backend/app/schemas/customer_communication_admin.py` — `CustomerTicketReplyRequest` (message length + non-blank).
- `backend/app/routers/admin_communication.py` — `_ticket_send_gate` + `POST .../tickets/{id}/reply`.
- `frontend/assets/js/admin-b2c-communication.js` — reply box + `comSubmitReply` in the ticket drawer (replaces the old "cannot be answered" note).
- `backend/tests/test_b2c_communication_ticket_reply.py` (**new**) — 12 tests.

### Test results (actual, 2026-11-13)
- M2.3 suite `test_b2c_communication_ticket_reply.py`: **12 passed** — success (staff message + atomic metadata-only audit, body not stored; thread returned); super-admin; denied → 403 + DENIED, nothing added; 404 + FAILURE; resolved→open reopen; open/in_progress unchanged; cross-ticket isolation; 3 validation cases → 422; 503 when audit table absent; frontend reply-UI wired (static).
- Import smoke (all three routes registered): **OK**.
- M2.1 + M2.2 + focused regression: **80 passed** (unchanged).
- Full backend suite: **1781 passed, 44 failed, 4 skipped** — the +12 are the new reply tests; the 44 are the pre-existing `test_token_revocation.py` + `test_admin_supplier_reservation_http.py`. **No new regressions** (M2.2 baseline 1769 passed).

### Restrictions honoured
M2.3 only; B2B support-ticket code untouched; no auto email/SMS; 0095 unapplied; no PostgreSQL connection / DB data change; no deploy/commit/push; Gaming disabled; M2.1/M2.2, refund maker-checker, single DB, and M0/M1 audit controls all preserved. (Frontend wired + static-tested; no browser/visual verification performed.)

## M2 — Final integration review (2026-11-13) — COMPLETE

Reviewed M2.1 + M2.2 + M2.3 together (integration/correctness, not new features). Full report: `docs/STAGE_3_M2_COMPLETION_REPORT.md`.

- **Consistent across all three** send actions: explicit `b2c.communication.send` gate (no role default; super-admin short-circuit) → `require_audit_ready` → business write → SUCCESS audit atomic / FAILURE+DENIED independent; audit payloads **content-free** (ids, type/channel, lengths — never title/subject/body); uniform non-blank + per-channel length validation.
- **One correctness fix:** the `admin_communication` module docstring was stale (said email/ticket-reply unimplemented) → corrected to describe all three actions. No behaviour change (comment only).
- **Minor, left as-is:** `_send_gate` vs `_ticket_send_gate` are near-identical (differ only by path param + entity_type) — justified by FastAPI path binding; no other duplication.
- **Security/isolation:** email recipient resolved server-side (no arbitrary recipient); reply scoped to its ticket (cross-ticket isolation tested); notifications/replies visible to the customer via existing reads; 404 on unknown; FAILURE/DENIED resilient.
- **Preserved:** B2B `support_tickets.py`/`models_v2` not modified; refund maker-checker unchanged (the only refund-service edit in the tree is the Stage-2 Approach-C hook, not M2); single DB; Gaming disabled (`test_gaming_fail_closed` green).
- **Tests:** integrated M2 + audit + readiness + M1 + rbac + gaming = **140 passed**; import smoke OK; full suite (M2.3 run) **1781 passed / 44 pre-existing failures / 4 skipped** — no new regressions (the docstring edit is comment-only).
- **Frontend verification:** full authenticated browser check **not performed** (needs a running backend + seeded auth + `customer_*`/audit tables + 0095 applied — none available under no-DB/no-deploy). Verified by code inspection + static presence tests instead; documented honestly in the completion report.
- **Deployment dependency:** migration `0095` must be applied for any M2 action to work (else 503 by design); SMTP must be configured for M2.2.

## M3–M4 — pending (awaiting explicit approval)
