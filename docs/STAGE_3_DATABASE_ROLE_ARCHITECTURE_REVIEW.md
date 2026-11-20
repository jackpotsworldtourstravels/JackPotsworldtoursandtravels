# Stage 3 — Database Role Architecture Review (read‑only)

**Purpose.** Assess how database accounts are used for migrations vs. runtime, and whether/how to introduce a dedicated migration account and a least‑privilege runtime account for the Stage 3 audit table (`customer_admin_audit_logs`, migration 0095).

**Status.** Read‑only inspection and documentation. No PostgreSQL connection, no SQL executed, no source/Docker/config/migration edits, no deploy/commit/push. No secrets shown. No role names invented (unknowns are placeholders). Gaming Tour Packages left disabled. Not a production‑readiness claim; Stage 4 not started.

**Files inspected:** `deploy/staging/docker-compose.staging.yml`, `deploy/staging/stack.env.example`, `deploy/staging/backend.staging.env.example`, `deploy/docker-entrypoint.sh`, `Dockerfile`, `backend/app/config.py`, `backend/alembic/env.py`, `backend/app/database/session.py`, `backend/alembic/versions/0095_customer_admin_audit_logs.py`, `docs/STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md`.

> **Legend:** **[VERIFIED]** = observed directly in the repo. **[PROPOSED]** = recommendation, not in the repo.

---

## A. Verified existing behaviour

- **One connection string, one role, for everything.** **[VERIFIED]**
  - `backend/app/database/session.py`: `engine = create_engine(settings.database_url, pool_pre_ping=True)` — the runtime engine.
  - `backend/alembic/env.py`: `DATABASE_URL = settings.database_url`; `run_migrations_online()` builds its own `create_engine(DATABASE_URL, poolclass=NullPool)`.
  - `backend/app/config.py`: `database_url: str` (env `DATABASE_URL`), loaded once from the environment / `backend/.env`.
  - ⇒ Alembic and the FastAPI app read the **same** `DATABASE_URL`, i.e. **the same database account**.
- **Migrations run on every app‑container start, as that same account.** **[VERIFIED]** `deploy/docker-entrypoint.sh` runs `cd /app/backend && alembic upgrade head` and then `exec gunicorn app.main:app …`. The entrypoint is the container `CMD` (`Dockerfile`). There is no separate release phase.
- **Staging binds that role to the DB owner/superuser.** **[VERIFIED]** `deploy/staging/docker-compose.staging.yml` sets `DATABASE_URL=postgresql+psycopg2://${POSTGRES_USER}:…@postgres:5432/${POSTGRES_DB}`; `stack.env.example` shows `POSTGRES_USER=jpw_staging` (example placeholder). The `postgres:16` container creates `POSTGRES_USER` as the **owner and superuser** of `POSTGRES_DB`.
- **Production role is not in the repo.** **[VERIFIED]** `DATABASE_URL` lives in `backend/.env` (`deploy/README.md`, `redeploy.sh`); the real production role name is **not determinable from the repository** — placeholder only. `docs/AWS_DEPLOYMENT.md` shows a sample user `jpwadmin` (an admin/owner, not a restricted runtime role).
- **No least‑privilege role, no GRANT/REVOKE anywhere.** **[VERIFIED]** No `CREATE ROLE`/`GRANT`/`REVOKE` exists in `deploy/`, `database/`, or `backend/alembic/`. The 0095 privilege model (INSERT+SELECT only) is a documented out‑of‑band DBA step (`docs/STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md`), not code.
- **0095 objects.** **[VERIFIED]** Creates the enum `customer_admin_audit_outcome_enum`, table `customer_admin_audit_logs` (BIGINT autoincrement PK ⇒ a backing sequence), six+ indexes, a partial‑unique index, and an append‑only **trigger** (`trg_block_customer_admin_audit_mutation` / `fn_block_customer_admin_audit_mutation`) that fires `BEFORE UPDATE OR DELETE` for **every** role — owner and superuser included.

---

## B. The ten questions

**1. Which database account currently runs Alembic?** **[VERIFIED]** The single account in `DATABASE_URL` (via `settings.database_url` in `alembic/env.py`). In staging that is `POSTGRES_USER` (example `jpw_staging`, the owner/superuser); in production it is whatever `backend/.env` holds (not in repo).

**2. Which account handles normal FastAPI requests?** **[VERIFIED]** The **same** account — `session.py` builds its engine from the same `settings.database_url`.

**3. Are both accounts currently identical?** **[VERIFIED] Yes — identical.** One env var feeds both code paths. There is no separation today.

**4. What happens if the runtime account loses DDL privileges?** 
- **Request handling:** unaffected — the application performs **no DDL at request time** (only DML; schema changes only happen via Alembic). **[VERIFIED]** (no runtime DDL in the request path).
- **Startup:** **it breaks**, because the *same* account runs `alembic upgrade head` in the entrypoint on every boot. A pending migration (e.g. 0095 creating a table/trigger/type) needs `CREATE`/ownership; without DDL the migration fails, the entrypoint `set -e` aborts, and the container never reaches gunicorn. **[VERIFIED]** this coupling exists.
- ⇒ The only reason the runtime account "needs" DDL today is the entrypoint coupling, not the application itself.

