# Stage 4 Closure & QA Quality Review

Non-destructive state review (no records deleted, no app code, no commit). Commits `f7345ad` and
`478f016` intact. Env at review time: `jpw_qa`@`localhost:5435`, app `:8099`, alembic head `0093`.

## 1. Stage 4A.1–4A.4 deliverables & test coverage

| Sub-stage | Delivered | Result |
| --- | --- | --- |
| **4A.1 Harness** | storage-state auth (jwt_*/jpc_*), per-worker namespace, network/console capture, authz probe (`Api`), expired-JWT minter, read-only `DbProbe`, safety-gated QA-customer cleanup | green |
| **4A.2 All-portal smoke + authz** | 8 anon-load + 6 authed-boot across all 7 portals; 9 API access-control checks (unauth/invalid/expired/wrong-role/cross-scheme); Operations permission-gate suite | green (ops browser boot skipped — see §4) |
| **4A.3 P1 journeys** | customer register+persist, dashboard+password-error, search+seeded packages; admin booking-management; merchant-classic queue; operations requests workflow | 6 journeys green |
| **4A.4 Cross-portal** | X1 registration→admin, X2 booking→admin (same `booking_ref`), X3 admin-status→customer, X4 merchant request→admin (same `request_number`), X5 operations/admin consistency | 5 journeys green; **X6 deferred** |

**Aggregate test counts (current):**
- Playwright (4A): **43 collected** — 38 `-m e2e` (**37 passed, 1 skipped** [ops browser boot]) + 5 offline scaffold (**5 passed**). Chromium.
- Backend pytest: **1124 passed** (1103 baseline + 12 month-fix + 9 A2-fix).
- Frontend node: **14 + 155 = 169 passed**.
- CDP browser suite: 23 files (Chromium, not in CI) — unchanged.
- 51-script `verify_*` E2E (seeded run): **49/51** — 1 SKIP-safety (`verify_payments`), 2 FAIL (see §6).

## 2. Playwright specs, fixtures & actual workflow coverage

**Specs** (`qa/playwright/`):
- `test_scaffold_smoke.py` — offline harness self-check (5).
- `e2e/smoke/test_all_portals_smoke.py` — anon-load ×8, authed-boot ×6.
- `e2e/smoke/test_operations_portal.py` — identity + permission gates (+1 skipped browser boot).
- `e2e/authz/test_access_control.py` — 9 access-control checks.
- `e2e/journeys/{test_customer_journeys,test_admin_booking_mgmt,test_merchant_operations}.py` — P1 (6).
- `e2e/cross_portal/{test_x1_registration_admin,test_x2_customer_booking,test_x4_request_portals}.py` — X1–X5 (5).

**Fixtures/support**: `conftest.py` (base_url, api, role_tokens, customer_session, new_authed_page,
db_probe, worker_ns, viewport/console fixtures, markers, safety-gated cleanup); `fixtures/auth.py`
(role tokens, storage-state, expired-JWT, `Api`); `fixtures/db.py` (read-only safety-gated probe);
`fixtures/journeys.py` (B2C booking + B2B request builders); `fixtures/api_seed.py`; `viewports.py`
(8 viewports); `pages/` (Base/Landing/BookingCard/auth + 5 portal shells).

**Actual workflow coverage:** customer auth/profile/search (UI+API+DB); admin booking-management
(UI boot + API + authz + DB); merchant-classic queue + operations (API-level; browser data :8000-limited);
cross-portal identity consistency X1–X5. **Not yet covered:** deep per-view CRUD across admin's ~30
views, merchant-classic's 21 workflows (P3), visual regression, accessibility, performance.

## 3. Remaining QA records & disposable reset proposal

