# Production Readiness Checklist — PR #54 (`feat/b2c-admin-dashboard`)

> Scope: B2C Admin Portal (dashboard, audit trail migration `0095`), mobile app, docs,
> and the migration-credential isolation restored on top of the ECR pipeline.
> **This is a pre-deployment checklist for an operator. It does NOT execute anything.**
> Prepared 2026-11-20. Deploy only after CI is green and a reviewer has approved PR #54.

Legend: **[verified here]** confirmed in this session · **[operator]** must be done/checked on the host · **[do-not]** explicitly out of bounds for the agent.

---

## 1. Required environment variables & secrets

Three separate env files on the EC2 host (all gitignored — never commit):

| File | Purpose | Key contents |
|---|---|---|
| `backend/.env` | **Serve-only app** container `env_file` | `DATABASE_URL` (least-privilege runtime role), `JWT_SECRET_KEY`, `S3_*` / storage, HDFC/payment keys, SMTP. **Must NOT contain `MIGRATION_DATABASE_URL`.** |
| `backend/.env.migration` | **Migration step only** (`chmod 600`) | `MIGRATION_DATABASE_URL` (owner/DDL role). Template: `backend/.env.migration.example`. |
| `deploy/.env` | Compose/Caddy + image ref | `SITE_DOMAIN`, `APP_IMAGE` (set by `redeploy.sh`). |

- **[operator]** Confirm `backend/.env.migration` exists, is `chmod 600`, and holds the migration/owner URL. `redeploy.sh` **fails closed** without it.
- **[verified here]** The production compose (`deploy/docker-compose.yml`) hard-sets `DEPLOYED=true`, `DEBUG=false`, `OTP_DEV_ECHO=false`, `REDIS_URL`, `FORWARDED_ALLOW_IPS=*`, `APP_COMMIT`. These override a laptop `.env` copied up.
- **[operator]** `GAMING_TOUR_PACKAGES_ENABLED` must remain **unset / falsey** in production (keeps Gaming disabled — 404). **[do-not]** Never enable it.
- **[operator]** Verify `REDIS_URL` resolves to the compose `redis` service (chat fan-out across 2 gunicorn workers depends on it).

## 2. Runtime database permissions (app container)
- **[operator]** `DATABASE_URL` connects as the **least-privilege runtime role**: SELECT/INSERT/UPDATE/DELETE on application tables, **no DDL**. The serve-only app never migrates, so it does not need `CREATE`/`ALTER`.
- **[operator]** Confirm the runtime role **cannot** `ALTER TYPE`/`CREATE TABLE` (defence in depth — a compromised app process cannot change schema).

## 3. Migration database permissions (migration step only)
- **[operator]** `MIGRATION_DATABASE_URL` connects as the **owner/migration role** with DDL rights (needed for `alembic upgrade head`, incl. `ALTER TYPE ... ADD VALUE`).
- **[verified here]** The migration credential is supplied **only** to the one-off migration container via a bare `-e MIGRATION_DATABASE_URL` passthrough (value never on the command line / `ps` / logs), sourced from `backend/.env.migration`.
- **[verified here]** `migrate.sh` and `docker-entrypoint.sh` both **fail closed** on a deployed host (`DEPLOYED=true`) if `MIGRATION_DATABASE_URL` is missing — they never fall back to the runtime `DATABASE_URL`.

## 4. Migration execution order
- **[verified here]** `redeploy.sh` runs migrations in **step 3b** — a one-off container from the just-pulled ECR image — **before** step 4 starts/upgrades the app. Target revision: single Alembic head **`0095_customer_admin_audit_logs`**.
- **[operator]** Because the schema is upgraded while the previous app version is still serving, confirm migration `0095` (B2C audit logs) is **backward-compatible** with the currently-running code for the brief overlap window (it is additive — a new audit table).
- **[verified here]** If the migration fails, the deploy **aborts** (`|| fail`) and the app is **not** (re)started — the previous container keeps serving.

## 5. Backup & recovery
- **[operator]** Take an **RDS manual snapshot immediately before** running `redeploy.sh` for any release that includes a migration (this one does: `0095`). Automated backups alone may not capture the exact pre-migration point.
- **[operator]** Confirm RDS automated backups / retention are enabled.
- **[operator]** Record the current `APP_IMAGE` (the ECR SHA tag) as the rollback image before deploying (see §10).