**5. Can we separate migration and runtime credentials without breaking startup?** **Yes [PROPOSED]**, but it requires decoupling *migrate* from *serve*: migrations run as a DDL/owner role; the app serves as a DML‑only role. Because `env.py` and `session.py` both read the single `settings.database_url`, a clean split needs a small config/code change (a distinct migration URL) **and** an entrypoint/deployment change so the migrate step uses the migration role while gunicorn uses the runtime role. Done that way, startup is *more* robust (the long‑lived app process never holds DDL), not broken.

**6. Safest way to run Alembic as a separate deployment step?** **[PROPOSED]** A dedicated, approved **release/migration phase** before the app starts, run with the migration (DDL/owner) credentials, e.g. on the staging stack:
```bash
# migrate as the DDL role, entrypoint overridden so only alembic runs:  [APPROVAL REQUIRED]
docker compose -f deploy/staging/docker-compose.staging.yml --env-file stack.env \
  run --rm --no-deps --entrypoint "" app \
  sh -lc 'cd /app/backend && DATABASE_URL="$MIGRATION_DATABASE_URL" alembic upgrade head'
# then start the app, which serves with the least-privilege runtime DATABASE_URL:
docker compose -f deploy/staging/docker-compose.staging.yml --env-file stack.env up -d   # [APPROVAL REQUIRED]
```
(Equivalently: a CI/CD release job, or a one‑shot `migrate` compose service that exits before `app` starts. All require the entrypoint to stop auto‑migrating as the runtime role — see §B10.) Read‑only revision inspection stays available via `alembic current` with the entrypoint overridden.

