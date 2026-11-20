# Admin Portal — Deployment Architecture: Final Read-Only Review

**Project:** JackPots World Tours & Travels · **Scope:** database role separation + migration safety across all deploy targets
**Date:** 2026-11-13
**Nature:** READ-ONLY inspection + documentation. **No file modified, no PostgreSQL connection, no migration executed, no role created, no GRANT/REVOKE, no deploy/commit/push.** All existing/untracked changes preserved. **Production readiness is NOT claimed.**

**Files reviewed:** `Dockerfile`, `deploy/docker-entrypoint.sh`, `deploy/migrate.sh`, `deploy/redeploy.sh`, `deploy/docker-compose.yml`, `deploy/staging/docker-compose.staging.yml`, `render.yaml`, `deploy/README.md`, `docs/STAGE_3_STAGING_DEPLOYMENT_RUNBOOK.md` (+ `backend/app/config.py`, `backend/app/database/session.py`, `backend/alembic/env.py` for the engine/URL logic).

---

## 1. Architecture diagram (role separation)

```
                         ┌─────────────────────────────────────────────┐
                         │                ONE PostgreSQL DB             │
                         │   B2B tables (models_v2 Base) + B2C tables   │
                         │   (models_customer Base) — one schema, one   │
                         │   Alembic history (head 0095)                │
                         └───────▲───────────────────────────▲──────────┘
             runtime role │ DATABASE_URL          migration/owner role │ MIGRATION_DATABASE_URL
            (DML only)     │ (least privilege)     (DDL + ownership)     │ (deployed: REQUIRED)
                           │                                            │
        ┌──────────────────┴───────────────┐        ┌───────────────────┴───────────────────┐
        │  SERVE-ONLY app container         │        │  ONE-OFF migration step               │
        │  docker-entrypoint.sh → gunicorn  │        │  deploy/migrate.sh → alembic upgrade  │
        │  session.py: 1 engine/SessionLocal│        │  env.py: own NullPool engine          │
        │  /get_db  (reads DATABASE_URL)    │        │  (reads settings.alembic_url)         │
        │  NEVER runs Alembic by default    │        │  run BEFORE app (re)start; fail→abort │
        └───────────────────────────────────┘        └───────────────────────────────────────┘
```

## 2. Environment-by-environment deployment flow

- **Local dev / CI** (`DEPLOYED` unset/false): single role. Alembic falls back to `DATABASE_URL` (no `MIGRATION_DATABASE_URL` needed). App serve-only unless a developer opts into `RUN_MIGRATIONS_ON_START=true`. *(Confirmed: `config.alembic_url` fallback; entrypoint default serve-only.)*
- **Staging** (`deploy/staging/docker-compose.staging.yml`): app `DEPLOYED=true`, `DATABASE_URL` built from `POSTGRES_*` → staging `postgres`. Migration is a **separate one-off**: `run --rm --no-deps --entrypoint /app/deploy/migrate.sh -e MIGRATION_DATABASE_URL=… app`. `MIGRATION_DATABASE_URL` is **not** in the app service env. *(Confirmed: compose sets `DEPLOYED: "true"`, no `RUN_MIGRATIONS_ON_START`; staging env example passes the migration URL to the one-off only.)*
- **Production (self-hosted)** (`deploy/docker-compose.yml` + `deploy/redeploy.sh`): `redeploy.sh` (`set -euo pipefail`) builds the image, then **step 3b** runs `deploy/migrate.sh` as a one-off with `|| fail` **before** step 4 `up -d`. App `DEPLOYED=true`, serve-only (no `RUN_MIGRATIONS_ON_START`). *(Confirmed: migrate-before-up with abort-on-failure.)*
- **Render** (`render.yaml`): single Docker web service, `DEPLOYED=true`, `RUN_MIGRATIONS_ON_START=false` (serve-only). Migration must be a **separate one-off** with `MIGRATION_DATABASE_URL` set (documented in the file's comment). *(Caveat — see Risk R3: Render's free tier has no native release phase, so the one-off is manual/dashboard-driven.)*

## 3. Migration-flow verification