## 6. Deployment sequence (what `redeploy.sh` does)
1. **1/6** Verify checkout, Dockerfile, compose, docker/compose/aws CLIs, `backend/.env`, `deploy/.env`.
2. **2/6** `git pull --ff-only`.
3. **3/6** ECR login (instance role) → `docker compose pull app` (immutable commit-SHA tag) → image/host architecture match check.
4. **3b/6** **Migrate** (one-off container, migration role, fail-closed, abort-on-failure).
5. **4/6** `docker compose up -d --remove-orphans` (serve-only app).
6. **5/6** Wait for `/api/health` healthy (`HEALTH_TIMEOUT=180s`, override available).
7. Persist `APP_IMAGE` to `deploy/.env` (only after health passes).
8. **6/6** Status + smoke-test reminders.
- **[operator]** Run exactly: `cd ~/JackPotsworldtoursandtravels && bash deploy/redeploy.sh`. Nothing else deploys this app.

## 7. Health checks
- **[verified here]** Compose healthcheck polls `http://127.0.0.1:8000/api/health` (interval 30s, timeout 10s, retries 3, start_period 90s); `redeploy.sh` waits on that verdict.
- **[operator]** Post-deploy: `curl -fsS https://${SITE_DOMAIN}/api/health` and check `/api/version` reports the just-deployed `APP_COMMIT`.

## 8. Authentication & RBAC smoke tests (post-deploy)
- **[operator]** Admin sign-in at `/admin/` (OTP emailed — `OTP_DEV_ECHO=false` in prod, so **no on-screen code**).
- **[operator]** **Shared catalogue**: a B2B admin (role default `catalog.manage`) can open catalogue; a B2C-scope holder can too; a user with neither is 403.
- **[operator]** **B2C desks** (customers, payments reconciliation, refunds, audit) require explicit `b2c.*` grants or super-admin — a B2B-only admin is refused.
- **[operator]** **Gaming disabled**: `/gaming-packages` shows the enquiry form; `POST /api/customer/gaming-tour-enquiries` and the admin gaming queue return **404**.
- **[operator]** Confirm the production super-admin is **not** on the public default password (see the project's credential note — PRODUCTION rotation was previously unverified).

## 9. Payment & refund safety checks
- **[operator]** Confirm payment provider is configured for the intended mode (HDFC UAT vs live) and that demo-success mode is **off** on the deployed host (`DEPLOYED=true` forces real).
- **[operator]** Exercise a refund-approval path on a test booking and confirm the audit trail records it.
- **⚠ Pre-existing, OUT OF SCOPE of this PR:** the customer payment-status enum (`customer_payment_status_enum` includes `cancelled`/`expired`) vs the ORM enum differs; reading such a row could error. **Not introduced by PR #54** and not fixed here (no unrelated refactoring). Track separately.
- **[operator]** A real end-to-end UAT/production payment was **not** testable in this session (no live provider); validate on the host before calling payments done.

## 10. Rollback procedure
- **App rollback (manual, supported):** re-point `APP_IMAGE` at the previously-recorded ECR SHA and `docker compose -f deploy/docker-compose.yml --project-directory deploy up -d`. `redeploy.sh` records the prior image as `ROLLBACK_IMAGE` and never prunes images.
- **⚠ Schema rollback is NOT automatic.** `redeploy.sh` migrates forward only. If `0095` must be reversed, an operator runs `alembic downgrade` **as the migration role**, owner-approved, ideally restoring the §5 snapshot. Roll the app image back to a version compatible with the resulting schema.

---

## Outstanding before merge (not blockers to prepare, but gate the merge)
- **CI** on PR #54 must be green: `backend-tests`, `ui-e2e`, `postgres-migrations` (frontend-tests already passing).
- **Reviewer approval** — no review decision yet.
- **Branch is behind `origin/main`** by 2 unrelated commits (PR #55, "fix(hdfc): remove UDF2 from order creation"). Decide whether to merge latest `main` into the branch before merging the PR (not done here — a fresh merge could conflict and would need re-verification).

**[do-not] performed in this session:** no production deploy, no production migration, no production DB access, no credential rotation, no force-push, no PR merge.
