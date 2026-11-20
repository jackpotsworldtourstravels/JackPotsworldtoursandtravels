# B2B / B2C Logical Separation — Final Implementation Specification

**Project:** JackPots World Tours & Travels
**Date:** 2026-11-12
**Status:** **SPECIFICATION ONLY — NOTHING EXECUTED.** No code, database, configuration, migration, or git file has been modified. All code blocks are *proposed contents for review*.
**Decision implemented by this spec:** one PostgreSQL database; B2B and B2C logically separated inside it. **No second database, engine, connection pool, session factory, or Alembic history is introduced.**
**Parent:** `docs/B2C_LOGICAL_SEPARATION_PLAN.md` (approved direction).

**Evidence tags:** **[SRC-V]** verified in repo (path:line) · **[GAP]** required but **not present in code today** · **[NV]** needs Stage B read-only DB query.

---

## 1. Complete table inventory (final)

The authoritative per-table inventory is `B2C_LOGICAL_SEPARATION_PLAN.md` §5. Confirmed totals, re-verified from the three `__tablename__` sets [SRC-V]:

| Layer | Base | Count | Status |
|---|---|---|---|
| B2B operational | `models_v2.Base` | **26** | all live |
| B2C operational | `models_customer.Base` | **47** (46 `customer_*` + `payment_provider_events`) | all live |
| Legacy v1 | `app/models/*` Base | **39** mappings (36 legacy-only physical tables + 3 dead mappers over live B2B `users`/`payments`/`service_requests`) | dead at code level |
| Shared-infra | — | **1** (`alembic_version`) | one migration history |

**Distinct physical tables (code-derived): ≈ 110.** `op.create_table` appears across 32 migration revisions [SRC-V], consistent with the three layers; the **exact live table set is [NV]** (Stage B §8 query). The model layer is authoritative for *ownership*; Stage B confirms *existence and row data*.

**Completeness guarantee:** every table owned by a live domain is declared in `models_v2.py` (B2B) or `models_customer.py` (B2C). Any table in neither, but present in the DB, is either legacy (`app/models/`) or an artefact to classify in Stage B — never silently "shared".

---

## 2. Ownership of ambiguous & public-facing tables (resolved from source) [SRC-V]

| Router | Imports | Domain | Tables touched | Notes |
|---|---|---|---|---|
| `payment_webhooks.py` | `get_db`, `payment_event_service`, `payments` providers | **B2C** | `payment_provider_events` (+ customer payment tables via the event service) | Provider callback. No `models_v2` import. Uses the single `get_db` — correct under one DB. [SRC-V:45-47] |
| `payment_returns.py` | `from app.models_customer import …`, `payment_event_service` | **B2C** | `customer_*` + `payment_provider_events` | Browser return URL from provider. [SRC-V:40,48] |
| `eticket.py` | `from app.models_customer import Customer`, `get_current_customer`, `customer_booking_service` | **B2C** | `customer_bookings`, `customers` | Both owner + public routers are B2C. [SRC-V:14,18-21] |
| `public.py` | `email_service` + schemas only | **Infra / stateless** | **none** | Landing contact form; sends email, writes **no** DB model. Does **not** touch legacy `contact_us`/`newsletter`. [SRC-V:7-16] |
| `gaming_tour_enquiries.py` | `from app.models_v2 import GamingTourEnquiry` (via service) | **B2B** | `gaming_tour_enquiries` | Stays B2B; must be gated off (§7). [SRC-V:6] |

**`payment_provider_events` ownership — final:** **B2C.** No B2B payment service (`payment_admin_service`, `finance_service`, `payment_management_service`) references it in source [SRC-V]. Its writers are all B2C: `payment_event_service`, `trustbrick_provider`, `customer_payment_admin_service` (+ read in `payment_verification_service`). Row-level confirmation = [NV] (Stage B §9).

**Public-facing legacy tables** (`contact_us`, `newsletter`, `reviews`, `wishlist`, etc.) are **not written by any live router** [SRC-V]; the live contact form is email-only. They remain Legacy/unused · data = [NV]. **Not assumed deletable.**

---

## 3. Independent B2B and B2C backend permission scopes

### 3.1 Current mechanism [SRC-V `auth/rbac.py`]
A three-role B2B model: effective permissions are the union of portal-role defaults, merchant sub-role defaults, and explicit codes in the `users.permissions` JSONB array (which replaced the dead `permissions`/`role_permissions` tables). `UserRole.CUSTOMER` holds `frozenset()` — "retail customers are out of scope" of RBAC; B2C customers authenticate through a **separate** `auth/customer_deps.get_current_customer` [SRC-V `eticket.py:14`]. B2C **admin** endpoints today authenticate with `get_current_admin` (B2B identity) but there is **no permission code distinguishing "may manage B2C" from "may manage B2B"** [GAP].

