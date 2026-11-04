# Stage 3 — Live Environment + E2E Baseline (results)

Date 2026-11-04. The isolated Docker environment was brought up and the existing `verify_*` E2E
suite executed against it. No application logic, production config, or existing tests were modified.

## Environment verification (all confirmed before migrating)

| Check | Result |
| --- | --- |
| Docker running | ✓ engine 29.5.3, daemon up |
| Container | ✓ `jpw_qa_pg`, image `postgres:16-alpine` |
| Port | ✓ host **5435** → container 5432 (5433/5434 were taken by your other project DBs `clari5pay_db`, `vera-full-project-db-1`, which were left untouched) |
| Database name | ✓ `jpw_qa`, role `jpw_qa` |
| Cannot reach production | ✓ safety gate passed; **0** connectivity errors to anything but localhost:5435; URL has no prod markers |
| Payment provider | ✓ `PAYMENT_PROVIDER=none` |
| External suppliers | ✓ Duffel/Hotelbeds dormant (no creds); `OCR_PROVIDER=none`; `STORAGE_BACKEND=local` |
| App flags | ✓ `DEPLOYED=false`, `OTP_DEV_ECHO=true` |

Migrations: `alembic upgrade head` → **0093** (94 migrations), 73 tables, clean.
Seed (from migrations): **3 accounts** — `admin@jackpotsworldtours.com` (super_admin) + 2 merchant_admins.
App: booted on **:8099**, `/api/health` = `{"status":"ok"}`, schema `v2-nine-table`.

## E2E suite result: 14 PASS · 1 SKIP(safety) · 33 FAIL  (`run_all.py` tally: 15/48)

> Note: a first run under-reported because I had not exported `DATABASE_URL`/`JWT_SECRET_KEY` into the
> `run_all.py` shell, so scripts that import the app config raised `Settings` validation errors. That
> was a harness mistake on my side; the numbers below are from the corrected re-run with full env.

### PASS (14) — ran green against the isolated DB
`verify_asset_versions` · `verify_call_management` · `verify_canonical` · `verify_cr4a` ·
`verify_fare_seed` · `verify_footer` · `verify_guest_session` · `verify_package_catalogue` ·
`verify_responsive` · `verify_seed_race` · `verify_storage` · `verify_storage_s3` ·
`verify_travel_assistant_routing` · `verify_voice_calls`

### SKIP by safety design (1) — NOT a failure, NOT a pass
`verify_payments` → self-skips: *"SKIPPING the B2C payment fixtures — this environment can take real
money."* Correct behaviour; recorded as BLOCKED-by-safety.

### FAIL (33) — cause breakdown (honest; most are NOT app bugs)

| Cause | Count | Scripts | Nature |
| --- | ---: | --- | --- |
| **Missing seeded account** (`demo.merchant@example.com`, `priya.raghavan@…`, `manager.desk`, `ops.desk`) → 401 at login | ~31 | all the `verify_m*`, `cr2/3/5`, `cr4b/c/d`, `verify_api`, `booking_completion`, `direct_booking`, `group_booking`, `manual_booking_unquoted`, `manager_approval`, `merchant_*`, `passenger_lookup`, `passport_ocr`, `payment_requests`, `providers`, `support_center`, `customer_portal`, `assistant`, `live_chat` | **Environment seeding gap** — the alembic seeds do not create the verify-suite's accounts |
| **Optional dep missing** (`httpx2` for Starlette TestClient) | 1 | `verify_trustbrick_payments` | Known per `tests/README` — "fails rather than skips" without `httpx2` |
| **Suite bookkeeping** | 1 | `verify_m9` | Pre-existing: 3 scripts on disk (`verify_image_assets`, `verify_open_graph`, `verify_structured_data`) are not registered in `run_all.py`'s SUITE — `m9` guards exactly this |

Evidence: 33 login-failure lines, all for `demo.merchant@example.com` (21) and
`priya.raghavan@jackpotsworldtours.com` (12). **Zero** database connectivity errors.

## What this tells us

- The isolated environment is **correct and working** — migrations, seed, boot, HTTP all succeed, and
  nothing touched production or external suppliers.
- The E2E pass rate is **gated almost entirely by test-account seeding**, not by application defects.
  `alembic upgrade head` provisions super_admin + merchant_admins only; the verify suite expects
  `priya.raghavan` (admin), `ops.desk` (admin2), `manager.desk` (manager) and `demo.merchant` (merchant).
- Two failures are pre-existing, account-independent, and documented in the repo itself
  (`httpx2` optional dep; `m9` suite-registration) — not introduced by this work.

## Honest limitations

- I did **not** fabricate or infer any pass: 33 scripts are recorded as FAIL with their real cause.
- I did **not** seed the four missing accounts yet (that edges into "making the suite pass", which I
  paused for your decision). Seeding them via the repo's own `backend/scripts/seed_account.py` (admin,
  manager) + a merchant org/user is the natural unblock and would let us measure the true E2E pass rate.
- `verify_payments` stays SKIP by design; we never enable real-money fixtures.

## Teardown

Stop app + destroy DB: `bash qa/scripts/stop_test_env.docker.sh` (removes `jpw_qa_pg`, data gone).
The app (:8099) and container are currently **left running** so the next step (if approved) can seed
accounts and re-run without a cold start.
