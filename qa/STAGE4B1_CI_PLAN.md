# Stage 4B.1 — Plan: GitHub Actions Playwright UI E2E (`ui-e2e` job)

**Planning only. No files changed, no CI edited, no app code.** Adds a 4th CI job alongside the three
existing ones (`backend-tests`, `frontend-tests`, `postgres-migrations`), which are preserved unchanged.
Reuses the committed QA harness: `qa/requirements-qa.txt`, `qa/scripts/check_db_safety.py`,
`qa/playwright/**`, the Alembic seed migrations, `backend/scripts/seed_account.py`, and the `-m e2e` gating.

## Current CI (unchanged): `.github/workflows/ci.yml`
`backend-tests` (pytest on SQLite), `frontend-tests` (node --test), `postgres-migrations` (alembic up/down
on a `postgres:18-alpine` service). `on: push/pull_request → main`; **no secrets**; Python 3.12, node 22,
10-min timeouts. The new job mirrors these conventions.

## 1. The `ui-e2e` job (shape)
- Independent job (own `runs-on: ubuntu-latest`), same triggers (`push`/`pull_request` to `main`).
- Does **not** modify or depend on the three existing jobs. Optionally `needs: backend-tests` so it only
  runs when fast tests pass (saves minutes) — recommended but optional.
- `timeout-minutes: 20` (ample; expected ~3–5 min).

## 2. Isolated PostgreSQL service + disposable QA database
```yaml
services:
  postgres:
    image: postgres:18-alpine            # matches postgres-migrations job
    env:
      POSTGRES_USER: jpw_qa
      POSTGRES_PASSWORD: jpw_qa_local     # throwaway, non-secret (CI-only)
      POSTGRES_DB: jpw_qa
    ports: ["5432:5432"]
    options: >-
      --health-cmd "pg_isready -U jpw_qa" --health-interval 5s
      --health-timeout 5s --health-retries 5
```
`DATABASE_URL=postgresql+psycopg2://jpw_qa:jpw_qa_local@localhost:5432/jpw_qa`. The DB name ends in
`jpw_qa` and the host is `localhost`, so the **safety gate passes unchanged** (not weakened). The service
container is destroyed when the job ends — the disposable-DB reset is automatic in CI.

## 3. Safe migration + test-account seeding (steps)
1. `pip install -r backend/requirements.txt pytest httpx` + `pip install -r qa/requirements-qa.txt`.
2. `playwright install --with-deps chromium` (Linux needs `--with-deps` for browser libraries).
3. **DB safety gate FIRST:** `python qa/scripts/check_db_safety.py` (must exit 0 before touching the DB) —
   asserts local host + disposable `*_qa` name + `DEPLOYED!=true` + `PAYMENT_PROVIDER=none`.
4. `cd backend && alembic upgrade head` — runs all migrations incl. the seed ones (0002/0003/0027/0083):
   creates `admin@jackpotsworldtours.com` (super_admin) + the two demo merchants (Aurora/Blueline).
5. Seed the three staff accounts the suite expects, via the repo's own tool (no raw SQL):
   `JPW_SEED_PASSWORD=… python backend/scripts/seed_account.py --email priya.raghavan@… --role admin`
   (and `ops.desk@…` admin, `manager.desk@…` manager). The merchant uses the seeded **Aurora** account
   via `JPW_MERCHANT_EMAIL/PASSWORD` override.

## 4. Application startup + health checks
- `cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8099 --no-access-log &` (background; no
  `--reload`). `WEB_CONCURRENCY=1` so the in-process chat registry works without Redis.
- Health-gate: poll `GET /api/health` until `{"status":"ok"}` (bounded loop, ~40s cap) before running tests.

## 5. Playwright Chromium install + execution
- Chromium only (engine coverage decision; Firefox/WebKit deferred).
- `cd qa/playwright && python -m pytest -m e2e --browser=chromium --junitxml=results.xml`
  (pytest.ini `addopts` already set `--screenshot=only-on-failure --tracing=retain-on-failure
  --video=retain-on-failure --output=artifacts`).
- Run **serially** (no `pytest-xdist`) — see §Unreliable-tests (rate limits).

## 6. Existing markers + test selection
- Select `-m e2e` → the 38 live specs (smoke anon/authed, authz, journeys, cross-portal). The offline
  `test_scaffold_smoke.py` (marked `smoke`, not `e2e`) can run as a fast pre-gate (`-m "smoke and not e2e"`)
  or be left to local use. `require_server`/`server_available` gating means any live spec SKIPS (not fails)
  if the app is down — in CI the app is up, so they execute. `test_operations_boots_in_browser` stays
  **skipped** (documented :8000 limitation).

## 7. Screenshots, traces, videos, failure artifacts
- Already produced on failure under `qa/playwright/artifacts` (screenshot/trace.zip/video).
- Upload with `actions/upload-artifact@v4` (`if: always()`, `path: qa/playwright/artifacts`, retention 7–14d).
- Also upload `qa/playwright/results.xml` (JUnit) for the GitHub test summary; optionally
  `mikepenz/action-junit-report` or `dorny/test-reporter` for inline annotations.

