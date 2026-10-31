# JackPots World — Audit Part B: Full Deliverable Set (2026-10-31)

Companion to `COMPETITOR_GAP_AUDIT_2026-10-31.md` (evidence limits, key findings, 25-row gap matrix). Audit and planning only. No source, commit, branch, PR, deploy, migration, AWS/env/payment change was made; the only files written are these two documents (uncommitted).

## 1. Executive summary

JackPots World is a mature, honest FastAPI monolith (60+ routers, 94 Alembic migrations, 1090 passing backend tests on SQLite) with real hotel and package catalogues, a provider-abstracted payment layer, RBAC with strict customer/partner token separation, chat + voice support and PDF documents. Versus Trip.com, Travala and MakeMyTrip, most visible gaps are supplier- or compliance-gated (live flights, maps, insurance, loyalty, crypto). The most important findings are internal:

1. Gateway refunds are never executed — "refunded" is an admin-set ledger status (`PaymentProvider.refund()` has no caller).
2. No CI exists; the suite is not a merge gate.
3. Production behaviour, Postgres migrations and the `tests/verify_*.py` integration scripts were not verified in this audit.

Recommendation: fix money movement and quality gates first (P0), then no-supplier conversion/retention work (P1/P2), then supplier-dependent services.

## 2. Existing feature inventory

| Area | Evidence | Status |
|---|---|---|
| Auth | JWT + refresh, OTP, Google; customer vs partner tokens mutually rejected | Implemented, needs live test |
| Customer account | profile, saved travellers (middle name), wishlist + notes, notifications, my-bookings | Implemented (unit-tested); migration 0093 not run on Postgres |
| Flights | Demo "Sample schedule"; Duffel adapter dormant behind flag; server-side pricing | Partially implemented |
| Hotels | DB catalogue, rooms/meal plans, tax quote, free-cancellation derivation, booking | Implemented (unit-tested) |
| Packages / tour enquiries / groups | DB catalogue, booking, B2C enquiry (0091), group bookings | Implemented |
| Gaming tours | enquiry-only | Partially implemented |
| Trains, buses, cabs, villas, visa | enquiry-only, labelled | Partially implemented |
| Payments | Razorpay, HDFC SmartGateway, TrustBrick; default `none`; verified webhooks, event dedupe, stale-pending reconcile | Implemented; live activation ops-gated |
| Refunds / cancellations | request → approve → refund_processing → refunded (admin-set); `refund()` unused | **Backend only (ledger)** |
| Admin | catalogue CRUD, bookings, cancellations, payments, reconciliation, reviews, B2C reports | Implemented |
| Partner / merchant | portal, wallet, approvals, team, service requests, reports | Implemented |
| Support | chat, WebRTC voice, tickets, assistant | Implemented, needs live test |
| Documents | confirmation, invoice, itinerary, vouchers, receipts, e-ticket verify | Implemented |
| Deploy | Dockerfile, Caddy, docker-compose, redeploy.sh, render.yaml; EC2 | Present |
| Tests | 1090 pytest, JS tests, ~30 `verify_*.py`, locust | Present, **no CI** |
| Loyalty, referral, price alerts, insurance policy, multi-currency, PWA/push | none | Not implemented |

## 3. Competitor comparison matrix

Y = observed on public homepage 2026-10-31 · L = login-gated / unverifiable · (prior) = from earlier benchmark; the MakeMyTrip fetch timed out this session · N = not seen.

| # | Capability | Trip.com | Travala | MakeMyTrip | JackPots |
|---|---|---|---|---|---|
| 1 | Search/discovery | Y (map, inspiration) | Y | (prior) Y | Partial (no map) |
| 2 | Flights | Y | Y | (prior) Y | Partial (demo) |
| 3 | Hotels/rooms | Y | Y | (prior) Y | Y |
| 4 | Villas/alt. stays | Y Homes | Y villas, apartments, holiday parks | (prior) Y | Enquiry |
| 5 | Packages | Y group/private tours | N | (prior) Y | Y |
| 6 | Tours/attractions | Y | Y | (prior) Y | Enquiry |
| 7 | Cars/transfers | Y | Y | (prior) Y | N |
| 8 | Visa | L | N | (prior) Y | Partial |
| 9 | Insurance | L | N | (prior) Y | Add-on label only |
| 10 | Accounts | L | Y My Trips | (prior) Y | Y |
| 11 | Saved travellers | L | L | (prior) Y | Y |
| 12 | Booking mgmt | L | Y | (prior) Y | Y |
| 13 | Payments | logos only | Y cards + 100+ crypto | (prior) Y | Built, off |
| 14 | Refund/cancel | L | Y best-price guarantee (stated) | (prior) Y | Ledger only |
| 15 | Coupons/loyalty | Y Rewards | Y AVA, credits, vouchers | (prior) Y | Coupons only |
| 16 | Reviews | L | L | (prior) Y | Y |
| 17 | Support | Y ~30s phone claim | Y 24/7 chat/email (stated) | (prior) Y | Chat + voice |
| 18 | Partner mgmt | Y supplier + affiliate | L | (prior) Y | Y |
| 19 | Admin/reporting | L | L | L | Y |
| 20 | Mobile | Y app | L | (prior) Y | Responsive web |
| 21 | SEO/content | Y | Y | (prior) Y | Y |
| 22 | AI/personalisation | Y Trip.Planner | N | (prior) partial | Rules + LLM |

