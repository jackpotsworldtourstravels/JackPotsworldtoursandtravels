# Admin Portal Assessment — 5. Completion Scorecard & Prioritized Roadmap

**Date:** 2026-11-13 · Read-only. **This is a static code-evidence scorecard.** A screen scores on whether its backend stack exists and implements the actions its UI implies — NOT on runtime behaviour, UX correctness, or live-DB verification. Treat percentages as "implemented in code," with the explicit caveats below.

## Methodology
Each active screen scored: **Complete = 1.0**, **Partial = 0.5**, **Missing = 0.0**, **By-design-limited = 1.0** (counts as done because the limit is intentional). Gaming is excluded (intentionally disabled). `profile` counted once (shared). Score = Σ / (number of screens).

## B2B scorecard (18 screens)
All 18 scored **Complete** on code evidence (doc 3): Dashboard, Merchants, Active Users, Booking Enquiries, Approval Queue, Booking Operations, Service Request Mgmt, Providers, Manual Booking, Payment Mgmt, Wallet Desk, Reports Export, Analytics, Audit Logs, System Logs, Support, Notifications, Profile.
**B2B score = 18.0 / 18 = ~100% code-present.** Adjusted for "not runtime-verified + pre-existing supplier-reservation test failures": **~92% confidence-adjusted.**

## B2C scorecard (16 active screens)
| Screen | Score |
|---|---|
| Bookings, Cancellations&Refunds, Reviews, Live Chat/WiFi, Customer Payments, Reconciliation, User Activity, Catalogue Hotels, Catalogue Packages, Catalogue Destinations, B2C Reports, B2C Analytics | 12 × 1.0 |
| Catalogue Flights (by-design status-only) | 1.0 |
| Customers (view-only; no block/reset) | 0.5 |
| Communication (read-only; no send) | 0.5 |
| B2C Admin Audit trail (code-complete, undeployed) | 0.5 |
**B2C score = (13 + 1.5) / 16 = 14.5 / 16 = ~91% code-present.** Confidence-adjusted for the undeployed audit table + view-only customer mgmt + read-only comms + no runtime/DB verification: **~82%.**

## Overall
- **Code-present:** B2B ~100%, B2C ~91% → weighted overall **~95%** (the portal is largely built).
- **Confidence-adjusted (honest):** B2B ~92%, B2C ~82% → overall **~87%**.
- **Deployment-adjusted for B2C audit (the one feature that is inert until a DB migration runs):** B2C effective **~78%** until 0095 is applied.

### Caveats that cap these numbers
1. **Static only** — no screen was driven in a browser; no endpoint hit against a live DB this assessment.
2. **The B2C admin audit system is not deployed** — migration 0095 unexecuted, so that feature is code-only.
3. **44 pre-existing backend test failures** (`test_token_revocation`, `test_admin_supplier_reservation_http`) are unrelated WIP but mean two areas aren't green.
4. Completion ≠ production-ready (see Stage 2F §12: production-readiness is NOT claimed).

## Prioritized development roadmap
Ordered by value/risk. Each item maps to the gap list (doc 3) and the earlier tracks.

### P1 — Make the built B2C audit feature real (Track A)
Apply migration `0095` + the DBA grant/revoke on the single Postgres DB; verify the append-only trigger and the `record_independently`/WebSocket paths live; decide retention durations. *Why first: the feature is fully built and tested but inert until this runs — highest value-for-effort.* Requires DB-execution approval.

### P2 — Close the B2C functional gaps (small, high-value)
- **Customer management actions**: add block/unblock/status/reset-password endpoints to `customer_admin` (audited via the Stage-2 writer).
- **Communication send**: add an admin→customer notification/message endpoint to `admin_communication` (audited).
*Why: these turn two view-only screens into operational ones; low risk, reuses existing audit/permission plumbing.*

### P3 — Admin Portal scope-gated navigation (Track B)
Filter the sidebar by the logged-in admin's `b2c.*` grants so B2B-only admins don't see unusable B2C items; add the cross-domain CI guard + `verify_customer_portal.py` Stage-2 assertions. *Why: UX + defence-in-depth; backend already enforces, so this is polish not a security fix.*

### P4 — Operational provisioning
Grant the appropriate `b2c.*` scopes to the admins who should have B2C access (data step, no migration); confirm the super-admin seed is the only all-access account. *Why: Stage 1 made B2C access explicit; existing admins need grants to keep working.*

### P5 — Legacy verification & cleanup (Track C + residuals)
Run the long-pending **read-only** legacy-table scan (needs a read-only DB account — still blocked on provisioning one; do not use the `postgres` superuser). Remove the cosmetic gaming web residuals (`packages.html` footer, `booking-card.js` search tab). *Why: lower urgency; the legacy cluster is dead at code level and gaming is functionally disabled.*

### P6 — (New candidate, not previously scoped) Screening/compliance
There is no KYC/AML/sanctions screening module (doc 3, domain table). If the business needs it, it is net-new work — scope separately.

## Recommendation for "Stage 3"
The highest-leverage Stage 3 is **P1 + P2**: deploy the already-built B2C audit system (P1, needs your DB-execution approval) and close the two small B2C functional gaps (P2, pure local dev). That converts the most "built-but-not-usable" value into working features with the least new risk. P3–P6 follow once P1/P2 land. Final scope is yours to set.

---
*Assessment documents: 01 Screen Inventory · 02 Traceability Map · 03 Gap Analysis · 04 Access & Permissions · 05 Scorecard & Roadmap (this file). All read-only; no code/DB/config changed; Gaming disabled.*
