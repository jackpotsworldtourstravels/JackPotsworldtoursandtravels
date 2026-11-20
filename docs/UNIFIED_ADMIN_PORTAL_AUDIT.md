# Unified Admin Portal — Codebase Audit (Phase 1 / Report Only)

**Project:** JackPots World Tours & Travels
**Scope of this document:** Stage 1 audit only. **No code, schema, config, migration, or git change was made.** This is the deliverable requested in the specification's "First Deliverable — Audit Report Only" section. Implementation is paused pending your explicit approval.
**Date:** 2026-11-12
**Method:** Direct inspection of actual source files. Every claim is tagged **[Verified]** (read in the repo, path/line given), **[Partial]** (evidence found but not exhaustively traced), or **[Not Verified]** (could not confirm in the time/scope of this pass).

---

## 0. Executive summary — read this first

Four findings dominate everything else:

1. **The "Unified Admin Portal with a B2B/B2C selector" already substantially exists.** `frontend/admin/index.html` (2,003 lines) already has a **B2B Management / B2C Management mode toggle** (`data-mode-toggle="b2b"` / `"b2c"`, separate `nav-mode-body` blocks that hide/show). The B2C side already wires sections for customers, bookings, refunds, reviews, communication, reconciliation, activity, catalogue (flights/hotels/packages), reports and analytics. **This is not a greenfield build. It is mostly an integration, completion and hardening job.** [Verified — `frontend/admin/index.html:92,108-355`]

2. **B2B and B2C share ONE physical database.** There is a single SQLAlchemy engine, a single `SessionLocal`, a single `database_url`, and a single Alembic migration chain. The spec's #1 requirement — "completely separate operational databases" with independent connection pools — is **not met today**. [Verified — `backend/app/database/session.py:6-7`, `backend/app/config.py:9`, `backend/alembic/env.py:20,35`]

3. **There IS deliberate logical model separation, just not physical.** `models_customer.py` declares its **own `Base`** (its own mapper registry), explicitly and on purpose — the module docstring says "THE SEPARATE `Base` IS THE POINT, NOT AN OVERSIGHT." B2B models live in `models_v2.py` under a different `Base`. So the ORM layer already keeps B2C and B2B apart; what is shared is the one Postgres database they both connect to. [Verified — `backend/app/models_customer.py:5-14,59`]

4. **Gaming packages are NOT strictly disabled, and the fail-closed flag the spec mandates does not exist.** There is no `GAMING_TOUR_PACKAGES_ENABLED` setting anywhere in the backend. A **public** enquiry endpoint `POST /api/customer/gaming-tour-enquiries` is live, `gaming-packages.html` is served, and admin gaming sections exist. Gaming is implemented as a **call-back enquiry queue only** (not a browsable/bookable catalogue), which is softer than "sold", but it is **not** the fail-closed, globally-disabled state the spec requires. [Verified — `backend/app/routers/gaming_tour_enquiries.py:36-47`, `frontend/admin/index.html:341-355`; absence confirmed by grep over `backend/app`]

**Bottom line:** The biggest real work is **(a)** deciding how literally to take "completely separate databases" (true physical split is a large, risky migration), and **(b)** completing/verifying the B2C admin modules that are already scaffolded, not rebuilding the portal. Recommendations are in §10.

---

## Report 1 — Repository Architecture [Verified unless noted]