Response-time promises, giveback rates and guarantees are competitors' own marketing and unverified.

## 4. Implementation gap matrix
See section 2 of `COMPETITOR_GAP_AUDIT_2026-10-31.md` (25 rows, every requested field).

## 5. Recommended architecture (extend, don't replace)

| Concern | Today | Recommendation |
|---|---|---|
| Backend/frontend | FastAPI monolith serving static HTML/JS | Keep; no SPA rewrite |
| DB/migrations | Postgres, Alembic to 0093 | Additive nullable migrations; each tested up AND down on Postgres in CI |
| API versioning | Unversioned `/api/...` | Don't retrofit a prefix; version only breaking changes (`/api/v2/<resource>`); document in `API_CONTRACT.md` |
| Suppliers | Duffel/Hotelbeds adapters behind flags | Reuse adapter + flag pattern for activities, cars, insurance; a fake supplier per adapter for tests |
| Payment abstraction | `PaymentProvider` base | Keep; wire refund execution through existing `refund()`; routing unchanged |
| Idempotency/webhooks | signature→parse→record-once→act; deferred sweep | Extend to refund webhooks; unique idempotency key per refund attempt |
| Booking lifecycle | `lifecycle.py` state machine | Keep; no new state without a transition test |
| Refund lifecycle | manual ledger | `refund_processing` only when provider accepts; `refunded` only on provider confirmation; add `refund_failed` + alert; separate approve vs execute permission |
| Permissions | RBAC + token scopes | Keep; role-matrix test generated from route list |
| Audit logging | `audit_service` | Audit row required on every money/status transition, tested |
| Background jobs | in-process tasks | No broker; DB outbox table + one polling worker for refunds/alerts/email (`redis_url` config exists if ever needed) |
| Caching/performance | HTML no-store, assets immutable, locust | Keep; add short-TTL in-process catalogue cache only if profiling shows need |
| Monitoring | `/api/health`, `/api/status`, basic logging | One error-tracking service; JSON logs; alerts on webhook signature failures, stale pending payments, refund_processing > 24h, 5xx rate |

## 6. Roadmap (effort in engineer-days, rough)

**P0 — Production safety and functional audit (~12–15 ed).** CI (pytest, JS tests, asset check, Postgres migration up/down); refund execution + reconciliation; migration 0093 on a Postgres copy; `verify_*.py` against staging with mocked providers; read-only prod smoke checklist; HDFC UAT (ops). Depends on: staging, HDFC creds, D1–D3. Risks: double refund, staging drift. Acceptance: CI required on `main`; sandbox refund reaches `refunded` only after provider confirmation and replay creates 0 extra refunds; migration up/down clean; every `verify_*.py` passes or has a triaged failure.

**P1 — Core booking and account (~15–20 ed).** PWA manifest/offline shell; loading/empty/failure states; saved searches; guest-to-account conversion; self-service cancellation with refund ETA; live flights behind a staging flag if D4 approved. Depends on: P0 refunds; Duffel contract. Risks: live-fare cost, ticketing rules. Acceptance: checkout completion baseline captured, then improvement target set from it; Lighthouse mobile ≥ 85 on key pages; zero "refunded" rows without a provider refund id.

**P2 — Hotel discovery, loyalty, reviews, partners (~20–30 ed).** Property-type/villa filter; map view (D5); verified-stay reviews; coupon scheduling and usage reports; loyalty ledger (only after D6); partner referral links. Depends on: maps key; finance sign-off. Risks: stored-value liability, GST, abuse. Acceptance: filter returns only the chosen type; only completed bookings can review; loyalty balance equals ledger sum (property test).

**P3 — Additional services and suppliers (~30–45 ed).** Activities, transfers/cars, visa status tracker, insurance via licensed partner, Hotelbeds activation. Depends on: contracts, licensed insurer. Risks: regulation, supplier SLAs. Acceptance: each service books end-to-end in supplier sandbox with voucher PDF; no policy shown without an insurer-issued number.

**P4 — AI, personalisation, analytics (~15–25 ed).** Grounded itinerary planner; recommendation tuning; funnel/cohort analytics; price alerts (needs live fares). Depends on: P1 live flights for alerts; event tracking. Risks: prompt injection, PII to LLM, hallucinated inventory. Acceptance: planner cites only catalogue IDs (automated check); PII-redaction test passes; dashboard counts match DB within 1%.

## 7. Testing plan

