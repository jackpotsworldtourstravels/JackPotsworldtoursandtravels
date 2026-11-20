> **⚠ PARTLY SUPERSEDED (2026-11-12):** The decision changed to **one database with logical separation**. The physical-split parts of this spec (`customer_session.py`, `customer_engine`, `get_customer_db`, `CUSTOMER_DATABASE_URL`, `alembic_customer/`, data migration/cutover) are **dropped**. Only the audit table, router classification, and boundary CI assertions survive, re-scoped to one DB. See `docs/B2C_LOGICAL_SEPARATION_PLAN.md` §6.

# Stage A — File-Level Technical Specification (B2C Physical DB Separation)

**Project:** JackPots World Tours & Travels
**Status:** **PLANNING / SPECIFICATION ONLY.** Nothing in this document has been applied. No file was created or modified, no config changed, no DB object created, no migration or data move run, no git action. The code blocks below are **proposed contents for review**, not files on disk.
**Companion:** `docs/B2C_DATABASE_SEPARATION_PLAN.md` (v2). This document is the detailed Stage-A build spec it pointed to.
**Date:** 2026-11-12
**Tags:** **[V]** verified in repo (path:line) · **[P]** partial · **[NV]** needs live DB (cannot be done in planning).

---

## 1. Database configuration specification

**Existing convention** [V — `config.py:3,8-9,647,750`]: `pydantic_settings.BaseSettings`; snake_case fields bind to UPPERCASE env vars (`database_url` ← `DATABASE_URL`); `.env` loaded via `SettingsConfigDict(env_file=BACKEND_DIR/".env", extra="ignore")` at line 647; a module-level singleton `settings = Settings()` at line 750.

**Proposed keys** (added to `class Settings` in `backend/app/config.py`):

| Purpose | Field (proposed) | Env var | Type / default | Notes |
|---|---|---|---|---|
| B2B database (existing) | `database_url` | `DATABASE_URL` | `str` (required) | **unchanged** |
| B2C database (new) | `customer_database_url` | `CUSTOMER_DATABASE_URL` | `str \| None = None` | None ⇒ falls back to B2B URL during transition (see below) |
| B2C pool size (optional) | `customer_db_pool_size` | `CUSTOMER_DB_POOL_SIZE` | `int = 5` | independent pool |
| B2C pool overflow (optional) | `customer_db_max_overflow` | `CUSTOMER_DB_MAX_OVERFLOW` | `int = 10` | independent pool |

**Proposed addition to `Settings` (illustrative — not applied):**
```python
    # --- B2C operational database (physically separate from B2B) ---
    # Unset on a host that has not yet been split: the effective URL then falls
    # back to database_url so the single-DB deployment keeps working unchanged.
    # Set CUSTOMER_DATABASE_URL to the new B2C database to activate the split.
    customer_database_url: str | None = None
    customer_db_pool_size: int = 5
    customer_db_max_overflow: int = 10

    @property
    def effective_customer_database_url(self) -> str:
        return self.customer_database_url or self.database_url
```

**DATABASE_URL compatibility during transition:** `effective_customer_database_url` resolves to `customer_database_url` when set, else to `database_url`. So:
- **Before the split:** only `DATABASE_URL` is set → both engines point at the same DB → behaviour identical to today (customer tables still co-resident). Safe no-op.
- **At cutover:** set `CUSTOMER_DATABASE_URL` to the new B2C DB → the B2C engine uses it; B2B engine unchanged.
- **Acceptance mode (optional, §8):** a config check can *require* a distinct `customer_database_url` in the "deployed/split" state so production never silently runs both on one DB.

**No credentials, no real database names** appear here; URLs come only from env/`.env` on the host.

---

## 2. Customer database session design

