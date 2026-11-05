# Stage 3 — Final Seeded E2E Run Report

Date 2026-11-04. One run of all 48 scripts against the isolated DB with accounts seeded.
Source: `scratchpad/e2e_run_final.log` (`42/48 scripts passed`). Safety conditions honored throughout
(see §Safety). No application/test/`run_all.py` code changed; nothing committed/pushed/deployed.

## Headline

| | Run 2 (pre-seed) | **Final (seeded)** |
| --- | --- | --- |
| `run_all` tally | 15/48 | **42/48** |
| PASS | 14 | **41** |
| FAIL | 33 | **6** |
| SKIP/MISSING (safety) | 1 | **1** |
| Flipped FAIL→PASS | — | **+27** |
| Regressions (PASS→FAIL) | — | **0** |

Seeding the 3 staff accounts + using the existing Aurora merchant cleared **all 27** account-blocked
scripts with **zero regressions**. Of the 6 remaining failures, **3 are environmental/harness** and
**3 are candidate application findings** that need code inspection (none confirmed as a defect yet).

## PASS / FAIL / SKIP / BLOCKED (classified)

| Class | Count | Scripts |
| --- | ---: | --- |
| **PASS** | 41 | all except the 7 below |
| **SKIP (safety)** | 1 | `verify_payments` (self-skip: "can take real money") |
| **BLOCKED / ENVIRONMENT** (not app) | 3 | `verify_m9`, `verify_trustbrick_payments`, `verify_m1` |
| **CANDIDATE APP FINDING** (unconfirmed) | 3 | `verify_assistant`, `verify_customer_portal`, `verify_live_chat` |
| **Confirmed application defects** | 0 | — (the 3 candidates require Stage-4 code inspection) |

## The 6 failures — actual error + root cause

### Environment / harness (not application defects)
1. **`verify_m9`** — `FAILED: every verify_*.py on disk is registered in run_all.py` — 3 scripts
   (`verify_image_assets`, `verify_open_graph`, `verify_structured_data`) are not in the SUITE list.
   Pre-existing suite-registration gap; we were instructed not to modify `run_all.py`. **Not an app defect.**
2. **`verify_trustbrick_payments`** — `TrustBrick timed out: POST /api/partner/v1/payments`. Needs the
   optional `httpx2` (Starlette TestClient) and/or a live TrustBrick sandbox — both deliberately excluded
   per your conditions. **Not an app defect** (environment/optional-dep).
3. **`verify_m1`** — **36 checks passed, 0 failed**, then the script crashed with
   `UnicodeEncodeError: 'charmap' codec can't encode character '→'` while *printing* a check name that
   contains a `→` arrow, under the Windows cp1252 console. The assertions passed; the script died
   formatting output. **Not an app or test-logic defect** — a Windows-console encoding issue in the harness;
   it would complete on a UTF-8 console (CI/Linux). (Fix later by setting `PYTHONUTF8=1` for the run.)

### Candidate application findings — ran past login, real assertion failures, NOT yet confirmed
> These three now execute (they only failed on login before). Their failures are genuine assertion
> failures, but confirming whether each is an application defect or test-drift requires reading the
> relevant router/service code — a Stage-4 activity. They are reported as **candidates**, not defects.

4. **`verify_assistant`** — `config/interpret: unauthenticated is refused -- 403` and
   `AssertionError: interpret 'what is my wallet balance': 422 {detail: loc:["query","payload"], "Field required"}`.
   The assistant endpoints returned 403 where the test expected a different refusal, and `interpret`
   expects `payload` as a **query** parameter the test didn't supply. Looks like an **API-contract mismatch**
   (endpoint vs test) — could be test drift or a real contract bug. Needs code inspection.
5. **`verify_customer_portal`** — cluster of session/logout lifecycle checks failed: `profile requires
   authentication`, `sessions endpoint requires authentication`, `the session is live before logout`,
   `logout returns 200`, `logout requires a session`. Points at the **customer session/logout endpoints** —
   the strongest candidate for a genuine behavior gap, but possibly test drift. Needs code inspection.
6. **`verify_live_chat`** — `FAILED: both concurrent opens returned a conversation [7]`. The single-winner /
   idempotent "open conversation" guarantee did not hold for two concurrent opens. Candidate **concurrency
   finding** in chat-open, or test timing. Needs code inspection.

### Additional observation (did not fail a script)
- The **app** log (`server_final.log`) shows `ValueError: month must be in 1..12` on some request during
  the run — an unhandled server-side exception on a bad `month` input. It surfaced **0** times in the suite
  log (no script failed on it), but it is a possible input-validation/500 robustness item worth a Stage-4 look.

## Individual script results (all 48)

**PASS (41):** verify_storage, verify_storage_s3, verify_seed_race, verify_cr4a, verify_asset_versions,
verify_fare_seed, verify_api, verify_merchant_no_approval, verify_m1_concurrency, verify_m2, verify_m3,
verify_manager_approval, verify_m4, verify_cr5, verify_cr2, verify_booking_completion, verify_direct_booking,
verify_passenger_lookup, verify_manual_booking_unquoted, verify_group_booking, verify_cr3, verify_cr4b,
verify_cr4c, verify_m5, verify_cr4d, verify_payment_requests, verify_m6, verify_m7, verify_support_center,
verify_merchant_ui_parity, verify_providers, verify_passport_ocr, verify_guest_session,
verify_package_catalogue, verify_travel_assistant_routing, verify_responsive, verify_footer, verify_canonical,
verify_voice_calls, verify_call_management, verify_m8.

**SKIP-safety (1):** verify_payments.

**FAIL (6):** verify_m9 (ENV/registration), verify_trustbrick_payments (ENV/optional-dep),
verify_m1 (ENV/Windows-encoding), verify_assistant (candidate), verify_customer_portal (candidate),
verify_live_chat (candidate).

## Before → after comparison

- **+27 flipped FAIL→PASS:** api, booking_completion, cr2, cr3, cr4b, cr4c, cr4d, cr5, direct_booking,
  group_booking, m1_concurrency, m2, m3, m4, m5, m6, m7, m8, manager_approval, manual_booking_unquoted,
  merchant_no_approval, merchant_ui_parity, passenger_lookup, passport_ocr, payment_requests, providers,
  support_center. All were previously 401-blocked on the missing accounts.
- **0 regressions:** every script that passed in run 2 still passes.
- **Still FAIL:** 6 (3 environmental, 3 candidates) — detailed above.

## Safety — confirmed for this run
- **Container:** only the **existing** `jpw_qa_pg` was started (`docker start`); nothing recreated. DB verified
  `jpw_qa` @ `localhost:5435`, alembic head `0093`, 6 users (incl. the 3 seeded staff) — all persisted.
- **DB safety gate** passed before boot; app config resolved to `localhost:5435/jpw_qa` only.
- **Payments:** `verify_payments` self-skipped; `PAYMENT_PROVIDER=none` — no real payment/refund.
- **No `httpx2`** (or any dep) installed; no application/test/`run_all.py` code changed.
- **No** production, external payment-service, or other-project-DB contact (other containers left as-is).
- **Suite run exactly once.** No commit/push/deploy.

## Current state / teardown
- The app (`:8099`) and container `jpw_qa_pg` are **left running** for any follow-up inspection.
- Teardown when you want: stop the app; `docker stop jpw_qa_pg` (keep data) or
  `bash qa/scripts/stop_test_env.docker.sh` (destroy the container).