### 3.2 Proposed scopes (dedicated namespaces, no new table — codes live in the existing JSONB array)
- **B2B scopes:** the existing `rbac.py` codes (unchanged) — e.g. `booking.view`, `merchant.manage`, `wallet.manage`, `provider.manage`, `finance.*`.
- **B2C admin scopes (new `b2c.*` namespace):** `b2c.bookings.view`, `b2c.bookings.manage`, `b2c.cancellations.manage`, `b2c.refunds.approve`, `b2c.reviews.moderate`, `b2c.communication.send`, `b2c.catalogue.manage`, `b2c.customers.view`, `b2c.reconciliation.view`.
- **Enforcement:** a dependency `require_scope("b2c.<x>")` (extends the existing permission check) on every B2C-admin endpoint; the existing B2B codes guard B2B endpoints. A B2B-only admin (no `b2c.*`) → **403** on B2C-admin endpoints; a B2C-only admin (no B2B codes) → **403** on B2B endpoints.
- **Admin Portal selector mapping:** the environment selector shows B2B and/or B2C based on which scope families the logged-in admin holds; `super_admin` holds both. This is UI gating over the same enforced scopes — never the sole guard.

---

## 4. Separate administrative audit logging

### 4.1 Three distinct trails (no cross-domain writes)
| Trail | Table | Base | Purpose | Change |
|---|---|---|---|---|
| B2B actions | `audit_logs` | models_v2 | B2B/merchant admin actions | unchanged |
| B2C customer self-service | `customer_audit_logs` | models_customer | customer's own actions | unchanged |
| **B2C admin actions** | **`customer_admin_audit_logs`** (new) | models_customer | B2B-identity admin acting on B2C data | **new** |

### 4.2 New model (proposed, on the B2C `Base`; added to `models_customer.py`)
Admin identity stored as a **snapshot value, no FK to `users`** — keeping the two domains decoupled even within one DB. Columns: `id`, `admin_user_id` (BigInteger, no FK), `admin_email`/`admin_name`/`admin_role` (snapshot), `environment='b2c'`, `action`, `record_type`, `record_id`, `previous_value`/`new_value` (JSONB, secrets excluded), `reason`, `outcome` (enum success/failure), `ip_address`, `created_at` (tz-aware, server default now); indexes on `admin_user_id`, `(record_type, record_id)`, `created_at`.

### 4.3 Writer + migration
- New `backend/app/services/customer_admin_audit_service.py` → `record(db, admin, action, record_type, record_id, previous, new, reason, outcome, ip)`. Uses the **same `get_db` session** (one DB).
- Invoked by B2C-admin endpoints; **replaces** the current cross-domain write where `admin_cancellations._audit()` writes B2B `audit_logs` while operating on B2C refund tables [SRC-V `routers/admin_cancellations.py:77`].
- Ships as **one additive revision in the existing `alembic/`** (next after `0094`). No `alembic_customer/`.

---

## 5. Automated cross-business access-prevention tests

Extend `tests/verify_customer_portal.py` and add a focused pytest module. Assertions:

1. **Import boundary (static, `ast`):** no B2C router imports `models_v2`; no B2B router imports `models_customer`; the only permitted seam is a B2C-admin router importing `get_current_admin` for identity. Fails the build otherwise.
2. **No cross-`Base` FK (within the one DB):** every FK on a `customer_*` table references a `customer_*` table, and no `models_v2` table FKs into `customer_*` (and vice versa).
3. **Permission isolation (runtime):** a B2B-only admin token → 403 on a representative B2C-admin endpoint; a B2C-scoped token lacking B2B codes → 403 on a representative B2B endpoint.
4. **Audit routing:** a B2C-admin mutation writes `customer_admin_audit_logs` and adds **zero** rows to B2B `audit_logs`.
5. **Single-DB invariant:** assert exactly one engine / one `SessionLocal` / one `get_db` is defined (guards against a regression that reintroduces a second session). **Drop** the obsolete "distinct engine URL" assertion from the physical-split spec.

---

## 6. Legacy-model quarantine plan (no deletion, no rename)

1. **Leave in place:** `app/models/` (39 mappings) and the six dead services (`admin_service, booking_management_service, catalog_items, payment_management_service, pricing_service, inventory_service`) — untouched. [SRC-V: imported only by each other; sole live importer is `alembic/env.py`]
2. **Document as dead:** add a `backend/app/models/README.md` and module docstrings marking the layer quarantined (doc-only, a later approved step).
3. **Keep Alembic registration** (`alembic/env.py:8 from app.models import *`) — removing it would change B2B autogenerate behaviour; out of scope.
4. **Duplicate names** (`users`, `payments`, `service_requests`): the live mapper is `models_v2`; the legacy mapper is dead over the same physical table. No action beyond documentation.
5. **Gate any retirement on Stage B** read-only row-count + recent-write scan — **nothing is deleted or renamed under this spec.**

---

## 7. Gaming Packages fail-closed — **REQUIREMENT NOT YET MET** [GAP]