### 2.1 Proposed `backend/app/database/customer_session.py` (new file — proposed contents)
Mirrors `backend/app/database/session.py` [V:1-19] but on its own engine. **Note:** `models_customer.Base` already exists and is separate [V — `models_customer.py:27`]; this module does **not** redeclare a Base — it imports the existing one so metadata stays single-sourced.
```python
"""B2C operational database — a physically separate engine/session from B2B.

The B2B engine lives in app/database/session.py and is untouched. This module
binds the customer model layer (its own DeclarativeBase in app/models_customer)
to the B2C database. There is NO fallback from one engine to the other: a B2C
outage must surface as a B2C error, never a read against the B2B database.
"""
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models_customer import Base as CustomerBase  # the separate B2C Base

customer_engine = create_engine(
    settings.effective_customer_database_url,
    pool_pre_ping=True,
    pool_size=settings.customer_db_pool_size,
    max_overflow=settings.customer_db_max_overflow,
)
CustomerSessionLocal = sessionmaker(
    autocommit=False, autoflush=False, bind=customer_engine
)

# Re-exported so callers/migrations reference one metadata, never a second Base.
customer_metadata = CustomerBase.metadata


def get_customer_db() -> Iterator[Session]:
    """FastAPI dependency: a B2C session, always closed, never falling back."""
    db = CustomerSessionLocal()
    try:
        yield db
    finally:
        db.close()


def customer_db_healthy() -> bool:
    """Used by the startup/health check. Returns False on any connection error
    rather than raising, so the B2B app can start and report B2C as degraded."""
    from sqlalchemy import text
    try:
        with customer_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except OperationalError:
        return False
```

### 2.2 Dependency / lifecycle / cleanup / error handling / routing
- **Dependency:** `get_customer_db` (generator dependency, identical lifecycle to `get_db`).
- **Engine lifecycle:** module-level singleton `customer_engine`, created at import; connection pool managed by SQLAlchemy; `pool_pre_ping=True` drops dead connections.
- **Session cleanup:** `try/finally: db.close()` — same guarantee as `get_db` [V:14-19].
- **Connection error handling:** `customer_db_healthy()` returns False (no raise) for the health/startup check; request-time failures propagate as 5xx from the B2C endpoint (no fallback). Proposed startup hook in `main.py` logs a clear warning if `customer_db_healthy()` is False, mirroring the existing `ensure_default_admin` startup block [V — `main.py:481-499`].
- **Routing:** B2C endpoints depend on `get_customer_db`; B2B endpoints keep `get_db`. The two engines never share a session.

### 2.3 Exactly how each B2C router switches dependency
**Mechanical change per endpoint:** replace `db: Session = Depends(get_db)` with `db: Session = Depends(get_customer_db)` and change the import `from app.database.session import get_db` → `from app.database.customer_session import get_customer_db`. Service functions already take a `Session` arg, so no service signature changes for pure-B2C services. [V — e.g. `customer_bookings.py:23,167`]

**Admin-on-B2C endpoints (two sessions):** keep `current_admin: User = Depends(get_current_admin)` (auth on **B2B** via `get_db`, unchanged) **and** add `db: Session = Depends(get_customer_db)` for data. Operational audit writes go to `customer_admin_audit_logs` (B2C, §4) instead of B2B `audit_logs`. [V — pattern at `admin_cancellations.py:30,60,77`]

### 2.4 Every affected router file (complete) [V — grep `from app.database.session import get_db` over `backend/app/routers`]

**Group B2C-PURE → swap to `get_customer_db` (customer identity on B2C token, data on B2C):**
`customer_auth.py`, `customer_profile.py`, `customer_account.py`, `customer_travellers.py`, `customer_bookings.py`, `customer_hotel_bookings.py`, `customer_package_bookings.py`, `customer_cancellations.py`, `customer_payment_admin.py`, `customer_recommendations.py`, `customer_destinations.py`, `customer_assistant.py`, `customer_chat.py`.

**Group B2C-ADMIN → two sessions (B2B auth via `get_db` + B2C data via `get_customer_db`):**
`admin_customer_bookings.py`, `admin_cancellations.py`, `admin_reconciliation.py`, `admin_reviews.py`, `admin_communication.py`, `admin_user_activity.py`, `admin_b2c_reports.py`, `admin_catalogue_destinations.py`, `admin_catalogue_hotels.py`, `admin_catalogue_packages.py`, `customer_admin.py`. *(Also `admin_catalogue.py` — confirm its session import; it imports catalogue services but did not match the `get_db` grep. [P])*