| # | Requirement | Verdict | Evidence (read-only) |
|---|---|---|---|
| 2.1 | Normal startup never runs Alembic | **Confirmed** | `docker-entrypoint.sh` default branch is serve-only (`RUN_MIGRATIONS_ON_START:-false`); `render.yaml`=false; prod & staging compose do **not** set it true |
| 2.2 | Staging/prod migration requires `MIGRATION_DATABASE_URL` | **Confirmed** | `config.alembic_url` raises when `deployed` and URL unset; `migrate.sh` + entrypoint opt-in shell guards (`exit 1`) |
| 2.3 | Migration failure stops deployment before app restart | **Confirmed** | `redeploy.sh` step 3b (`|| fail`) precedes `up` under `set -euo pipefail` |
| 2.4 | Runtime always uses `DATABASE_URL` | **Confirmed** | `session.py` binds `settings.database_url`; role-sep test asserts the module never reads the migration URL |
| 2.5 | Migration creds cannot leak into runtime processes | **Confirmed (code)** / **Risk at runtime** | Code never reads it; **but** on prod it would be present in the app process env if placed in the shared `../backend/.env` — see **R2** |
| 2.6 | Render has a documented, workable separate migration process | **Partially** | Documented one-off with `MIGRATION_DATABASE_URL`; workable but **manual** (no release phase) — see **R3** |
| 2.7 | Docker image includes the migration script + deps | **Confirmed** | `Dockerfile` `COPY deploy/migrate.sh` (+ `chmod +x`); `alembic>=1.13` in `requirements.txt` |
| 2.8 | Env var names consistent & documented | **Confirmed (with one stale comment)** | `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DEPLOYED`, `RUN_MIGRATIONS_ON_START` used consistently; docs updated — **but** see **R1** (stale healthcheck comment) |

## 4. Database architecture verification

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 3.1 | One PostgreSQL database | **Confirmed** | single `database_url`; no second DB URL |
| 3.2 | One runtime application engine | **Confirmed** | one `create_engine(settings.database_url)` in `session.py` |
| 3.3 | One runtime session factory | **Confirmed** | one `SessionLocal` |
| 3.4 | One `get_db` | **Confirmed** | `session.py` |
| 3.5 | One Alembic history | **Confirmed** | single chain, head `0095 → 0094 → 0093` |
| 3.6 | Separate migration & runtime credentials | **Confirmed (supported)** | `MIGRATION_DATABASE_URL` (Alembic) vs `DATABASE_URL` (runtime); actual two-role DB setup is a **[DBA / unverified on target]** step |
| 3.7 | Separate B2B / B2C model Bases | **Confirmed** | `models_v2.Base` vs `models_customer.Base` (logical separation on one DB) |
| 3.8 | Gaming Tour Packages disabled | **Confirmed** | `gaming_tour_packages_enabled` fail-closed (defaults disabled); `test_gaming_fail_closed.py` present |

## 5. Security & operational risks

- **R1 — Stale comment (documentation).** `deploy/docker-compose.yml` (~line 63) healthcheck comment still says *"The entrypoint runs migrations before serving."* No longer true (serve-only). Harmless at runtime (the 90s `start_period` is still fine), but misleading. **Recommend** updating the comment. *(Not changed — read-only.)*
- **R2 — Migration-credential exposure on production (security).** `deploy/redeploy.sh` step 3b runs `migrate.sh` **without** `-e MIGRATION_DATABASE_URL`, relying on the shared `../backend/.env`. Because the serve-only **app** service also uses `env_file: ../backend/.env`, placing `MIGRATION_DATABASE_URL` there makes it **present in the runtime app process environment** (unused by code, but exposed). Staging avoids this by passing the URL only to the one-off via `-e`. **Recommend** prod do the same: keep `MIGRATION_DATABASE_URL` **out** of `backend/.env` and pass it to the migrate one-off explicitly (e.g. `redeploy.sh` forwards it from a deploy-time secret). **[Recommendation — not changed]**
- **R3 — Render has no native release phase (operational).** `render.yaml` is now serve-only, so on Render the migration is a **manual** one-off (dashboard job / `render exec`) with `MIGRATION_DATABASE_URL`. Workable but easy to forget; a deploy without the one-off leaves the schema behind (the app simply 503s audited actions via the M0 gate — fail-safe, not data-damaging). **Recommend** documenting the exact Render one-off command, or moving Render to a plan with a pre-deploy command.
- **R4 — Missing env vars (fail-safe).** On a deployed host without `MIGRATION_DATABASE_URL`, migration **fails closed** (intended). Without SMTP, M2.2/M1-reset return 502/503 (no false success). Without `DEPLOYED=true`, the fail-closed guard would not engage — so **`DEPLOYED=true` must be set on every deployed host** (it is, in render.yaml + both compose files).
- **R5 — Startup ordering.** Staging compose gates the app on `postgres`/`redis` health; prod `redeploy.sh` sequences build → migrate → up. No ordering defect found. Compose `run` (one-off migrate) vs `up` ordering is enforced by `redeploy.sh`, not by compose itself — correct, but it means **a manual `docker compose up` that skips `redeploy.sh` would not migrate** (serve-only) — acceptable (fail-safe), documented.
- **R6 — Migration failure recovery.** `redeploy.sh` aborts before restart; the previous version keeps serving. Alembic+Postgres run the migration transactionally, so a mid-`upgrade` failure rolls back atomically. Destructive downgrade is owner-gated. No recovery defect found.

