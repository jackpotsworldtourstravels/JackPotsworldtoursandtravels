# Stage 3 — DBA Privilege Script Review for `customer_admin_audit_logs` (migration 0095)

**Purpose.** A DBA‑reviewed, *draft* SQL script that applies the spec‑D3 privilege model for the Stage 3 audit table created by `0095_customer_admin_audit_logs`: the application login gets **INSERT + SELECT only**, with **UPDATE / DELETE / TRUNCATE revoked**. The migration deliberately issues no `GRANT`/`REVOKE` (per its own docstring and `docs/STAGE_3_DATABASE_DEPLOYMENT_CHECKLIST.md` §1.5 / §2.5); this is the out‑of‑band DBA step.

**Status.** Draft for DBA review only. **Not executed. Not production‑ready.** No PostgreSQL connection was made; no SQL was run. Fill the placeholders and have a DBA review against the live cluster before any use. Commands that change privileges are marked **`[APPROVAL REQUIRED]`**.

**Sources inspected:** `docs/STAGE_3_STAGING_DEPLOYMENT_RUNBOOK.md`, `docs/STAGE_3_DATABASE_DEPLOYMENT_CHECKLIST.md`, `backend/alembic/versions/0095_customer_admin_audit_logs.py`, `deploy/staging/docker-compose.staging.yml`, `deploy/staging/stack.env.example`, `deploy/staging/backend.staging.env.example`.

---

## 1. Application role name — repository evidence (not invented)

There is **no `CREATE ROLE`, `GRANT`, or `REVOKE` anywhere in the repository** (searched `deploy/`, `database/`, `backend/alembic/`). No dedicated least‑privilege application role is defined. What the repo *does* reveal about the connecting role:

| Environment | How the app's DB login is set | Role value in repo | Determinable? |
|---|---|---|---|
| **Staging** | `deploy/staging/docker-compose.staging.yml` builds `DATABASE_URL=postgresql+psycopg2://${POSTGRES_USER}:…@postgres:5432/${POSTGRES_DB}`; `POSTGRES_USER` comes from `stack.env` | `stack.env.example` shows `POSTGRES_USER=jpw_staging` (an **example placeholder**) | Only the *example* value; the real one is whatever the operator sets in `stack.env` on the host |
| **Production** | `DATABASE_URL` lives in `backend/.env` (**not** in git — see `deploy/README.md`, `redeploy.sh`) | Not present in the repo; `docs/AWS_DEPLOYMENT.md` shows a sample connection string user `jpwadmin` (the **admin/owner**, not a restricted app role) | **No** — must be supplied by the owner/DBA |

> **CRITICAL caveat.** In both environments the configured login is the **database owner** (in staging, `POSTGRES_USER` is the role the `postgres` container creates as owner **and** superuser of `${POSTGRES_DB}`). **A table's owner — and any superuser — bypasses object‑level `GRANT`/`REVOKE`.** So if the app keeps connecting as the owner/superuser, this script's `REVOKE` statements are effectively inert: the append‑only **trigger** (`trg_block_customer_admin_audit_mutation`, which fires for *every* role, owner and superuser included) is what actually blocks `UPDATE`/`DELETE`, and `TRUNCATE` stays owner‑only regardless.
>
> **The INSERT/SELECT‑only privilege model is only meaningful when the app connects as a *non‑owner, non‑superuser* login that is separate from the DDL/owner role.** The repository does not define such a role. Creating it is a prerequisite (see §8, step 0) and its name must be provided by the owner/DBA — **it is left as a placeholder below; do not invent it.**

**Placeholders used in this script** (set via `psql` variables so nothing is hard‑coded):
```sql
-- Fill these in on the target cluster before running. DO NOT GUESS.
\set app_role    'REPLACE_WITH_APP_LOGIN_ROLE'     -- the NON-owner login the app uses (see §1 caveat)
\set ddl_owner   'REPLACE_WITH_TABLE_OWNER_ROLE'   -- the role that ran migration 0095 (owns the table)
\set audit_table 'customer_admin_audit_logs'
\set audit_enum  'customer_admin_audit_outcome_enum'
```

---

## 2. Schema & table ownership requirements

- **Schema:** `public` (the migration uses unqualified names; `0095` creates the table, enum, indexes, trigger and function in the default search path, i.e. `public`). This script qualifies objects as `public.customer_admin_audit_logs`.
- **Owner:** the table, its indexes, the enum type `customer_admin_audit_outcome_enum`, the function `fn_block_customer_admin_audit_mutation()` and the trigger are owned by **whichever role ran `alembic upgrade head`** (the `ddl_owner` placeholder). Per the `0095` design the actor column is a value snapshot (`admin_user_id BIGINT`, **no FK**), so no cross‑table grants are implied.
- **Ownership requirement for this script:** the statements must be run **as the table owner (`ddl_owner`) or a superuser** — only the owner/superuser may `GRANT`/`REVOKE` on the table (see §7). This script does **not** change ownership and does **not** create objects.
- **Do not** grant the app role ownership; ownership would re‑expose UPDATE/DELETE/TRUNCATE and defeat the model.

---

