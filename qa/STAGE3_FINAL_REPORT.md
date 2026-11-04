# Stage 3 — Final E2E Report (analysis of `e2e_run2.log`)

Date 2026-11-04. Reporting only — no tests rerun, no code changed, no dependency installed, nothing
committed/pushed/deployed. Source: the second E2E run, `scratchpad/e2e_run2.log` (`15/48 scripts passed`).

> **Which dataset this is.** `e2e_run2.log` is the corrected full-environment run taken **before** the
> admin/manager accounts were seeded. After it, I seeded 3 staff accounts and verified all 5 roles can
> authenticate, then started a third run (`e2e_run3.log`) to measure the post-seed pass rate — but that
> run was **interrupted** (Docker Desktop / the session was torn down mid-run), so it is incomplete and
> is **not** reported as results. Per your instruction, the authoritative dataset here is run 2.

## 1. Exact counts

**Raw `run_all.py` verdicts (run 2):** 14 PASS · 33 FAIL · 1 MISSING(self-skip) = 48.

**QA re-classification by verified root cause:**

| Bucket | Count | Meaning |
| --- | ---: | --- |
| **PASS** | 14 | Ran green against the isolated DB |
| **SKIP (by safety)** | 1 | `verify_payments` self-skips ("can take real money") |
| **BLOCKED — missing seeded accounts** | 31 | 401 at login (env, pre-seeding) — not an app defect |
| **BLOCKED — optional dep / no live sandbox** | 1 | `verify_trustbrick_payments` |
| **Pre-existing test-infra issue** | 1 | `verify_m9` (suite-registration bookkeeping) |
| **Genuine application defect** | **0** | — |

## 2. All 48 scripts with individual results

### PASS (14)
`verify_storage` · `verify_storage_s3` · `verify_seed_race` · `verify_cr4a` · `verify_asset_versions` ·
`verify_fare_seed` · `verify_guest_session` · `verify_package_catalogue` · `verify_travel_assistant_routing` ·
`verify_voice_calls` · `verify_call_management` · `verify_responsive` · `verify_footer` · `verify_canonical`

### SKIP — safety (1)
`verify_payments` — self-skips: *"SKIPPING the B2C payment fixtures — this environment can take real money."*

### FAIL (33) — with actual error and root cause

