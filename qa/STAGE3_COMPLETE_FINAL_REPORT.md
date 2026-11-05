# Stage 3 — Complete Final Report (seeded E2E run)

Date 2026-11-04. Reporting only — built from the existing `scratchpad/e2e_run_final.log` (and the app's
`server_final.log`). Nothing was rerun or modified; logs and the running environment are preserved.
`git status` = `?? qa/` only (no tracked file changed; empty diff).

---

## 1. Exact counts — and whether 42 includes safety skips

| Bucket | Count |
| --- | ---: |
| **PASS** | 41 |
| **FAIL** | 6 |
| **SKIP (safety)** | 1 (`verify_payments`) |
| **BLOCKED** (as a distinct bucket) | 0 — see note |
| **Total** | 48 |

**Does `42/48` include the safety skip? YES.** `run_all.py` computes `len(results) − failed`; a skip/MISSING
is stored with `code=None` and is **not** counted as failed, so it lands in the "passed" numerator.
**42 = 41 real PASS + 1 safety-SKIP** (`verify_payments`). "BLOCKED" is not a label `run_all` emits — in this
report I classify the 6 FAILs by cause below (4 are environment/infra "blocked-like", 2 are candidate findings).

---

## 2. Individual results — all 48

**PASS (41):** verify_storage, verify_storage_s3, verify_seed_race, verify_cr4a, verify_asset_versions,
verify_fare_seed, verify_api, verify_merchant_no_approval, verify_m1_concurrency, verify_m2, verify_m3,
verify_manager_approval, verify_m4, verify_cr5, verify_cr2, verify_booking_completion, verify_direct_booking,
verify_passenger_lookup, verify_manual_booking_unquoted, verify_group_booking, verify_cr3, verify_cr4b,
verify_cr4c, verify_m5, verify_cr4d, verify_payment_requests, verify_m6, verify_m7, verify_support_center,
verify_merchant_ui_parity, verify_providers, verify_passport_ocr, verify_guest_session,
verify_package_catalogue, verify_travel_assistant_routing, verify_responsive, verify_footer, verify_canonical,
verify_voice_calls, verify_call_management, verify_m8.

**SKIP — safety (1):** verify_payments (`"SKIPPING the B2C payment fixtures — this environment can take real money."`).

**FAIL (6):** verify_m9, verify_trustbrick_payments, verify_m1, verify_assistant, verify_customer_portal, verify_live_chat.

---

## 3. Every failed script — actual error + root cause + class

| Script | Actual error (from log) | Root cause | Class |
| --- | --- | --- | --- |
| `verify_m9` | `FAILED: every verify_*.py on disk is registered in run_all.py` | 3 scripts (`verify_image_assets`, `verify_open_graph`, `verify_structured_data`) not in SUITE | **ENV / test-infra** |
| `verify_trustbrick_payments` | `TrustBrick timed out: POST /api/partner/v1/payments` | needs optional `httpx2` (TestClient) + live sandbox — both excluded per instruction | **ENV / optional-dep** |
| `verify_m1` | `UnicodeEncodeError: 'charmap' can't encode '→'` after **36 passed, 0 failed** | crash while *printing* a check name containing `→` on the Windows cp1252 console; assertions had passed | **ENV / Windows console encoding** |
| `verify_customer_portal` | **114 passed, 5 failed** (profile/sessions auth + logout) interleaved with `Rate limit exceeded: 10 per 1 minute` | per-IP auth rate-limit exhausted by the long sequential single-IP run → 429 where 401/200 expected | **ENV / rate-limit (§4)** |
| `verify_assistant` | `interpret …: 422 {loc:["query","payload"],"Field required"}`; `unauthenticated is refused -- 403` | assistant API contract vs test expectation (payload as query param; 403 vs expected refusal) | **CANDIDATE** (needs code review) |
| `verify_live_chat` | `FAILED: both concurrent opens returned a conversation [7]` | single-winner/idempotent "open conversation" guarantee not observed under concurrency | **CANDIDATE** (needs code review) |

Separately, the **application log** recorded one unhandled exception during the run (did not fail a script) — a
genuine defect — detailed in §5.

---

## 4. Detailed investigation — `verify_customer_portal` auth failures

**Result: 114 passed / 5 failed. The 5 failures are a rate-limit artifact, not an authentication defect.**

The 5 failing checks:
- §6 Profile: `profile requires authentication`, `sessions endpoint requires authentication`
- §9 Logout: `the session is live before logout`, `logout returns 200`, `logout requires a session`

What actually passed (the real auth/isolation surface):
- All of §1 structural isolation (46 B2C tables, no cross-boundary FK, services import no merchant model).
- All of §2 signup + CUS- sequence, §3 login-by-email/mobile + wrong-password/OTP refusals.
- **All of §4 cross-portal isolation (27 checks):** customer/merchant/admin/manager/super_admin tokens each
  refused at the other side's endpoints, including `/api/customer/profile` and `/api/customer/profile/sessions`.
- §5 (customer endpoints write nothing merchant-side; logout closed the session row), §7 change-password, §8
  forgot/reset revokes sessions.

Root cause: immediately before the 5 failures the log shows repeated
`(rate-limited on login; waiting 5s/12s/25s/62s) … {"error":"Rate limit exceeded: 10 per 1 minute"}`. The
customer-auth endpoints enforce **5/min signup, 10/min login per IP**. Running all 48 scripts back-to-back from
one IP exhausts that shared budget by the later sections, so:
- the negative checks (`profile/sessions requires authentication`) received **429** instead of the expected
  **401** → assertion on status fails;
- the logout section could not establish a fresh live session (login 429 after 5 retries), so
  `session is live before logout` is false and the rest cascade.