```
TOURS AND TRAVEL/
├─ backend/                     FastAPI + SQLAlchemy + Alembic (Python)
│  ├─ app/
│  │  ├─ main.py                App assembly; ~60 include_router() calls (52 KB)
│  │  ├─ config.py              Pydantic settings — ALL feature flags live here (44 KB)
│  │  ├─ database/session.py    Single engine + SessionLocal + Base  ← one DB
│  │  ├─ models_v2.py           B2B model set (own Base) — "nine-table redesign"
│  │  ├─ models_customer.py     B2C model set (SEPARATE Base, on purpose)
│  │  ├─ models/                LEGACY v1 models (User/Flight/Hotel/Booking…) still imported
│  │  ├─ routers/               ~60 routers (B2B + B2C + public)
│  │  ├─ services/              Business logic (payments/, chat, refunds, reconciliation…)
│  │  ├─ schemas/               Pydantic request/response models
│  │  ├─ auth/                  rbac.py, deps.py, security.py, rate_limit.py
│  │  └─ integrations/          duffel/ (flights), hotelbeds/   ← NO tbo/ adapter
│  └─ alembic/versions/         95 migrations, single linear chain
├─ frontend/                    Static HTML/CSS/JS (no React build in the admin surface)
│  ├─ admin/index.html          ★ UNIFIED ADMIN SPA with B2B/B2C toggle (2003 lines)
│  ├─ super-admin/index.html    Super-admin surface (366)
│  ├─ manager/index.html        Manager portal (284)
│  ├─ merchant/ + merchant-classic/   Merchant (B2B customer) portals
│  ├─ customer/                 B2C customer dashboard/app
│  └─ *.html                    Public B2C marketing/booking site (index, flights,
│                               hotels, packages, gaming-packages, etc.)
├─ mobile-app/                  Expo/React Native app (per project memory)
├─ database/, deploy/, docs/, tests/, qa/, loadtest/, scripts/, uploads/
```

**Technology (confirmed from source, not assumed):** FastAPI, SQLAlchemy (`DeclarativeBase`, `Mapped`), Alembic, PostgreSQL (`postgresql+psycopg2`). Frontend admin is **server-served static HTML + vanilla JS modules**, not a React SPA bundle. [Verified — `backend/.env.example:3`, `backend/app/database/session.py:1-2`, `frontend/admin/index.html`]

**⚠️ Architecture risk — three model layers:** `app/models/` (v1: `User, Role, Flight, Hotel, TourPackage, Cruise, Booking, Payment`) is still imported by `admin_service.py`, `booking_management_service.py`, `inventory_service.py`; `models_v2.py` defines a *different* `User`/`Payment`; `models_customer.py` defines the B2C set. Which of the v1 classes still back live tables vs. which are legacy-dead needs a dedicated trace before any model work. **[Partial — imports verified at `backend/app/models/__init__.py:1-14`, `backend/app/services/admin_service.py:9-12`; live-vs-legacy status Not Verified]**

---

## Report 2 — B2B Implementation [Verified]

**Model set:** `models_v2.py` — `Merchant`, `User`, `ServiceRequest`, `Payment`, `PassengerData`, `MerchantServiceAccess`, `MsgLog`, `SystemLog`, `AuditLog`, `RequestDocument`, `GroupBookingImport`, `RequestNote`, `PaymentAccount`, `WalletTopup`, `WalletTransaction`, `Provider`, `ProviderUser`, `HotelEnquiry`, `TourPackageEnquiry`, `GamingTourEnquiry`, `PassportOcrExtraction`, … [Verified — `models_v2.py` class list]

**Routers (B2B surface):** `auth`, `super_admin`, `merchants`, `merchant_team`, `merchant_approvals`, `manager`, `manager_approvals`, `enquiries`, `hotel_enquiries`, `tour_package_enquiries`, `group_bookings`, `booking_ops`, `change_requests`, `finance`, `wallet`, `payment_admin`, `providers`, `dashboard`, `reports`, `admin_ops`, `support_tickets`, `tickets`, `messages`, `analytics`, `documents`, `passport_ocr`. [Verified — `main.py:313-429`]

**Workflows present (page/route/model exist):** merchant registration & approval, merchant service access toggles (`MerchantServiceAccess`), booking enquiry → quotation → booking request → manager approval, booking history/ops, wallet top-ups and transactions, provider management, passport OCR, audit logging, support tickets. [Verified — router + model + service all present]

**B2B admin UI** lives under the "B2B Management" toggle in `frontend/admin/index.html`: sections `users`, `active-users`, `ticket-enquiries`, `partner-requests`, `booking-ops`, `service-requests-mgmt`, `providers`, `manual-enquiry`, `manual-request`, `payments`, `wallet-desk`, `reports`, `analytics`, `audit`, `system-logs`, `support`, `live-support`, `notifications`. [Verified — `frontend/admin/index.html` nav]

**Not independently re-verified this pass:** that each workflow *functions end-to-end* (spec rightly warns against "a page exists = implemented"). Functional confirmation per module is a Stage-4 task. **[Not Verified — behaviour]**

---

## Report 3 — B2C Implementation [Verified structure / Partial completeness]

