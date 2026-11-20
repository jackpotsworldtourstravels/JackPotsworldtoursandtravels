# Stage 3 — Database Role Separation Implementation Plan

**Decision being implemented:** Alternative A from `docs/STAGE_3_DATABASE_ROLE_ARCHITECTURE_REVIEW.md` — a dedicated **migration/owner** account and a restricted **runtime** account.

**Status.** Planning + repository inspection only. **No PostgreSQL connection, no SQL executed, no roles created, no source/Docker/env/migration edits, no deploy/commit/push.** No credentials shown. **No role names invented** — unknown names are placeholders. Gaming Tour Packages left disabled. Not a production‑readiness claim; Stage 4 not started.

**Labels.** **[VERIFIED]** observed in the repo · **[PROPOSED]** recommended change, not applied · **[DBA ACTION]** performed by a DBA on the cluster · **[APPROVAL REQUIRED]** needs explicit owner approval before execution. This plan **must preserve all existing B2B and B2C functionality** (see §13).

**Files inspected:** `docs/STAGE_3_DATABASE_ROLE_ARCHITECTURE_REVIEW.md`, `docs/STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md`, `docs/STAGE_3_STAGING_DEPLOYMENT_RUNBOOK.md`, `backend/app/database/session.py`, `backend/alembic/env.py`, `backend/app/config.py`, `deploy/docker-entrypoint.sh`, `Dockerfile`, `deploy/staging/docker-compose.staging.yml`, `backend/alembic/versions/`.

**Placeholders (fill on the cluster; do not guess):**
```
:migration_role   -- owner/DDL login that runs Alembic (CREATE/ownership)
:runtime_role     -- restricted app login (LOGIN, NOSUPERUSER, NOINHERIT; DML only)
:db               -- the target database name (staging ${POSTGRES_DB}; prod from backend/.env)
```

---

## 1. Current database connection architecture **[VERIFIED]**
- One setting feeds everything: `backend/app/config.py` → `database_url: str` (env `DATABASE_URL`).
- Runtime: `backend/app/database/session.py` → `engine = create_engine(settings.database_url, pool_pre_ping=True)`; `SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)`; `get_db()` yields a session per request.
- Migrations: `backend/alembic/env.py` → `DATABASE_URL = settings.database_url`; `run_migrations_online()` opens its own `create_engine(DATABASE_URL, poolclass=NullPool)`.
- Boot coupling: `deploy/docker-entrypoint.sh` runs `alembic upgrade head` then `exec gunicorn app.main:app …` on **every** container start (the `Dockerfile` `CMD`).
- Identity: therefore **Alembic and FastAPI use the same account**. Staging binds it to `POSTGRES_USER` (owner/superuser of `${POSTGRES_DB}`, per `deploy/staging/docker-compose.staging.yml`); production's role is in `backend/.env` (not in the repo → placeholder).

## 2. Database operations the FastAPI application performs **[VERIFIED]**
- **ORM CRUD** across all domains via SQLAlchemy `Session` (`SELECT`/`INSERT`/`UPDATE`/`DELETE`): B2B (`app/models_v2.py`, legacy `app.models`) and B2C (`app/models_customer.py`). `autocommit=False` ⇒ explicit `db.commit()`.
- **Stored‑procedure / function calls via raw SQL** — `app/services/admin_partner_service.py` executes `text("SELECT * FROM sp_admin_list_partner_bookings(:status,:search)")`, `sp_approve_request`, `sp_reject_request`, `sp_resolve_service_request`. ⇒ the runtime role needs **EXECUTE** on those routines (B2B partner‑booking admin depends on them).
- **Audit writes** (B2C Stage 2/3): `customer_admin_audit_service.record_in_session`/`record_independently` do `INSERT` only; the read side does `SELECT`. No `UPDATE`/`DELETE` of audit rows anywhere.
- **No runtime DDL and no `TRUNCATE`** in `app/` (schema changes happen only through Alembic). Verified: the only `truncate`/`create table` hits are docstrings/comments, not executed SQL.
- Sequence usage: PKs are serial/`BIGSERIAL`‑style (`0095` uses `BigInteger … autoincrement=True`), so `INSERT`s advance backing sequences.

