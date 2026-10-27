# JackPots World — Customer Feature Batch (2026-10-27)

**Branch:** `claude/jackpotsworld-feature-batch` (off `origin/main` `2eae5e6`)
**Commits:** `4b07107` (recently viewed) · `3b8119e` (saved travellers) · `d197921` (compare)
**PR:** not opened yet (terminal `gh` unauthenticated here) — link in §7. **Not merged, not deployed.**

A batch of three genuinely-missing, no-supplier, end-to-end customer features,
each verified against the repo first so nothing already working was rebuilt.

---

## 1. Feature matrix

Legend: ✅ exists & works · ◑ partial · ✨ **new this batch** · ⛔ blocked (needs external dependency).

| Capability | Status before | This batch | Notes |
|---|---|---|---|
| Wishlist (save/remove) | ✅ | — | kept |
| Wishlist notes | ✅ (shipped & deployed) | — | kept |
| Scored recommendations ("For you") | ✅ | — | kept; distinct from recently-viewed |
| Recently-viewed destinations (local shelf) | ✅ (landing, localStorage) | — | kept |
| **Recently-viewed hotels & packages (account, server-backed)** | ○ missing | ✨ | new endpoint over existing `customer_activity`; hotel views now recorded |
| Saved-traveller CRUD API | ✅ (used by booking form) | — | kept, unchanged |
| **Saved-traveller management UI (account)** | ○ missing | ✨ | Account Center tab onto the existing API; passport masked |
| **Compare saved hotels/packages** | ○ missing | ✨ | side-by-side in the wishlist, from catalogue data already fetched |
| Hotel free-cancellation badge | ✅ | — | kept (verified honest earlier) |
| Flight/hotel/package search, sort, filters | ✅ | — | kept |
| Coupons (apply + admin strips) | ✅ | — | not touched this batch |
| Multi-city flights, price alerts, live fares | ⛔ | — | needs Duffel contract+token (§6) |
| Live hotel inventory / richer content | ⛔ | — | needs Hotelbeds creds (§6) |
| Interactive maps of results | ⛔ | — | needs a paid maps provider (§6) |
| Loyalty / rewards / referrals | ⛔ | — | finance + compliance sign-off (§6) |
| Multi-currency pricing | ⛔ | — | business decision + FX source (§6) |
| Verified reviews tied to bookings | ◑ | — | review API exists; a verified-booking gate is a separate design |

---

## 2. Features implemented this batch

### F1 — Recently viewed (server-backed), `4b07107`
Account Center → **Recently Viewed**: the hotels and holiday packages the
customer actually opened, newest first, deduped to the most recent view, each
with a "View again" deep link. Reads the same `view` signals the recommender
uses. Package & destination views were already recorded server-side; **hotel
views were not**, so a hotel open now records one (guarded, session-only), via
the same `JWInterest.track` `package.js` uses. Items missing from the catalogue
are dropped, never shown dangling. Owner-scoped (session, no id in the path).

### F2 — Saved travellers management, `3b8119e`
Account Center → **Saved Travellers**: list / add / edit / delete, wired to the
pre-existing owner-scoped `/api/customer/travellers` CRUD — **no backend change**.
Passport numbers are shown **masked** (last 4 only); the raw number is never
rendered. Create (POST) vs update (PATCH) is routed by presence of an id; delete
confirms first and notes that existing bookings keep their own frozen copy.

### F3 — Compare saved hotels/packages, `d197921`
In the wishlist, when two or more saved items of one kind exist, a
**"Compare N hotels/packages"** button shows them side by side — built from the
catalogue data the wishlist already fetched (**no new request, no backend**).
Only attributes at least one item has are shown; an all-empty attribute is
dropped; a package rating appears only with its source (the same honesty rule
the API applies). No value is invented.

---

## 3. Changed files & API/DB changes

**Backend (3 files):**
- `app/services/recommendation_service.py` (+81) — `get_recently_viewed()`; imports the hotel catalogue service.
- `app/routers/customer_recommendations.py` (+46) — `GET /api/customer/recently-viewed` + response schema.
- `tests/test_recently_viewed.py` (new, 152) — service tests.

**Frontend (JS, 2 files):**
- `assets/js/account-center.js` (+255) — Recently-Viewed tab/panel/loader; Saved-Travellers tab/panel/form/CRUD wiring (+ `maskPassport`); wishlist Compare (`compareTableHtml`, `appendWishlistCompare`).
- `assets/js/hotel-rooms.js` (+7) — record a hotel `view` on open.

**Frontend (tests, 3 new):** `recently-viewed.test.js`, `saved-travellers.test.js`, `wishlist-compare.test.js`.