| Layer | Scope | Real / mocked |
|---|---|---|
| Unit | pricing, tax, coupon eligibility, lifecycle transitions, free-cancellation derivation, refund state machine | none |
| API integration | every router: happy / 401 / 403 / 422; role matrix generated from routes | SQLite fast; Postgres in CI |
| Database | migrations up/down on Postgres; uniqueness/constraints; backfill safety | Postgres |
| Frontend | existing JS tests; add checkout form, traveller picker, results filters; responsive checks | none |
| E2E booking | search→select→travellers→pay→confirm→documents for flight, hotel, package, enquiry | **mocked provider + fake supplier** |
| Payments | success, failure, pending timeout, duplicate callback, out-of-order callback, bad signature, amount mismatch, callback before return | **mocked provider; gateway sandbox for UAT only** |
| Refund/cancel | full, partial, none; double-click; replayed webhook; provider failure; refund-after-refund; cancel after ticketing | **mocked provider; sandbox once** |
| Roles/permissions | customer↔partner token rejection; IDOR on bookings, travellers, wishlist, documents; merchant scoping; maker-checker | none |
| Security | headers, rate limits, upload sniffing, JWT expiry/tamper, OTP brute force, injection/XSS probes, dependency and secret scans | staging only |
| Performance | locust: search, checkout, webhook burst; budget p95 < 500 ms for search | staging, never prod |
| SEO | canonical, JSON-LD validity, sitemap, OG (existing verify scripts) | none |
| Production smoke | read-only: `/api/health`, home, search renders, assets, TLS/headers, login page. **No bookings, no payments** | prod, read-only |

Must be mocked or sandboxed: all payment and refund calls, Duffel, Hotelbeds, email/SMS/OTP, LLM, maps.

## 8. Security and production risk register

| ID | Risk | Likelihood | Impact | Mitigation | Decision |
|---|---|---|---|---|---|
| R1 | Customer sees "refunded" but no gateway refund was sent | High | High | P0 refund execution + reconciliation; interim relabel/SOP | D1 |
| R2 | No CI; regressions reach prod | High | Med–High | P0 CI | D2 |
| R3 | Migration 0093 untested on Postgres | Med | High | Test on a copy first | D3 |
| R4 | Payment misrouting (prod default none + 12 pilot refs) | Low | High | Config allowlist test | — |
| R5 | Demo flights mistaken for real inventory | Med | High | Keep "Sample schedule" label until Duffel live | D4 |
| R6 | PII (passports, travellers) retention / DPDP | Med | High | Retention policy, encryption at rest, access logging | D7 |
| R7 | IDOR on documents/travellers | Low | High | Role/IDOR suite | — |
| R8 | LLM prompt injection / PII leakage | Med | Med | Grounding, redaction, no tool actions | — |
| R9 | Insurance sold without licence | Low if gated | High | Licensed partner only | D8 |
| R10 | Loyalty liability | Med | High | Finance sign-off first | D6 |
| R11 | Single EC2 host, no alerting | Med | High | Alerts, backups, restore drill | D9 |
| R12 | Webhook secrets/keys without rotation runbook | Low | High | Rotation runbook | — |
| R13 | Duplicate B2B/B2C coupon and review models drift | Med | Low–Med | Shared service layer | — |

## 9. Milestones and dependencies

| Milestone | Content | Depends on | Exit |
|---|---|---|---|
| M0 (wk 1) | Approvals D1–D3; staging + Postgres copy | you / ops | decisions recorded |
| M1 (wk 2–3) | CI + migration check + verify-script triage | M0 | CI green and required |
| M2 (wk 3–5) | Refund execution + reconciliation in sandbox | M1, gateway sandbox creds | R1 closed |
| M3 (wk 5–8) | P1 improvements; HDFC UAT sign-off | M2, ops creds | UAT evidence |
| M4 (wk 8–14) | P2 discovery/reviews/partners | M3, D5/D6 | acceptance tests pass |
| M5 (wk 14+) | P3 suppliers, P4 AI/analytics | contracts | per-service sandbox pass |

## 10. Decisions requiring your approval

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Build gateway refund execution; meanwhile relabel customer-facing "refunded" as "refund initiated"? | Yes, both |
| D2 | Add GitHub Actions CI and require it on `main` (repo setting change)? | Yes |
| D3 | Run migration 0093 up/down against a Postgres copy (never prod)? | Yes |
| D4 | Pursue live flights via Duffel (cost, ticketing obligations) or stay demo-labelled? | Business call |
| D5 | Buy a maps provider for result maps? | Defer to P2 |
| D6 | Build a loyalty/wallet programme (finance + GST sign-off)? | Defer |
| D7 | Define a data-retention policy for passport/traveller PII (DPDP)? | Yes, before P3 |
| D8 | Offer insurance only through a licensed insurer partner? | Yes, or skip |
| D9 | Approve an error-tracking vendor and alert channel? | Yes |
| D10 | Who provisions the staging environment? | You / ops |

I have not begun implementation and am waiting for your answers.
