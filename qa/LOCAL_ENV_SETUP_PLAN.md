# Local Isolated Testing Environment — Option A (plan only)

**This is the plan to execute in Stage 3 after approval. Nothing here is run yet and no dependency
is installed.** A throwaway PostgreSQL + seeded test accounts, fully isolated from production. It
reuses the app's own config, Alembic seed migrations, and `tests/config.py` account model.

## Safety invariants (enforced by this plan)

- Dedicated throwaway DB `jpw_qa` on a local Postgres — **never** the production RDS/connection string.
- `DEPLOYED=false` → demo/sandbox is permitted locally and refused on real hosts (app already enforces this).
- `PAYMENT_PROVIDER=none` (default) → no gateway calls; sandbox requires explicit opt-in + a customer
  allowlist, so **no real payments/refunds**.
- `OTP_DEV_ECHO=true` and no SMTP → OTPs are returned in the API response, **never sent** by SMS/email;
  no real customer notifications.
- Duffel/Hotelbeds have **no credentials** → dormant (flight/hotel tested on demo/seeded data only).
- `STORAGE_BACKEND=local`, `OCR_PROVIDER=none` → no S3, no external OCR.
- Redis optional: run the server single-worker (`WEB_CONCURRENCY=1`) so the in-process chat registry
  works without Redis, OR point `REDIS_URL` at a local throwaway Redis for the chat/voice E2E scripts.

## Topology

```
Local Postgres (:5432)  ──  DB "jpw_qa"  (created + dropped by QA scripts)
        │  alembic upgrade head  → schema + seed migrations (0002/0003/0027/0083)
        ▼
uvicorn app.main:app  (:8099, a throwaway port — NOT the 8000/8420 dev ports)
        │  DATABASE_URL=postgresql+psycopg2://jpw_qa:...@localhost/jpw_qa
        ▼
tests/run_all.py   (JPW_BASE=http://127.0.0.1:8099)   ← the 51 verify_* E2E scripts
Playwright e2e      (base_url=http://127.0.0.1:8099)   ← Stage 3+
```

Port 8099 is deliberately **not** 8000 or 8420 (the live local dev ports noted in project memory), so
a QA run never collides with a running dev server or app worktree.

## Environment file — `qa/.env.qa.example` (to be added, git-ignored actual)

```bash
DATABASE_URL=postgresql+psycopg2://jpw_qa:jpw_qa_local@localhost:5432/jpw_qa
JWT_SECRET_KEY=qa-local-only-not-a-secret-0123456789abcdef
DEPLOYED=false
DEBUG=true
PAYMENT_PROVIDER=none
PAYMENT_ENVIRONMENT=test
OTP_DEV_ECHO=true
STORAGE_BACKEND=local
OCR_PROVIDER=none
WEB_CONCURRENCY=1
FRONTEND_BASE_URL=http://127.0.0.1:8099
CORS_ORIGINS=http://127.0.0.1:8099,http://localhost:8099
# REDIS_URL=redis://localhost:6379/15   # only if running chat/voice E2E
```

No real credential ever goes in the tracked example; the actual `.env.qa` is git-ignored. Seeded role
accounts come from `tests/config.py` (already tracked, reproducible dev creds — not production secrets).

## Step sequence (what the Stage-3 bootstrap script will do)

1. **Create DB** (idempotent, local only):
   ```bash
   psql -h localhost -U postgres -c "DROP DATABASE IF EXISTS jpw_qa;"
   psql -h localhost -U postgres -c "CREATE DATABASE jpw_qa OWNER jpw_qa;"
   ```
   (Role `jpw_qa` created once with a local-only password.)
2. **Migrate + seed**: `cd backend && alembic upgrade head` — runs all 94 migrations including the seed
   ones (`0002_seed_content`, `0003_seed_admin`, `0027_seed_catalog_inventory`, `0083_package_catalogue`),
   which create the admin/manager/merchant accounts and catalogue/inventory the E2E suite expects.
3. **Boot server**: `uvicorn app.main:app --port 8099 --no-access-log` with the `.env.qa` above. (No
   `--reload`; schema/backend changes require a restart — see project memory on the 8000 no-reload trap.)
4. **Health check**: poll `GET /api/health` and `GET /api/status` until ready.
5. **Run E2E**: `JPW_BASE=http://127.0.0.1:8099 python tests/run_all.py` — expect the 51 verify_* scripts
   to run; record pass/fail/blocked (4 scripts optionally skip without `websockets`/`moto`; one needs
   `httpx2` — those install decisions are deferred to Stage 3, not now).
6. **Run Playwright/axe/Lighthouse** (Stage 3+) against `:8099`.
7. **Cleanup**: stop uvicorn; `DROP DATABASE jpw_qa;` (and flush the throwaway Redis DB 15 if used).
   Each CI run re-creates from scratch → no state leaks between runs.

## Customer test accounts (no seeded customer by default)

The seed migrations create staff/merchant/manager accounts but **not** a B2C customer. The plan:
register a customer through the real flow and read the OTP from the API response (`OTP_DEV_ECHO=true`),
exactly as the E2E/Playwright fixtures will — so there is still **no real OTP delivery**. A reusable
`qa/fixtures` builder (Stage 3) will encapsulate this, reusing `tests/flows.py` patterns.

## Windows / local notes

- Postgres: a local install or a Docker container (`postgres:16-alpine`, matching the CI service image)
  both work; the plan prefers Docker for clean teardown, falling back to a local server if Docker is
  unavailable on this machine.
- The CI `postgres-migrations` job already proves `alembic upgrade head` + `downgrade -1` on Postgres 16,
  so step 2 is known-good.

## What this unblocks

- The **213 E2E-only endpoints** (section B of `MISSING_COVERAGE.md`) become executable.
- Cross-portal consistency workflows (X1–X6) become testable end to end.
- Playwright UI E2E and Schemathesis get a real, seeded, disposable target.

## What this plan does NOT do

- No connection to production DB or any real credential.
- No real payment/refund/OTP/email/notification.
- No Duffel/Hotelbeds activation.
- No install of Playwright/Schemathesis/axe/Lighthouse/ZAP (that is Stage 3, on your approval).