## 3. `GRANT INSERT, SELECT` — `[APPROVAL REQUIRED]`

```sql
-- Least privilege for the application login: it only ever writes new audit
-- rows and reads them back (list/detail). No column list on INSERT so future
-- additive columns keep working; SELECT is table-wide for the read side.
GRANT INSERT, SELECT ON TABLE public.customer_admin_audit_logs TO :"app_role";   -- [APPROVAL REQUIRED]

-- The PK is an IDENTITY/serial-style BIGINT (autoincrement) populated server-side,
-- so NO sequence GRANT is required for INSERT. If, and only if, a future change
-- makes the app supply the id via a sequence, add (owner decision):
--   GRANT USAGE, SELECT ON SEQUENCE public.customer_admin_audit_logs_customer_admin_audit_log_id_seq TO :"app_role";
```
Notes: the enum type `customer_admin_audit_outcome_enum` needs **no** grant — `USAGE` on a type is only restricted when `USAGE` was revoked from `PUBLIC`, which this script does not do. INSERT does not require UPDATE even though the trigger exists (the trigger only fires on UPDATE/DELETE).

---

## 4. `REVOKE UPDATE, DELETE, TRUNCATE` — `[APPROVAL REQUIRED]`

```sql
-- Defence in depth behind the append-only trigger. These REVOKEs matter ONLY
-- for a non-owner app_role (see §1 caveat); for an owner/superuser login they
-- are inert and the trigger is the real guard.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.customer_admin_audit_logs FROM :"app_role";   -- [APPROVAL REQUIRED]

-- Also strip any blanket privileges that may have reached the table via PUBLIC
-- (see §5). Harmless if PUBLIC held nothing.
REVOKE ALL ON TABLE public.customer_admin_audit_logs FROM PUBLIC;                               -- [APPROVAL REQUIRED]
```
Notes:
- `TRUNCATE` is **owner‑only by default** and is never granted to `PUBLIC`; revoking it from a non‑owner role is explicit but typically a no‑op (the role never had it). Included for completeness and auditability.
- **Do not** `REVOKE … FROM :"ddl_owner"` — an owner cannot be stripped of its own object privileges by `REVOKE`, and attempting to rely on that would give a false sense of protection. The trigger is what constrains the owner.

---

## 5. Inheritance via `PUBLIC` or another role — check before trusting the model

Two ways the app role could hold more than INSERT/SELECT despite §3–§4:

1. **`PUBLIC` grants.** If the cluster (or an `ALTER DEFAULT PRIVILEGES … TO PUBLIC`) granted table privileges to `PUBLIC`, every role — including `app_role` — inherits them. The `REVOKE … FROM PUBLIC` in §4 addresses the table; verify with §6.2. Also check default privileges (§6.4) so newly created objects don't silently re‑grant to `PUBLIC`.
2. **Role membership + `INHERIT`.** If `app_role` is a member of another role that has privileges on the table, and `app_role` has the `INHERIT` attribute, it inherits those privileges automatically. Verify `app_role`'s memberships and `rolinherit`/`rolsuper` (§6.3). If `app_role` is a superuser or a member of an owner/privileged group, the model is void until that is corrected (owner/DBA decision — not done here).

---

## 6. Read‑only verification SQL (safe to run; inspects privileges only)

> These are `SELECT`‑only inspections — no data or privilege changes. Run **after** §3–§4 to confirm the effective state.

**6.1 Effective table privileges held by the app role**
```sql
SELECT grantee, privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name   = 'customer_admin_audit_logs'
  AND grantee      = :'app_role'
ORDER BY privilege_type;
-- EXPECT exactly: INSERT, SELECT. No UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER.
```

**6.2 Point checks (boolean) and PUBLIC exposure**
```sql
SELECT
  has_table_privilege(:'app_role','public.customer_admin_audit_logs','INSERT')   AS can_insert,   -- expect t
  has_table_privilege(:'app_role','public.customer_admin_audit_logs','SELECT')   AS can_select,   -- expect t
  has_table_privilege(:'app_role','public.customer_admin_audit_logs','UPDATE')   AS can_update,   -- expect f (non-owner)
  has_table_privilege(:'app_role','public.customer_admin_audit_logs','DELETE')   AS can_delete,   -- expect f (non-owner)
  has_table_privilege(:'app_role','public.customer_admin_audit_logs','TRUNCATE') AS can_truncate; -- expect f (non-owner)

-- Anything PUBLIC still holds on the table (expect zero rows):
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name='customer_admin_audit_logs' AND grantee='PUBLIC';

-- Raw ACL + owner, for the record:
SELECT c.relname, pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname='customer_admin_audit_logs';
```

**6.3 Role attributes & memberships (catch superuser / inherited privilege)**
```sql
SELECT rolname, rolsuper, rolinherit, rolcanlogin
FROM pg_roles WHERE rolname = :'app_role';
-- EXPECT: rolsuper=f ; rolcanlogin=t ; rolinherit as per policy.
-- If rolsuper=t, this whole model is bypassed — stop and escalate (owner/DBA).

SELECT r.rolname AS member, g.rolname AS member_of
FROM pg_auth_members m
JOIN pg_roles r ON r.oid=m.member
JOIN pg_roles g ON g.oid=m.roleid
WHERE r.rolname = :'app_role';
-- Review each parent role: if any owns or is privileged on the audit table and
-- app_role INHERITs, it gains those privileges (see §5.2).
```