## 3. Required DML privileges for application tables **[PROPOSED] / [DBA ACTION]**
Grant the runtime role table DML across the schema, then apply the audit exception (§5). Prefer schema‑wide grants over hand‑listing tables (the authoritative table list is the models + migrations; enumerating ~dozens by hand risks omissions and would preserve B2B/B2C function only by luck):
```sql
GRANT USAGE ON SCHEMA public TO :runtime_role;                                   -- [APPROVAL REQUIRED]
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :runtime_role;  -- [APPROVAL REQUIRED]
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :runtime_role;                -- for sp_* routines (§2) [APPROVAL REQUIRED]
```
(No `REFERENCES`/`TRIGGER`/`CREATE` to the runtime role.)

## 4. Required sequence privileges **[PROPOSED] / [DBA ACTION]**
```sql
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :runtime_role;          -- [APPROVAL REQUIRED]
```
Without this, `INSERT`s on serial‑PK tables fail across both B2B and B2C.

## 5. Audit table restricted permissions **[PROPOSED] / [DBA ACTION]**
Per `docs/STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md` — the runtime role gets **INSERT + SELECT only** on `customer_admin_audit_logs`; strip the rest:
```sql
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.customer_admin_audit_logs FROM :runtime_role;  -- [APPROVAL REQUIRED]
REVOKE ALL ON TABLE public.customer_admin_audit_logs FROM PUBLIC;                               -- [APPROVAL REQUIRED]
-- (INSERT, SELECT remain from the §3 schema-wide grant.)
```
The append‑only trigger (`trg_block_customer_admin_audit_mutation`) enforces immutability even against the owner/superuser; the REVOKEs are the defence‑in‑depth that only *bites* because `:runtime_role` is a non‑owner (§6). Append‑only does **not** block `INSERT`, so audit writes keep working.

## 6. Ownership of migration‑created objects **[PROPOSED] / [DBA ACTION]**
- All objects created by Alembic (tables, the `customer_admin_audit_outcome_enum` type, indexes, the partial‑unique index, the trigger + `fn_block_customer_admin_audit_mutation`) are owned by **`:migration_role`** (the role that runs `alembic upgrade`).
- `:runtime_role` is **never** an owner and is **not** a member of `:migration_role` (so it cannot inherit ownership/DDL). This is what makes §5's REVOKEs effective.

## 7. Separate migration and runtime credentials **[PROPOSED] / [DBA ACTION]**
Two distinct roles **per environment** (names supplied by the owner/DBA — placeholders here):
```sql
-- CREATE ROLE :migration_role LOGIN PASSWORD '<<out-of-band>>' NOSUPERUSER;            -- owns schema objects; may CREATE  [APPROVAL REQUIRED]
-- CREATE ROLE :runtime_role   LOGIN PASSWORD '<<out-of-band>>' NOSUPERUSER NOINHERIT;  -- DML only, no CREATE            [APPROVAL REQUIRED]
-- GRANT CONNECT ON DATABASE :db TO :migration_role, :runtime_role;                                                      -- [APPROVAL REQUIRED]
```
Credentials live only in the environment/secret store (never git). See §9 for staging vs production.

## 8. How Alembic receives migration credentials independently of FastAPI **[PROPOSED code change — not applied]**
- Add a dedicated setting, e.g. `alembic_database_url: str | None` (env **`MIGRATION_DATABASE_URL`**) in `backend/app/config.py`.
- In `backend/alembic/env.py`, use it when present, else fall back to `settings.database_url` (backward compatible — existing single‑role deploys keep working):
  ```python
  # PROPOSED (illustrative; not edited here):
  DATABASE_URL = settings.alembic_database_url or settings.database_url
  ```
- `backend/app/database/session.py` is **unchanged** — the runtime engine keeps using `DATABASE_URL` (`:runtime_role`).
- Net: Alembic connects as `:migration_role` via `MIGRATION_DATABASE_URL`; the app connects as `:runtime_role` via `DATABASE_URL`. **[APPROVAL REQUIRED]** to land the code change.