**Group KEEP on `get_db` (B2B, `models_v2`):**
`auth.py`, `super_admin.py`, `merchants.py`, `merchant_team.py`, `merchant_approvals.py`, `manager.py`, `manager_approvals.py`, `enquiries.py`, `hotel_enquiries.py`, `tour_package_enquiries.py`, `group_bookings.py`, `booking_ops.py`, `change_requests.py`, `finance.py`, `wallet.py`, `payment_admin.py`, `providers.py`, `dashboard.py`, `reports.py`, `admin_ops.py`, `support_tickets.py`, `tickets.py`, `messages.py`, `analytics.py`, `documents.py`, `passport_ocr.py`, `profile.py`, `notifications_v2.py`.

**Group MIXED → per-endpoint review before swap [P / §10]:**
`gaming_tour_enquiries.py` (uses **B2B** `GamingTourEnquiry` — stays `get_db`, gated by the gaming flag), `eticket.py` (owner_router/public_router — likely B2C e-tickets; confirm), `admin_chat.py` (admin side of **customer** chat → likely B2C; confirm vs any merchant chat), `payment_webhooks.py` and `payment_returns.py` (handle provider callbacks that may touch **both** B2B `payments` and B2C `customer_*_payments`/`payment_provider_events` — must be split by payment origin; this is the highest-care item, tied to unresolved Q3).

---

## 3. Alembic separation

### 3.1 Existing state [V]
- `backend/alembic.ini` (`script_location = alembic`, `prepend_sys_path = .`); `backend/alembic/env.py` sets `target_metadata = app.database.session.Base.metadata` and `from app.models import *` — i.e. autogenerate currently sees **only the legacy layer**; `models_v2`/`models_customer` schema is **hand-written** in revisions. [V — `alembic/env.py:7-8,15`]
- Customer tables are created by ~9 interleaved revisions in the single 95-revision chain: `0044_customer_portal, 0053, 0054, 0055, 0061, 0079, 0086, 0089, 0094`. [V]

### 3.2 Proposed B2C Alembic (new, isolated)
- **New `backend/alembic_customer.ini`** (`script_location = alembic_customer`, `prepend_sys_path = .`).
- **New `backend/alembic_customer/env.py`** (proposed contents):
```python
from sqlalchemy import create_engine, pool
from alembic import context

from app.config import settings
from app.models_customer import Base  # the B2C DeclarativeBase

target_metadata = Base.metadata
DATABASE_URL = settings.effective_customer_database_url  # B2C DB

def run_migrations_online() -> None:
    connectable = create_engine(DATABASE_URL, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata,
                          version_table="alembic_version")  # in the B2C DB
        with context.begin_transaction():
            context.run_migrations()

def run_migrations_offline() -> None:
    context.configure(url=DATABASE_URL, target_metadata=target_metadata,
                      literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()

run_migrations_offline() if context.is_offline_mode() else run_migrations_online()
```
- **New `backend/alembic_customer/script.py.mako`** (copy of the existing mako [V — `backend/alembic/script.py.mako`]).
- **New `backend/alembic_customer/versions/`** with the baseline (§3.4).

### 3.3 Isolation & history preservation
- **B2B migration isolation:** `backend/alembic/` is **not modified**; its `alembic_version` stays in the B2B DB; the existing 95-revision history is preserved verbatim. The ~9 customer revisions remain in B2B history (they already ran) — they are **not deleted**; their tables are dropped from the B2B DB only at the gated post-verification cleanup (plan §7 Stage D).
- **B2C revision management:** independent chain with its own `alembic_version` table **in the B2C DB**; commands run with `-c alembic_customer.ini`. The two histories never cross.

### 3.4 Initial B2C schema creation strategy — **do NOT trust `metadata.create_all`**
Per your instruction, the baseline is built from a **three-way comparison**, because the live schema contains objects SQLAlchemy metadata does **not** carry:
- **PostgreSQL ENUM types** created by migration 0044 (e.g. `customer_audit_status_enum`, status/purpose enums) [V — `models_customer.py:35-66` names "match the PostgreSQL types created by 0044"].
- **The `seq_customer_code` sequence** and server-side defaults/`server_default` values [V — referenced in `verify_customer_portal.py:160`, `models_customer` server_defaults].
- CHECK constraints, partial/unique indexes, and `::jsonb` defaults [V — `models_customer.py:1906,2256`].

