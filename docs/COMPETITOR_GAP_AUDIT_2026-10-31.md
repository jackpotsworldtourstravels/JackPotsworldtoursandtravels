# JackPots World — Competitor Gap Audit & Architecture (2026-10-31)

Builds on `COMPETITOR_BENCHMARK.md` (10-26) and `COMPETITOR_AUDIT_2026-10-27.md`; does not repeat them.
Original strategy only — no competitor branding, code or designs are to be copied.

## 0. Evidence and its limits

| Source | What was done | Limit |
|---|---|---|
| Repo (this worktree, HEAD `8d04f5a`) | Read module/route/model layout, payment + cancellation services, config flags, tests, deploy files | Not every file read; statuses below are from code reading + suite result, not live clicking |
| Tests | `pytest backend/tests` on SQLite: **1090 passed** (14 warnings) | SQLite, not Postgres; `tests/verify_*.py` integration scripts **not run** (need server + creds) |
| Production site | **Not browsed** this session | Live behaviour of jackpotsworldtours.com is **Cannot verify** here |
| Travala, Trip.com | Public homepage fetched | Homepage only; no login, no checkout |
| MakeMyTrip | Homepage fetch **timed out** | MMT column relies on the prior benchmark and is marked *(prior doc)* |
| Competitor internals (APIs, inventory, loyalty maths, support SLAs) | — | **Cannot verify** — require login or are private |

Publicly observed this session: **Travala** — hotels plus villas/apartments/cruises/holiday parks, flights, car rental, activities; cards + 100+ cryptocurrencies; AVA rewards (advertised 2% giveback on accommodation/activities), best-price guarantee, travel credits/promo vouchers, language/currency selector, "My Trips" dashboard, 24/7 chat/email. **Trip.com** — Hotels & Homes, Flights, Flight+Hotel, Cars, Attractions & Tours, Cruises, private/group tours, an AI "Trip.Planner", Rewards, supplier/affiliate programmes, currency/language selectors, an advertised ~30-second phone-answer promise, app download.

## 1. Findings that change priorities (new vs. earlier docs)

1. **Provider refunds are never executed.** `PaymentProvider.refund()` exists in `services/payments/base.py` and HDFC documents a refunds endpoint, but no code path calls `.refund(`. `customer_cancellation_admin_service.py` states refunds are recorded as an admin ledger status (`refund_processing → refunded`) — money is returned manually. Customers can see "refunded" without the gateway having refunded. **Highest-risk gap.**
2. **No CI.** There is no `.github/` directory and no test step in `Dockerfile` or `render.yaml`. The 1090-test suite only runs when someone runs it.
3. **Two parallel schema generations** (`models/`, `models_v2.py`, `models_customer.py`) with overlapping concepts (`Coupon`/`CustomerCoupon`, `Review`/`CustomerReview`, `Wishlist`). Not wrong (B2B vs B2C by design) but a drift risk for any cross-cutting feature.
4. **Loyalty/referral: zero code** (no matches for loyalty/referral/reward in `backend/app`). **Price alerts / saved searches: zero code.** Insurance exists only as a ₹899 add-on line in `customer_catalog_service.py` — no insurer, policy or claims.
5. Strengths confirmed: idempotent, signature-verified webhooks; cancellation request workflow with admin states; RBAC and token-scope separation; honest supplier labelling; PDFs; chat + voice support.

## 2. Gap matrix

Status key: **IV** implemented & verified · **IT** implemented, needs testing · **P** partial · **FO** frontend only · **BO** backend only · **NI** not implemented · **CV** cannot verify.
"IV" is used only where the 1090-test run exercises the logic; nothing is IV end-to-end against production.
Complexity S/M/L. Priority P0 now · P1 next · P2 later · P3 defer.