## 9. Docker entrypoint: stop auto‑running migrations **[PROPOSED Docker change — not applied]**
- `deploy/docker-entrypoint.sh` currently runs `alembic upgrade head` before gunicorn. Proposed: make the container **serve‑only** (remove the migrate line), so the long‑lived app process never needs DDL and never migrates implicitly.
- Single‑service hosts (Render/Fly, which have no release phase) need an alternative so the schema still advances: a one‑shot **migrate‑then‑exit** service/init container using `MIGRATION_DATABASE_URL`, or a documented manual pre‑deploy migrate (§10). **[APPROVAL REQUIRED]** to change the entrypoint.

## 10. Authorized deployment sequence (migrations run separately) **[APPROVAL REQUIRED]**
Order (staging shown; mirror for production with its own roles):
1. **Backup** the target DB (logical dump / RDS snapshot). **[DBA ACTION]**
2. **Verify current revision, read‑only** (no upgrade): `… run --rm --no-deps --entrypoint "" app sh -lc 'cd /app/backend && alembic current'`.
3. **Owner approval** to apply pending migrations (e.g. `0095`). **[APPROVAL REQUIRED]**
4. **Migrate as `:migration_role`** in a separate step: `… run --rm --no-deps --entrypoint "" app sh -lc 'cd /app/backend && DATABASE_URL="$MIGRATION_DATABASE_URL" alembic upgrade head'`. **[APPROVAL REQUIRED]**
5. **Apply/confirm grants** (§3–§5, §11) as `:migration_role`/owner. **[DBA ACTION] / [APPROVAL REQUIRED]**
6. **Verify** schema, ownership, privileges, audit immutability (§12).
7. **Start the app** (serve‑only entrypoint) as `:runtime_role`: `… up -d`. **[APPROVAL REQUIRED]**
8. **Smoke‑test** B2B + B2C flows (§13) and `/api/health`.
Until §8–§9 land, the interim is: run step 4's migrate command manually with migration creds, then start the app with runtime creds — no code change strictly required to *operate* this way, but the entrypoint will still try to migrate on boot unless overridden.

## 11. Default privileges for future tables/sequences **[PROPOSED] / [DBA ACTION]**
So objects created by **future** migrations are auto‑granted to the runtime role (default privileges apply only to objects created by the role they are set `FOR`, hence `FOR ROLE :migration_role`):
```sql
ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES  TO :runtime_role;              -- [APPROVAL REQUIRED]
ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :runtime_role;                             -- [APPROVAL REQUIRED]
ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :runtime_role;                                   -- [APPROVAL REQUIRED]
ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;                                              -- [APPROVAL REQUIRED]
```
**Caveat:** a future *append‑only* table (another audit‑style table) would be auto‑granted full DML by the defaults above; its UPDATE/DELETE/TRUNCATE must then be **re‑revoked explicitly** (as in §5) as part of that migration's rollout. Document this as a standing rule.

## 12. Verification queries (read‑only; safe) **[DBA ACTION]**
Reuse/extend `docs/STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md` §6. Additions for role separation:
```sql
-- Effective table privileges for the runtime role (expect DML on app tables; INSERT,SELECT only on the audit table):
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema='public' AND grantee = :'runtime_role'
GROUP BY table_name ORDER BY table_name;

-- Audit table specifically:
SELECT has_table_privilege(:'runtime_role','public.customer_admin_audit_logs','INSERT')   AS ins,  -- t
       has_table_privilege(:'runtime_role','public.customer_admin_audit_logs','SELECT')   AS sel,  -- t
       has_table_privilege(:'runtime_role','public.customer_admin_audit_logs','UPDATE')   AS upd,  -- f
       has_table_privilege(:'runtime_role','public.customer_admin_audit_logs','DELETE')   AS del,  -- f
       has_table_privilege(:'runtime_role','public.customer_admin_audit_logs','TRUNCATE') AS trn;  -- f

-- Sequence privileges (sample a serial PK sequence):
SELECT has_sequence_privilege(:'runtime_role', c.oid, 'USAGE') AS usage_ok
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='S' AND n.nspname='public' LIMIT 5;

-- EXECUTE on the stored procedures the app calls (expect t):
SELECT has_function_privilege(:'runtime_role','public.sp_approve_request(bigint,bigint,numeric)','EXECUTE');  -- adjust signature

-- Role attributes & membership (expect runtime: rolsuper=f; NOT a member of migration_role):
SELECT rolname, rolsuper, rolinherit, rolcanlogin FROM pg_roles WHERE rolname IN (:'runtime_role', :'migration_role');
SELECT r.rolname AS member, g.rolname AS member_of FROM pg_auth_members m
  JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid
 WHERE r.rolname = :'runtime_role';

-- Ownership of migration-created objects (expect owner = migration_role):
SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('customer_admin_audit_logs');
SELECT proname, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname='fn_block_customer_admin_audit_mutation';

-- Audit immutability (expect ERROR 'customer_admin_audit_logs is append-only'); run as runtime_role, read-only intent:
-- UPDATE public.customer_admin_audit_logs SET reason='x' WHERE false;   -- should RAISE even with WHERE false? (trigger is row-level; use a benign existing row in a transaction you ROLLBACK)
-- Prefer: BEGIN; DELETE FROM public.customer_admin_audit_logs WHERE customer_admin_audit_log_id = <known id>; ROLLBACK;  -- expect the trigger to RAISE
```