## 8. Timeouts, retries, failure reporting
- Job `timeout-minutes: 20`.
- **No blanket auto-retries** initially (reruns can mask real flakiness and hide the signup rate-limit
  issue we need to fix properly). If a scoped safety net is wanted, add `pytest-rerunfailures` with
  `--reruns 1 --only-rerun "RateLimit|429"` rather than global reruns.
- Failure reporting: non-zero pytest exit fails the job; JUnit + artifacts attached; `concurrency`
  group cancels superseded runs (mirror the existing `ci.yml` concurrency block).

## 9. CI environment variables & security
All values are **synthetic or reproducible dev seeds — NO production secrets, NO GitHub Secrets needed**
(matches the existing CI's "SECRETS: none required"):
```
DATABASE_URL=postgresql+psycopg2://jpw_qa:jpw_qa_local@localhost:5432/jpw_qa
JWT_SECRET_KEY=ci-ui-e2e-not-a-secret-0123456789abcdef
DEPLOYED=false  PAYMENT_PROVIDER=none  PAYMENT_ENVIRONMENT=test
OTP_DEV_ECHO=true  STORAGE_BACKEND=local  OCR_PROVIDER=none  WEB_CONCURRENCY=1  PYTHONUTF8=1
FRONTEND_BASE_URL=http://127.0.0.1:8099  CORS_ORIGINS=http://127.0.0.1:8099,http://localhost:8099
JPW_QA_BASE=http://127.0.0.1:8099  JPW_BASE=http://127.0.0.1:8099
JPW_MERCHANT_EMAIL=jackpotsworldtours.travels@gmail.com   # seeded by migration 0023 (dev, not secret)
JPW_MERCHANT_PASSWORD=<Aurora seed pwd from 0023>          # non-secret dev seed; set as plain workflow env
JPW_SEED_PASSWORD=<per-account, set inline for seed_account.py; non-secret dev values>
```
- **No production/RDS/other-project DB**: the only DB is the job's own `postgres` service; the safety gate
  enforces this and is NOT weakened.
- **No real payment/OTP/supplier/external calls**: `PAYMENT_PROVIDER=none`, suppliers unconfigured,
  `OTP_DEV_ECHO=true` (OTPs returned in-API, never sent). `verify_payments`-style guards still apply.
- The dev-seed credentials are reproducible from `backend/alembic/versions/` (as `tests/config.py`
  documents) — they are not production secrets and must never be replaced with real ones.

## 10. Runtime & resource considerations
- ubuntu-latest (2 vCPU). Expected: pip install (cached) ~30–60s; `playwright install chromium` ~20–40s
  (cache `~/.cache/ms-playwright`); alembic+seed ~15s; app boot ~8s; `-m e2e` suite ~70–90s → **~3–5 min**.
- Single worker (serial) — small CPU footprint; avoids the shared per-IP rate limit.
- Cache: pip (`cache: pip` on setup-python) + a `~/.cache/ms-playwright` cache keyed on the playwright
  version to avoid re-downloading Chromium each run.

## Tests that cannot safely/reliably run in CI (and why)
| Test(s) | Issue | Handling |
| --- | --- | --- |
| `test_operations_boots_in_browser` | ops-core.js hardcodes API `:8000`; CI app is `:8099` → can't reach API in-browser | **Already `@skip`** with reason; expected skip in CI (Operations verified at API level). Not an app change. |
| Customer-signup-heavy specs (`customer_session`, `role_tokens` customer, X1, C1, `new_authed_page('customer')`) | signup is **5/min per IP**; a run does ~4–6 signups on **one** CI IP; `create_customer` has **no 429 backoff** (`raise_for_status`) → a 429 FAILS | **Reliability risk.** Mitigate TEST-SIDE (Stage-4B.1 impl, no prod-limit change): (a) run serially (no xdist); (b) reuse `customer_session` wherever possible; (c) add a bounded 429 backoff/retry to `create_customer`. Do NOT raise the production rate limit. |
| Merchant-Classic journey browser portion | classic-shell.js hardcodes API `:8000` | CI-safe as written — the browser assertion only checks the shell loads (no `:8099` data dependency); the workflow is API-level. |
| 51-script `verify_*` suite, CDP `tests/js/browser` | need `httpx2`/`websockets`/local Chrome + a running server with seeded B2B data; separate harness | **Out of scope** for `ui-e2e`; they are their own concern (existing `frontend-tests` covers node; verify suite is a separate future job). |
| Visual-regression / axe / Lighthouse | not implemented yet | N/A this stage. |

## Constraints honored by this plan
Three existing CI jobs preserved; only `localhost` service DB (no prod/RDS/other-project); no real
payment/OTP/supplier/external; no production secrets (synthetic + reproducible dev seeds, no GitHub
Secrets); DB safety gate kept and run first (not weakened); no application code change; commits
`f7345ad` & `478f016` preserved; nothing committed/pushed/deployed. Implementation (writing the workflow
+ the small test-side rate-limit mitigation) awaits your approval.