**Baseline procedure (proposed, read-only until approved):**
1. `pg_dump --schema-only --no-owner -t 'customer*' -t 'payment_provider_events'` (plus the enum types/sequence those objects depend on) from the current shared DB → the authoritative DDL. **[NV — needs DB access]**
2. Reconcile that DDL against `models_customer.Base.metadata` (what the ORM expects) **and** the ~9 customer revisions (how it was built). `verify_customer_portal.py` already asserts *declared == existing tables* today, which gives confidence the table set matches — but **enum types, the sequence, and functions are not in that assertion**, so they must be carried explicitly. [V — `verify_customer_portal.py:170-179`]
3. Hand-write the B2C baseline revision from the reconciled DDL (not autogenerate), `alembic -c alembic_customer.ini stamp head` on the freshly built B2C DB.

**Open check [NV]:** confirm whether any `customer_*` column has a cross-schema default/trigger (none expected). The three-way compare is the gate.

---

## 4. Administrator audit architecture

### 4.1 Proposed model `CustomerAdminAuditLog` (added to `backend/app/models_customer.py`, on the B2C `Base`)
Follows the module's conventions [V — `models_customer.py:24,55,312-335`; `JSONB` at :764,1906; `DateTime(timezone=True)`/`func.now()` throughout]. **No FK to B2B `users`.**
```python
class AdminAuditOutcome(str, enum.Enum):
    SUCCESS = "success"
    FAILURE = "failure"

_ADMIN_AUDIT_OUTCOME = SAEnum(AdminAuditOutcome, name="customer_admin_audit_outcome_enum",
                              values_callable=lambda e: [m.value for m in e])

class CustomerAdminAuditLog(Base):
    """B2B administrator actions performed ON B2C data, recorded IN the B2C DB.
    The admin lives in the B2B `users` table; we store the id and a snapshot,
    never a foreign key across databases."""
    __tablename__ = "customer_admin_audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    #: B2B users.user_id — a plain value, NOT a ForeignKey (cross-DB forbidden).
    admin_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    #: Identity captured at write time so the trail is readable without the B2B DB.
    admin_email: Mapped[str] = mapped_column(String(255), nullable=False)
    admin_name: Mapped[Optional[str]] = mapped_column(String(150), nullable=True)
    admin_role: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    environment: Mapped[str] = mapped_column(String(8), nullable=False, server_default=text("'b2c'"))
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    record_type: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    record_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    previous_value: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    new_value: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    outcome: Mapped[AdminAuditOutcome] = mapped_column(_ADMIN_AUDIT_OUTCOME, nullable=False,
                                                       default=AdminAuditOutcome.SUCCESS)
    ip_address: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False,
                                                    server_default=func.now())

    __table_args__ = (
        Index("ix_customer_admin_audit_record", "record_type", "record_id"),
        Index("ix_customer_admin_audit_created", "created_at"),
    )
```

| Required item (your list) | Column |
|---|---|
| Table name | `customer_admin_audit_logs` |
| Administrator identity snapshot | `admin_user_id` (no FK) + `admin_email`/`admin_name`/`admin_role` |
| Environment | `environment` (default `'b2c'`) |
| Action | `action` |
| Previous / new values | `previous_value` / `new_value` (JSONB, secrets excluded by the writer) |
| Reason | `reason` |
| Outcome | `outcome` (enum success/failure) |
| Timestamp | `created_at` (tz-aware, server default now) |
| Indexes | `admin_user_id`, `(record_type, record_id)`, `created_at` |