**Model set:** `models_customer.py` (separate `Base`) — `Customer`, `CustomerAuth`, `CustomerIdentity`, `CustomerProfile`, `CustomerSession`, `CustomerOtp`, `CustomerPasswordReset`, `CustomerAuditLog`, `CustomerTraveller`, `CustomerBooking`, … [Verified — `models_customer.py` class list]

**Customer-facing routers:** `customer_auth`, `customer_profile`, `customer_account`, `customer_travellers`, `customer_bookings`, `customer_hotel_bookings`, `customer_package_bookings`, `customer_recommendations`, `customer_destinations`, `customer_cancellations`, `customer_payment_admin`, `customer_chat`, `customer_assistant`, `eticket`, `public`. [Verified — `main.py:437-478`]

**B2C *admin* routers (already built):** `customer_admin`, `admin_customer_bookings` (`/api/admin/customer-bookings`), `admin_cancellations`, `admin_reconciliation`, `admin_reviews`, `admin_communication`, `admin_user_activity`, `admin_b2c_reports` (+ `analytics_router`), `admin_catalogue`, `admin_catalogue_hotels`, `admin_catalogue_packages`, `admin_catalogue_destinations`. [Verified — `main.py:396-416`]

**B2C admin UI (already scaffolded)** under "B2C Management": `b2c-customers`, `b2c-bookings`, `b2c-refunds`, `b2c-reviews`, `b2c-communication`, `b2c-reconciliation`, `b2c-activity`, `b2c-cat-flights`, `b2c-cat-hotels`, `b2c-cat-packages`, `b2c-cat-destinations`, `b2c-reports`, `b2c-analytics`, plus a nested gaming-enquiries queue. [Verified — `frontend/admin/index.html:270-355`]

**Reading of status:** B2C is the *more recently built* half and is **"implemented but requires verification"** across most modules — the routers, models and UI sections exist; what needs checking is data correctness, completeness of each action, and that the B2C admin reads only B2C data. **[Partial]**

---

## Report 4 — Database Architecture [Verified] ← most important section

| Item | Finding | Evidence |
|---|---|---|
| Number of physical DBs | **One** | `database/session.py:6` single `create_engine(settings.database_url)` |
| DB name | `jackpotsworldtours` (example) | `backend/.env.example:3` |
| Connection config | Single `database_url: str` | `config.py:9` |
| Engines / pools | **One** engine, one pool | `database/session.py:6` |
| Sessions | **One** `SessionLocal` | `database/session.py:7` |
| Migrations | **One** Alembic chain, 95 revisions | `alembic/env.py:20,35`; `alembic/versions/` |
| ORM registries | **Two** separate `Base`s (B2B `models_v2`, B2C `models_customer`) + a legacy `app/models` set | `models_customer.py:5-14,59` |
| Cross-DB FKs | N/A — single DB, so FKs *can* cross B2B↔B2C tables | design consequence, **[Partial]** — not exhaustively scanned |

