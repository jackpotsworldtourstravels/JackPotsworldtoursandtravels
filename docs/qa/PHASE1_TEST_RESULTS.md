# Phase 1 Test Results

**Branch:** `claude/jackpotsworld-12-bug-sprint-c59a3f` @ `372c14b`
**Date:** 2026-11-21
**Environment:** Windows 11, Python 3.11.9, pytest 9.1.1, Node v24.13.0

All results below are actual runs from this machine. CI env (matching
`.github/workflows/ci.yml`): `DATABASE_URL=sqlite:///./ci_test.db`,
`JWT_SECRET_KEY=ci-test-secret-key-0123456789abcdef`.

## New regression tests (this sprint)

| Suite | Command | Result |
|---|---|---|
| Bug 6 — coupon messaging | `python -m pytest tests/test_coupon_product_messaging.py -q` (from `backend/`, CI env) | **11 passed** |
| Bug 4 — wishlist detail link | `node frontend/tests/wishlist-detail-link.test.js` | **PASS** |
| Bugs 8/9 — header name | `node frontend/tests/service-shell-auth-name.test.js` | **PASS** |
| Bug 11 — footer link removed | `node frontend/tests/footer-no-image-credits.test.js` | **PASS** |
| Bug 7 — edit-search restore | `node frontend/tests/package-edit-search-restore.test.js` | **PASS** |

## Verified existing tests (Bugs 10, 12)

| Suite | Command | Result |
|---|---|---|
| Bug 10 — payment history | `python -m pytest tests/test_payment_history.py -q` (from `backend/`, CI env) | **12 passed** |
| Bug 12 — voice handoff | `node --test tests/js/voice-handoff.test.mjs` | **14 passed** |

## Frontend suites (full)

| Suite | Command | Result |
|---|---|---|
| frontend/tests | `node --test frontend/tests/*.test.js` | **21 tests, 21 pass, 0 fail** |
| tests/js (top-level) | `node --test tests/js/*.test.mjs` | **155 tests, 155 pass, 0 fail** |

> Note: the `tests/js/browser/*.ui.test.mjs` Playwright-style tests (incl. the
> updated `image-credits.ui.test.mjs`) require a running server + Chrome; they
> **skip** when neither is present and are not in the fast CI lane. The
> image-credits assertion change was reviewed by inspection.

## Complete backend suite

Command (from `backend/`, CI env):
```
python -m pytest tests -q
```

Result (695s): **2754 passed, 37 failed, 33 skipped.**

**All 37 failures are pre-existing, environment-only, and unrelated to this
sprint.** They fall into two documented categories, confirmed by running them
with full tracebacks:

1. **401-vs-403 skew** (most of the 37) — admin HTTP permission/boundary tests
   that `assert ... == 401` but receive `403`, e.g.
   `test_admin_ticketing_payments_http::test_issue_ticket_permissions`:
   `AssertionError: assert 403 == 401`. This is the floating FastAPI pin skew
   already documented for this repo; not a behaviour change.
2. **Route-discovery collection artifact** —
   `test_security_remediation::test_every_public_api_route_is_rate_limited`
   fails at `assert len(routes) > 40` with `0` routes discovered in this
   environment (the guard is vacuous, not the app).

None of the failing tests exercise the files changed in this sprint
(`customer_pricing_service.py` and the four frontend files). The sprint's own
backend changes are covered by `test_coupon_product_messaging.py` (11 passed)
and the verified `test_payment_history.py` (12 passed), all green. The failing
suites (`test_admin_*_http`, `test_security_remediation`, `test_db_isolation_guard`)
touch admin permissions, rate-limiting and the isolation guard — areas this
sprint does not modify. See the project memory `backend-test-env-401-vs-403`.

## `git diff --check`
Clean — no whitespace errors.

## Not run here (and why)
- **Postgres migration up/down** (`postgres-migrations` CI job): needs a Postgres
  18 service container. This sprint introduces **no** migration, so there is
  nothing new to migrate. (Bug 2's integration would introduce migration 0096 —
  that would need the Postgres up/down run before trusting it.)
- **Browser matrix** (Bug 5 "browser-specific search failure", Bug 12
  cross-network call): require a real browser / two networks — see the
  deployment checklist.
- **Live email/SMS delivery** (Bug 1): requires live SMTP + an SMS provider;
  will be covered by mocked tests when implemented.

---

# Phase 2 Test Results (Bugs 1 & 3)