**6.4 Default privileges that could re‑grant to PUBLIC/others on future objects**
```sql
SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS granted_by,
       n.nspname AS schema, d.defaclobjtype AS objtype, d.defaclacl
FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace;
-- Review for any blanket TO PUBLIC default (objtype 'r' = tables).
```

**6.5 Confirm the append‑only guard exists (the real owner‑proof control)**
```sql
SELECT tgname FROM pg_trigger
WHERE tgname='trg_block_customer_admin_audit_mutation' AND NOT tgisinternal;      -- expect 1 row
SELECT proname FROM pg_proc WHERE proname='fn_block_customer_admin_audit_mutation'; -- expect 1 row
```

---

## 7. Required DBA permissions to run this script

- **To `GRANT`/`REVOKE` on the table (§3–§4):** connect as the **table owner** (`ddl_owner`) **or a superuser**. A non‑owner cannot alter the table's ACL.
- **To create the dedicated app role (§8 step 0, if not already present):** `CREATEROLE` (or superuser). Creating/altering a **superuser** role itself requires superuser.
- **To run the verification queries (§6):** any role with `CONNECT` to the database and normal `pg_catalog` / `information_schema` read access (available to all roles by default). `has_table_privilege(role, …)` works for any caller; it does not require being that role.
- **No `CREATE`/DDL privileges** are needed for §3–§4 (no objects are created here); object creation already happened in migration 0095.

---

## 8. Safe execution order & rollback

**Order (each privilege step `[APPROVAL REQUIRED]`):**
0. **Prerequisite — only if the app does not already use a dedicated non‑owner login (see §1 caveat).** Owner/DBA creates it and sets `DATABASE_URL`/`POSTGRES_USER` to it. Name supplied by owner — **placeholder here, not invented:**
   ```sql
   -- CREATE ROLE :"app_role" LOGIN PASSWORD '<<set out-of-band, never in git>>' NOSUPERUSER NOINHERIT;  -- [APPROVAL REQUIRED]
   -- GRANT CONNECT ON DATABASE <db> TO :"app_role";                                                     -- [APPROVAL REQUIRED]
   -- GRANT USAGE  ON SCHEMA public TO :"app_role";                                                       -- [APPROVAL REQUIRED]
   ```
1. Confirm migration `0095` is applied and the objects exist (§6.5 + checklist §1) **before** granting.
2. Run **§3** (`GRANT INSERT, SELECT`).
3. Run **§4** (`REVOKE UPDATE, DELETE, TRUNCATE` + `REVOKE ALL … FROM PUBLIC`).
4. Run **§6** verification; confirm the expected rows/booleans. Keep the output as the sign‑off artifact.
5. Wrap steps 2–3 in a single transaction so a partial application cannot occur:
   ```sql
   BEGIN;  -- [APPROVAL REQUIRED]
     GRANT  INSERT, SELECT ON TABLE public.customer_admin_audit_logs TO :"app_role";
     REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.customer_admin_audit_logs FROM :"app_role";
     REVOKE ALL ON TABLE public.customer_admin_audit_logs FROM PUBLIC;
   COMMIT;
   ```

**Rollback (privilege‑only; does not touch data or the table):**
```sql
BEGIN;  -- [APPROVAL REQUIRED]
  -- Reverse §3/§4. This restores the PRIOR privilege state of app_role; it does
  -- NOT re-grant to PUBLIC (re-granting to PUBLIC is never desirable here).
  REVOKE INSERT, SELECT ON TABLE public.customer_admin_audit_logs FROM :"app_role";
  -- UPDATE/DELETE/TRUNCATE were revoked, not granted, so there is normally
  -- nothing to restore; only re-grant them if a reviewed reason exists:
  -- GRANT UPDATE, DELETE ON TABLE public.customer_admin_audit_logs TO :"app_role";
COMMIT;
```
- **Do not** roll back by dropping the table/trigger — that is migration `0095.downgrade()`, which **destroys audit history** and is separately `[APPROVAL REQUIRED]` (checklist/runbook). Privilege rollback and schema rollback are different operations.
- If step 0 created a role, dropping it (`DROP ROLE`) is only safe once nothing depends on it; prefer leaving the role and reverting only the grants.

---

## Caveats & scope
- The real **production** application role name is **not in the repository** (`backend/.env`); it is a **placeholder** here and must be provided by the owner/DBA. Staging's `POSTGRES_USER` example (`jpw_staging`) is the owner/superuser and is **not** a valid restricted app role as‑is.
- This script is **meaningful only with a dedicated non‑owner, non‑superuser app login**; otherwise the append‑only trigger is the sole enforced control.
- Draft for review only — **no production‑readiness claim**. No DB connection, no SQL executed, no source/migration edits, no deploy/commit/push. Gaming Tour Packages remains disabled; Stage 4 not started.