## 6. Confirmed working behaviour vs unverified assumptions

**Confirmed (static/read-only + local tests):** serve-only startup; fail-closed migration in deployed envs (config + shell + 6 passing tests); migrate-before-restart abort; single DB/engine/session/get_db/Alembic history; separate Bases; gaming disabled; image ships `migrate.sh` + alembic. Backend suite **1839 passed, 0 failed, 4 skipped**; migration-separation **12 passed** (as reported; re-confirmed locally this session).

**Unverified (require a real target / DBA — not done here):** that a true two-role DB (separate migration vs runtime grants) exists and that the runtime role genuinely lacks DDL; that `MIGRATION_DATABASE_URL` is set per deployed host; that `0095` applies cleanly on PostgreSQL and the append-only trigger/partial-index behave; SMTP delivery; the authenticated UI. All are `[TO VERIFY on staging]` per the staging assessment.

## 7. Critical blockers

1. **`MIGRATION_DATABASE_URL` must be provisioned** per deployed host (else migration fails closed — intended, but blocks schema advance until set). **[REQUIRES AUTHORIZATION / DBA]**
2. **Two-role DB + grants** not yet created/verified on any target. **[DBA]**
3. **Migration `0095` unapplied.** **[REQUIRES AUTHORIZATION / DBA]**
4. **R2 (prod credential exposure)** should be resolved before production use. **[Recommendation]**

## 8. DBA responsibilities

- Create the migration/owner and runtime roles; grant the runtime role **DML only** (no DDL); own table/trigger/function as the migration role; grant the app role `INSERT, SELECT` on `customer_admin_audit_logs`, revoke `UPDATE/DELETE/TRUNCATE`.
- Supply `MIGRATION_DATABASE_URL` to the **migration step only**; keep the runtime `DATABASE_URL` least-privilege.
- Backup + restore rehearsal; confirm `alembic current`=`0094`; run `alembic upgrade head` via the one-off; run the §6 verification SQL from the deployment checklist; confirm append-only. All **[APPROVAL REQUIRED]** per the blocker-resolution plan.

## 9. Recommended next steps

1. **Resolve R2:** pass `MIGRATION_DATABASE_URL` to the prod migrate one-off via `-e` from a deploy-time secret; keep it out of `backend/.env` (mirror staging). *(Code/doc change — separate approval.)*
2. **Fix R1** stale comment and **document the exact Render one-off migrate command** (R3). *(Doc change — separate approval.)*
3. Proceed with the staging deployment per `STAGE_3_STAGING_DEPLOYMENT_RUNBOOK.md` and the blocker-resolution plan once the DBA/owner approvals and `MIGRATION_DATABASE_URL` are in place.
4. Verify on staging (the §6 "unverified" list), then mirror to production with its own roles.

---

**Confirmations:** read-only only; no file modified, no PostgreSQL connection, no migration executed, no role created, no GRANT/REVOKE, no deploy/commit/push; all existing/untracked changes preserved; Gaming Tour Packages remain disabled; production readiness not claimed.

**Document created:** `docs/ADMIN_PORTAL_DEPLOYMENT_ARCHITECTURE_FINAL_REVIEW.md`.