**Branch:** `claude/jackpotsworld-phase-2-bugs-1080f3` (Phase 1 merged in).
**Date:** 2026-11-22
**Environment:** Windows 11, Python (pytest), Node. Backend run with `JWT_SECRET_KEY` set; the conftest DB guard pins `DATABASE_URL` to a closed port (SQLite in-memory / temp-file harness only — no PostgreSQL reachable).

## New regression tests (Phase 2) — all actual runs on this machine

| Suite | Command (from `backend/`) | Result |
|---|---|---|
| Bug 1 — SMS adapter | `python -m pytest tests/test_sms_service.py -q` | **9 passed** |
| Bug 1 — confirmation service | `python -m pytest tests/test_booking_confirmation_service.py -q` | **11 passed** |
| Bug 1 — confirm→enqueue integration | `python -m pytest tests/test_booking_confirmation_integration.py -q` | **3 passed** |
| Bug 3 — enquiry admin (HTTP) | `python -m pytest tests/test_tour_package_enquiry_admin_http.py -q` | **12 passed** |
| **Phase 2 backend subtotal** | the four files above, one run | **35 passed** |
| Bug 3 — admin screen renderers | `node frontend/tests/admin-tour-package-enquiries.test.js` | **PASS** |

What these cover:
- **SMS adapter:** off-by-default suppression, console + http adapters, unknown-provider fail-closed, number masking, api-key-never-in-result, http non-2xx/timeout handled without raising.
- **Confirmation service:** email+SMS enqueued; email-only when no mobile; idempotent per `(booking_ref, channel)`; disabled flag writes nothing; composed body carries ref/amount/link and **no** card/cvv/password/token; SMTP-unset → `suppressed` (not a false `sent`); configured-but-refused → `failed`, retried, then parked; SMS off → `suppressed`; SMS console → `sent`.
- **Integration:** real `payment_verification_hotel_service.confirm_booking` enqueues a confirmation atomically with CONFIRMED; a second (redelivered) confirm is a no-op and does not double-enqueue; an amount-mismatch booking neither confirms nor enqueues.
- **Enquiry admin (HTTP):** `tour_package.enquiry.manage` required (ADMIN passes, SUPER_ADMIN is refused — granular grant, explicit per-user grant passes, unauthenticated refused); status filter + pagination + search; detail + 404; PATCH status/notes, assign-auto-ASSIGN, unknown-status 422; `/history` records the actor and the status transition; the public submission still stores a `NEW` enquiry (preserved).

## Complete backend suite (Phase 2)

Command (from `backend/`): `python -m pytest -q`

Result (412s): **2834 passed, 37 failed, 33 skipped.**

**Back to the Phase 1 baseline — the 37 failures are the same pre-existing,
environment-only set, zero of them introduced by Phase 2.** They are entirely
`test_admin_*_http` (the floating-FastAPI **401-vs-403** skew — see memory
`backend-test-env-401-vs-403`), `test_db_isolation_guard` + its intentional
`test_leaky` child-run, and `test_security_remediation::…rate_limited` (the
route-discovery collection artifact). No `test_booking_confirmation*`,
`test_sms_service`, `test_tour_package_enquiry_admin_http`, `test_rbac`,
`test_hdfc*`, `test_phase13*` or `test_sandbox*` appears in the failures.

> Regression caught and fixed during this run: the first full-suite pass showed
> **102 failed** — ~64 confirm-flow tests (hdfc/phase13/sandbox) plus the
> `test_rbac` permission-count snapshot. Root cause: `enqueue()` wrote to the
> new `customer_booking_notifications` table inside `confirm_booking`'s
> transaction, which those older harnesses do not create, poisoning it. Fixed
> by making `enqueue()` best-effort inside a SAVEPOINT (a queue failure can
> never roll back a confirmed, paid booking — the platform's existing "delivery
> never breaks the booking" rule), and by bumping the deliberate `test_rbac`
> permission snapshot (49→51) with an added Admin-only assertion for both
> enquiry codes. The numbers above are the re-run after those fixes.

## `git diff --check`
Clean — no whitespace errors.

## Not run here (and why)
- **PostgreSQL migration up/down** for **0096** and **0097**: needs a Postgres 18
  service container (the `postgres-migrations` CI job). Unlike Phase 1, Phase 2
  **does** introduce migrations; they are additive and pass on the SQLite
  harness, but the PG up/down run must pass before deploy. 0097 widens a CHECK
  constraint (drop + recreate) — exactly the kind of DDL that must be confirmed
  on real PostgreSQL.
- **Live email/SMS delivery:** no live SMTP and `sms_enabled=false` on this
  machine by design; sends are exercised with mocked providers only.
