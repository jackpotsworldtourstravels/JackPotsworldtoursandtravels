# Phase 1 Production Bug Resolution Report

**Register:** Phase 1 Production Bug Register — 2026-11-17
**Branch:** `claude/jackpotsworld-12-bug-sprint-c59a3f` (cut from `main` @ `3987c79`)
**Date:** 2026-11-21
**Author:** Harsha7215 + Claude Opus 4.8

> Honesty note: statuses below reflect the code and the tests as they actually
> stand in this branch. Nothing is marked FIXED AND TESTED unless a committed
> regression test exercises it and passes here. Items needing a provider,
> production infrastructure or a browser matrix are called out explicitly.

## Status summary

| Bug | Original issue | Root cause | Fix implemented | Tests | Status |
|---|---|---|---|---|---|
| 11 | "Image Credits" link in the footer should be removed | Link listed in the footer's data model (`site-footer.js`) and in the static footer copy in `index.html` | Removed both references; page itself kept (reachable by direct URL). Browser UI test flipped to assert the footer link is absent | `footer-no-image-credits.test.js`; `image-credits.ui.test.mjs` (updated) | **FIXED AND TESTED** |
| 4 | Wishlist item titles are not clickable | `loadAcctWishlist` rendered the title as a plain `<div>`; no detail-page resolver | Added `wishlistHref`: packages → `/package-details/{id}`, hotels → `/hotels?hotel={id}`; flights/cruises (demo, no detail page) and deleted/unresolved items stay plain text. Remove action untouched | `wishlist-detail-link.test.js` | **FIXED AND TESTED** |
| 7 | Editing a package search loses destination + month on refresh / nav / direct URL | The PackageSearch panel handler set only `state.pkgDest` and never wrote the URL; `writeUrl`/`seedFromUrl` persist `?type=`/`?month=` via `state.pkgType` | Panel handler now syncs `state.pkgType` and calls `writeUrl(true)`, mirroring the hero card; `mountPackageSearch` already resolves `pkgType → pkgDest` on load | `package-edit-search-restore.test.js` | **FIXED AND TESTED** |
| 8 | Contact-Us header shows generic "My Account" | `service-shell.js` fallback (pages with no `auth.js`) rendered a static label | Fallback now reads `jpc_user_name`, shows the name, falls back to "My Account" when blank and "Login / Create" when signed out; name HTML-escaped (`esc` fallback hardened) | `service-shell-auth-name.test.js` | **FIXED AND TESTED** |
| 9 | Policy pages header shows generic "My Account" | Same shell, same fallback | Same single fix — verified all seven policy/contact pages use `service-shell.js` with no ProfileMenu/`auth.js`, so all are covered | `service-shell-auth-name.test.js` | **FIXED AND TESTED** |
| 6 | Coupon error says "does not apply to flight bookings" on hotel/package | `validate_coupon` (shared by flight/hotel/package) hardcoded "flight" in two messages | **Excluded from this release.** A message-only change (via `_product_noun`) was prototyped in the Phase 1 sprint (`372c14b`) but was **reverted** in `e92cb0b`; production coupon wording is unchanged and coupon **usage-limit enforcement is not implemented** | None in this release — the sprint's `test_coupon_product_messaging.py` was removed and is **not** part of this release | **EXCLUDED — NOT IN THIS RELEASE** |
| 10 | Payment History showed flight payments only | (Already fixed in PR #52 / `455fe51f`) `list_payments_for_customer` joined only the flight payment table | Verified: reads all three payment sources, tags `service_type`, owner-scoped from the authenticated caller, honest refund status, safe pagination | `test_payment_history.py` (12 cases) | **FIXED AND TESTED** |
| 12 | Admin voice-call acceptance collapsed the agent's own call | (Already fixed in `d0bfa0c2`) `accept()` published `call_cancelled` to the answerer's own channel | Verified: fix present in branch history; `turn_credentials()` mints time-limited HMAC creds (coturn `use-auth-secret`, secret never sent); `ice_config` builds from settings, no baked creds | `voice-handoff.test.mjs` (14 cases) | **FIXED — EXTERNAL VERIFICATION REQUIRED** (coturn must be deployed + a real cross-network call tested; see deployment checklist) |
| 1 | Booking confirmation email + SMS | No B2C booking-confirmation email path; `acct.notify` is in-app only; no SMS provider layer exists | **Implemented (Phase 2).** New `sms_service.py` (configurable adapter: console/http, off by default, never raises, masks numbers) + `booking_confirmation_service.py` (composes ref/customer/itinerary/payment summary/My-Bookings link; email via `email_service`; outbox table `customer_booking_notifications`, idempotent per booking_ref+channel; retry + failure logging; never exposes card/credential data). Enqueued atomically inside all three `confirm_booking` paths; sent by a background outbox sweep | `test_sms_service.py` (9), `test_booking_confirmation_service.py` (11), `test_booking_confirmation_integration.py` (3) | **FIXED AND TESTED** (live SMTP/SMS provider = ops dependency) |
| 3 | Tour-package enquiry admin management | `tour_package_enquiry_service.py` handles customer submission + email only; no admin list/detail/status/assignment/notes/audit | **Implemented (Phase 2).** Admin list (filter/search/paginate), detail, PATCH (status/assignment/internal notes, auto-ASSIGN on first assign), audit history (`/history`) — mirroring the Gaming Tour desk. New RBAC code `tour_package.enquiry.manage` (ADMIN), actor-attributed System-Logs audit with status transitions. Admin portal screen wired (`admin-tour-package-enquiries.js` + nav/section/modal). Public submission + email **preserved untouched** | `test_tour_package_enquiry_admin_http.py` (12) + `admin-tour-package-enquiries.test.js` (frontend) | **FIXED AND TESTED** |
| 2 | Multi-city flight booking | `customer_bookings` was one-flight-per-booking (see memory: single-flight booking model) | **Implemented (Phase 3 integration).** `customer_bookings` grown into an envelope owning 1..N segments: migration `0096_booking_segments` (additive), `POST /bookings/multi-segment`, per-leg pricing/seats/add-ons, multi-city builder in `travel-explore.js` (the Bug 7 conflict resolved), My-Bookings + e-ticket per-leg display | `test_multi_segment_booking.py`, `test_multi_segment_http.py`, `test_multi_segment_confirmation.py`, `tests/js/round-trip.test.mjs`, browser `multi-city.ui.test.mjs` (see Phase 3 test results) | **FIXED AND TESTED** (Phase 3) |
| 5 | Round-trip booking | Same single-flight model; round-trip payment was previously blocked | **Implemented (Phase 3 integration).** A round trip is the 2-segment case of the multi-segment envelope above; the frontend `checkoutHold` sample block was removed so round-trip is bookable, priced per leg and confirmed as one envelope (one `booking_ref`) | round-trip cases in `test_multi_segment_*` + `tests/js/round-trip.test.mjs`; browser `round-trip.ui.test.mjs` (see Phase 3 test results) | **FIXED AND TESTED** (Phase 3) |

### Release bug tally — all 12, reconciled for `release/jackpotsworld-tours-phase2`

Target scope for this release: Bugs **1, 2, 3, 4, 5, 7, 8, 9, 10, 11** included; Bugs **6 and 12** excluded.

- **Newly implemented & tested in this release (9):** Bugs 11, 4, 7, 8, 9 (Phase 1 sprint) + Bugs 1, 3 (Phase 2) + Bugs 2, 5 (Phase 3 multi-segment integration).
- **Previously existing fix, carried in the base & verified (1):** Bug 10 (payment history, PR #52 / `455fe51f`) — an ancestor of this branch, present and tested, not re-implemented here.
- **Excluded from this release (2):**
  - **Bug 6** — coupon product-wording change reverted in `e92cb0b`; coupon usage-limit enforcement is not implemented.
  - **Bug 12** — not part of this deployment. Its pre-existing addressing fix (`d0bfa0c2`) is an ancestor of the base and remains in history, but this release introduces **no** Bug 12 code and the feature is **externally unverified** (coturn not deployed; no real cross-network call).

**Totals (counting method):** of the 12 bugs, **10 are included and code-complete in this release** (9 newly implemented + 1 pre-existing), all with tests; **2 are excluded** (Bug 6 reverted, Bug 12 out of deployment scope / externally unverified). "Included" = the fix is present on this branch; "newly implemented" = introduced by this release's own commits; "previously existing" = an ancestor commit's fix carried in the base.

## Changed files (this sprint, commit `372c14b`)

```
backend/app/services/customer_pricing_service.py   (Bug 6 — REVERTED in e92cb0b; not in this release)
frontend/assets/js/account-center.js               (Bug 4)
frontend/assets/js/service-shell.js                (Bugs 8, 9)
frontend/assets/js/site-footer.js                  (Bug 11)
frontend/assets/js/travel-explore.js               (Bug 7)
frontend/index.html                                (Bug 11)
tests/js/browser/image-credits.ui.test.mjs         (Bug 11, test)
backend/tests/test_coupon_product_messaging.py     (Bug 6 — REMOVED in e92cb0b; not in this release)
frontend/tests/footer-no-image-credits.test.js     (Bug 11, new test)
frontend/tests/wishlist-detail-link.test.js        (Bug 4, new test)
frontend/tests/service-shell-auth-name.test.js     (Bugs 8/9, new test)
frontend/tests/package-edit-search-restore.test.js (Bug 7, new test)
docs/qa/*.md                                        (this report + two deliverables)
```

Commit: `372c14b` — `fix(b2c): Phase 1 bug sprint — footer, wishlist links, edit-search, headers, coupons`

## Per-bug detail

### Bug 11 — Image Credits footer link
- `frontend/assets/js/site-footer.js`: removed `['Image Credits', '/image-credits']` from the `legal` list.
- `frontend/index.html`: removed the `<li><a href="/image-credits">Image Credits</a></li>` from the footer Legal column.
- A whole-frontend search confirmed these were the only two link references; the page (`image-credits.html` / `image-credits.js`) and the `CREDITS.md` records are deliberately kept.
- The browser UI test `image-credits.ui.test.mjs` asserted the footer linked to the page; flipped to assert its absence (the page is still loaded and validated by direct URL).

### Bug 4 — Wishlist item detail navigation
- Added `wishlistHref(type, item, itemId)` in `account-center.js`; render wraps the title in `<a class="ar-title-link">` only when a href exists.
- Links: package → `/package-details/{id}`; hotel → `/hotels?hotel={id}` (the hotels page loads the full catalogue on cold load, so its router opens the property). Absolute paths so resolution never depends on the account page URL.
- flights/cruises have no detail page (demo/client-side) → plain text. Deleted/unresolved items (no catalogue match) → plain text (graceful). Remove action unchanged.

### Bug 7 — Package Edit Search restoration
- Root cause: the hero search card kept `state.pkgType` in step with the destination and called `writeUrl`, but the PackageSearch **panel** handler set only `state.pkgDest` and never wrote the URL — so a panel search left `?type=`/`?month=` stale and a reload rebuilt state from the previous/empty criteria.
- Fix (`travel-explore.js`): the panel handler now sets `state.pkgType = req.destination` and calls `writeUrl(true)`. `seedFromUrl` reads `?type=`/`?month=` and `mountPackageSearch` resolves `pkgType → pkgDest` by exact package name on load, so refresh, Back/Forward and direct/shared URLs restore the destination + month. Unrelated params untouched.

### Bugs 8 & 9 — Contact-Us and policy-page headers
- `service-shell.js` fallback `renderAuth` (used by pages with no `auth.js`) now reads `jpc_user_name` (auth.js's `CUSTOMER_KEYS.name`) and displays it, matching the ProfileMenu chip on the booking pages.
- Safe fallbacks: signed-in-but-nameless → "My Account"; signed-out → "Login / Create".
- The name is user data injected via `innerHTML`, so the `esc` helper's fallback was hardened to actually escape when `escapeHtml` is absent, and the label is passed through `esc`.
- Verified every policy/contact page (`contact-us`, `privacy-policy`, `terms-and-conditions`, `cookie-policy`, `cancellation-refund-policy`, `payment-security`, `disclaimer`) renders through this shell.

### Bug 6 — Hotel coupons — EXCLUDED FROM THIS RELEASE
- **Status:** Bug 6 is **not fixed or tested in this release.** A message-only change was prototyped in the Phase 1 sprint (`372c14b`) and then **reverted in `e92cb0b`**: `customer_pricing_service.py` is back to its pre-sprint state and `test_coupon_product_messaging.py` has been removed. Production coupon wording is unchanged by this release.
- **Historical context (prototyped, not shipped):** the sprint had made `validate_coupon` in `customer_pricing_service.py` (shared by flight, hotel and package pricing) use `_product_noun(product_type)` so the product-mismatch and international-only messages named the actual product instead of hardcoding "does not apply to flight bookings." / "flights only." That change is **not** part of this release.
- **Coupon usage-limit enforcement is not implemented.** The `CustomerCoupon` model has **no** usage-limit / redemption-count column; the existing eligibility set (active, product type, domestic/international, validity dates, minimum spend, percent cap, and the discount never exceeding the fare) is unchanged. Adding a usage-limit would be a schema change / new feature and is out of scope.
- **Production coupon data was not read or modified.**

### Bug 10 — Payment History (verified, PR #52)
- `list_payments_for_customer` → `_collect_payments` reads flight, hotel and package payment tables, each joined to its booking table for the ref, merged and sorted newest-first with a deterministic tie-break.
- Each row carries `service_type`, `booking_ref`, `transaction_ref`, amount, currency, method, status and an honestly-derived `refund_status`. Owner-scoped by the booking's `customer_id` from the authenticated caller. Safe pagination (page ≥ 1, page_size 1..100). No rewrite made — functionality is complete and tested.

### Bug 12 — Admin voice-call acceptance (verified, `d0bfa0c2`)
- The one-line addressing fix (publish `call_cancelled` to the *other* candidates, not the answerer) is in branch history and covered by `voice-handoff.test.mjs`.
- `turn_credentials(actor)` implements coturn's REST `use-auth-secret` scheme: username `expiry:actor`, credential `base64(HMAC-SHA1(secret, username))`. The shared secret is never transmitted. `ice_config` assembles STUN/TURN servers from settings only.
- Remaining is production operations: deploy coturn (`deploy/setup-coturn.sh`), set the TURN env, and run a real cross-network call. See `PRODUCTION_DEPLOYMENT_CHECKLIST.md`.

## Remaining work — concrete plans

### Bug 1 — Booking confirmation email + SMS (safe to implement)
1. Add config: `sms_provider` (default `none`), provider credentials (no hardcoded secrets), mirroring the SMTP pattern.
2. New `sms_service.py`: provider abstraction (`none` / `log` / a real provider), returns a delivery result, logs, never raises.
3. New `booking_confirmation_service.py`: compose the email (booking ref, customer/passenger details, itinerary, payment info, ticket details — reuse `eticket_service.public_view` for flights) and the SMS; send via `email_service` + `sms_service`; retry transient failures; **record delivery status so a failed send is never reported as delivered**.
4. Hook at the confirmation point: `booking_confirmed_now` in the flight pay/reconcile path, plus the hotel and package equivalents.
5. Tests with mocked providers (success, SMTP down, SMS down, retry, "never report delivered on failure").
- **Dependency:** real email/SMS delivery needs live SMTP + an SMS provider account (credentials) — code and mocked tests complete without them.

### Bug 3 — Tour-package enquiry admin management (safe to implement)
1. Extend `tour_package_enquiry_service.py`: list (filter/paginate), detail, status transitions, assignment, internal notes.
2. Admin API endpoints under the existing admin router, with RBAC permission checks and `customer_admin_audit` logging.
3. Integrate into the admin portal (the B2C admin dashboard pattern from PR #54).
4. **Preserve** customer submission + email notification (do not touch the public POST path).
5. Tests: service unit + HTTP permission tests.

### Bugs 2 & 5 — Multi-city and round-trip — DONE (integrated in Phase 3)

> **Update:** completed in the Phase 3 integration (see the Phase 3 section below). The multi-segment implementation was merged onto `release/jackpotsworld-tours-phase2`, the `travel-explore.js` Bug 7 conflict resolved, and the migrations renumbered into one linear chain (`0096_booking_segments` → `0097_booking_notifications` → `0098_tour_package_enquiry_admin`). The original scope-decision plan is retained below for history.

**SUPERSEDED BY PHASE 3** — the steps below were the original pre-integration plan. They have all been carried out in the Phase 3 integration and are **not pending tasks**; they are retained verbatim for historical context only.

- _(Historical plan — superseded by Phase 3.)_ A complete implementation exists on `claude/phase-2-booking-segments-e6a6b0` (`4d884d10`): migration 0096 (additive), `POST /api/customer/bookings/multi-segment`, per-segment pricing/seats/add-ons, frontend multi-city flow, My Bookings + e-ticket per-segment display, 51 tests.
- _(Historical plan — superseded by Phase 3; done.)_ Integration path: merge/cherry-pick onto this branch, resolve the conflict with the Bug 7 edit in `travel-explore.js`, re-run migration up/down on Postgres 18, re-run the 51 Phase 2 tests + the full suite, then browser-verify multi-city and round-trip search/selection/pricing/payment (Bug 5's "browser-specific search failure" must be reproduced in a real browser).
- _(Historical plan — superseded by Phase 3; the go-ahead was given and the work was integrated.)_ This touches the core booking model and overlaps Bug 5, so it was held pending a go-ahead rather than merged silently into a bug-sprint branch.

## Outstanding risks
- **Bug 2/5 integration — SUPERSEDED BY PHASE 3.** _(Historical risk, retained for context.)_ This rebased a large, separately-developed branch over a moved `main`; conflicts (notably `travel-explore.js`) and migration ordering (0096 vs later migrations already in main) had to be checked before trusting it. **Completed and verified in Phase 3:** the branch was integrated, the `travel-explore.js` conflict resolved, and the migrations renumbered into one linear chain (`0096_booking_segments` → `0097_booking_notifications` → `0098_tour_package_enquiry_admin`, single head `0098`) and exercised up/down on PostgreSQL 18 — no longer a pending task.
- **Bug 12** cannot be declared done until coturn is live and a cross-network call succeeds; STUN alone fails for the CGNAT/mobile customer base.
- **Bug 1** real delivery is only as reliable as the configured SMTP/SMS provider; the code must fail honest (never mark delivered on error).

---

# Phase 2 — Bugs 1 & 3

**Branch:** `claude/jackpotsworld-phase-2-bugs-1080f3` (Phase 1 branch `c59a3f` merged in locally; Phase 1 commits `372c14b`/`7e371b2` preserved untouched as ancestors).
**Date:** 2026-11-22
**Author:** Harsha7215 + Claude Opus 4.8

> Same honesty rule as Phase 1: nothing is FIXED AND TESTED without a committed, passing regression test. External dependencies (live SMTP/SMS, PostgreSQL migration run, browser) are called out.

## Bug 1 — Booking confirmation email + SMS — **FIXED AND TESTED**

**The authoritative confirmation point.** A flight, hotel or package booking becomes CONFIRMED in exactly one place per product — `confirm_booking()` in `payment_verification_flight_service` / `payment_verification_hotel_service` / `payment_verification_service`. Five request paths reach them (three customer routers, the payment-webhook sweep, the admin manual-confirm), so the confirmation is enqueued **inside `confirm_booking`**, not at a router — every path gets it, with no per-call-site wiring to forget. `confirm_booking` already returns True exactly once per booking under a row lock, which is the idempotency guarantee the outbox builds on.

**What was built:**
- **`sms_service.py`** — a configurable provider adapter. `settings.sms_provider` selects it (`console` default, `http` for a generic gateway); `settings.sms_enabled` is the master switch, **off by default**, so nothing sends a live SMS until a deployment turns it on. `send()` never raises (a provider fault is a returned failure), masks phone numbers in every log line, and keeps the api key in a request header only — never in a log, a message or the result. An unknown provider fails closed.
- **`booking_confirmation_service.py`** — composes the confirmation (booking reference, customer name, product itinerary/stay, payment summary `CUR amount`, and a My Bookings link where the e-ticket/vouchers live) and `enqueue()`s one outbox row per channel. `enqueue` performs **no network I/O** and runs in the confirmation's own transaction, so it is atomic with the CONFIRMED status and cannot roll a confirmation back over a slow mail server. It is idempotent per `(booking_ref, channel)`. `process_pending()` sends queued/retriable rows best-effort, records `sent`/`failed`/`suppressed`, retries failures up to `booking_confirmation_max_attempts`, then parks them for staff (`failed()`). **No card number, gateway token or credential is ever composed, stored or logged.**
- **Outbox table** `customer_booking_notifications` (migration **0096**) — B2C-scoped (its own `customers` FK, `customer_*` prefix; not folded into the merchant `msg_logs`). Unique `(booking_ref, channel)` is the idempotency key.
- **Delivery driver** — a background outbox sweep (`main._confirmation_outbox_loop`), the same bare-asyncio pattern as the completion and payment sweeps, gated by `booking_confirmation_sweep_enabled`.

**Honesty-by-design:** SMTP unconfigured → `suppressed` (nothing wrong, nothing sent), a configured server refusing → `failed` (retried), SMS off → `suppressed`. A send is only ever marked `sent` when a provider accepted it.

## Bug 3 — Tour-package enquiry admin management — **FIXED AND TESTED**

Mirrors the existing Gaming Tour enquiry desk exactly (the two models are the same shape).

**What was built:**
- **Model** (`TourPackageEnquiry`, migration **0097**): `assigned_admin_id` (→ `users.user_id`, ON DELETE SET NULL), `admin_notes` (internal, never shown to the customer), `updated_at`; the status CHECK widened from NEW/CONTACTED/CLOSED to the full workflow NEW/ASSIGNED/CONTACTED/QUOTE_SENT/CONVERTED/CLOSED/CANCELLED (the originals are a subset, so existing rows stay valid).
- **Service**: `list_enquiries` (status filter, search, pagination), `get`, `update` (PATCH — only sent fields; assigning an admin to a NEW row auto-moves it to ASSIGNED), `counts`, `admin_item_dict`/`admin_names_for` (one query for a page's assignee names, no N+1), and `audit_trail`.
- **Router** (same file as the public submission, scoped by permission not URL prefix): `GET /api/admin/tour-package-enquiries` (list), `/counts`, `/{id}` (detail), `/{id}/history` (audit), `PATCH /{id}`. Every route requires the new RBAC code **`tour_package.enquiry.manage`** (held by ADMIN; a granular grant, so even SUPER_ADMIN does not hold it — same as Gaming).
- **Audit history**: each admin write logs an actor-attributed System-Logs row (`module=TourPackageEnquiries`, the enquiry id, and the `from_status`/`to_status` transition), read back by `/history`.
- **Admin portal**: `admin-tour-package-enquiries.js` + a nav item, a `#section-tour-package-enquiries` panel and a detail modal (status/assign/notes + a live history panel) in `admin/index.html`, dispatched from `admin.js`.
- **Preserved:** the public `POST /api/customer/tour-package-enquiries` and its courtesy desk email are untouched (a regression test asserts a submission still stores a `NEW` enquiry).

## Changed files (Phase 2)

```
backend/app/config.py                                   (Bug 1: SMS + outbox settings)
backend/app/services/sms_service.py                     (Bug 1, new)
backend/app/services/booking_confirmation_service.py    (Bug 1, new)
backend/app/models_customer.py                          (Bug 1: CustomerBookingNotification)
backend/alembic/versions/0096_customer_booking_notifications.py  (Bug 1, new migration)
backend/app/services/payment_verification_flight_service.py     (Bug 1: enqueue hook)
backend/app/services/payment_verification_hotel_service.py      (Bug 1: enqueue hook)
backend/app/services/payment_verification_service.py            (Bug 1: enqueue hook)
backend/app/main.py                                     (Bug 1: outbox sweep loop)
backend/app/models_v2.py                                (Bug 3: enquiry admin columns + __repr__ fix)
backend/alembic/versions/0097_tour_package_enquiry_admin.py     (Bug 3, new migration)
backend/app/auth/rbac.py                                (Bug 3: TOUR_PACKAGE_ENQUIRY_MANAGE)
backend/app/schemas/tour_package_enquiry.py             (Bug 3: admin schemas)
backend/app/services/tour_package_enquiry_service.py    (Bug 3: admin service layer)
backend/app/routers/tour_package_enquiries.py           (Bug 3: admin endpoints)
frontend/assets/js/admin-tour-package-enquiries.js      (Bug 3, new admin screen)
frontend/assets/js/admin.js                             (Bug 3: loadSection dispatch)
frontend/admin/index.html                               (Bug 3: nav + section + modal + script)
backend/tests/test_sms_service.py                       (Bug 1, new test)
backend/tests/test_booking_confirmation_service.py      (Bug 1, new test)
backend/tests/test_booking_confirmation_integration.py  (Bug 1, new test)
backend/tests/test_tour_package_enquiry_admin_http.py   (Bug 3, new test)
frontend/tests/admin-tour-package-enquiries.test.js     (Bug 3, new test)
```

## Phase 2 outstanding risks / external dependencies
- **Migration run not performed here.** Phase 1 introduced no migration; Phase 2 introduces **0096** and **0097**. They are additive and have been exercised on the SQLite test harness, but the PostgreSQL 18 up/down run (the `postgres-migrations` CI job) has **not** been run on this machine and must pass before deploy.
  - **Phase 3 update:** on the integrated branch the PostgreSQL 18 up/down run **was** subsequently performed on a disposable PG18 container and recorded in the Phase 3 test evidence — `alembic upgrade head` applied all revisions through **`0098`** (single linear head), and `alembic downgrade 0095_customer_admin_audit_logs` reversed `0098`/`0097`/`0096` with a re-upgrade re-applying them. **No production migration was run** (disposable container only).
- **Migration-number collision.** The (then-unmerged) multi-segment branch (Bugs 2/5) also numbered its migration **0096**. **Resolved in Phase 3:** renumbered into one linear chain — `0096_booking_segments` → `0097_booking_notifications` → `0098_tour_package_enquiry_admin` (single head `0098`).
- **Live delivery is an ops dependency.** Booking-confirmation email needs live SMTP; SMS needs `sms_enabled=true` + a configured provider. With neither, sends are recorded `suppressed`, never falsely `sent`. See the deployment checklist §4.
- **No production data touched.** No live SMS/email was sent; no production database was modified; nothing was pushed, merged or deployed.

---

## Phase 3 — Integration + demo-flight bookability (2026-11-22)

**Branch:** `claude/phase2-integration-demo-bookable` — a fresh integration of `claude/jackpotsworld-phase-2-bugs-1080f3` (base: Phase 1 + Phase 2 Bugs 1/3 + HDFC) with `claude/phase-2-booking-segments-e6a6b0` (multi-segment Bugs 2/5). The two source branches were left untouched; this branch was built with `git merge --squash` so **nothing is committed yet** (staged for review).

### Migration numbering resolved (the collision both prior docs flagged)
The two Phase 2 branches each numbered a migration `0096`. They were renumbered into one linear chain:

| Rev | Migration | Purpose |
| --- | --- | --- |
| `0096_booking_segments` | multi-segment bookings | `customer_booking_segments` (Bugs 2/5) |
| `0097_booking_notifications` | booking-confirmation outbox | `customer_booking_notifications` (Bug 1) |
| `0098_tour_package_enquiry_admin` | enquiry admin | columns + widened status CHECK (Bug 3) |

Single head `0098`; `down_revision` chain verified linear.

**Latent bug found and fixed:** the Bug 1 revision id `0097_customer_booking_notifications` is **35 characters**, exceeding alembic's default `alembic_version.version_num` `VARCHAR(32)`; `alembic upgrade` fails with `StringDataRightTruncation` on a fresh database. (This was already true of its `0096_*` form on the source branch — it had simply never been run against a fresh 32-wide column.) The revision id was shortened to **`0097_booking_notifications`** (26 chars). It is the only id in the project exceeding 32.

### Demo/sample flights are now bookable
The prior model booked one flight per booking; round-trip/multi-city and sample flights were blocked in the frontend. With multi-segment integrated, the frontend `checkoutHold` sample block was removed so one-way, round-trip and multi-city are all bookable in demo mode. **No backend change was required:** `payment_verification_flight_service.confirm_booking` already lets a demo flight confirm (`supplier_guard`), while a live-supplier flight still needs a real supplier order id. Every legitimate guard — amount-equals-envelope-total across all segments, currency match, no partial payments, supplier guard, idempotent confirmation — is unchanged. False "Sample flight — not bookable" labels became honest "demonstration data" disclosures.

### One confirmation per booking (not per segment)
A multi-segment booking is one `customer_bookings` envelope (one `booking_ref`) owning N segments. `confirm_booking` enqueues once on the envelope, and the outbox is idempotent per `(booking_ref, channel)`. New test `backend/tests/test_multi_segment_confirmation.py` proves a round-trip (2 segments) and a multi-city (3 segments) each yield exactly one confirmation (one email + one SMS), idempotent on redelivery, and that an amount mismatch across segments confirms nothing.

### No production data touched (Phase 3)
No live SMS/email; no production database (only a disposable PG18 container, since removed); nothing pushed, merged or deployed; not committed.
