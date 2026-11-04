# Stage 3 — Local Test Env + Framework Scaffold (results)

Date 2026-11-04. Scope executed: **framework scaffold + minimum deps + safety tooling + baseline
re-run**. The live `jpw_qa` database was **not created** — it needs a DB credential that is yours to
provide (see "Blocked" below). No application code changed, nothing committed/pushed, no deploy.

## 1. Local environment setup instructions

Two supported paths. **Docker is recommended** (true isolation, no need for your existing Postgres
password, matches the CI image). Pick one.

### Path A — Docker (recommended)
1. Start Docker Desktop.
2. `bash qa/scripts/start_test_env.docker.sh` — safety-gates, launches `postgres:16-alpine` on host
   port 5433 with throwaway creds, runs `alembic upgrade head` (seeds), boots the app on `:8099`.
3. Verify: `curl http://127.0.0.1:8099/api/health`.
4. Stop + clean: `bash qa/scripts/stop_test_env.docker.sh` (removes the container = destroys the DB).

### Path B — existing local PostgreSQL 18 (already running on this machine, port 5432)
1. `cp qa/.env.qa.example qa/.env.qa` and set the `jpw_qa` password in it.
2. One-time, to let the script create the role+db: `$env:PGADMIN_PASSWORD = "<your postgres superuser password>"`.
3. `pwsh qa/scripts/start_test_env.ps1` — safety-gates, creates `jpw_qa` role+db if absent, migrates+seeds, boots `:8099`.
4. Stop: `pwsh qa/scripts/stop_test_env.ps1`  ·  Stop + drop DB: `pwsh qa/scripts/stop_test_env.ps1 -DropDb`.

## 2. Testing-framework directory structure (created)

```
qa/
  requirements-qa.txt            # isolated QA deps (never in backend/requirements.txt)
  .env.qa.example                # env template (copy to git-ignored qa/.env.qa)
  scripts/
    check_db_safety.py           # REFUSES non-local/non-disposable DBs (fail-closed gate)
    start_test_env.ps1 / stop_test_env.ps1          # local PG 18 path
    start_test_env.docker.sh / stop_test_env.docker.sh   # Docker path (recommended)
  playwright/
    pytest.ini                   # isolated config; screenshots/traces/videos on failure -> artifacts/
    conftest.py                  # base_url, api_client, role sessions, viewport + console fixtures
    viewports.py                 # the 8 desktop/tablet/mobile viewports
    pages/                       # page objects: Base, Landing, BookingCard, Login, portal shells
    fixtures/api_seed.py         # API seeding + sign-in, reusing tests/config.py accounts
    e2e/ visual/ a11y/           # Stage-4+ specs (README placeholders only, no specs yet)
    test_scaffold_smoke.py       # offline self-check (runs with no server) — 5 tests
```

Existing suites are untouched: `backend/tests/`, `frontend/tests/`, `tests/`, `tests/js/`,
`tests/js/browser/` (CDP), `loadtest/` (locust). Nothing removed or overwritten.

## 3. Dependency list (installed this stage)

Added to the Python env (NOT to `backend/requirements.txt`):
- `playwright 1.63.0` + Chromium browser binary (Firefox/WebKit deferred to Stage 4)
- `pytest-playwright 0.10.0`, `pytest-base-url 2.1.0`, (`httpx` already present)

Deferred (listed in `requirements-qa.txt`, NOT installed): `schemathesis` (Stage 6),
`axe-playwright-python` (Stage 8). OWASP ZAP runs as a container/CLI, not a pip dep.

## 4. Database safety verification

`qa/scripts/check_db_safety.py` is a fail-closed gate run before every migrate/boot/drop. Verified:
- `postgresql+psycopg2://jpw_qa:***@localhost:5432/jpw_qa` → **SAFE (exit 0)**.
- `...@mydb.rds.amazonaws.com/...` → **REFUSED (exit 1)** — remote/production marker + non-local host.
- `...@localhost/jackpots_prod` → **REFUSED (exit 1)** — non-disposable DB name.
It also refuses `DEPLOYED=true` or `PAYMENT_PROVIDER!=none`, and redacts passwords in its output.

## 5. Start / stop commands (quick reference)

| Action | Docker | Local PG 18 |
| --- | --- | --- |
| Start | `bash qa/scripts/start_test_env.docker.sh` | `pwsh qa/scripts/start_test_env.ps1` |
| Health | `curl http://127.0.0.1:8099/api/health` | same |
| Stop | `bash qa/scripts/stop_test_env.docker.sh` | `pwsh qa/scripts/stop_test_env.ps1` |
| Cleanup DB | (stop removes container) | `pwsh qa/scripts/stop_test_env.ps1 -DropDb` |
| Run scaffold check | `cd qa/playwright && python -m pytest` | same |
| Run E2E later (Stage 4) | `cd qa/playwright && python -m pytest -m e2e` | same |

## 6. Actual test execution results (this stage)

| Suite | Command | Result |
| --- | --- | --- |
| Backend pytest (SQLite) | `python -m pytest tests` (in `backend/`) | **1103 passed** (no regression) |
| Frontend node | `node --test frontend/tests/*.test.js` | **14 / 14** |
| Logic node | `node --test tests/js/*.test.mjs` | **155 / 155** |
| Playwright scaffold | `cd qa/playwright && python -m pytest` | **5 passed** (offline) |
| CDP browser suite | not run | needs local Chrome (unchanged) |
| `verify_*` E2E (51) | not run | **BLOCKED** — no live server yet |
| Playwright `-m e2e` | none exist yet | Stage 4 |

The Playwright scaffold check proves: Chromium launches, all 8 viewports resize, page objects import,
and the live fixtures **skip** (not fail, not pass) when no server is present.

## 7. Known limitations

1. **Live `jpw_qa` DB not created** — blocked on a DB credential you provide (Docker running, or the
   local postgres superuser password for the one-time role/db creation). Until then the 213 E2E-only
   endpoints and all `-m e2e`/`verify_*` tests remain BLOCKED and are reported as such — never as passed.
2. **Chromium only** installed; Firefox/WebKit are a Stage-4 add (`playwright install firefox webkit`).
3. **No UI/E2E/visual/a11y specs written yet** — deliberately, per Stage-3 scope. Only the offline
   scaffold self-check exists.
4. **`api_seed.register_customer` endpoint/field names are provisional** and will be confirmed against
   the `customer_auth` router in Stage 4 before use; role sign-in delegates to the proven `tests/config.py`.
5. **Deps installed into the machine's Python env** (same one the existing pytest uses), not a separate
   venv — chosen to extend the existing infrastructure rather than fork it. Removable via
   `pip uninstall playwright pytest-playwright pytest-base-url`.