### 4.2 How the B2B admin authenticates and writes to B2C without cross-DB FK
1. Request carries a B2B admin access token → `get_current_admin` validates it against **B2B** `users` via `get_db` (unchanged). [V — `auth/deps.py:30-50`]
2. The endpoint also depends on `get_customer_db` (B2C session).
3. A proposed helper `customer_admin_audit_service.record(cdb, admin, action, record_type, record_id, previous, new, reason, outcome, ip)` inserts a `CustomerAdminAuditLog` row into the **B2C** DB, copying `admin.user_id/email/name/role` as a **snapshot** — a value, not a relationship. No FK, so no cross-DB constraint.
4. `customer_audit_logs` is **not touched** (stays the customer's own trail). [V — unchanged, `models_customer.py:312`]

Baseline/migration: the new table + its enum ship in the B2C baseline (§3.4) and are added to the B2B DB only as a no-op if the split is deferred (it lives on the B2C metadata either way).

---

## 5. Legacy model quarantine (reference verification — no deletion/rename)

**Reference check results (whole-repo, read-only):** [V]
| Source | Imports legacy `app/models/*` or the 6 services? |
|---|---|
| API routers (`backend/app/routers`) | **No** (the earlier "18 routers" was a substring false-positive; real B2C routers use `customer_*`/`catalogue_*` services) |
| `main.py` / app assembly | **No** reference to the 6 services |
| Background workers / scheduled jobs | the payment sweep (`payment_sweep_enabled`) and refund reconcile run inside the app on `models_v2`/`models_customer`; **no** legacy import found |
| Deployment entry points (`Dockerfile`, `render.yaml`, `deploy/`) | **not** importing the legacy cluster (run the app/alembic) [P — re-confirm at §10] |
| CLI / scripts (`scripts/`) | **No** (image/seed/catalogue utilities; none import legacy travel/pricing/user/booking) |
| Tests (`tests/`, `backend/tests/`) | **No** import of the 6 services or legacy models |
| External integrations (`integrations/duffel`, `hotelbeds`) | **No** legacy import |
| Alembic | **Yes — only** `alembic/env.py:8 from app.models import *` (metadata registration) |

**Quarantine plan (no delete, no rename):**
1. **Leave everything in place** — `app/models/` and the six services (`admin_service, booking_management_service, catalog_items, payment_management_service, pricing_service, inventory_service`) stay in the B2B DB / codebase, untouched.
2. **Document** them as dead in a `backend/app/models/README` / module docstrings (a *proposed* doc-only change, for a later approved step — not part of this spec's execution).
3. **Duplicate `users`/`payments`/`service_requests`:** verdicts stand — legacy copies are referenced only by the dead cluster (+ `__init__`), live copies are `models_v2`. The legacy `service_requests` (`app/models/partner_service_request.py`) has **zero importers** repo-wide. [V] No action beyond documentation.
4. **Keep alembic registration** as-is (removing `from app.models import *` would change B2B autogenerate behaviour — out of scope).
5. **Gate on the §6 live-DB checks** before any future retirement proposal.

---

## 6. Existing data verification — read-only SQL (DO NOT run destructive SQL)

All statements below are **SELECT-only**. They are provided for your DBA to run against the current shared DB; none has been executed here. **[NV — all require live DB access.]**

```sql
-- 6.1 B2C table row counts (all customer_* + payment_provider_events)
SELECT relname AS table, n_live_tup AS approx_rows
FROM pg_stat_user_tables
WHERE relname LIKE 'customer\_%' OR relname = 'payment_provider_events'
ORDER BY relname;
-- exact: SELECT 'customer_bookings' t, count(*) FROM customer_bookings; (repeat/UNION per table)

-- 6.2 Legacy table row counts (confirm dead/empty before quarantine)
SELECT 'coupons' t, count(*) n FROM coupons
UNION ALL SELECT 'seasonal_prices', count(*) FROM seasonal_prices
UNION ALL SELECT 'discount_campaigns', count(*) FROM discount_campaigns
UNION ALL SELECT 'flights', count(*) FROM flights
UNION ALL SELECT 'hotels', count(*) FROM hotels
UNION ALL SELECT 'tour_packages', count(*) FROM tour_packages
UNION ALL SELECT 'legacy_users_dupe', count(*) FROM users          -- live B2B table; compare context
UNION ALL SELECT 'bookings', count(*) FROM bookings
UNION ALL SELECT 'service_requests', count(*) FROM service_requests;
-- Also, recent-write check per table:
SELECT max(updated_at) FROM coupons;   -- repeat where an updated_at/created_at exists

-- 6.3 Foreign-key consistency / crossing the boundary (schema-level, no data change)
SELECT tc.table_name, kcu.column_name, ccu.table_name AS refs
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND (tc.table_name LIKE 'customer%' OR ccu.table_name LIKE 'customer%')
  AND NOT (tc.table_name LIKE 'customer%' AND ccu.table_name LIKE 'customer%');  -- expect 0 rows

-- 6.4 Orphan records (example: booking passengers without a parent booking)
SELECT count(*) FROM customer_booking_passengers p
LEFT JOIN customer_bookings b ON b.customer_booking_id = p.customer_booking_id
WHERE b.customer_booking_id IS NULL;   -- repeat per child FK from models_customer

-- 6.5 Duplicate identifiers (customer_code / email / mobile uniqueness)
SELECT customer_code, count(*) FROM customers GROUP BY customer_code HAVING count(*) > 1;
SELECT lower(email), count(*) FROM customers GROUP BY lower(email) HAVING count(*) > 1;
SELECT mobile, count(*) FROM customers GROUP BY mobile HAVING count(*) > 1;

-- 6.6 payment_provider_events writers & dependencies (inspect, don't mutate)
SELECT provider, processing_status, count(*) FROM payment_provider_events GROUP BY 1,2;
-- repo-side writers already identified: services/payment_event_service.py,
-- services/payments/trustbrick_provider.py, services/customer_payment_admin_service.py [V]

-- 6.7 Existing customer authentication dependencies (B2C identity island)
SELECT count(*) FROM customer_auth;
SELECT count(*) FROM customer_sessions WHERE is_active;
SELECT count(*) FROM customer_otps;
-- confirm no users row shares a customer address (cross-identity leak check):
SELECT count(*) FROM users u WHERE EXISTS (SELECT 1 FROM customers c WHERE lower(c.email)=lower(u.email));
```

**Repository-verified vs live-DB facts:** the table/FK *structure* and the *writers* above are [V] from code; every *count*, *orphan*, *duplicate*, and *recent-write* result is **[NV]** until these run against the live DB.

---

## 7. Migration & rollback execution sequence (specification — not executed)

| # | Step | Detail | Gate / rollback point |
|---|---|---|---|
| 1 | Pre-migration checks | run §6 queries; capture row-count manifest; confirm app boots with two DBs in staging; confirm `CUSTOMER_DATABASE_URL` set to the NEW DB | abort if any §6 anomaly |
| 2 | Backups | full `pg_dump` of shared DB + per-table dumps of `customer_*`/`payment_provider_events`; **verify restore** to scratch | abort if restore fails |
| 3 | Target DB prep | provision new B2C PostgreSQL; create roles; empty | — |
| 4 | B2C schema creation | apply §3.4 baseline (enums + sequence + tables + `customer_admin_audit_logs`); `stamp head` | verify schema == `models_customer` + dump |
| 5 | Data migration | copy in FK-parent→child order (plan §7.3); keep source intact | — |
| 6 | FK validation | zero orphans for every child FK; (re)validate FKs on B2C | **rollback** if orphans |
| 7 | Record-count comparison | per-table B2C == manifest; reset sequences to `max(id)+1` | **rollback** if mismatch |
| 8 | Application cutover | maintenance window: freeze B2C writes (B2B stays up) → final delta → deploy code (`get_customer_db`, 2-session admin, B2C audit) → point `CUSTOMER_DATABASE_URL` | **rollback** = revert env+code to single-DB |
| 9 | Customer auth testing | signup/login/OTP/reset against B2C; run `verify_customer_portal.py` (two-DB mode, §8) | **rollback** if any auth check fails |
| 10 | Payment verification testing | reconcile/verify flows read B2C `payment_provider_events`; **no real payment/refund** | **rollback** if verification path broken |
| 11 | Booking regression | flight/hotel/package quote+book+cancel smoke on B2C | **rollback** if booking broken |
| 12 | Rollback decision points | after 6,7,9,10,11; **success declared only when ALL acceptance tests pass** | — |
| 13 | B2B continuity (throughout) | merchant/B2B smoke before+during+after; B2B DB counts unchanged | halt if B2B affected |
| 14 | (Deferred, gated) | drop `customer_*` from B2B DB only after stable verification, against backup | reversible from backup |

**B2B remains operational throughout** (its DB is never migrated). **No cutover is treated as successful until steps 9–11 all pass.**

---

## 8. Proposed additions to `tests/verify_customer_portal.py`

**Structural change first:** the script currently opens one session via `from app.database.session import SessionLocal` [V:58] and queries `customer%` and `users/audit_logs` in the *same* DB [V:158-161,414-420]. Post-split it must open **two** sessions. Proposed:
```python
from app.database.session import SessionLocal            # B2B
from app.database.customer_session import CustomerSessionLocal  # B2C (new)
def _db_b2b(): return SessionLocal()
def _db_b2c(): return CustomerSessionLocal()
```
Then route each existing query to the correct DB (customer_* → B2C; users/system_logs/msg_logs/audit_logs → B2B). The cross-DB delta checks in §3/§5 of the script become: "a customer journey adds 0 rows to the **B2B** log tables" (now a genuinely separate database — a stronger guarantee).

**New assertions (proposed) — a `== Stage A: physical separation ==` section:**
```python
# (a) B2C routers use the B2C session; B2B routers use the B2B session.
import ast, pathlib
R = BACKEND / "app" / "routers"
B2C = {"customer_auth","customer_profile","customer_account","customer_travellers",
       "customer_bookings","customer_hotel_bookings","customer_package_bookings",
       "customer_cancellations","customer_payment_admin","customer_recommendations",
       "customer_destinations","customer_assistant","customer_chat",
       "admin_customer_bookings","admin_cancellations","admin_reconciliation",
       "admin_reviews","admin_communication","admin_user_activity","admin_b2c_reports",
       "admin_catalogue_destinations","admin_catalogue_hotels","admin_catalogue_packages",
       "customer_admin"}
for f in R.glob("*.py"):
    src = f.read_text(encoding="utf-8")
    uses_b2c = "get_customer_db" in src
    uses_b2b = "import get_db" in src or "Depends(get_db)" in src
    if f.stem in B2C:
        check(f"{f.stem} uses the B2C session", uses_b2c and not uses_b2b, f.stem)
    elif f.stem.startswith(("merchant","manager","super_admin","wallet","finance",
                            "providers","payment_admin","booking_ops")):
        check(f"{f.stem} uses the B2B session", uses_b2b and not uses_b2c, f.stem)

# (b) No accidental cross-database fallback: the two engines are different URLs.
from app.database.session import engine as b2b_engine
from app.database.customer_session import customer_engine
check("B2C engine is a distinct database from B2B",
      str(b2b_engine.url) != str(customer_engine.url)
      or settings.customer_database_url is None,  # equal only in un-split transition
      f"{b2b_engine.url!r} vs {customer_engine.url!r}")

# (c) Missing B2C configuration fails safely (no crash, no silent B2B use).
from app.database.customer_session import customer_db_healthy
check("B2C health check returns a bool, never raises", isinstance(customer_db_healthy(), bool))

# (d) No cross-DB FK — assert on EACH database separately now.
for sess, side in ((_db_b2c(), "B2C"), (_db_b2b(), "B2B")):
    rows = list(sess.execute(text(""" ... information_schema FK query ... """)))
    crossing = [r for r in rows if _crosses_boundary(r)]
    check(f"no FK crosses the boundary in the {side} database", not crossing, crossing)

# (e) Gaming Packages remain disabled (fail-closed flag).
from app.config import settings as _s
check("gaming packages flag is disabled by default",
      getattr(_s, "gaming_tour_packages_enabled", False) is False)
r = requests.post(f"{BASE}/api/customer/gaming-tour-enquiries", json={...minimal...})
check("public gaming enquiry endpoint is gated off", r.status_code in (403, 404, 503), r.status_code)
```
**Outage behaviours (operational tests, run in staging, not in the unit script):**
- *B2C outage does not affect B2B:* stop the B2C DB; assert merchant/admin B2B endpoints still 200 and B2C endpoints return a clean 5xx (no B2B read). 
- *B2B outage does not silently redirect B2C:* stop the B2B DB; assert B2C endpoints do not fall back to a B2B connection (they fail their own auth on B2B, by design, rather than reading B2B data through the B2C engine).

---

## 9. File-by-file implementation checklist

| File | Existing status | Proposed change | Dependencies | Risk |
|---|---|---|---|---|
| `backend/app/config.py` | exists [V:8] | add `customer_database_url`, pool settings, `effective_customer_database_url`; (gaming flag) | pydantic-settings | Low |
| `backend/app/database/customer_session.py` | **new** | B2C engine/session/dep/health (§2.1) | config, models_customer | Low |
| `backend/app/database/session.py` | exists [V] | **unchanged** (B2B) | — | None |
| `backend/app/models_customer.py` | exists [V] | **add** `CustomerAdminAuditLog` + enum (§4.1); keep `customer_audit_logs` as-is | B2C Base | Low |
| `backend/alembic_customer.ini` | **new** | B2C alembic config (§3.2) | — | Low |
| `backend/alembic_customer/env.py` | **new** | target `models_customer` metadata, B2C URL (§3.2) | config, models_customer | Med (baseline correctness) |
| `backend/alembic_customer/script.py.mako` | **new** | copy of existing mako | — | Low |
| `backend/alembic_customer/versions/0001_b2c_baseline.py` | **new** | hand-written baseline from §3.4 dump+reconcile | live schema dump | **High** (enums/sequence/defaults) |
| `backend/app/routers/customer_*.py` (13) | exist [V] | swap `get_db`→`get_customer_db` (§2.4) | customer_session | Med |
| `backend/app/routers/admin_*b2c*.py` (11) | exist [V] | two-session pattern + B2C audit (§2.3) | customer_session, audit svc | **High** |
| `backend/app/routers/{eticket,admin_chat,payment_webhooks,payment_returns,gaming_tour_enquiries}.py` | exist [V] | per-endpoint routing review (§2.4 MIXED) | — | **High** |
| `backend/app/services/customer_admin_audit_service.py` | **new** | `record(...)` writer to B2C (§4.2) | models_customer | Low |
| `backend/app/main.py` | exists [V:481] | add B2C startup health check (log-only) | customer_session | Low |
| `tests/verify_customer_portal.py` | exists [V] | two-session refactor + Stage-A asserts (§8) | both sessions | Med |
| `backend/app/models/**`, 6 legacy services | exist [V] | **no change** (quarantine = docs only, later) | — | None |
| `Dockerfile`/`render.yaml`/`deploy/` | exist | add `CUSTOMER_DATABASE_URL` env + run `alembic_customer` upgrade at deploy | infra | Med ([P] confirm §10) |

---

## 10. Final approval checklist — decisions still needed from you

1. **Audit table shape:** approve `customer_admin_audit_logs` (dedicated, §4.1) vs. extending `customer_audit_logs`. *(Recommended: dedicated.)*
2. **MIXED routers:** approve a per-endpoint review of `payment_webhooks`, `payment_returns`, `eticket`, `admin_chat`, `gaming_tour_enquiries` before any swap (Q3-related). **[P]**
3. **`payment_provider_events`:** confirm (via §6.6 + a short code trace) that **no B2B payment path** writes it, so it moves cleanly to B2C. **[NV/P]**
4. **Baseline source:** approve building the B2C baseline from a **live schema dump reconciled with models + migrations** (not `create_all`), to carry enums/sequence/defaults (§3.4). **[NV — needs a read-only dump]**
5. **Compatibility mode:** approve `effective_customer_database_url` fallback (keeps single-DB hosts working) and, in the split/"deployed" state, a config assertion requiring a distinct `CUSTOMER_DATABASE_URL`.
6. **Deploy wiring:** approve adding `CUSTOMER_DATABASE_URL` + a second `alembic_customer upgrade head` step to `Dockerfile`/`render.yaml`/`deploy/` (confirm entry points). **[P]**
7. **Live-DB verification window:** authorize a **read-only** run of the §6 queries (no writes) to turn the [NV] facts into verified ones before implementation.
8. **Gaming flag:** confirm it ships now (fail-closed) and stays disabled until you authorize activation.

---

## 11. Strict-restriction confirmation

No code modified · no configuration modified · no database object created · no migration generated or run · no data migrated · no git action · no deploy · no payment/refund initiated · Gaming Packages not enabled · no legacy model/record removed or renamed. **This document is specification text only.**

**Awaiting your explicit implementation approval. I will not write, change, or run anything until you give it.**
