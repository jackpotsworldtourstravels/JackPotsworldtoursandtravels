# Stage B — Read-Only Database Verification Report

**Project:** JackPots World Tours & Travels
**Date:** 2026-11-12 (updated same day after reviewer direction)
**Scope approved:** Non-mutating database inspection only. No implementation, no migration, no data move.
**Status:** **HALTED BEFORE ANY DATABASE CONNECTION.** No read-only account is available and the target database is not yet confirmed, so no query in this report has been executed.

> **⚠ REFRAMED (2026-11-12):** The architecture decision changed to **one database with logical separation** (see `docs/B2C_LOGICAL_SEPARATION_PLAN.md`). Stage B's read-only queries still apply unchanged, but now verify single-DB integrity and classify legacy-table *data* for a later retirement decision — **not** to size a physical migration. The read-only-account blocker below is unchanged.

---

## 0. Verification layers (how to read this report)

Every finding below is tagged with exactly one layer, so the distinction between *what the code says* and *what a running database actually contains* is never blurred:

| Tag | Layer | Meaning |
|---|---|---|
| **[SRC-V]** | **Source-code verified** | Established by read-only inspection of repository files. Describes *source references / declared intent*, **not** deployed runtime behaviour. |
| **[LOCAL-NV]** | **Local database — not verified** | Would require a read-only query against the local dev DB (`127.0.0.1/jackpots_v2`). Not run. |
| **[STAGING-NV]** | **Staging — not verified** | Would require a read-only query against the staging DB. Not run; no connection path used. |
| **[PROD-NV]** | **Production — not verified** | Would require a read-only query against the production DB (AWS host, SSM-only). Not run; explicitly out of scope until authorized. |

**Caveat accepted from the reviewer:** source references (`[SRC-V]`) are repository-level facts only. They do **not** prove the deployed runtime does the same thing, nor that no out-of-repository process exists. Any claim about live data, live writers, or runtime behaviour is `[*-NV]` until the corresponding database is queried read-only.

---

## 1. STOP — required access is not available

The Stage B safety requirements are explicit: *use a read-only account; do not use the production administrator account; if a read-only account is unavailable, stop and explain what access is required; do not create one without approval.*

**[SRC-V] Finding:** the only database credential anywhere in the repository is the PostgreSQL **superuser**.

| Where | Credential | Account type |
|---|---|---|
| `backend/.env:3` | `postgres:****@127.0.0.1:5432/jackpots_v2` | **`postgres` — superuser / DB administrator** |
| `backend/.env.example:3` | `user:password@localhost:5432/...` | placeholder only |
| `backend/.env.*.bak` | same `postgres` superuser | superuser |
| `deploy/staging/stack.env.example` | `POSTGRES_USER=jpw_staging` | DB owner, **not** read-only |
| whole repo (`GRANT SELECT`, `CREATE ROLE`, `readonly`, `_ro`) | **none found** | — |

No read-only role exists. `postgres` is the forbidden administrator account. I did **not** connect. All live-database items are therefore `[LOCAL-NV]` / `[STAGING-NV]` / `[PROD-NV]`.

**Prerequisites to resume (both required, both provided by you — not by me):**
1. A least-privilege, SELECT-only role — reviewable script at `docs/stage-b/00_create_readonly_role.sql` (**not executed**).
2. A confirmed target database (dev / staging / production) and a connection path.

---

## 2. Source-code verified findings `[SRC-V]`

These are repository-level facts. They describe declared code structure, not deployed runtime.

### 2.1 `payment_provider_events` ownership and writers
`grep payment_provider_events|PaymentProviderEvent` over `backend/`:

| File | Role | Layer |
|---|---|---|
| `backend/app/models_customer.py` | **Model definition** — table declared on the **B2C `Base`** | B2C |
| `backend/app/services/payment_event_service.py` | Writer (records provider events) | B2C payment path |
| `backend/app/services/payments/trustbrick_provider.py` | Writer (TrustBrick events) | B2C payment path |
| `backend/app/services/customer_payment_admin_service.py` | Writer / reader (admin reconciliation) | B2C payment path |
| `backend/app/services/payment_verification_service.py` | Reference (verification / read path) | B2C payment path |
| `backend/alembic/versions/0062_customer_payment_provider.py` | Creates the table | migration |
| `backend/tests/test_hdfc_*`, `sweep_fakes.py`, `test_deferred_sweep_products.py` | Tests only | — |

**[SRC-V]** Every non-test, non-migration reference is on the **customer/B2C payment path**. No B2B (`models_v2`) payment service — `payment_admin_service`, `finance_service`, `payment_management_service` — references the table **in source**.

### 2.2 Legacy service cluster (dead at code level)
The six legacy services — `pricing_service`, `catalog_items`, `booking_management_service`, `admin_service`, `payment_management_service`, `inventory_service` — are imported **only by each other**:
- `pricing_service.py:8` → `catalog_items`
- `payment_management_service.py:9-10` → `booking_management_service`
- `inventory_service.py:5` → `catalog_items`