**7. Which tables/sequences need runtime INSERT/SELECT/UPDATE/DELETE?** Stated by principle (the authoritative list is the models/migrations; **not enumerated or invented here**):
- **General application tables:** the runtime role needs **SELECT, INSERT, UPDATE, DELETE** on the application tables it reads/writes (B2B `models_v2`/legacy `app.models` and B2C `models_customer` tables), **plus `USAGE, SELECT` on their backing sequences** wherever PKs are serial/`BIGSERIAL` (0095's PK is BIGINT autoincrement ⇒ a sequence; most tables follow this pattern). **[VERIFIED: pattern]**
- **`customer_admin_audit_logs` (exception):** **INSERT + SELECT only** — **no UPDATE/DELETE/TRUNCATE** (append‑only; `docs/STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md`). It is append‑only, so the runtime role does **not** need its sequence to be writable beyond what INSERT requires (`USAGE` on the id sequence if the server expects the client to advance it; with IDENTITY/autoincrement this is server‑side). **[VERIFIED: intent]**
- **No table needs DDL at runtime.** **[VERIFIED]**
- A reviewed grant script should therefore grant DML broadly (ideally via `GRANT … ON ALL TABLES IN SCHEMA public` + matching `ALTER DEFAULT PRIVILEGES` so future migrations' tables are covered), then apply the audit‑table exception. Enumerating each of the ~70 tables by hand risks omissions — prefer schema‑wide grants + the one explicit exception. **[PROPOSED]**

**8. Audit‑table ownership & permissions.** **[PROPOSED, per the SQL review]** Owned by the **migration/DDL role** (whoever runs `alembic upgrade`); the **runtime role** receives **INSERT, SELECT** and is **not** the owner; `UPDATE/DELETE/TRUNCATE` revoked from it and from `PUBLIC`. The append‑only trigger enforces immutability even against the owner/superuser. The INSERT/SELECT‑only model only *restricts* anything when the runtime role is a **non‑owner, non‑superuser** login distinct from the migration role — otherwise the REVOKEs are inert and the trigger is the sole control. **[VERIFIED caveat]**

**9. Staging vs production credential separation.** **[PROPOSED]** Each environment gets its **own** migration role and its **own** runtime role, with distinct passwords, never shared across environments:
- Staging already isolates its database (its own `postgres` container; `DATABASE_URL` built from `stack.env`; `JWT_SECRET_KEY` must differ from production). **[VERIFIED]**
- Production credentials live only in `backend/.env` / SSM, never in git. **[VERIFIED]**
- Add, per environment: `MIGRATION_DATABASE_URL` (DDL/owner) used only by the release step, and `DATABASE_URL` (DML‑only runtime). Do not reuse the staging role in production or vice‑versa.

**10. Changes eventually required (code / Docker / env / deployment).** **[PROPOSED] — none performed here.**
- **Database (DBA):** create two roles per environment — a **migration/owner** role (CREATE/ownership of the schema objects) and a **runtime** role (`LOGIN`, `NOSUPERUSER`, `NOINHERIT`, DML‑only + sequence `USAGE,SELECT`, audit‑table INSERT/SELECT only). Set object ownership to the migration role; apply the §B7/§B8 grants + `ALTER DEFAULT PRIVILEGES`.
- **Config/code:** add a separate setting (e.g. `alembic_database_url` / env `MIGRATION_DATABASE_URL`) and have `alembic/env.py` prefer it, while `session.py` keeps using the runtime `DATABASE_URL`. (Both currently read `settings.database_url`.)
- **Docker/entrypoint:** stop auto‑migrating as the runtime role — remove `alembic upgrade head` from `deploy/docker-entrypoint.sh` (serve‑only), and run migrations as the separate approved step/service/CI job using the migration URL. A single‑service host (Render/Fly) that has no release phase needs an alternative (a migrate‑then‑exit init container/service, or a documented manual pre‑deploy migrate).
- **Deployment:** introduce the release/migration phase (§B6) ahead of app start; update `redeploy.sh`/runbook accordingly; keep migrations `[APPROVAL REQUIRED]`.

---

## C. Alternatives

### Alternative A — Dedicated migration account + restricted runtime account **[PROPOSED]**
- **Shape:** migration/owner role runs Alembic in a separate release step; runtime role is DML‑only (audit table INSERT/SELECT‑only), non‑owner, non‑superuser.
- **Pros:** the audit‑table REVOKEs actually bite; the long‑lived app process cannot alter schema or rewrite/delete audit rows even if the app were compromised; least privilege across all tables; clean separation of "change schema" from "serve traffic"; matches spec D3 intent.
- **Cons/effort:** requires the code/entrypoint/deployment changes in §B10; two credentials per environment to manage; a mis‑scoped runtime grant surfaces as a runtime permission error (mitigated by schema‑wide `GRANT` + `ALTER DEFAULT PRIVILEGES`); single‑service hosts need a migrate step added.
- **Startup compatibility:** improved — migrate step gates app start; app never needs DDL.

### Alternative B — Keep the single database account (status quo) **[VERIFIED current state]**
- **Shape:** one owner/superuser role for both Alembic and runtime (today's behaviour).
- **Pros:** zero change; `alembic upgrade head` on boot "just works"; no code/entrypoint/deploy edits.
- **Cons/risks:**
  - The runtime login is **owner/superuser**, so the 0095 `GRANT/REVOKE` model is **inert** — only the append‑only trigger constrains the audit table; a superuser login also **bypasses object ACLs** everywhere else.
  - A compromised app process (SQLi, RCE, leaked `DATABASE_URL`) inherits **full DDL + superuser**: drop tables, disable triggers, read/alter anything, exfiltrate at will.
  - No least privilege anywhere; blast radius = the whole database.
  - Migrations auto‑run as that account on every boot (any accidental `up`/restart migrates).
- **Startup compatibility:** unchanged (works), at the cost of the above exposure.

---

## D. Recommendation

**Adopt Alternative A (dedicated migration account + restricted runtime account), phased.** It is the only option under which the Stage 3 audit privilege model (INSERT/SELECT‑only, UPDATE/DELETE/TRUNCATE revoked) is actually enforced, and it bounds the blast radius of an application compromise. Alternative B should be treated as the *known‑risky interim* state, not the target.

**Suggested phasing [PROPOSED]:**
1. **Now (no code change):** on staging, create a non‑owner runtime role and a separate owner/migration role; run the migrate step manually with the migration role (§B6), start the app pointed at the runtime role; apply the audit grants from the SQL‑review doc. This validates the model before touching code.
2. **Next (small code change):** add `MIGRATION_DATABASE_URL` support in `alembic/env.py`/config so the split is first‑class.
3. **Then (deploy change):** make the entrypoint serve‑only and move migration to an approved release step; mirror to production with its own two roles.

**Migration compatibility.** All migrations (0095 included) are indifferent to *which* role runs them provided that role has `CREATE`/ownership; the enum, indexes, partial‑unique index and append‑only trigger are created by the migration role exactly as today. The runtime role's INSERT/SELECT works once the grants are applied. No migration file changes are needed. **[VERIFIED: migrations are role‑agnostic given DDL rights]**

**Operational risks.** (a) A runtime role missing a grant on some table → runtime permission error — mitigate with schema‑wide `GRANT` + `ALTER DEFAULT PRIVILEGES` so future migrations' objects are covered. (b) Single‑service hosts lose the "migrate on boot" convenience — mitigate with a migrate‑then‑exit service/init step. (c) Credential sprawl (two roles × environments) — mitigate with a secrets manager/SSM. (d) Sequence privileges forgotten → INSERT fails — grant `USAGE,SELECT` on sequences.

**Rollback considerations.** The separation is **privilege/config‑level and fully reversible without data impact**: point `DATABASE_URL` back at the single role and restore the original entrypoint from git to revert to Alternative B; drop the added roles only after their grants are no longer referenced. This is distinct from schema rollback — reverting role architecture never runs `alembic downgrade` and never touches `customer_admin_audit_logs` data (its `downgrade()` is separately `[APPROVAL REQUIRED]` and destroys audit history).

---

*Prepared read‑only. Verified behaviour is labelled [VERIFIED]; everything under "proposed/alternatives/recommendation" is [PROPOSED] and not implemented. No DB connection, no SQL, no code/Docker/config/migration edits, no deploy/commit/push. Role names that are not in the repository are placeholders, not invented values. Gaming Tour Packages disabled; Stage 4 not started.*
