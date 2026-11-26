# JackPots World — MakeMyTrip-style marketplace: Gap Analysis

**Date:** 2026-11-26
**Author:** Claude (Opus 4.8) · inspection phase
**Scope:** Compare the supplied ZIP (`JackpotsWorld_MMT_style_implementation.zip`) and the implementation note against the existing repository, then map the full gap to the stated objective (a complete, functional MMT-style platform with its own premium identity).

---

## 1. What the ZIP actually contains

The ZIP is a snapshot of `main` **plus a frontend-only change set**. Verified by recursive diff (excluding `.git`, caches, `uploads`).

**New files (11):**
| File | Lines | Purpose |
|---|---|---|
| `frontend/buses.html` `cabs.html` `trains.html` `villas.html` `forex.html` `insurance.html` | 95 ea. | Thin page shells; all content injected by JS |
| `frontend/assets/js/marketplace-services.js` | 261 | Shared preview shell: per-service search form, working client-side filter/sort over **hardcoded sample cards**, every card stamped `PREVIEW`, booking CTA → `/contact-us` |
| `frontend/assets/js/service-directory.js` | 34 | Renders the 11-service nav strip |
| `frontend/assets/css/marketplace-services.css`, `service-directory.css` | 171 | Styling for the above |

**Modified files (39):** all frontend. The substantive ones:
- `assets/js/jw-header.js` — adds 8 service links to the header nav.
- `assets/js/flight-filters.js` — adds a **Fare Type** facet (Regular/Student/Senior/Armed Forces/Corporate) rendered **disabled with an explanatory reason** until a supplier returns `fareCategory`.
- `assets/js/hotel-filters.js` — expands the hotel filter rail to the full MMT facet set (property type, brand, top locations, meal plan, room type, bed type, room amenities, room views, booking preferences, house rules, payment, deals, policies). **Every group the current search response can't supply is shown disabled with a specific "why" line.**
- The remaining ~35 HTML files + `site-footer.js` are nav/footer link propagation.

**No changes to:** backend, models, Alembic migrations, admin portal, payment, auth, or any test except `tests/verify_footer.py`.

### Verdict on the ZIP
It is an **honest, well-scoped UI-preview layer**, consistent with the repo's existing "honesty-by-schema" ethos: nothing fabricates live availability, Visa/Forex/Insurance are enquiry/handoff by design, and unsupported filters are disabled-with-reason rather than faked. It is a good **Phase 0 foundation** — but it is a presentation layer only. It delivers none of the real booking functionality, My Trips integration, admin control, or backend enforcement the objective calls for.

---

## 2. Existing platform capabilities (baseline, from the repo)