| # | Feature | Competitor ref | JackPots today | Status | Backend change | Frontend change | DB | Third party | Security / compliance | Cx | Pri | Acceptance |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Search & discovery | All: unified search, inspiration, map (Trip) | Unified BookingCard, destination pages, facets, recommendations; no map | P | Expose lat/lng in search payload; fuzzy ranking | Map toggle on results | none (lat/lng exist) | Maps API (paid) | Key restricted by referrer | M | P2 | Map pins match list, filters sync |
| 2 | Flights | All three | Demo "Sample schedule"; Duffel adapter dormant; server-side pricing | P (demo) | Enable Duffel in staging; PNR, fare rules, multicity | Multicity UI, fare-rule panel | PNR/ticket fields | Duffel contract | PCI-adjacent, ticketing T&Cs, IATA rules | L | P1 (business gate) | Live search→book→ticket in sandbox; demo label removed only when live |
| 3 | Hotels & room selection | All | Real DB catalogue, rooms, meal plans, tax quote, trust-badge derivation | IV (logic) / IT (live) | Pagination/perf review | Filters polish | none | Hotelbeds optional | Content licence if synced | S | P2 | Live smoke with test account |
| 4 | Villas / alt. accommodation | Travala, Trip (Hotels & Homes) | Enquiry-only villas | NI (search) | Add `property_type` filter | Type chips | column on hotels | Supplier or own inventory | — | M | P2 | Filter returns only villas |
| 5 | Holiday packages | MMT, Trip | Real DB catalogue, enquiry/quote flow, booking | IV (logic) | — | — | — | — | — | — | — | Keep |
| 6 | Tours & attractions | Trip, Travala (activities) | `activities.html` enquiry-led | P / FO-ish | Catalogue + booking mirror of packages | Listing/detail | new `activities` tables | Viator/GYG or own | Supplier terms | L | P2 | Bookable activity with voucher |
| 7 | Car rentals & transfers | Travala (new), Trip | Enquiry-only | NI | Enquiry→supplier quote | — | — | Car supplier | — | L | P3 | — |
| 8 | Visa assistance | MMT, Trip | `visa.html` + enquiry | P | Document checklist + status tracker | Status page | status table | — | Passport data retention (DPDP) | M | P2 | Customer sees application status |
| 9 | Travel insurance | MMT, Trip | ₹899 add-on line only | P (label, no policy) | Insurer API, policy issuance | Plan picker | policy table | Insurer (IRDAI-licensed partner) | **Regulated product — must not sell without licensed partner** | L | P3 | Policy PDF from insurer |
| 10 | Customer accounts | All | OTP + Google, profile, activity, notifications | IV (logic) | — | — | — | — | — | — | — | Keep |
| 11 | Saved travellers | All | Done incl. middle name, picker, prefill (0093) | IT | **Run migration 0093 up/down on Postgres** | — | — | — | PII at rest | S | **P0** | Up/down clean on Postgres |
| 12 | Booking management | All | `my-bookings`, change requests, e-ticket verify | IV (logic) | — | — | — | — | — | — | — | Keep |
| 13 | Payment methods | Travala (crypto, 100+), MMT UPI | Razorpay, HDFC, TrustBrick built; default `none`; prod has 12 pilot refs | IT | Activate HDFC UAT | — | — | Gateway creds | PCI SAQ-A scope via hosted page | S (ops) | P0 | UAT evidence signed off |
| 14 | **Refunds & cancellations** | All; Travala best-price guarantee | Request workflow + admin ledger; **no gateway refund call** | **P — BO ledger only** | Call `provider.refund()` on `start_refund`, store `provider_refund_id`, handle async refund webhook, idempotency key, partial refunds | Show real refund state/ETA | `refund_attempts` table | Gateway refund API | Money movement; double-refund guard; maker-checker approval | M | **P0** | Sandbox refund reaches `refunded` only after provider confirms; replay is a no-op; failure leaves `refund_processing` + alert |
| 15 | Coupons & loyalty | Travala AVA, Trip Rewards, MMT | Coupons (two models); no loyalty | P / NI | Coupon admin scheduling + usage report; loyalty ledger later | Wallet widget | points ledger | — | Stored-value liability, GST, abuse | M / L | P2 / P3 | Coupon limits enforced; loyalty needs finance sign-off |
| 16 | Reviews & ratings | All | Reviews + moderation (0090) | IT | Verified-stay gate | Photos | — | — | UGC moderation, defamation | S | P2 | Only completed bookings can review |
| 17 | Customer support | Trip (30s phone promise) | Chat, WebRTC voice, tickets | IT | SLA metrics | — | — | TURN server | Call recording consent | S | P2 | SLA dashboard |
| 18 | Agent / partner management | Trip supplier/affiliate | Merchant portal, wallet, approvals, team, commission | IV (logic) | Affiliate/referral links | — | referral table | — | KYC, TDS | M | P2 | — |
| 19 | Admin ops & reporting | All | Admin, manager, super-admin, ops, reconciliation, B2C reports | IV (logic) | Refund reconciliation vs gateway | Report | — | — | RBAC audit | S | P1 | Daily gateway↔ledger diff |
| 20 | Mobile experience | App stores | Responsive web; `verify_responsive.py`; no app/PWA | P | Web-push endpoint | Manifest + service worker | push subscription | — | Push consent | M | P2 | Lighthouse PWA pass |
| 21 | SEO / destination content | All | Canonical, JSON-LD, OG, sitemap | IT | Sitemap regeneration job | Content pages | — | — | — | S | P2 | Search Console clean |
| 22 | AI / personalisation | Trip.Planner | Rules+optional LLM assistant, recommendations | P | Itinerary generation grounded on catalogue | Planner UI | — | LLM API | Prompt-injection, PII to LLM | M | P2 | Plan only cites catalogue items |
| 23 | Price alerts / saved searches | Trip, MMT | None | NI | Needs live fares | — | alerts table | Duffel | Email consent | M | P3 (supplier-gated) | — |
| 24 | Multi-currency / language | Travala, Trip | None | NI | Currency display layer | Selector | — | FX feed | Display vs charge currency | L | P3 | — |
| 25 | CI / quality gates | — | None | NI | — | — | — | GitHub Actions | Secret scanning | S | **P0** | PR blocked on pytest + JS tests + asset-version check |

