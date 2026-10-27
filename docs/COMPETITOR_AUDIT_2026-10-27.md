# JackPots World — Competitor Audit, Verification & Roadmap (2026-10-27)

**Branch:** `claude/jackpotsworld-competitor-audit-f52b5a`
**Author:** audit session, grounded in a direct read of this repository + a live
test run on the date above.

> **Relationship to `COMPETITOR_BENCHMARK.md`.** That document (PR #26, 2026-10-26)
> already benchmarks **Trip.com, Travala and MakeMyTrip** and sets the honest
> baseline. This document does **not** repeat it. It (a) **re-verifies** the key
> claims rather than assuming them unchanged, (b) extends the competitor set with
> the **hotel-OTA and metasearch** platforms in the brief (Goibibo, Booking.com,
> Expedia, Agoda, Skyscanner, Airbnb), and (c) records the one increment
> implemented this session. Read both together.

---

## 1. Executive summary

JackPots World is a **mature, honest, production-grade** FastAPI monolith
(~303 Python modules in `backend/app`, 60+ registered routers, Alembic migrations
through the 0090s). It already matches mainstream OTAs on the hard parts: secure
idempotent payments with verified webhooks, a booking state machine, admin/ops
portals, RBAC, support (chat + WebRTC voice), transparent server-authoritative
pricing, SEO (canonical + JSON-LD + OG), and **honest supplier labelling** (demo
flights are labelled "Sample schedule"; trains/buses/cabs/visa are enquiry-only).

The strategic conclusion from the prior benchmark holds and is re-confirmed: the
leverage is **conversion, trust and retention polish that needs no new supplier
contract** — not a redesign or a clone. Most competitor "gaps" are either already
present, or gated on a third-party API/contract (Duffel, Hotelbeds, a maps
provider, a live payment gateway) that is an ops/business decision, not code.

---

## 2. What I verified this session (not assumed)

| Claim | How verified | Result |
|---|---|---|
| Backend test suite green | `python -m pytest backend/tests/ -q` (SQLite harness, `DATABASE_URL`+`JWT_SECRET_KEY` set) | **743 passed** — matches the prior doc |
| Wishlist CRUD wired | Read `routers/customer_account.py`, `services/customer_account_service.py`, schema + model | `GET/POST/DELETE /api/customer/wishlist`, owner-scoped, idempotent add, `item_type` pattern-validated |
| Wishlist backend coverage | `grep` over `backend/tests/` | **None existed** — only `frontend/tests/wishlist-*.test.js` (client enrichment). Now fixed (§5) |
| PR #27 B2C work present | git log + routers | Merge `eaca284`; coupon/sort/wishlist code in `cab00a3` |
| Payments default off | prior doc + webhook router read | `provider=none` → honest "no payment taken"; webhook verifies signature→parse→record-once→act |
| Suppliers dormant | integration dirs + config flags | Duffel (flights) & Hotelbeds (hotels) adapters built, **off** behind flags |
| Worktree clean | `git status` | Clean before my change |

**Honest limits of this verification:** tests ran against the **SQLite unit
harness**, not PostgreSQL; the repo-root `tests/verify_*.py` integration scripts
(live server + provider) were **not** run (no server/credentials in this
environment); no production smoke test was run; browser/live-wishlist-with-a-real-
account was **not** exercised here (no authenticated session). The new coverage
closes the *logic* gap; a live end-to-end pass with a real test account is still a
separate, ops-dependent step.

---

## 3. Extended competitor patterns (hotel-OTA + metasearch)

Scope-of-honesty note, same as the prior doc: these are **publicly observable**
product behaviours from each platform's public web flows and help/marketing pages.
Private APIs, inventory sources and contracts are not inspectable. Items inferred
from marketing rather than a directly observed flow are marked *(marketing)*.
Third-party aggregator pages were treated as weak evidence and excluded.

| Platform | Distinctive publicly-observable pattern | Transfers to JackPots as | JackPots today | Priority |
|---|---|---|---|---|
| **Booking.com** | Free-cancellation badge surfaced *in results* before you open a property; "Reserve now, pay later"; Genius loyalty tiers *(marketing)* | Surface the **cancellation/pay terms as a result-card badge**, not only on the detail page | Policy shown on detail; not a result badge | **P1** (hotels we own the data) |
| **Agoda** | Dense price-per-night + taxes toggle; "X people looking now" urgency *(marketing)* | **Taxes-included toggle** on hotel result cards (we already compute the total) | Total shown at checkout, not toggle-on-card | **P1** |
| **Expedia** | Bundle "+ add a hotel to your flight" cross-sell; one itinerary | Flight+hotel cross-sell is **supplier-gated** (needs live flights) | Enquiry-only cross-sell possible | P2 (defer till Duffel) |
| **Skyscanner** | "Everywhere" cheapest-destination search; **whole-month cheapest-date** calendar; **price alerts** | Price alerts / whole-month need **live fares** (Duffel); not doable on demo data honestly | Demo schedule only | P2/P3 (supplier-gated) |
| **Airbnb** | **Map-first** results; category pills; **flexible dates**; wishlists with notes | **Wishlist with notes/folders** is doable now (no supplier); map is a paid provider | Wishlist exists (flat list) | Wishlist-notes **P2**; map P3 |
| **Goibibo** | goCash wallet + tiered rewards; referral *(marketing, amounts unconfirmed)* | Rewards/referral = **liability + compliance**, explicitly deferred per brief | Coupons only | P3 (business sign-off) |

**Net new, safe, no-supplier ideas this adds over the prior doc:**
1. **Result-card trust badges** for hotels — free-cancellation / taxes-included,
   computed from catalogue data we already hold. (Booking.com + Agoda lesson.)
2. **Wishlist with a short note per saved item** — low-cost retention, no supplier,
   and the table already has a clean per-item row to extend. (Airbnb lesson.)

Everything else distinctive to these six (map view, price alerts, whole-month,
bundles, loyalty wallet) is **supplier- or compliance-gated** and correctly sits
behind the same gates the prior doc identified. No honest increment exists for
them on today's data.

---

## 4. The "first report" (as requested)

- **What works** (verified): payments pipeline (idempotency, verified webhooks,
  reconciliation sweep), booking state machine, admin/ops/merchant portals, RBAC,
  transparent server-side pricing, coupons, wishlist CRUD, SEO (canonical/JSON-LD/
  OG), a11y result-announce live region, support chat+voice, honest supplier
  labelling. Suite: **748 passed** after this session.
- **What is incomplete / unverified**: live end-to-end wishlist with a real
  authenticated account (logic now tested, live pass still pending); the
  `tests/verify_*.py` integration scripts (need a running server + provider);
  production smoke tests; HDFC/Razorpay live activation (**ops-gated**).
- **What the best reference platforms do differently**: surface **trust/terms at
  the result card** (Booking/Agoda), **map-first + wishlist-with-notes** (Airbnb),
  **price alerts / whole-month** (Skyscanner) — the last group needs live fares.
- **Highest value**: (1) backend wishlist coverage — done; (2) hotel result-card
  trust badges; (3) wishlist notes. All no-supplier, testable.
- **Needs external APIs / contracts / paid services**: Duffel (live flights →
  multicity, PNR, baggage rules, price alerts), Hotelbeds (live hotel content),
  a maps provider (result maps), a live payment gateway (HDFC/Razorpay creds),
  any loyalty/referral economy (finance + compliance sign-off).

---

## 5. Implemented this session

### Backend wishlist test coverage — `backend/tests/test_customer_wishlist.py` (NEW)

**Why.** The wishlist endpoints and service shipped and are used by the Account
Center and the hotel/package heart controls, but had **no server-side test** — the
only coverage was the client enrichment harness in `frontend/tests/`. The two
invariants that matter were unpinned: (a) saving the same item twice must not
stack a second heart (the UI toggles, so double-POST is ordinary), and (b) one
customer must never read/delete another customer's saved item.

**What.** 5 service-level tests (mirroring `test_customer_notifications.py`, same
SQLite harness, no HTTP/real DB): idempotent re-save, `(type,id)` identity so
hotel#7 ≠ package#7, per-customer list scoping, the cross-customer ownership
refusal that backs the DELETE 404, and targeted removal + re-save.

**Production code changed:** **none** — test-only, fully additive.

**Result:** `python -m pytest backend/tests/` → **748 passed** (743 + 5).

**Rollback:** delete the one new test file.

**Documented, not changed (proposed as P2):** `POST /wishlist` does not validate
`item_id` against the live catalogue, so a dangling id can be saved; the frontend
enrichment already tolerates this. Validating would couple the account service to
the catalogue tables — a deliberate design choice to confirm before changing.

---

## 6. Prioritised roadmap (safe, no-supplier, testable first)

| # | Increment | Supplier? | Complexity | Acceptance |
|---|---|---|---|---|
| 1 | **Wishlist backend coverage** ✅ done | no | S | 748 pass |
| 2 | Hotel result-card trust badges (free-cancel / taxes-incl) | no | M | badge renders from catalogue fields; UI + unit test; no pricing change |
| 3 | Wishlist note per saved item | no | M | additive column + migration; note round-trips; backward compatible |
| 4 | Loading skeletons / richer empty+error states where thin | no | S | per-surface visual + test |
| 5 | Coupons/campaigns admin polish | no | M | admin CRUD + eligibility tests |
| — | HDFC/Razorpay activation | **ops** | — | creds + public HTTPS host (no code) |
| — | Duffel live flights → multicity/PNR/price-alerts | **contract** | L | token + contract |
| — | Hotelbeds live content + result map | **contract + $** | L | creds + maps key |
| — | Loyalty / referral economy | **compliance** | L | finance sign-off |

**Deployment & rollback (for approval, unchanged):** Docker + Caddy on EC2; each
increment is a focused, revertable commit on this branch; this session's change is
test-only. Nothing is to be merged or deployed without explicit approval.
