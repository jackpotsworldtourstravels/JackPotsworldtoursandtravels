# JackPots World — Competitor Benchmark, Gap Analysis & Roadmap

**Date:** 2026-10-26  ·  **Branch:** `claude/jackpotsworld-competitor-analysis-184569`
**Competitors benchmarked:** Trip.com, Travala, MakeMyTrip

> Scope note on honesty. The competitor columns below describe **publicly
> observable** product features of the three sites, from their public web
> flows and published help/docs. They do **not** describe private APIs,
> authenticated internals, pricing contracts or inventory sources, which are
> not inspectable. Where a competitor capability is inferred rather than
> directly confirmed it is marked *(assumed)*. The JackPots column is grounded
> in a direct read of this repository on the date above.

---

## Phase 1 — Audit of the existing platform

### Architecture (verified from the repo)

| Area | Finding |
|---|---|
| Backend | **FastAPI** monolith (`backend/app/main.py`), ~421 Python modules, 60+ routers, 92 Alembic migrations. Schema v2 (nine-table) port tracked in `/api/status`. |
| Frontend serving | **Served by the app itself in production** via `CleanUrlStaticFiles` — nginx-style `try_files` (`/login` → `login.html`), dynamic routes (`/destination/{slug}`, `/hotels/{dest}/{loc}`, `/package/{id}`, `/ticket/verify/{token}`), and deliberate cache policy (HTML `no-store`, versioned assets `immutable`). This **is** the clean-URL routing fix referenced in the brief — present and merged. |
| Frontend | Static HTML + vanilla JS + CSS, component-ish via shared JS (`booking-card.js`, `search-widgets.js`, `HeroShell`, `booking-flow.js`). Portals: customer, admin, manager, merchant, super-admin, operations. |
| Database | PostgreSQL via SQLAlchemy. B2B (users/merchants/service-requests) and B2C (`customer_*` tables) are separated by token scope, not convention. |
| Payments | Provider abstraction (`services/payments/`): Razorpay, **HDFC SmartGateway** (UAT-ready), **TrustBrick** partner, mock. Default `none`. Verified webhooks, idempotency, deferred-event sweep + stale-pending reconcile. |
| Suppliers | **Duffel** (flights) and **Hotelbeds** (hotel content) adapters built; both **dormant** behind config flags. |
| Auth | JWT access/refresh, OTP second factor, Google identity, strict scope separation (customer vs merchant/admin tokens mutually rejected). |
| Security | Security headers middleware + Caddy edge headers, HSTS at TLS edge, rate limiting (slowapi), upload magic-byte sniffing, identity scans never statically mounted. |
| SEO | Canonical tags + verification tests **merged** (PR #22). Sitemap/robots present. |
| Notifications | In-app notifications, email (SMTP), live chat + WebRTC voice calls, travel AI assistant (rules-based default, optional LLM). |
| Deploy | Dockerfile, `deploy/Caddyfile` (prod edge) + nginx alternative, `render.yaml`, EC2. Health at `/api/health`, port status at `/api/status`. |
| Tests | ~30 `tests/verify_*.py` integration scripts (~29k LOC) + `backend/tests/` pytest suite (~20 modules) + 1 JS test. |
| Git | Clean working tree; canonical SEO work merged; clean-URL routing live. |

### What is genuinely live vs demo/dormant (the honesty picture)

- **Flights** — `demo` supplier by default; sample schedule generated client-side and **labelled "Sample schedule"** in the UI. Duffel adapter dormant (needs token + `FLIGHT_SUPPLIER=duffel`). Pricing/seat authority already moved server-side so a real supplier drops in behind one seam.
- **Hotels** — **real** admin-managed DB catalogue (JPH###### refs). Hotelbeds dormant (no creds).
- **Packages** — **real** admin-managed DB catalogue (JPP###### refs).
- **Trains / buses / cabs / villas / visa / gaming tours** — **enquiry-only, honestly labelled**; they route to enquiry forms, not fake searches.
- **Payments** — `none` by default → honest "no payment taken" notice. HDFC blocked only on ops credentials, not code.

**Conclusion:** this is a mature, honest, production-grade platform. The majority of mainstream competitor features already exist in some form. The opportunity is **targeted polish, transparency surfacing and retention mechanics that need no new supplier contract** — not a redesign or a clone.

---

## Phase 2 — Competitor feature comparison matrix

Legend — Status: ✅ present · ◑ partial · ○ absent · ⚑ enquiry-only (honest).
Priority: P0 (now) · P1 (next) · P2 (later) · P3 (reject/defer). Complexity: S/M/L.

### A. Design & UX

| Feature | Trip.com | Travala | MakeMyTrip | JackPots | Value | Cx | Dependency | Priority | Action |
|---|---|---|---|---|---|---|---|---|---|
| Unified home search widget | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Destination discovery shelves | ✅ | ✅ | ✅ | ✅ | Med | — | none | — | keep |
| Result sort (price/duration/time) | ✅ | ✅ | ✅ | ✅ (flights/hotels/packages) | High | — | none | — | keep |
| Result filters (facets) | ✅ | ✅ | ✅ | ✅ (`flight-filters`, `hotel-filters`, package facets) | High | — | none | — | keep |
| Map view of results | ✅ | ✅ | ✅ | ○ | Med | L | maps provider ($) | P2 | defer |
| Loading skeletons / empty states | ✅ | ✅ | ✅ | ◑ | Med | S | none | **P1** | improve |
| Accessibility (labels/focus/kbd) | ◑ | ◑ | ◑ | ◑ | High | M | none | **P1** | improve |
| Property photos/reviews/amenities | ✅ | ✅ | ✅ | ✅ | High | — | catalogue | — | keep |

### B. Flights

| Feature | Trip | Travala | MMT | JackPots | Value | Cx | Dependency | Priority | Action |
|---|---|---|---|---|---|---|---|---|---|
| One-way/round/multicity | ✅ | ◑ | ✅ | ◑ one-way demo | High | M | **Duffel live** | P1 | improve when live |
| Pax & cabin selection | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Airline/stop/time/price filters | ✅ | ◑ | ✅ | ◑ | High | S | none | **P1** | improve |
| Baggage/fare rules/cancellation | ✅ | ◑ | ✅ | ◑ | High | M | Duffel live | P1 | improve when live |
| Transparent fare breakdown | ✅ | ✅ | ✅ | ✅ itemised, server-authoritative | High | — | none | — | keep |
| PNR / airline ref | ✅ | ◑ | ✅ | ○ (demo) | High | — | Duffel live | P2 | defer |
| Flight status / disruption alerts | ✅ | ○ | ✅ | ○ | Med | L | status feed ($) | P3 | defer |
| Price alerts / saved searches | ✅ | ○ | ✅ | ○ | Med | M | Duffel live | P2 | defer |

### C. Hotels

| Feature | Trip | Travala | MMT | JackPots | Value | Cx | Dependency | Priority | Action |
|---|---|---|---|---|---|---|---|---|---|
| Dest/dates/rooms/guests search | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Property types (villa/homestay…) | ✅ | ✅ | ✅ | ◑ ⚑ villas | Med | — | supplier | P2 | defer |
| Price/rating/amenity/location filters | ✅ | ✅ | ✅ | ◑ | High | M | none | **P1** | improve |
| Verified reviews + photos + map | ✅ | ✅ | ✅ | ◑ reviews ✅, map ○ | High | M | maps ($) | P2 | partial |
| Room/occupancy/meal plans | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Free cancel / pay-at-property | ✅ | ✅ | ✅ | ◑ policy shown | High | S | supplier terms | P1 | improve |
| Taxes/fees total before pay | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Confirmation/cancel/refund tracking | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |

### D. Packages & experiences

| Feature | Trip | Travala | MMT | JackPots | Value | Cx | Dependency | Priority | Action |
|---|---|---|---|---|---|---|---|---|---|
| Domestic/international packages | ✅ | ◑ | ✅ | ✅ | High | — | none | — | keep |
| Themed (honeymoon/pilgrimage/…) | ◑ | ○ | ✅ | ✅ | High | — | none | — | keep |
| Custom itinerary / quote request | ◑ | ○ | ✅ | ✅ ⚑ | High | — | none | — | keep |
| Activities / sightseeing | ✅ | ✅ | ✅ | ◑ ⚑ | Med | — | supplier | P2 | defer |
| Airport transfers / cabs | ✅ | ○ | ✅ | ⚑ | Med | — | supplier | P2 | defer |
| Train / bus | ○ | ○ | ✅ | ⚑ | Med | — | supplier | P2 | defer |
| Visa assistance | ✅ | ○ | ✅ | ✅ ⚑ | Med | — | none | — | keep |
| Travel insurance / forex | ✅ | ○ | ✅ | ○ | Low | — | partner | P3 | defer |

### E. Payments & trust

| Feature | Trip | Travala | MMT | JackPots | Value | Cx | Dependency | Priority | Action |
|---|---|---|---|---|---|---|---|---|---|
| Multiple payment methods | ✅ | ✅ (+crypto) | ✅ | ✅ built | High | — | gateway creds | P0(ops) | activate |
| Idempotent / secure checkout | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Confirm only after verified pay | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Refund / cancellation workflow | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Invoices / receipts / itineraries | ✅ | ✅ | ✅ | ✅ PDF | High | — | none | — | keep |
| Support / contact / assistance | ✅ | ✅ | ✅ | ✅ chat+voice | High | — | none | — | keep |
| Clear policies & disclosures | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |

### F. Loyalty, promotions, personalisation

| Feature | Trip | Travala | MMT | JackPots | Value | Cx | Dependency | Priority | Action |
|---|---|---|---|---|---|---|---|---|---|
| Coupons / promo codes | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Referral campaigns | ✅ | ✅ | ✅ | ○ | Med | M | none | P2 | consider |
| Loyalty points / travel credits | ✅ | ✅ (AVA) | ✅ | ○ | Med | L | **business + compliance** | P3 | defer |
| Wishlist / saved trips | ✅ | ✅ | ✅ | ✅ | Med | — | none | — | keep |
| Price alerts / notifications | ✅ | ○ | ✅ | ◑ notifs | Med | M | Duffel live | P2 | defer |
| Personalised recommendations | ✅ | ◑ | ✅ | ✅ | Med | — | none | — | keep |
| AI travel planning | ✅ | ◑ | ◑ | ✅ rules+LLM | Med | — | none | — | keep |
| Multicurrency / multilingual | ✅ | ✅ | ◑ | ○ | Med | L | justified? | P3 | defer |

### G. Business operations & administration

| Feature | Trip | Travala | MMT | JackPots | Value | Cx | Dependency | Priority | Action |
|---|---|---|---|---|---|---|---|---|---|
| Booking management + status history | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Customer & support management | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Supplier / agent management | ✅ | ✅ | ✅ | ✅ merchant+provider | High | — | none | — | keep |
| Commission / reconciliation | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Coupons / campaigns admin | ✅ | ✅ | ✅ | ◑ | Med | — | none | P2 | improve |
| Refund approvals + audit logs | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Sales/conversion analytics | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| RBAC | ✅ | ✅ | ✅ | ✅ | High | — | none | — | keep |
| Error monitoring / ops reporting | ✅ | ✅ | ✅ | ◑ logs | Med | M | monitoring ($) | P2 | consider |

---

## Phase 3 — Product strategy

The platform already matches competitors on the hard parts (secure payments,
booking state machine, admin, support, honest supplier labelling). The leverage
is therefore **conversion and trust at the result/checkout surface**, not new
verticals. Applying each competitor's lesson within our means:

- **Trip.com → discovery & result clarity.** Bring sort + facet filters to the
  same bar on *all three* result surfaces (flights have the most today; hotels
  and packages less). No supplier needed — filters operate on data we already
  return.
- **MakeMyTrip → Indian workflow & checkout confidence.** Our enquiry-labelled
  trains/buses/cabs are the right honest shape; the win is finishing HDFC
  activation (ops) and making the **fare breakdown fully transparent** before Pay.
- **Travala → transparent, low-liability incentives.** Adopt the *transparency*,
  not the token economy. Coupons already exist; a rupee-denominated future-credit
  or referral is a P2 business decision, explicitly **not** crypto/points
  liabilities (the brief forbids these without compliance sign-off).

---

## Phase 4 — Implementation roadmap

> Reality check after audit: fare transparency, result sort/filters, honest
> supplier labelling and SEO canonical are **already implemented and strong**.
> They are listed as "keep", not work. The genuinely remaining safe, no-supplier,
> testable increments are narrower than a typical greenfield gap list:

- **P1 Structured-data (JSON-LD) coverage** — extend the existing schema.org
  markup (present on index/flights/hotels/packages/about/contact/faqs/gaming)
  to the indexable pages in `sitemap.xml` that still lack it. *Additive, no
  behaviour change, no supplier; verifiable with a sitemap-driven test that
  mirrors `verify_canonical.py`.* **Recommended first increment.**
- **P1 Accessibility pass** (form labels, visible focus, keyboard nav on the
  booking card and result cards). *No supplier. M. Needs per-page verification.*
- **P2 Loading skeletons + richer empty/error states** where still thin.
- **P0 (ops) HDFC activation** — code is UAT-ready; needs real creds + public
  HTTPS host. *No code. Business/ops.*

### Stage 2 — Growth & retention (next)
- Coupons/campaigns admin polish (P2).
- Referral programme (P2, business sign-off).
- Rupee travel-credit *only* with finance/compliance approval (P3).
- Booking-status notifications richer (P2).

### Stage 3 — Advanced platform (later; each needs a contract/cost)
- Duffel live flights → multicity, PNR, baggage/fare rules, price alerts.
- Hotelbeds live content + map view (maps provider).
- Multicurrency/multilingual (only if a real market justifies it).
- Error monitoring / APM (paid).

Each Stage-3 item is gated on a third-party contract or paid API and is **not**
implementable as "safe, scoped" work today.

---

## Phase 8 — Deliverables index (pointers)

1. **Comparison matrix** — Phase 2 above.
2. **Audit of features & gaps** — Phase 1 above.
3. **Prioritised roadmap** — Phase 4 above.
4. **Implemented features & reasons** — see the "Implementation log" section,
   appended as work lands (first increment: transparent fare breakdown).
5. **Deferred features & dependencies** — every ⚑ / P2 / P3 row names its
   supplier/cost/compliance dependency.
6. **Files changed & migrations** — per increment in the log.
7. **Test commands & results** — per increment in the log.
8. **Perf/a11y/security/SEO notes** — SEO canonical merged; a11y is a Stage-1
   item; security posture strong (headers, RBAC, verified webhooks).
9. **Deploy & rollback** — unchanged; Docker + Caddy. Each increment is a
   focused, revertable commit on this branch.
10. **Still-needs-manual** — HDFC/Razorpay live creds, Duffel token, Hotelbeds
    creds, maps key, any loyalty/referral business + compliance approval.

---

## Implementation log

### 1. Structured-data (JSON-LD) coverage for all indexable pages — 2026-10-26

**Why.** On-page structured data is the other half of the SEO surface all three
benchmarked competitors carry (the canonical work shipped the first half). Eight
pages already had a JSON-LD block; the discovery and policy/support pages in the
sitemap did not, so they could not qualify for rich results. This is additive
`<head>` markup only — **no behaviour, API, schema or payment change** — and no
supplier/credential is involved.

**Files changed (12):**
- `frontend/destinations.html`, `activities.html` — `CollectionPage`
- `frontend/visa.html` — `WebPage` + `Service` (visa assistance)
- `frontend/customer-support.html` — `ContactPage` + `ContactPoint`
- `frontend/payment-security.html`, `image-credits.html`, `privacy-policy.html`,
  `terms-and-conditions.html`, `cancellation-refund-policy.html`,
  `cookie-policy.html`, `disclaimer.html` — `WebPage`
- `tests/verify_structured_data.py` — **new** sitemap-driven test (stdlib only)

Scope note: the dynamic product pages (`/destination/{slug}`, `/package/{id}`,
`/hotels/{dest}/{loc}`) are **not** in `sitemap.xml` and are deliberately out of
scope here — their structured data would be client-rendered from API data and is
a separate, larger effort.

**Migrations:** none.

**Test command & result:**
```
python tests/verify_structured_data.py   # PASS: 19 indexable pages, valid schema.org JSON-LD
python tests/verify_canonical.py          # PASS (regression): canonical unaffected
```
The new test found and this change fixed one real pre-existing gap
(`image-credits.html`, indexable but had no structured data).

**Rollback:** revert the single commit; the markup is isolated to `<head>` and
removing it returns each page to its prior bytes.

### 2. Open Graph + Twitter card completeness — 2026-10-26

**Why.** Shared links build their preview from Open Graph tags. Two indexable
pages (`activities`, `visa`) had **no** OG tags (shared as bare links), and 11
more had `og:title`/`og:url` but **no `og:image`** — the imageless grey card.
Twitter cards existed on only 6 pages. For a travel brand the share-preview image
is the difference between a tap and a scroll-past. Additive `<head>` metadata
only — no behaviour, API, schema or payment change; no supplier.

**Files changed (13):**
- `frontend/activities.html`, `visa.html` — full OG block + Twitter card added
- `frontend/about.html`, `contact-us.html`, `faqs.html`, `customer-support.html`,
  `payment-security.html`, `privacy-policy.html`, `terms-and-conditions.html`,
  `cancellation-refund-policy.html`, `image-credits.html`, `cookie-policy.html`,
  `disclaimer.html` — added `og:image` + `twitter:card` + `twitter:image`
  (`twitter:title`/`description` inherit from OG by design)
- `tests/verify_open_graph.py` — **new** sitemap-driven test (stdlib only); it
  also asserts every `og:image`/`twitter:image` resolves to a real asset on disk

Default social image is the site hero (`hero-dubai-1600.webp`), matching the
homepage's existing `og:image`. Migrations: none.

**Test command & result:**
```
python tests/verify_open_graph.py         # PASS: 19 indexable pages, complete OG + Twitter card
python tests/verify_structured_data.py    # PASS (regression)
python tests/verify_canonical.py          # PASS (regression)
```

**Rollback:** revert the commit; the tags are isolated to `<head>`.

### 3. Accessibility pass — booking card & search result cards — 2026-10-26

**Audit result first (honest baseline).** The booking-card search widget and the
result cards are **already strongly accessible** and were left unchanged:
- `booking-card.js`: every input has a `<label for>`; tabs use
  `role="tablist/tab/tabpanel"` and trip-type/hotel-mode use
  `role="radiogroup/radio"`, each with **roving `tabindex` and full arrow-key +
  Home/End handling**; swap/fare/remove controls are real `<button>`s with
  `aria-label`.
- `hotel-results.js`: real `<button>`s, star ratings as `role="img"` +
  `aria-label`, loading `role="status"`, enquiry errors `role="alert"`,
  screen-reader-only rating text; `Wishlist.button` carries `aria-pressed` + a
  descriptive `aria-label`.
- `travel-explore.js`: date strip marks the selected day with
  `aria-current="date"`; skeletons use `role="status" aria-live="polite"`.
- `flights.html`: a "Skip to results" skip link; `:focus-visible` focus rings are
  defined in `booking-card.css` and `results-card-premium.css`.

**The one verified gap fixed.** The result lists update asynchronously, but only
the *start* of a search was announced to screen readers ("Searching…"). The
*outcome* never was: the visible "Showing X of X" count was removed from flights
in the UX pass (and hidden), and neither list is itself a live region — so a
screen-reader user heard "Searching for flights…" then silence. Added one shared
visually-hidden polite live region (`announceResults()`) updated on each render
with the outcome ("12 flights found" / "No flights found for this route" /
"No flights match those filters", and the hotel equivalents). Visible design is
unchanged; no API, pricing, booking-flow or responsive change.

**Files changed (5):**
- `frontend/assets/js/travel-explore.js` — `announceResults()` helper + one call
  in each of the flight and hotel render paths (+47 lines)
- `frontend/flights.html`, `hotels.html`, `cruises.html` — `?v=` cache-bust token
  re-stamped by `scripts/stamp_asset_versions.py` (content hash; the only stale
  asset was `travel-explore.js`)
- `frontend/tests/search-live-region.test.js` — **new** Node harness: runs the
  real `announceResults()` in a VM (asserts the live region's ARIA contract) and
  asserts both render paths announce

**Test commands & results (all PASS):**
```
node frontend/tests/search-live-region.test.js        # PASS (behavioural + structural)
node frontend/tests/hotel-image-map.provider.test.js  # PASS (regression)
python tests/verify_structured_data.py                # PASS
python tests/verify_open_graph.py                     # PASS
python tests/verify_canonical.py                      # PASS
```

**Browser verification (static preview, port 8420):** fresh JS loaded
(`?v=202e38b122`); the live region is created with `role=status`,
`aria-live=polite`, `aria-atomic=true`; it announced "No flights found for this
route" and re-announced on each date change; mobile (375px) had no horizontal
overflow. **Not verified live:** a *populated* flight list (the static preview
has no backend, and the fixed client-side sample routes could not be matched
through the UI), so the positive-count string is verified by the unit test and
code, not on screen; and screen-reader output was not verified with an actual AT
(no screen reader in this environment).

**Rollback:** revert the commit; `travel-explore.js` changes are additive and the
`?v=` tokens re-stamp deterministically from file content.

---

## Phase 2 — Booking & payment reliability audit (2026-10-26)

### Test baseline
`python -m pytest backend/tests/` → **739 passed** (needs `DATABASE_URL` +
`JWT_SECRET_KEY` in env; conftest supplies a SQLite harness — no real DB). The
repo-root `tests/verify_*.py` are integration scripts that need a running server
and a live provider, so they were **not** run here (no server/provider in this
environment).

### Flow, traced from code
- **Checkout** (`customer_bookings.start_flight_checkout` etc.) opens a payment
  order with an **idempotency key** → one order per key.
- **Webhook** (`routers/payment_webhooks.py`, the *only* unauthenticated write
  surface): raw bytes → **verify signature → only then parse** → record once via
  a unique index on `(provider, provider_event_id)` → act. A `payment.captured`
  is recorded `deferred`; amount/currency/ownership are verified server-side
  before anything is confirmed. Bad signature → 401, nothing recorded.
- **Confirmation** happens only after a server-side re-verification against the
  provider (Order Status API / capture), per product
  (`payment_verification_{service,flight_service,hotel_service}`).
- **Delayed/missed webhooks**: `_payment_sweep_loop` retries deferred events and
  reconciles stale-pending payments (same verifier as the webhook).
- **Refunds / cancellations**: the refund **amount is an admin decision**
  (`customer_cancellation_admin_service`), not an auto-computed tier — so there
  is no rounding/percentage calculation to get wrong.
- **Commission**: the platform does **not** compute percentage commissions; the
  B2B side stores a margin (sell − cost) as values, and "commission" appears only
  as an invoice label. So "incorrect commission calculation" is **N/A** here.

### Verified-defect finding
**None.** The six requested regression scenarios are already covered by the
existing suite, with direct evidence:

| Requested scenario | Already covered by |
|---|---|
| Duplicate payment callbacks | `test_duplicate_webhook_confirms_once`, `test_verified_webhook_confirms_once_and_a_duplicate_changes_nothing`, `test_http_webhook_success_then_duplicate_both_200` |
| Repeated booking submissions | `test_pay_now_twice_with_the_same_key_opens_one_order`, `test_duplicate_create_refused_by_hdfc_falls_back_to_the_existing_order` |
| Payment OK then supplier-booking fails | `test_late_failure_event_cannot_undo_a_capture`, `test_success_on_a_cancelled_booking_is_kept_for_review` (note: no live GDS/supplier-booking step exists today — confirmation is internal) |
| Delayed webhook delivery | `test_a_paid_deferred_event_confirms_the_booking_once`, `test_stale_pending_payment_is_settled_without_a_return_or_webhook`, `test_return_and_webhook_racing_confirm_once` |
| Refund state transitions | `test_charged_but_fully_refunded_is_refunded`, `test_failed_attempt_then_refunded_retry_is_recorded`, `test_a_refunded_payment_blocks_a_new_checkout` |
| Incorrect commission calculation | **N/A** — no commission is computed (see above) |

Per the brief ("do not assume a workflow is broken without evidence"), **no fix
was made** — there is no verified defect to fix.

### What was genuinely missing — added
The **router-level guards** on the webhook endpoint (which run before any
adapter) had no coverage, only the adapter-level signature logic did. Added
`backend/tests/test_payment_webhook_router.py` (test-only, no production change):
empty body → 400, oversized body (`MAX_BODY_BYTES`) → 400 with a strict `>`
boundary check, unknown provider → 400 **without enumerating configured
providers** — each asserting nothing is recorded (spying on `events.handle`).

`backend/tests/` → **743 passed** (739 + 4 new).

### Remaining risks / next priorities
- **Integration path unverified here**: `tests/verify_*.py` (live server +
  provider) and the real HDFC/Razorpay/TrustBrick paths need an environment with
  credentials — see [[hdfc-smartgateway-integration-state]]. Ops-gated, not code.
- **No live supplier-booking step** for flights (Duffel dormant): the moment a
  real GDS lands, "paid but ticketing failed" becomes a real state needing its
  own reconciliation — worth a dedicated test then.
- **Concurrency** is handled by DB unique indexes (event id, order id), not app
  locks; correct under the current design, but worth a load test before a live
  gateway carries real volume.