## 13. Compatibility risks for existing B2B and B2C functionality
- **Missing table grant → runtime 42501 errors.** Mitigate with the **schema‑wide** `GRANT` (§3) + **default privileges** (§11) so every current and future B2B/B2C table is covered. **[PROPOSED mitigation]**
- **Stored procedures (B2B partner bookings).** `sp_admin_list_partner_bookings` / `sp_approve_request` / `sp_reject_request` / `sp_resolve_service_request` are called at runtime **[VERIFIED]**. Under least privilege (REVOKE from `PUBLIC`), the runtime role needs explicit **EXECUTE** (§3) — otherwise these B2B admin flows break. SECURITY DEFINER vs INVOKER of those routines should be confirmed by the DBA.
- **Sequence privileges.** Missing `USAGE,SELECT` → every `INSERT` fails (both domains). Covered by §4 + §11.
- **B2C audit path.** `record_in_session`/`record_independently` need **INSERT** (granted); the REVOKE of UPDATE/DELETE does not affect INSERT. The M0 readiness gate already fails closed (503) if the table is absent — unchanged. **[VERIFIED behaviour preserved]**
- **Transactions/commits.** Role change is identity‑only; `autocommit=False` + explicit commits are unaffected. No ORM mapping or table structure changes. **[VERIFIED]**
- **Boot behaviour.** With the serve‑only entrypoint (§9), the app no longer migrates on boot — intended; the separate migrate step (§10) must run first or the app serves against an out‑of‑date schema (health/readiness surfaces this).
- **Gaming Tour Packages.** Unaffected and remains **disabled** (flag `GAMING_TOUR_PACKAGES_ENABLED` unset). **[VERIFIED]**
- **Single‑service hosts.** Removing boot‑migrate needs the §9 alternative or the schema will not advance on those hosts. **[PROPOSED]**

## 14. Rollback and recovery considerations **[PROPOSED]**
- **Privilege/config‑level, fully reversible, no data impact:** repoint `DATABASE_URL` back to the single owner role and restore the original `deploy/docker-entrypoint.sh` + `env.py`/`config.py` from git to return to Alternative B. Drop `:runtime_role`/`:migration_role` only after their grants are no longer referenced (`DROP ROLE` fails while objects/grants depend on them; use `REASSIGN OWNED`/`DROP OWNED` deliberately and only with approval).
- **Grant rollback** is independent of schema: `REVOKE … FROM :runtime_role` / re‑`GRANT` as reviewed — it never runs `alembic downgrade`.
- **Schema rollback is a different, destructive operation:** `0095.downgrade()` drops the audit table/trigger/function/enum and **destroys audit history** — separately **[APPROVAL REQUIRED]**; prefer code rollback over schema downgrade.
- **Recovery:** take a backup before the migrate step (§10.1); restore via `pg_restore`/snapshot if a migration misbehaves. Keep the §12 verification output as the sign‑off artifact.

---

*Prepared read‑only. VERIFIED items are observed in the repo; PROPOSED/DBA/APPROVAL‑REQUIRED items are not implemented here. No DB connection, no SQL, no roles created, no source/Docker/env/migration edits, no deploy/commit/push. No role names invented (placeholders where unknown); no credentials shown. All existing B2B and B2C functionality is to be preserved per §13. Gaming Tour Packages disabled; Stage 4 not started.*