## 3. Priority list

**P0 (before more features)**
1. Gateway refund execution + reconciliation (#14, #19).
2. CI pipeline (#25) — pytest, `node` tests in `tests/js` and `frontend/tests`, stale-asset check.
3. Postgres up/down run of migration 0093 (#11).
4. HDFC UAT activation — ops only (#13).

**P1** Live flights via Duffel once contract exists (#2).
**P2** Villa filter, activities, visa tracker, PWA/push, verified reviews, AI planner, coupon admin.
**P3** Insurance, loyalty, cars, multi-currency, price alerts.

## 4. Proposed architecture (extend, don't replace)

Keep the FastAPI monolith, Postgres, static frontend served by the app, Caddy/EC2 edge and the provider-abstraction pattern. Add:

- **Refund service** inside `services/payments/`: `RefundAttempt` row (idempotency key, provider id, status) driven by the existing `PaymentProvider.refund()` seam; webhook handler extends `payment_webhooks.py`; admin "approve" and "execute" kept as separate permissions.
- **Outbox/worker** (single process, DB-backed, e.g. a table polled by an existing scheduler) for refunds, price alerts, push and email — avoids introducing a broker.
- **Supplier seam** already exists for flights (`flight_supplier_service`) and hotels; apply the same adapter shape to activities, cars and insurance rather than new subsystems.
- **Loyalty** only as an append-only ledger table, after finance/compliance sign-off.
- **CI**: GitHub Actions running pytest (SQLite) plus a Postgres job that runs `alembic upgrade head` / `downgrade -1`.
- Consolidate duplicated B2B/B2C coupon and review concepts behind services, not by merging tables.

## 5. Not done / caveats

No live site test, no Postgres run, no `verify_*.py` run, MMT not freshly observed, no code changed. Statuses marked "IV (logic)" mean unit-tested logic, not production-proven.
