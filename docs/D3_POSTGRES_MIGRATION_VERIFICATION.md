# D3 — PostgreSQL Migration 0093 Verification

**Date:** 2026-10-31 · **Branch:** `claude/jackpotsworld-competitor-audit-7fe581`
**Scope:** Read-only investigation. No migration was run. No production system touched.

---

## 1. Current implementation findings

### Migration 0093: `traveller_middle_name`

**File:** `backend/alembic/versions/0093_traveller_middle_name.py`
**Chain:** `0092_wishlist_note` → `0093_traveller_middle_name`

```python
def upgrade() -> None:
    op.add_column(
        "customer_travellers",
        sa.Column("middle_name", sa.String(length=100), nullable=True),
    )

def downgrade() -> None:
    op.drop_column("customer_travellers", "middle_name")
```

**Analysis:**
- **Upgrade:** adds a single nullable `VARCHAR(100)` column to `customer_travellers`. This is the safest class of migration: purely additive, no data transformation, no NOT NULL constraint, no default value that triggers a table rewrite. On Postgres, `ALTER TABLE … ADD COLUMN … NULL` takes a table-level `ACCESS EXCLUSIVE` lock but completes in O(1) time (no row rewrite needed for nullable columns without defaults on Postgres 11+).
- **Downgrade:** drops the column. Any data in `middle_name` is lost on downgrade. This is expected and documented ("no separate middle name recorded" is the pre-migration state).
- **No data migration:** existing rows get NULL. The migration docstring explains why no retroactive split of "First Middle" into separate columns is attempted.

### Risk assessment

| Risk | Likelihood | Impact | Notes |
|---|---|---|---|
| Lock contention during upgrade | Low | Low | Single `ADD COLUMN NULL` is near-instant on Postgres; table lock duration is milliseconds |
| Data loss on downgrade | Expected | Low | Only `middle_name` values are lost; column is new and NULL for existing rows |
| Ordering conflict with other migrations | None | None | Linear chain; 0092 → 0093 with no branch |
| Incompatibility with existing queries | None | None | Column is nullable; no existing query selects or filters on it |

## 2. What was planned but blocked

I attempted to run the migration on a disposable Postgres 16 container via Docker. Docker is installed (`docker.exe` present, version 29.5.3) but **the Docker daemon is not running** (the Docker Desktop Linux engine pipe is not available). I could not start a container.

**What would have been tested:**
1. `alembic upgrade head` — all 94 migrations from scratch
2. `alembic downgrade -1` — drop `middle_name` column (0093 → 0092)
3. `alembic upgrade head` — re-add it (0092 → 0093)
4. Insert a row with `middle_name` set, downgrade, verify the row still exists (minus the column), upgrade, verify the row still exists with `middle_name` NULL

**What was verified instead:**
- The migration file is syntactically correct and has the correct revision chain
- The SQLite backend tests pass (1090 tests), which exercises the model including `middle_name`
- The CI workflow (D2) includes a `postgres-migrations` job that will run this exact test on a real Postgres 16 once pushed

## 3. Files affected

No files changed. The migration file already exists.

## 4. Proposed next steps

| Step | How | Risk |
|---|---|---|
| Start Docker Desktop and re-run the test | `docker run -d --name jpw_test -e POSTGRES_USER=test … postgres:16-alpine` then `alembic upgrade head && alembic downgrade -1 && alembic upgrade head` | None — throwaway container |
| OR: push the CI workflow (D2) and let GitHub Actions run it | The `postgres-migrations` job does exactly this on a service container | None — ephemeral CI container |
| After verification: run on a **copy** of production data | `pg_dump` production → restore into a throwaway instance → `alembic upgrade head` | Medium — needs production DB access |
| Production: run the migration | `alembic upgrade 0093_traveller_middle_name` on the production host | Low risk (nullable ADD COLUMN), but requires your explicit approval |

## 5. Rollback strategy

`alembic downgrade 0092_wishlist_note` drops the `middle_name` column. Any values stored in it are lost, which is acceptable since the column is new.

## 6. Decisions requiring your approval

| ID | Decision | Recommendation |
|---|---|---|
| PG1 | **Start Docker Desktop** on this machine and run the migration test now? | Yes, if Docker Desktop is available to start |
| PG2 | **Alternatively,** rely on the CI workflow's `postgres-migrations` job (requires pushing D2 first)? | Yes — this is the repeatable, automated path |
| PG3 | After CI passes, **run on a copy of production data** before running on production? | Yes — the one thing CI cannot test is interaction with existing production rows |