**[SRC-V]** No router, `main.py`, script, test, or integration imports any of the six. At the code level the cluster (and tables `coupons`, `seasonal_prices`, `discount_campaigns`, `flights`, `hotels`, `tour_packages`) is dead.

### 2.3 Background workers / scheduled jobs / integrations
**[SRC-V]** The only background processing is **two in-process `asyncio` sweeps** started at app startup (`backend/app/main.py`): booking-completion (`booking_completion_service.sweep_once_locked`) and the deferred payment-event sweep (`_run_payment_sweep` → customer payment verification / `payment_provider_events`). Both run on `models_v2` / `models_customer`. There is **no APScheduler / Celery / external scheduler**, and **neither sweep imports any of the six legacy services**. The payment sweep is read-only at the provider (`main.py:595`, "the sweep never submits a refund").

### 2.4 Target configuration
**[SRC-V]** `DATABASE_URL` resolves to a **local dev database** (`127.0.0.1/jackpots_v2`), not production. Production (per deployment records) is on the AWS host, reachable only via SSM.

---

## 3. Local database — NOT verified `[LOCAL-NV]`

Running read-only queries against `jackpots_v2` would establish all of the following. **None was run.**

| # | Item | Query | Status |
|---|---|---|---|
| 1 | B2C row counts (`customer_*` + `payment_provider_events`) | `01_stage_b_readonly_queries.sql` §1 | **[LOCAL-NV]** |
| 2 | Legacy row counts + recent-write scan | §2 | **[LOCAL-NV]** |
| 3 | Foreign-key integrity / boundary-crossing FKs | §3 | **[LOCAL-NV]** |
| 4 | Orphan records (every child → parent FK) | §4 | **[LOCAL-NV]** |
| 5 | Duplicate identifiers (`customer_code`, email, mobile) | §5 | **[LOCAL-NV]** |
| 6 | PostgreSQL ENUM types | §6 | **[LOCAL-NV]** |
| 7 | Sequences (esp. `seq_customer_code`) | §7 | **[LOCAL-NV]** |
| 8 | Indexes and constraints | §8 | **[LOCAL-NV]** |
| 9 | `payment_provider_events` row-level data / per-provider distribution | §9 | **[LOCAL-NV]** |
| 10 | Whether any legacy table has live/recent writes | §2 | **[LOCAL-NV]** |

> Note: even once a read-only account exists, local results describe only the developer's machine — not what production holds.

---

## 4. Staging — NOT verified `[STAGING-NV]`

No connection to staging was attempted (the instructions forbid it for now). Staging (`deploy/staging/`, DB `jpw_staging`) has its own data set; every item in §3 is independently **[STAGING-NV]** and must be run there separately if staging is chosen as a target.

---

## 5. Production — NOT verified `[PROD-NV]`

No connection to production was attempted. Production is explicitly out of scope until you authorize it and a read-only account is provisioned there. Every item in §3 is independently **[PROD-NV]**. Production is the only environment whose row counts, orphans, duplicates, and sequence positions matter for a real migration manifest.

---

## 6. Migration risks surfaced so far

- **Baseline fidelity (High):** enums / sequence / server-defaults are not carried by SQLAlchemy metadata; the B2C baseline must come from a live schema dump — needs DB access (Stage A spec §3.4).
- **Target ambiguity (Process):** dev vs staging vs production must be fixed before any count is trusted; sizing the maintenance window from a dev copy would be wrong.
- **Access gap (Process):** no read-only role exists — the first prerequisite for a safe Stage B.
- **Source ≠ runtime (Reviewer caveat):** the `[SRC-V]` writer/legacy findings hold in code; whether an out-of-repo process writes `payment_provider_events` or the legacy tables is unprovable without the read-only scan.

## 7. Newly discovered dependencies

- **[SRC-V]** `payment_verification_service.py` also references `payment_provider_events` (verification/read path), beyond the three writers named in the Stage A spec — still entirely B2C, no B2B path.

---

## 8. Reviewable scripts prepared (NOT executed)

| File | Purpose | Run by |
|---|---|---|
| `docs/stage-b/00_create_readonly_role.sql` | Least-privilege, SELECT-only login role for Stage B | **Your DBA**, as superuser, after you approve — not me |
| `docs/stage-b/01_stage_b_readonly_queries.sql` | All Stage B read-only verification queries (items 1–10), wrapped in a read-only transaction | Me, once the read-only account + target DB are provided |

Both files are specification text for review. Neither has been run; no database object was created; no permission changed.

---

## Strict-restriction confirmation

No database connection opened · no query executed · superuser account **not** used · no read-only account created · no `CREATE ROLE`/`GRANT` executed · no permission changed · no record modified · no migration run · no connection to staging or production · no source or config file modified · no git operation · no write transaction. Repository files were **read** only; this report and the two scripts under `docs/stage-b/` are the deliverable.

**Halted as instructed. Awaiting your confirmation of the target database and provisioning of a read-only account before continuing Stage B.**
