# Phase 1 — Global Admin Service Registry (complete)

**Date:** 2026-11-26 · **Status:** Implemented. Full backend suite green — **3000 passed, 33 skipped, 0 failed** (includes the 31 new Phase 1 tests; two pre-existing drift guards for the new service URLs were resolved in `main.py` / `public.py`).

The architectural backbone: one customer-facing service registry with full admin control and backend enforcement. Built end-to-end (model → migration → API → enforcement → admin UI → dynamic customer nav → tests), not UI-only.

## Requirement coverage
| # | Requirement | How |
|---|---|---|
| 1 | Central customer-facing service registry | `ServiceRegistry` model + `service_registry` table |
| 2 | All travel services | Seeded 11: flights, hotels, villas, packages, trains, buses, cabs, activities, visa, forex, insurance |
| 3 | Admin enable/disable | `enabled` master switch, `PATCH /api/admin/services/{code}` + admin UI toggle |
| 4 | Homepage visibility + nav ordering | `home_visible`, `nav_visible`, `nav_order` + `POST /api/admin/services/reorder` + UI move up/down |
| 5 | Maintenance mode | `maintenance_mode` + `maintenance_message`; search/booking refused 503, nav flags it |
| 6 | Provider + integration readiness | `provider` + `integration_status` (live/preview/enquiry/coming_soon) |
| 7 | Enforce in search + booking APIs | `require_service_available(code)` dependency on flight/hotel/package **search + create** |
| 8 | Preserve `merchant_service_access` | Untouched; new table is a separate global B2C concern (documented in both models) |
| 9 | Preserve existing bookings when disabled | Gate sits ONLY on search + new-booking create; pay/cancel/view/reconcile/resend never call it |
| 10 | Role-based permissions + audit logs | New scopes `b2c.services.view` / `b2c.services.manage`; every write → `CustomerAdminAuditLog` (fail-closed) |
| 11 | Dynamic customer navigation | `GET /api/services` feed; `service-directory.js` fetches it (static fallback for resilience) |
| 12 | Migrations + comprehensive tests | Migration `0102`; 31 tests (service layer, RBAC, audit, public feed, enforcement gate) |

## Files
**Backend**
- `backend/app/models_customer.py` — `ServiceRegistry` model
- `backend/alembic/versions/0102_service_registry.py` — table + seed of all 11 services (all enabled)
- `backend/app/services/service_registry_service.py` — CRUD, public feed, `availability`/`assert_available`/`require_service_available`
- `backend/app/schemas/admin_services.py` — `ServiceRow`, `ServiceUpdate`, `ServiceReorder`, `PublicServiceRow`
- `backend/app/routers/admin_services.py` — `/api/admin/services` (list, patch, reorder)
- `backend/app/routers/public.py` — `GET /api/services` public feed
- `backend/app/auth/rbac.py` — `B2C_SERVICES_VIEW` / `B2C_SERVICES_MANAGE` scopes
- `backend/app/main.py` — registers `admin_services.router`; adds the 6 new service pages (villas/trains/buses/cabs/forex/insurance) to `LEGACY_HTML_REDIRECTS` so their clean URLs (now in `sitemap.xml`) resolve and their `.html` addresses 301
- Enforcement added to `customer_bookings.py`, `customer_hotel_bookings.py`, `customer_package_bookings.py`
- `backend/app/routers/public.py` — `GET /api/services` is rate-limited (60/min), satisfying the public-route drift guard

**Frontend**
- `frontend/assets/js/service-directory.js` — now registry-driven (fetch `/api/services`, static fallback)
- `frontend/assets/css/service-directory.css` — maintenance badge styles
- `frontend/admin/index.html` — Service Management nav item + panel + script include
- `frontend/assets/js/admin-b2c-services.js` — admin desk module
- `frontend/assets/js/admin.js` — section title, reload-on-visit, init dispatch
- (Phase 0 foundation also adopted: the ZIP's 6 new service pages + marketplace shell + nav/footer updates)

**Tests**
- `backend/tests/test_service_registry_service.py` — service layer + enforcement (16)
- `backend/tests/test_admin_services_http.py` — RBAC, audit, public feed, booking gate (15)

## Design decisions
- **Enforcement fails OPEN** when a service row is missing or the table is absent (half-applied migration), so a registry problem never takes a working production flow offline. Disabled/maintenance states (rows present) still fail closed.
- **Audit via `CustomerAdminAuditLog` only** (not the B2B `system_logs`/`log_change`), matching the B2C reviews-moderation precedent; `record_in_session` is fail-closed, so no registry change lands unaudited.
- **Integration status is honest** — `live` only for the three real engines (flights/hotels/packages); preview/enquiry for the rest. No fake inventory introduced.
- **`code` is immutable** (keys enforcement + the frontend icon map); schema `extra="forbid"` rejects attempts to change it.

## Pending / not in Phase 1
- **Live visual QA** of the admin screen + dynamic nav against the mockups (deferred to the plan's Phase 5 QA; logic verified by tests). Requires a running stack with Postgres.
- **Enforcement on preview services** (buses/trains/etc.) is moot today — they have no real booking endpoints (enquiry/handoff only). When Phase 4 gives any a real flow, add the same `require_service_available` gate.
- Migration `0102` has been **verified to import/compile and pass tests on SQLite**; run its up/down on a disposable Postgres before deploy (consistent with the repo's migration-verification practice).

## Next
Phase 2 (Flights depth) → Phase 3 (Hotels depth) → remaining services, per `docs/MMT_MARKETPLACE_GAP_ANALYSIS.md`.
