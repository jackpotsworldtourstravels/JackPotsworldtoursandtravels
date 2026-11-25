# Release-Candidate Deployment Checklist — `jackpotsworld-prod-readiness-07ba10`

**Date:** 2026-11-25 · **Scope:** deploy prerequisites for this RC (B2C sprint fixes + the surgical #10
logout/chat-teardown consolidation). **References** the authoritative docs; does **not** supersede them:
`docs/RUNBOOK.md` (§2 migration rollback), `docs/ADMIN_PORTAL_DEPLOYMENT_ARCHITECTURE_FINAL_REVIEW.md`
(runtime/migration role split), `deploy/redeploy.sh`, `docs/qa/PRODUCTION_DEPLOYMENT_CHECKLIST.md`.

> **Secrets:** this checklist names settings only. Never print or commit any value. The readiness
> checker and adapters already print set/unset/too-short, never the value.

## 0. Gate status — overall **NO-GO** (deploy only when all are GO)

| Gate | State |
|------|-------|
| Code consolidated (sprint + #10 merge) | **DONE** — uncommitted |
| #10 logout/chat clearing | **RESOLVED & live-verified 2026-11-25** |
| Backend / JS / migration / browser verification | **PASS** (see §7 + release report) |
| Commit → PR → green CI | **PENDING** — local commits not authorized in this session |
| HDFC live payment UAT | **BLOCKED** — not claimed verified |
| Live-agent attachment delivery (#13) | **BLOCKED-AGENT** — not claimed verified |

## 1. Environment variables (names only)

- **Hard-required (app will not boot):** `DATABASE_URL`, `JWT_SECRET_KEY`.
- **Required on a deployed host (`DEPLOYED=true`):**
  - `MIGRATION_DATABASE_URL` — migration/owner role. **Fail-closed:** `migrate.sh` and the entrypoint
    abort if it is unset on a deployed host. `DATABASE_URL` must point at the **least-privilege runtime role**.
  - `SMTP_HOST` / `SMTP_FROM_EMAIL` (+ auth) — `DEPLOYED` forces emailed OTP; no SMTP = customers can't receive codes.
  - `CORS_ORIGINS`, `FRONTEND_BASE_URL` — the public origin(s).
  - `DATABASE_REQUIRE_SSL=true` for RDS (`verify-full`).
  - `HDFC_SG_BASE_URL/MERCHANT_ID/API_KEY/WEBHOOK_USERNAME/WEBHOOK_PASSWORD` + `PAYMENT_PROVIDER`/`PAYMENT_ENVIRONMENT`
    — only when enabling live payments (default `PAYMENT_PROVIDER=none` → demo, no money moves).
- **Leave off / default on prod:** `RUN_MIGRATIONS_ON_START` (**keep false** — migrations are a separate step);
  `SMS_*`, `PAYMENT_SWEEP_ENABLED`, `WEB_CONCURRENCY`, `PORT`, `UPLOAD_ROOT` as needed.
- **Verify:** `python scripts/check_hdfc_production.py` on the target host → must report **0 blocking** before enabling payments.

## 2. Database backup (before any migration)

- Take an **RDS snapshot** (or `pg_dump`) immediately before deploy — `RUNBOOK` §2.2.
- Confirm the snapshot completes and is restorable. This is the primary rollback for data.

## 3. Migrations — head `0101`

- Single head **`0101_customer_notif_prefs`** (Issue #21, per-customer notification prefs).
  **Verified up→down→up on disposable PG18 (2026-11-25):** `0099→0100→0101` up, `0101→0100` down, `0100→0101` re-up — clean.
- Run as a **separate one-off step with the migration role, BEFORE the app comes up** (`deploy/migrate.sh`;
  `redeploy.sh` step 3b runs it `|| fail`). Do **not** set `RUN_MIGRATIONS_ON_START=true` on prod.
- **Downgrade rule (`RUNBOOK` §2):** a downgrade MUST run from the image that still has the revisions, and
  **first** — downgrade the DB with the image being removed, then ship the older image. **Never** `alembic downgrade base`.

## 4. Startup health checks

- **Liveness:** `GET /api/health` → `{"status":"ok"}` — point the load-balancer health check here.
- **Status:** `GET /api/status` → schema + ported/pending modules.
- App runs **non-root (uid 10001)** via `deploy/docker-entrypoint.sh`; uploads dir ownership fixed on boot;
  `gunicorn` + `uvicorn.workers.UvicornWorker` on `PORT` (default 8000), `--timeout 120`.

## 5. Deploy sequence (self-hosted — `deploy/redeploy.sh`)

1. Build image (pinned base `python:3.12-slim`, `fastapi==0.122.0`).
2. **Back up DB** (snapshot).
3. **Run `deploy/migrate.sh`** one-off (migration role) → must succeed, else abort.
4. `docker compose up -d` (app serve-only).
5. `GET /api/health` green → smoke test: customer sign-in, a search, **log out via the profile dropdown**, re-sign-in.

## 6. Rollback

- **App:** redeploy the previous image tag.
- **DB:** restore the pre-deploy snapshot, **or** (if reverting a migration) downgrade **first** with the image
  being removed, then ship the older image — `RUNBOOK` §2. `0101` is **additive** (a new prefs table) and
  **reversible** (down→up verified), so a plain image rollback that simply leaves the `0101` table unused is safe.

## 7. Post-deploy verification — B2C #10 (the change in this RC)

1. Sign in as a test customer; add a wishlist item (count badge increments); open Support chat.
2. **Log out via the profile dropdown** → wishlist badge/hearts clear, chat closes, tokens gone.
3. Sign in as a second customer → no cross-account wishlist or chat leak; account switch repaints to the new user.

(Combined-target evidence for all three is in `qa/ISSUE_10_LOGOUT_WISHLIST_STATE.md`.)

## 8. Blockers carried forward (must clear before production)

- **Commit → PR → green CI** — this RC is **uncommitted**.
- **HDFC live UAT** — BLOCKED (real credentials + public HTTPS callback host). **Not verified.**
- **Live-agent attachment delivery (#13)** — BLOCKED (connected human agent). **Not verified.**