**HTML (14 files):** `?v=` asset re-stamps only. In `4b07107` these also corrected **pre-existing stale tags on `payment-screen.js` and `booking-pay.js`** left by PR #30 (tokens only — no payment JS/logic changed; without it the asset gate fails on current main).

**New API:** `GET /api/customer/recently-viewed` (customer session; empty list when nothing to show).
**DB / migrations:** **none.** No schema change — all three reuse existing tables (`customer_activity`, `customer_travellers`, `customer_hotels`/`customer_packages`) and existing endpoints.

---

## 4. Test commands & actual results

```
# backend (SQLite harness; DATABASE_URL + JWT_SECRET_KEY set)
python -m pytest backend/tests/ -q
  -> 796 passed, 14 warnings           # includes 6 new test_recently_viewed.py

# new frontend tests (Node VM harness, real escapeHtml/money)
node frontend/tests/recently-viewed.test.js      -> PASS
node frontend/tests/saved-travellers.test.js     -> PASS
node frontend/tests/wishlist-compare.test.js     -> PASS

# regression (unchanged wishlist behaviour)
node frontend/tests/wishlist-notes.test.js               -> PASS
node frontend/tests/wishlist-account-enrichment.test.js  -> PASS
node frontend/tests/wishlist-package.test.js             -> PASS

# JS syntax + asset-version gate
node --check frontend/assets/js/account-center.js   -> OK
node --check frontend/assets/js/hotel-rooms.js      -> OK
python tests/verify_asset_versions.py               -> PASS (0 stale)
```
**Automated only.** Not run here: the live `tests/run_all.py` gate (needs a running backend + real PostgreSQL) and any real-browser / authenticated end-to-end click-through — see §8.

---

## 5. Migration requirements & rollback

**No migration.** Rollback is a plain code revert of the three commits (or not
merging the branch). Nothing persists a new shape; recently-viewed reads data
that was already being written, and the saved-traveller rows are the existing
table. Reverting removes the three account tabs and the hotel-view recording
call — no data cleanup needed.

---

## 6. Remaining blockers (exact business action to unblock)

| Blocked capability | Exact missing dependency |
|---|---|
| Multi-city flights, live fares, price alerts, flight+hotel bundles | **Duffel** (or other GDS) **API token + commercial contract**; flights are demo today. Bundles also need live flights. |
| Live hotel inventory + richer supplier content | **Hotelbeds credentials** (adapter + idempotent sync already built, dormant). |
| Interactive maps of results | A **paid maps provider** API key (e.g. Google/Mapbox); `latitude`/`longitude` columns already exist to feed it. |
| Loyalty / rewards / referrals | **Finance + compliance sign-off** — stored-value liability + abuse model; a business decision, not code. |
| Multi-currency pricing | A **business decision on target markets** + a trusted **FX rate source**; prices are INR-authoritative today. |
| Verified reviews | A **verified-booking policy** (which bookings may review what) — the review API exists but gating it is a design + product decision. |

No part of any blocked item was faked. Each is honestly absent or enquiry-labelled.

---

## 7. Branch / commits / PR

- Branch: `claude/jackpotsworld-feature-batch` (pushed).
- Commits: `4b07107`, `3b8119e`, `d197921`.
- Open the PR (base `main`, do **not** merge):
  `https://github.com/jackpotsworldtourstravels/JackPotsworldtoursandtravels/pull/new/claude/jackpotsworld-feature-batch`

---

## 8. Deployment checklist (for approval — do not deploy without it)

This batch has **no migration**, so it is simpler than the `0092` deploy, but
note the environment state:

1. **Mind the main/prod gap.** Production is at `ed7e0fc` (wishlist notes).
   `origin/main` already carries **PR #30 (HDFC payment verification), `2eae5e6`,
   undeployed**, plus this branch once merged. A deploy of latest main therefore
   ships PR #30 **and** this batch — review/stage PR #30 deliberately, it is
   payment code this batch did not touch.
2. Merge this branch to `main` (after review), confirm the asset gate in CI:
   `python scripts/stamp_asset_versions.py --check`.
3. Deploy as usual (`redeploy.sh` via SSM) — the entrypoint runs
   `alembic upgrade head`; **head is unchanged (`0092`)**, so no schema change runs.
4. Smoke-test (read-only): `GET /api/health`; sign into a test customer account
   and verify the three new tabs load, a hotel view appears under Recently
   Viewed, a saved traveller round-trips, and Compare renders for 2+ saved items.
5. Rollback: redeploy `ed7e0fc` (or the pre-merge main). No DB downgrade needed.

**Honesty note:** live end-to-end (authenticated browser) and `tests/run_all.py`
were **not** run in this environment; they belong in staging/CI before deploy.