**Verified current state [SRC-V]:**
- `backend/app/config.py` has **no** gaming setting (no `gaming_tour_packages_enabled`).
- `backend/app/routers/gaming_tour_enquiries.py` has **no** flag/gate; the public `POST /api/customer/gaming-tour-enquiries` is documented "Public. No session required." and the admin endpoints are active.
- `main.py:326` registers `gaming_tour_enquiries.router` → **the endpoints are reachable today.** Any "disabling" is frontend-only.

**Conclusion:** the fail-closed requirement is **currently NOT satisfied at the backend.** Required work (proposed):
1. `config.py` — add `gaming_tour_packages_enabled: bool = False`.
2. `gaming_tour_enquiries.py` — gate the public submit + all admin endpoints behind the flag; return **503/404** when off.
3. Frontend — hide `gaming-packages.html`, the admin sidebar entry, and remove from `sitemap.xml`/`robots.txt`.
4. **Preserve** the `gaming_tour_enquiries` table and any rows (no delete). `GamingTourEnquiry` stays on the B2B `Base`.
5. Stays disabled until you explicitly authorize activation.

---

## 8. File-by-file implementation sequence (proposed — nothing executed)

| # | File | Change | New? | Risk |
|---|---|---|---|---|
| 1 | `backend/app/config.py` | add `gaming_tour_packages_enabled: bool = False` | edit | Low |
| 2 | `backend/app/routers/gaming_tour_enquiries.py` | gate public + admin endpoints (503/404 when off) | edit | Low |
| 3 | `frontend/gaming-packages.html`, `frontend/admin/index.html`, `sitemap.xml`, `robots.txt` | hide gaming surfaces | edit | Low |
| 4 | `backend/app/auth/rbac.py` (+ `auth/deps.py`) | add `b2c.*` permission codes + `require_scope` dependency | edit | **Med** (authorization) |
| 5 | `backend/app/routers/admin_*b2c*` + `customer_admin.py` | apply `require_scope("b2c.*")` per endpoint | edit | **Med** |
| 6 | `backend/app/models_customer.py` | add `CustomerAdminAuditLog` + outcome enum | edit | Low |
| 7 | `backend/app/services/customer_admin_audit_service.py` | `record(...)` writer (same `get_db`) | **new** | Low |
| 8 | `backend/app/routers/admin_cancellations.py` (+ other B2C-admin) | route admin audit to `customer_admin_audit_logs` | edit | **Med** (replaces cross-domain write) |
| 9 | `backend/alembic/versions/0095_customer_admin_audit.py` | additive migration in existing history | **new** | Low |
| 10 | `backend/app/models/README.md` + docstrings | quarantine documentation | **new/edit** | None |
| 11 | `tests/verify_customer_portal.py` + new pytest module | cross-access + permission + audit tests (§5) | edit/new | Med |

**Not touched (preserved):** `database/session.py`, `get_db`, the engine/pool, `alembic/env.py`, `models_v2.py` schema, HDFC/TrustBrick/Duffel config, all `customer_*` router session wiring (they keep `get_db`). **No `customer_session.py`, no `alembic_customer/`, no `CUSTOMER_DATABASE_URL`.**

---

## 9. Workflows requiring regression testing

**B2B (must stay unchanged):** admin/staff login + RBAC; merchant onboarding/approval; service-request/ticket lifecycle; manager & merchant approvals; wallet top-up + transactions; finance/payment-admin; providers; group bookings; hotel/tour-package enquiries; passport OCR; documents; messages/notifications.

**B2C (must stay unchanged):** customer signup/login/OTP/password-reset; flight/hotel/package quote→book→cancel; cancellations + refund attempts; customer payments (HDFC UAT, TrustBrick pilot routing); payment webhooks + return URLs; e-ticket (owner + public); chat/assistant/voice; catalogue admin (hotels/packages/destinations); reviews/communication/user-activity/reconciliation admin.

**Cross-cutting (new behaviour to test):** B2B↔B2C permission isolation (403s); admin audit lands in `customer_admin_audit_logs` only; Admin Portal environment selector shows the right sidebar per scope; Gaming endpoints return 503/404 when the flag is off.

**Payment preservation:** HDFC config untouched; TrustBrick `payment_provider_events` writes intact; Duffel untouched; **no real payment/refund** in any test.

---

## 10. Preservation & restriction confirmation

Preserved: B2B merchant operations · B2C customer operations · HDFC gateway · TrustBrick pilot routing · Duffel · booking & refund workflows · customer authentication. Single database connection architecture preserved — **no second database, engine, pool, session factory, or Alembic history.** Gaming Packages remain disabled until you authorize (and §7 flags that the backend gate must still be built).

No code modified · no configuration modified · no database object created or altered · no migration generated or run · no data moved · no legacy model/table/record deleted or renamed · no git action. **This document is specification text only.**

**Awaiting your explicit approval to begin implementation. I will not write, change, or run anything until you give it.**