**Verdict against spec §3:** The separate-`Base` design gives **logical isolation** (a B2C service can't accidentally map a B2B table), but all B2B and B2C tables live in **the same Postgres database reached through the same connection**. The spec's hard rules (#1 separate DB names/configs, #2 not one DB for both, independent pools, no shared connection) are **not satisfied**. Every other DB rule in §3.1 (no record copying, no fallback, no credential leakage) is *not currently violated* only because there is a single DB — there is nothing to leak between. [Verified]

**No passwords, keys or secrets are printed here, per instruction.**

---

## Report 5 — API → Database Mapping (representative) [Verified paths]

| Module | Env | Frontend | Backend API (prefix) | Service | DB | Status |
|---|---|---|---|---|---|---|
| Merchant mgmt | B2B | admin `users`/merchant | `routers/merchants.py` | `admin_merchant_service` | shared | Impl, verify |
| Service access | B2B | admin | `routers/merchant_approvals.py` | `admin_partner_service` | shared | Impl, verify |
| Booking ops | B2B | admin `booking-ops` | `routers/booking_ops.py` | `booking_ops_service` | shared | Impl, verify |
| Wallet | B2B | admin `wallet-desk` | `routers/wallet.py` | `wallet_service` | shared | Impl |
| Payments admin | B2B | admin `payments` | `routers/payment_admin.py` | `payment_admin_service` | shared | Impl |
| Providers | B2B | admin `providers` | `routers/providers.py` | `provider_service` | shared | Impl |
| Customer bookings (admin) | B2C | admin `b2c-bookings` | `routers/admin_customer_bookings.py` `/api/admin/customer-bookings` | — | shared (B2C tables) | Impl, verify |
| Cancellations/refunds | B2C | admin `b2c-refunds` | `routers/admin_cancellations.py` | `change_request_service` + payments | shared | Impl (maker-checker) |
| Reconciliation | B2C | admin `b2c-reconciliation` | `routers/admin_reconciliation.py` | reconciliation | shared | Impl |
| Catalogue (flights) | B2C | admin `b2c-cat-flights` | `routers/admin_catalogue.py` | `catalogue_flight_admin_service` | shared | Impl (no TBO) |
| Reviews | B2C | admin `b2c-reviews` | `routers/admin_reviews.py` | — | shared | Impl, verify |
| B2C reports | B2C | admin `b2c-reports` | `routers/admin_b2c_reports.py` | — | shared | Impl, verify |
| Gaming enquiries | B2C | admin gaming + public | `routers/gaming_tour_enquiries.py` | `gaming_tour_enquiry_service` | shared | **Live, not disabled** |
| Customer auth | B2C | login/register | `routers/customer_auth.py` | `customer_auth_service` | shared (B2C tables) | Impl |

Full table (all ~60 routers) can be produced on request; the above is the representative map proving the pattern. **[Partial — representative, not exhaustive]**

---

## Report 6 — Unified Sidebar: existing vs. proposed

**Reality:** the sidebar already exists with a B2B/B2C mode toggle. Mapping the spec's proposed items to what's already wired:

**B2B (spec item → existing section):** Dashboard→`reports`/`analytics` ✓ · Merchant Mgmt→`users`+merchant ✓ · Merchant Bookings/Enquiries/Requests→`booking-ops`,`ticket-enquiries`,`service-requests-mgmt`,`partner-requests`,`manual-*` ✓ · Payments→`payments`,`wallet-desk` ✓ · Suppliers→`providers` ✓ · Support→`support`,`live-support` ✓ · Reports→`reports`,`reports-export` ✓ · **Cancellations/Refunds (B2B), Flights/Hotels/Tour Packages catalogue (B2B), Staff Mgmt, Settings** → *not clearly present on the B2B side* → **develop/clarify**.

**B2C (spec item → existing section):** Dashboard→`b2c-analytics` ✓ · Bookings→`b2c-bookings` ✓ · Customers→`b2c-customers` ✓ · Cancellations/Refunds→`b2c-refunds`+`b2c-reconciliation` ✓ · Flights/Hotels/Holiday→`b2c-cat-*` ✓ · Suppliers→(uses B2B `providers`?) **clarify** · Support→(shared) · Reviews→`b2c-reviews` ✓ · Reports→`b2c-reports` ✓ · Staff Mgmt / Settings → **develop** · **Gaming → keep disabled** · **Activities & Tours → not present, pending approval**.

**Payments monitoring split (spec):** a dedicated B2C **Payments** section (separate from Refunds) is not obviously present on the B2C side — **develop/clarify**. **[Partial]**

---

## Report 7 — Required Changes (reuse vs build)

**Reuse (already there, keep):** the whole B2B portal & workflows; the B2B/B2C toggle shell; B2C admin routers & sections listed in Report 3; HDFC/TrustBrick/Razorpay payment stack; maker-checker refund + reconciliation; duffel flight adapter; chat/calling support stack; RBAC (`auth/rbac.py`).

**Build / complete:**
- **Database decision (biggest):** either (a) a true physical B2C database with its own engine/pool/migrations + per-request DB selection, or (b) a documented "logical separation on one DB" stance with enforced guards. This is a **go/no-go architecture decision for you** — option (a) is a large, risky migration touching every B2C model and all deploy configs.
- A real **`GAMING_TOUR_PACKAGES_ENABLED` fail-closed flag** gating the public page, the enquiry endpoint, admin sections, sitemap/SEO.
- B2C **Payments monitoring** section distinct from Refunds; **Staff Management** and **Settings** (environment-aware) on both sides.
- **Suppliers** page shared vs. per-environment decision; **TBO/TekTravels flight adapter** (currently unbuilt).
- Per-endpoint **environment-context enforcement** (spec §8 API isolation) if the DB split is pursued.
- Resolve the **three-model-layer** situation (legacy `app/models/`).

**Auth/permissions:** RBAC exists (roles `admin`, `manager`; permission codes; `require`/`require_role`). Spec's environment-scoped permissions (B2B-only / B2C-only / both) would be a **new permission dimension** on top of the existing matrix. **[Partial]**

---

## Report 8 — Dependencies & Risks

- **R1 (critical):** "Completely separate databases" taken literally = migrate all B2C tables to a new DB. High blast radius: every B2C service, deploy config, backup/restore, and the single Alembic chain. Must be staged and reversible. **Recommend deciding scope before any code.**
- **R2:** Three overlapping model namespaces → risk of editing the wrong `User`/`Payment`. Trace before touching models.
- **R3 (compliance vs spec):** Gaming is live as an enquiry queue; spec demands fail-closed disablement. Low-effort to fix, but currently **out of compliance**.
- **R4:** Production safety — do **not** run migrations, touch HDFC/TrustBrick config, or initiate real payments/refunds (spec §13, and consistent with project memory). OCR, OTP-email, demo-payment and `DEPLOYED` behaviours are controlled by server-side env and are invisible in git — changing them needs force-recreate on the host, not a code edit.
- **R5:** Single DB today means cross-environment joins/FKs are *possible*; a full scan for existing B2B↔B2C coupling is needed before claiming isolation. **[Not Verified — coupling scan not done]**

---

## Report 9 — Implementation Sequence (proposed, for approval)

Mirrors the spec's stages, re-ordered to reflect what already exists:

1. **Stage 1 (this doc):** audit. ← **awaiting your approval**
2. **Database decision workshop:** choose true-split vs. logical-split. *No code until decided.*
3. **Guard & flag quick wins:** add `GAMING_TOUR_PACKAGES_ENABLED` (fail-closed); add explicit environment-context assertions on B2C admin endpoints.
4. **B2C module verification pass:** confirm each already-built B2C admin section reads correct data and performs its actions (Reports/Bookings/Customers/Payments/Refunds).
5. **Fill gaps:** B2C Payments-monitoring section, Staff Mgmt, Settings (env-aware), Suppliers scope.
6. **Model cleanup:** resolve legacy `app/models/` vs `models_v2`.
7. **(If chosen) physical DB split:** second engine/session, per-request selection, independent migrations — staged, reversible, tested in isolation.
8. **Deferred by spec:** date-wise cancellation slabs; post-booking flight add-ons; Activities & Tours; TBO adapter — design first, implement only after approval.

Each stage to be independently testable; gaming stays disabled throughout.

---

## Report 10 — Final Recommendation

1. **One unified portal:** already present (`frontend/admin/index.html` B2B/B2C toggle) — **extend, don't rebuild.**
2. **Operational independence:** already real at the ORM layer (separate `Base`s). Strengthen with per-endpoint environment assertions.
3. **Connect both databases safely:** **this is a business/architecture decision you must make first.** My recommendation: treat the current separate-`Base`-on-one-DB as the baseline, and only move B2C to a physically separate database if a concrete requirement (compliance, scaling, tenancy) demands it — because the migration risk is high and the logical isolation already prevents accidental cross-mapping. Document whichever you choose.
4. **Preserve B2B:** no rewrite needed; integrate as-is.
5. **Complete B2C:** verification + gap-fill, not new-build.
6. **Environment sidebar:** exists; finish the missing sections and add environment-scoped permissions.
7. **Do first:** (a) the DB decision, (b) the gaming fail-closed flag, (c) B2C module verification pass.

---

### Verification ledger (honesty about limits)
- **[Verified]** single-DB architecture, separate-`Base` design, router inventory, admin B2B/B2C toggle, gaming live state, TBO-unbuilt, RBAC presence, 95 migrations.
- **[Partial]** per-module B2C completeness, full API table, environment-scoped permissions, sidebar gap list, legacy-model usage.
- **[Not Verified]** end-to-end behaviour of each workflow, exhaustive B2B↔B2C coupling scan, Redis/socket support-stack internals, mobile-app parity.

**STOP — no code, schema, migration, config, or git change will be made until you approve a scope.** Tell me which option you want for the database (logical vs. physical split) and I'll turn the approved stages into a concrete plan.