- **Backend:** FastAPI, PostgreSQL, Alembic (102 migrations, latest `0101`), 70+ routers, RBAC, B2B merchant portal + B2C customer surface.
- **Flights:** demo "sample schedule" served to customers; Duffel adapter dormant (no creds); **TBO flight adapter built behind a supplier switch** (PR #67, migration `0101`), blocked on sandbox hosts + IP whitelist. **Single-flight booking model** — `customer_bookings` = 1 flight/booking; multi-city & round-trip are structurally limited; round-trip payment already blocked.
- **Hotels:** real DB-backed catalogue + booking service; TBO hotel adapter built behind a switch; hotel DB not yet supplier-ready for structured property type/brand/room attributes.
- **Packages:** real DB-backed; Tour Package Enquiry flow merged (migration `0091`).
- **Payments:** TrustBrick, HDFC SmartGateway, Razorpay adapters all built and test-guarded; **none set as default** in prod; test-key guards merged + deployed (PR #37).
- **Service access control — B2B only:** `MerchantServiceAccess` / `ServiceCode` enum (`service_access_service.py`, migration 0045) governs **which products a merchant company may touch** — and the enum is limited to `FLIGHTS / HOTELS / VISA / HOLIDAYS`. This is **not** a customer-facing global service registry; it has no concept of buses/trains/cabs/villas/activities/forex/insurance, homepage visibility, nav order, maintenance mode, or per-service search/booking gating.

**Key takeaway:** there is **no customer-facing service registry** and **no admin service-management module**. Requirement 6 is effectively greenfield (the merchant table is a reference pattern, not a reusable mechanism).

---

## 3. Gap matrix — objective vs. current state

Legend: ✅ exists · 🟡 partial/preview · ❌ missing

### 3.1 Flights (requirement 3)
| Capability | State | Note |
|---|---|---|
| One-way | ✅ | demo schedule / TBO behind switch |
| Round-trip | 🟡 | structurally blocked (single-flight model) |
| Multi-city | ❌ | needs booking-model change |
| Airport autocomplete | 🟡 | verify current widget |
| Traveller/cabin selection | ✅ | |
| Fare categories | 🟡 | ZIP adds facet, **disabled until supplier data** |
| Time/stops/airline/price/duration/baggage/refundable filters | 🟡 | filter engine exists; coverage varies by result data |
| Fare family comparison | ❌ | |
| Seat selection | ❌ | |
| Meals & add-ons | 🟡 | meals partially done (per memory) |
| Traveller details / GST | ✅/🟡 | GST capture to confirm |
| Coupon & payment | ✅ | coupons rail + payment built |
| Confirmation & My Trips | ✅ | |

### 3.2 Hotels (requirement 4)
| Capability | State | Note |
|---|---|---|
| Search, autocomplete, rooms/guests, price | ✅ | |
| Full MMT filter rail | 🟡 | ZIP adds all facets **disabled-with-reason**; needs backend data to enable |
| Property type/brand/neighbourhood/room attrs/views/house rules | ❌ (data) | `HotelSearchResult` + supplier mapping must return these |
| Photos/videos, map, room comparison | ❌/🟡 | |
| Cancellation/inclusions/price breakdown | 🟡 | |
| Coupons & checkout | ✅ | |

### 3.3 New services (requirement 5) — all 🟡 **preview-only** in the ZIP
Buses · Trains · Cabs · Villas & Homestays · Tours & Attractions · Visa · Forex · Travel Insurance.
Each has search + filters + sort + sample cards + detail dialog + contact handoff. **None** has: real search, real results, detail page, customer-info capture, price breakdown, booking/handoff record, confirmation, or My Trips integration. Holiday Packages already has a real backend (reuse, don't rebuild).

### 3.4 Admin Service Management (requirement 6) — ❌ **greenfield**
Needed: per-service enable/disable, customer-facing + homepage visibility, nav order, provider management, integration status, maintenance mode, audit logs. Plus **enforcement**: disabled service → gone from nav, search + new-booking endpoints reject, existing bookings stay accessible.

### 3.5 Cross-cutting (requirements 7–8)
Preserve FastAPI/PG/Alembic/models/auth/RBAC/payments/workflows; no duplicate tables; tests for every change; visual QA with real screenshots vs. mockups at desktop + mobile.

---

## 4. Proposed phased implementation plan

**Phase 0 — Adopt the ZIP foundation** (low risk): bring in the 11 new + 39 modified frontend files, verify nav/footer/filter honesty renders, screenshot desktop+mobile. *This is the only part the ZIP delivers; everything below is new build.*

**Phase 1 — Service registry + Admin Service Management (foundation, requirement 6).** New `service_registry` table + Alembic migration (customer-facing services, enum covering all 11), admin CRUD + audit log, enforcement middleware (nav feed, search/booking gating, existing-booking exemption), maintenance mode. This gates every other service, so it comes first. Tests.

**Phase 2 — Flights depth (requirement 3):** fare families, seat map, add-ons, GST, round-trip/multi-city (requires booking-model work — largest single item). Preserve TBO/booking engine.

**Phase 3 — Hotels depth (requirement 4):** extend `HotelSearchResult` + supplier mapping + admin catalogue to populate the disabled facets, detail/rooms/comparison/photos/map. Enable filters only as data lands.

**Phase 4 — Real service experiences (requirement 5):** promote preview services to real flows where a supplier/workflow exists; keep the rest as labelled enquiry/handoff with a persisted enquiry record + My Trips entry (no fake availability).

**Phase 5 — Visual QA (requirement 8):** run locally, screenshot every page desktop+mobile, compare to mockups, fix.

---

## 5. Honesty & safety guardrails (non-negotiable, per requirement 9 + repo ethos)
- No fake live availability; preview ≠ real API — keep the `PREVIEW` stamps and enquiry handoffs until a contracted supplier is wired.
- Every visible filter/button/dropdown must do something real or be visibly disabled with a reason (the ZIP already models this well).
- Keep supplier credentials server-side; no new secrets in frontend.
- Don't break production integrations (payments, TBO switches, booking workflows).
- Clearly label implemented vs. preview vs. production-ready at every step.

---

## 6. Open decisions for the user
1. **Start point / priority:** begin at Phase 1 (admin service registry — the backbone), or lead with Phase 2/3 (flights/hotels depth) for faster visible value?
2. **Scope of "real" for Phase 4 services:** which, if any, have a contracted supplier now? Absent one, they stay enquiry/handoff.
3. **Multi-city flights:** confirm appetite for the booking-model change (touches `customer_bookings`), the single largest item.