| Script | Actual error | Root cause | Class |
| --- | --- | --- | --- |
| `verify_api` | `login demo.merchant@example.com: 401 Invalid email or password` | account not seeded | ENV |
| `verify_m1` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_m2` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_m3` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_m4` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_manager_approval` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_cr2` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_cr3` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_cr4b` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_cr4c` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_cr5` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_booking_completion` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_direct_booking` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_passenger_lookup` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_group_booking` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_support_center` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_assistant` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_merchant_ui_parity` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_providers` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_passport_ocr` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_customer_portal` | `login demo.merchant@…: 401` | account not seeded | ENV |
| `verify_merchant_no_approval` | `login priya.raghavan@…: 401` | account not seeded | ENV |
| `verify_m1_concurrency` | `login priya.raghavan@…: 401` | account not seeded | ENV |
| `verify_manual_booking_unquoted` | `login priya.raghavan@…: 401` | account not seeded | ENV |
| `verify_m5` | `login priya.raghavan@…: 401` | account not seeded | ENV |
| `verify_cr4d` | `login priya.raghavan@…: 401` | account not seeded | ENV |
| `verify_payment_requests` | `login priya.raghavan@…: 401` | account not seeded | ENV |
| `verify_m6` | `login priya.raghavan@…: 401` | account not seeded | ENV |
| `verify_m7` | `login priya.raghavan@…: 401` | account not seeded | ENV |
| `verify_live_chat` | `login priya.raghavan@…: 401` (admin needed) | account not seeded | ENV |
| `verify_m8` | `login priya.raghavan@…: 401` | account not seeded | ENV |
| `verify_trustbrick_payments` | `TrustBrick timed out: POST /api/partner/v1/payments` (98/99 checks passed) | optional `httpx2`/TestClient + no live TrustBrick sandbox configured | ENV/BLOCKED |
| `verify_m9` | `FAIL: every verify_*.py on disk is registered in run_all.py` — `verify_image_assets.py`, `verify_open_graph.py`, `verify_structured_data.py` are NOT in the SUITE list | pre-existing test-suite bookkeeping gap (3 scripts on disk but unregistered) | TEST-INFRA |

**Account split:** 21 scripts blocked on the merchant account (`demo.merchant@example.com`), 10 on the admin
(`priya.raghavan@…`) = **31** account-blocked scripts.

## 3. Reconciliation of "33 vs ~31"

- **33** was the count of 401 login-failure **log lines** (21 `demo.merchant` + 12 `priya`).
- **31** is the count of **FAIL scripts** whose root cause is a missing account.
- The gap = **2 of the 12 `priya` lines are `SKIP` lines inside PASSING scripts** (`verify_voice_calls`,
  `verify_call_management` skip their admin-only subsections and still pass overall; a third admin-skip
  line also appears). So line-count (33) ≠ failing-script-count (31); the two "33"s were different units.

## 4. Comparison with the previous run

| | Run 1 (`e2e_run.log`) | Run 2 (`e2e_run2.log`) |
| --- | --- | --- |
| Reported | 10/48 | 15/48 |
| PASS / FAIL / MISSING | 9 / 38 / 1 | 14 / 33 / 1 |

**+5 scripts flipped FAIL→PASS:** `verify_seed_race`, `verify_cr4a`, `verify_travel_assistant_routing`,
`verify_voice_calls`, `verify_call_management`. **Cause of the improvement:** in run 1 I had not exported
`DATABASE_URL`/`JWT_SECRET_KEY` into the `run_all.py` shell, so every script that imports the app config
crashed with `pydantic Settings` validation errors. Run 2 exported the full env; those 5 config-importing
scripts then ran. **No application code changed between the runs** — the delta is purely my harness fix.
No script regressed (0 PASS→FAIL).

## 5. Environment failures vs genuine application defects

- **Environment (not app): 33 of 33 failures.** 31 = accounts not seeded; 1 = `trustbrick` optional
  dep/no sandbox; 1 = `m9` suite-registration bookkeeping.
- **Genuine application defects: 0.** Every passing script asserted real behaviour against the real DB
  (storage, wallet ledger arithmetic `cr4a`, concurrent admin seeding `seed_race`, assistant routing,
  catalogue filtering, SEO) and passed. No failure traced to application logic.
- **Post-seed note:** after run 2, all 5 role logins were verified working (SUPER/ADMIN/ADMIN2/MANAGER →
  correct roles; MERCHANT → Aurora merchant_admin, merchant_id 1), so the 31 account-blocked scripts are
  expected to clear on a completed seeded re-run. That measurement was interrupted and is not claimed here.

## 6. Payment-test safety — confirmed

- `verify_payments` **self-skipped** with the explicit guard *"this environment can take real money."*
- `PAYMENT_PROVIDER=none`, `PAYMENT_ENVIRONMENT=test`, `DEPLOYED=false` throughout — no gateway configured,
  so no script could move real money. Payment-adjacent scripts (`cr4b/c/d`, `payment_requests`) failed at
  login before touching any payment path. **No real payment or refund was initiated.**

## 7. Database target — confirmed exclusive to `jpw_qa` @ localhost:5435

- The app config resolved to `localhost:5435/jpw_qa` (verified directly).
- The DB safety gate passed (local host, disposable name, no production markers) before migrate/seed.
- **0** database connectivity errors in the log; **0** references to `:5433`/`:5434` (your other project DBs).

## 8. No production / other-project / payment / deployment impact — confirmed

- The 13 log lines matching "prod-like" patterns are **all strings**, not network calls: the
  `@jackpotsworldtours.com` email domain inside login attempts (which went to `localhost:8099`), and one
  `https://jackpotsworldtours.com` inside the `verify_canonical` **string assertion**. No `rds.amazonaws`,
  no `trustbrick.org`/`api.trustbrick`, no `clari5pay_db`/`vera-full-project-db` contact.
- Other project containers on ports 5433/5434 were left untouched; only `jpw_qa_pg` (5435) was used.
- Duffel/Hotelbeds dormant (no credentials). No deployment. No `git commit`/`push` (tree shows only `qa/`).

## 9. Files modified during the Stage-3 process

- **Existing repository files changed: NONE.** `git status` shows only `?? qa/` (all-new, untracked).
- **New files created** (all under `qa/`, untracked): the Stage-2 inventory set, the Playwright scaffold
  (`qa/playwright/**`), the env scripts (`qa/scripts/**`), `qa/requirements-qa.txt`, `qa/.env.qa.example`,
  the Stage-3 docs, and this report.
- **Python environment (not repo files):** installed `playwright 1.63.0` (+ Chromium), `pytest-playwright`,
  `pytest-base-url`. Removable with `pip uninstall`.
- **Database state (ephemeral container `jpw_qa_pg`):** migrated to head `0093`; seeded **3** staff accounts
  (`priya.raghavan`, `ops.desk` = admin; `manager.desk` = manager) via the repo's own `seed_account.py`.
  No existing account overwritten (the script refuses duplicates).
- **Scratchpad (outside repo):** `e2e_run*.log` and parsing helpers in the session temp dir.

## Current environment state

Docker Desktop's engine is **not reachable right now** (shut down between sessions, not by any QA action),
so the `jpw_qa_pg` container and the `:8099` app are stopped. The container is named (not `--rm`), so if it
still exists, `docker start jpw_qa_pg` would resume it with the migrated+seeded data intact; this could not
be verified while the engine is down. Teardown when finished: `bash qa/scripts/stop_test_env.docker.sh`.