This is the rate limiter **working as designed**; §4 already proves the endpoints *do* require and isolate auth.
Not an application defect. (It would pass if run in isolation or with a per-script IP/limit reset; a future
option is to raise the dev-env limit or space these scripts.)

---

## 5. Investigation — `ValueError: month must be in 1..12`

- **Endpoint:** `GET /api/customer/package-bookings` → `list_packages`
  ([customer_package_bookings.py:196](backend/app/routers/customer_package_bookings.py:196)).
- **Request:** a `month` query parameter with an out-of-range/malformed value (e.g. `2026-13`).
- **Where it breaks:** `search_packages`
  ([customer_package_catalog_service.py:147](backend/app/services/customer_package_catalog_service.py:147)):
  `start = dt.date.fromisoformat(month + "-01")` → Python raises `ValueError: month must be in 1..12`.
- **Handling:** the router validates `category` and `trip_type` (422 on bad values) but **not** `month`; the
  `ValueError` is **unhandled** and propagates through the middleware → **HTTP 500**.
- **Genuine defect? YES (low severity).** A malformed/out-of-range `month` on an authenticated endpoint returns
  **500** instead of a clean **422/400**. The **public** `/api/packages` variant *does* guard month
  (`verify_package_catalogue`'s "an impossible month is refused" passed), so the customer-authed endpoint is
  simply missing the same validation. No data exposure or corruption; it is an input-validation / error-shape
  gap. It did not fail a suite script because the script that asserts on bad months exercises the public
  endpoint, not this one.
- **Suggested fix (for an approved Stage 4):** validate `month` in the router (reject non-`YYYY-MM` / month
  1–12 with 422), or wrap the `fromisoformat` parse in `search_packages` and raise `HTTPException(422)`.

---

## 6. Were the 31 previous account-related failures resolved? — YES

Run 2 had 31 account-login failures (21 needing `demo.merchant`, 10 needing `priya.raghavan`). After seeding the
3 staff accounts + using the existing Aurora merchant:
- **All 31 now get past login** (0 remaining `401 Invalid email or password`).
- **27 pass outright** (full green).
- **4 advanced past login** to reveal non-login issues: `verify_m1` (Windows encoding — 36 checks passed),
  `verify_customer_portal` (rate-limit, 114/5), `verify_assistant` (contract candidate),
  `verify_live_chat` (concurrency candidate).

So the account-seeding gap is **fully resolved**; no script now fails at authentication.

---

## 7. Comparison — 15/48 (run 2) vs 42/48 (final)

| | Run 2 (pre-seed) | Final (seeded) |
| --- | --- | --- |
| Reported | 15/48 | 42/48 |
| PASS / FAIL / SKIP | 14 / 33 / 1 | 41 / 6 / 1 |
| Flipped FAIL→PASS | — | **+27** |
| Regressions PASS→FAIL | — | **0** |

**+27 flipped:** api, booking_completion, cr2, cr3, cr4b, cr4c, cr4d, cr5, direct_booking, group_booking,
m1_concurrency, m2, m3, m4, m5, m6, m7, m8, manager_approval, manual_booking_unquoted, merchant_no_approval,
merchant_ui_parity, passenger_lookup, passport_ocr, payment_requests, providers, support_center.
Every run-2 PASS still passes (0 regressions). The only change between runs was **test-account seeding** — no
application or test code was altered.

---

## 8. Genuine application defects vs test-infrastructure issues

**Genuine application defect — 1 (confirmed):**
- **`month` → HTTP 500** on `GET /api/customer/package-bookings` with an invalid `month` (missing input
  validation; §5). Low severity.

**Candidate findings — 2 (not confirmed; require Stage-4 code review):**
- **`verify_assistant`** — assistant `interpret`/`config` contract mismatch (422 "payload required" / 403).
  May be test drift or a real contract bug.
- **`verify_live_chat`** — concurrent "open conversation" single-winner guarantee not observed. May be a real
  race or test timing.

**Test-infrastructure / environment (not application defects) — 4:**
- `verify_m9` (3 scripts unregistered in `run_all.py`), `verify_trustbrick_payments` (optional `httpx2` + live
  sandbox excluded), `verify_m1` (Windows cp1252 print crash; 36 checks passed), `verify_customer_portal`
  (per-IP auth rate-limit exhaustion; 114 passed, limiter behaving correctly).

---

## 9. Payments skipped + no production/external contact — confirmed
- `verify_payments` **self-skipped** (safety guard); `PAYMENT_PROVIDER=none`, `PAYMENT_ENVIRONMENT=test`,
  `DEPLOYED=false` — no gateway configured, **no real payment/refund** possible.
- `verify_trustbrick_payments` **timed out** precisely because no live TrustBrick endpoint was reachable — i.e.
  it did **not** contact any external payment service. **No `httpx2` installed.**
- No production, external payment-service, or other-project-DB contact. All calls were to `localhost:8099`
  (app) backed by `localhost:5435/jpw_qa` (the isolated container). Other project containers (5433/5434) untouched.

## 10. No application or test code modified — confirmed
- `git status` = `?? qa/` only; `git diff` and `git diff --cached` are **empty** → no tracked file changed.
- No change to application code, `tests/**`, or `run_all.py`. Source files were **read** (for §5) but not edited.
- The suite ran **exactly once**; nothing committed, pushed, or deployed.

---

## Environment state (preserved)
Container `jpw_qa_pg` (postgres:16-alpine, `5435→5432`, db `jpw_qa`, head `0093`, 6 users) and the app on
`:8099` are **left running**, as instructed. Teardown when you choose: `docker stop jpw_qa_pg` (keep data) or
`bash qa/scripts/stop_test_env.docker.sh` (destroy).
