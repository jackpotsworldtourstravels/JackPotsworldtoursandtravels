# Stage 4A.1 + 4A.2 — Implementation Review Report

Scope implemented: **4A.1 (harness hardening)** and **4A.2 (all-portal smoke)** only. No P1 journeys,
no cross-portal flows (those need separate approval). No application code changed, no `data-testid`
added, no commit/push/deploy, both commits (`f7345ad`, `478f016`) preserved.

## Merchant Classic — support-status investigation (per your adjustment)
Evidence it is **actively supported** (kept P3 / basic-smoke-only regardless):
- `frontend/partner-login.html:60` → `const PL_PORTAL = 'merchant-classic/'` — merchants are redirected
  to merchant-classic on login ("Mirrors MERCHANT_PORTAL_URL in assets/js/app.js").
- `docs/BOOKING_OPS_MILESTONES.md:177` labels it **"Merchant portal (Classic V2)"**; many CR/M milestones
  build on its `classic-*` modules (CR-1 "Documents removed from the Classic merchant workflow" is
  Complete & Approved). Admin/operations reuse `classic-enquiry/booking/passport-ocr`.
- **No deprecation marker found anywhere.**
Conclusion: treated as **P3 / support-status "likely active, keep"**; only basic smoke built (anon load +
authenticated boot), **not** the 21 workflows — pending your formal confirmation.

## Files changed / added (all under qa/, uncommitted)
| File | Status | Purpose |
| --- | --- | --- |
| `qa/playwright/fixtures/auth.py` | **new** | Role auth, browser storage-state builder (jwt_*/jpc_*), expired-token minting, `Api` authz probe, created-customer registry |
| `qa/playwright/conftest.py` | **modified** | Added `worker_ns`, `api`, `role_tokens` (session, rate-limit-safe), `new_authed_page` factory, safety-gated QA-customer cleanup; registered `authz` marker |
| `qa/playwright/e2e/smoke/test_all_portals_smoke.py` | **new** | 8 anon-load + 6 authed-boot smoke specs |
| `qa/playwright/e2e/authz/test_access_control.py` | **new** | 9 API-level access-control specs |
| `qa/STAGE4A_PLAN.md` | new (prev turn) | the approved plan |
| `qa/STAGE4A_IMPL_REPORT.md` | **new** | this report |

## 4A.1 — Harness hardening (built)
- **Storage-state auth (speed, not a substitute for authz):** sign in once per role via the API, inject
  the SPA's own localStorage keys (`jwt_*` for staff/merchant, `jpc_*` + `jpc_customer` JSON for
  customer) into a Playwright context. This lets browser specs start signed-in **without** replaying the
  per-IP login rate limit (the Stage-3 `verify_customer_portal` flake). `role_tokens` is session-scoped
  and `config.login` caches, so the whole run performs ~4 staff logins + 2 customer signups — well under
  the 10/min login & 5/min signup limits. **Rate limits were not changed.**
- **Per-worker data namespace** (`worker_ns`) so parallel specs never collide.
- **Network + console capture** in the authed-boot spec (records `/api/*` statuses and `pageerror`).
- **Authz probe client** (`Api`) + an **expired-JWT minter** (signs an exp-in-the-past token with the
  local test secret) to exercise the expired-session path.

## 4A.2 — All-portal smoke (built)
- **Anonymous load (8):** public, customer, admin, super_admin, merchant, merchant_classic, manager,
  operations — each loads with a non-empty `<title>`, a body, and **no uncaught JS error** (anon API
  401/403 are allowed; authz is tested separately).
- **Authenticated boot (6):** customer, admin, super_admin, merchant, merchant_classic, manager — each
  boots signed-in (storage-state), is **not bounced to a login page**, and any `/api` call its shell
  drives is **accepted** (≥1 2xx). Operations is anon-only (its required role is not among the seeded
  accounts — flagged for Stage-4 follow-up).

## Authorization coverage (requirement #1 — NOT replaced by storage-state)
API-level, against the live app, confirmed contract:
| Case | admin endpoint `/api/admin/customers` | customer endpoint `/api/customer/auth/me` |
| --- | --- | --- |
| Unauthenticated (no header) | refused (403) | refused (403) |
| Invalid token | 401 | — |
| **Expired session** | 401 | — |
| Cross-portal token (customer↔staff) | refused (401) | refused (admin→401) |
| Wrong staff role (merchant, manager) | refused (403) | — |
| Correct role | admin → 200 | customer → 200 |
All 9 assertions pass.

## Test execution results
Command (from `qa/playwright`, isolated env + `PYTHONUTF8=1` + merchant override):
`python -m pytest -m e2e --browser=chromium --screenshot=only-on-failure --tracing=retain-on-failure`
- **23 passed, 5 deselected** (49.96s). Breakdown: 9 authz + 8 anon smoke + 6 authed smoke.
- Offline scaffold self-check (`test_scaffold_smoke.py`, no server): **5 passed** — no regression.
- First run surfaced two harness bugs, both fixed and re-verified: a fixture **scope mismatch**
  (`role_tokens` session-scoped vs `require_server` function-scoped → now gated on session `server_available`)
  and `merchant_classic` not being a seeded role (→ mapped to the `merchant` account).

## Failures / known limitations
- **No application failures.** The only failures were the two harness bugs above, now fixed.
- **Test-data cleanup is best-effort and FK-limited.** The safety-gated teardown deletes **only** exact
  QA emails and **only** in a local `*_qa` DB, but `customers` has child rows (sessions/otps/profiles/
  audit), so the hard-delete was blocked and **2 namespaced rows remained** this run. Isolation is still
  guaranteed by per-run namespacing, and the **disposable `jpw_qa` container is the definitive cleanup**
  (`docker rm` recreates). No row outside the exact QA email list — and nothing outside `jpw_qa` — is
  ever touched. (A fuller FK-ordered cleanup can be added in Stage-4 if you want hard deletion.)
- **Operations role** unknown among seeded accounts → anon-smoke only for now.
- **Smoke is breadth, not depth:** it proves each portal boots and authenticates; it does not exercise
  per-view workflows (P1/cross-portal), which await separate approval.

## Safety checks (all satisfied)
- Only `localhost:5435/jpw_qa` + app `:8099`; the fail-closed DB gate governs the env; **0** contact with
  production/RDS/other-project DBs (5433/5434). DB head unchanged (`0093`); **no migration**.
- Suppliers dormant; `PAYMENT_PROVIDER=none`; **no** real payment/refund/OTP/notification (customer
  signup used dev-OTP echo only).
- Rate limits **unchanged** (storage-state avoids hammering them).
- **No application code changed; no `data-testid` added.** `git status`: `qa/playwright/conftest.py`
  modified + new `qa/playwright/{fixtures/auth.py,e2e/smoke,e2e/authz}` + `qa/STAGE4A_*` — all uncommitted.
- Both commits `f7345ad` and `478f016` intact; nothing committed/pushed/deployed.

## Awaiting approval
Stop here per instruction. Next (separate approval): 4A.3 P1 journeys and 4A.4 cross-portal workflows;
and your call on (a) Merchant Classic depth, (b) whether to add FK-ordered hard cleanup, (c) the
Operations role.