Current `jpw_qa` artifacts (read-only): total customers **46**; QA customers **18** (of which **5** have
package bookings → RESTRICT-blocked from the fixture's cascade-style auto-delete); `customer_package_bookings`
**5**; `service_requests` **442**; nulled `customer_audit_logs` **66**. Also the untouched **id 68**
(`qa.explore…`, pending your approval).

**Recommended reset (safest, no record-level deletes) — full disposable recreate:**
```
bash qa/scripts/stop_test_env.docker.sh         # removes the jpw_qa_pg container (data gone)
# then, when next needed:
bash qa/scripts/start_test_env.docker.sh         # recreates + alembic upgrade head (re-seeds)
# then re-seed the 3 staff accounts (seed_account.py) as in STAGE3_FINAL_RUN_PLAN
```
This wipes ALL QA artifacts cleanly (no FK ordering needed) because the container is disposable — the
intended cleanup for a throwaway DB. **Alternative (keep the container):** extend the approved FK-ordered
transactional cleanup (used for 57/58) to booked customers — delete `customer_package_booking_*`
grandchildren + `customer_package_bookings` for the QA ids first, then the customers. Needs separate
approval (it deletes records).

## 4. Operations & Merchant-Classic API-base limitation

Both SPAs hardcode the API origin on localhost:
- `operations/js/ops-core.js:23` and `merchant-classic/js/classic-shell.js:28`:
  `API_BASE = ['localhost','127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : ''`.

So their in-browser **data** calls target `:8000`, not the `:8099` isolated app → their cross-portal
**data** workflows are verified at the **API level**, not in-browser (static shell load still works).
The modern `/merchant` portal (same-origin) boots fully in-browser on `:8099`.

**Possible solutions (separately approved; all require an app change we have NOT made):**
1. Make the API base configurable (env/meta tag / `window.__API_BASE__`) instead of a hardcoded port.
2. Serve the isolated app on `:8000` for ops/classic browser runs (collides with the port-8000 app worktree; not preferred).
3. Front both on one origin via a reverse proxy in the QA env so `''` (same-origin) resolves to `:8099`.
Recommendation: option 1 (configurable base) — smallest durable fix; enables full browser coverage.

## 5. X6 invoice/e-ticket workflow requirements (deferred)

To exercise invoice/e-ticket cross-portal visibility without real payments/suppliers, the flow needs:
a booking advanced to **Ticket Issued** (staff upload via the M2 issuance path), then the generated
**invoice/confirmation PDF + e-ticket** (reportlab + `eticket_service`, `document_service`), then
cross-portal reads (customer My Bookings download, merchant delivery, admin view) asserting the same
booking ref + document. This is a multi-step staff-ops pipeline (`verify_m2`/`verify_m7` territory), not a
single cross-portal read. Proposed as a dedicated Stage-4B item with its own seeded booking + issuance
fixture; still no real payment/supplier required (Classic Tours bypass).

## 6. Outstanding issues — 51-script verification suite (last seeded run 49/51)

| Script | Status | Cause | Nature |
| --- | --- | --- | --- |
| `verify_payments` | SKIP (safety) | self-skips ("can take real money") | correct; not a failure |
| `verify_trustbrick_payments` | **FAIL/BLOCKED** | optional `httpx2` not installed → Starlette TestClient can't construct; its in-process mock never starts (no external contact) | environment/optional-dep; install `httpx2` in a test-only req if approved |
| `verify_customer_portal` | **FAIL** | per-IP auth rate-limit exhaustion over a long single-IP run → negative checks get 429 not 401 (116/3) | environment/rate-limit flake; not an app defect; mitigate with storage-state reuse or spacing — never change prod limits |

`verify_m9` (suite registration) was **fixed** in commit `478f016` (3 scripts registered) and now passes.
No genuine application defects outstanding from the suite.

## 7. CI readiness, browser-engine coverage & reporting gaps

- **CI:** existing 3 jobs green (pytest SQLite, node, alembic up/down). **Not yet added:** a `ui-e2e`
  job (boot Postgres service + app + `playwright install chromium` + `-m e2e`, upload traces/videos).
  Design exists in `STAGE4A_PLAN.md`; implementation is a Stage-4B item.
- **Browser engines:** **Chromium only** installed. Firefox/WebKit are a `playwright install firefox webkit`
  away (deferred to keep Stage-4 minimal). Viewports: 8 defined (`viewports.py`), used by smoke; full
  8-viewport sweep not yet wired into journeys.
- **Reporting gaps:** no consolidated HTML+JSON aggregator yet (pytest-json + node + Playwright + axe +
  Lighthouse → one report); no screenshot **visual-regression baselines** (reviewed); no **axe-core**
  accessibility scans; no **Lighthouse** performance; artifacts (screenshot/trace/video on failure) exist
  per-run but are not aggregated.

## 8. Prioritized next-stage roadmap (Stage 4B+)

1. **CI `ui-e2e` job** (Chromium + mobile per PR; artifacts) — makes the suite continuously enforced.
2. **Consolidated QA report** (HTML+JSON) merging pytest/node/Playwright + a coverage matrix.
3. **FK-aware disposable reset** (approve the container-recreate or the extended FK-ordered cleanup).
4. **Make ops/classic API base configurable** (small app change, separately approved) → unblock full
   browser coverage for Operations + canonical Merchant Classic.
5. **Accessibility (axe-core)** across the public + portal routes; start as warnings.
6. **Visual-regression baselines** (reviewed) for the public B2C pages + portal shells.
7. **X6 invoice/e-ticket** cross-portal workflow (issuance fixture).
8. **Firefox/WebKit** engines + full 8-viewport responsive sweep (nightly/on-label).
9. **Breadth**: deeper admin (~30 views) CRUD and merchant-classic (21) workflows once their support/scope
   is confirmed; back-fill fast pytest for the 213 E2E-only endpoints.
10. **Lighthouse** performance budgets; **OWASP ZAP** baseline (Stage 8 security).

## Git status & integrity (exact)
```
478f016 test(qa): register 51-script suite, fix test-quality issues, add QA framework
f7345ad fix: return 422 for invalid month and fix assistant interpret request body   (both INTACT)
 M qa/playwright/conftest.py
?? qa/STAGE4A4_WORKFLOW_INVENTORY.md  ?? qa/STAGE4A_IMPL_REPORT.md  ?? qa/STAGE4A_PLAN.md
?? qa/playwright/e2e/{authz,cross_portal,journeys,smoke}/   ?? qa/playwright/fixtures/{auth,db,journeys}.py
(+ this review doc)
```
No application or test-suite code modified; nothing committed/pushed/deployed.

## Retained limitations (explicitly accepted)
- Operations & Merchant-Classic cross-portal workflows are **API-level verified, not fully browser-tested** (:8000 hardcode).
- **X6** invoice/e-ticket visibility **deferred**.
- QA customers with booking records need **FK-aware cleanup** (or container recreate).
- Customer **id 68** (DOM-exploration artifact) remains **untouched pending approval**.
