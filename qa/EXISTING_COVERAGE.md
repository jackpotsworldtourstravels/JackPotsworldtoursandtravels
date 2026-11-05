# Existing Test Coverage Mapping — Stage 2

Every existing test file, its suite, size and what it covers. Baseline run (2026-11-04): pytest **1103 passed**, node **14/14 + 155/155**. `verify_*` and CDP suites were **not run** here (need live server / local Chrome).

## 1. Backend pytest — `backend/tests/` (fast, SQLite shim, in CI)

| File | Tests | Covers |
| --- | ---: | --- |
| `test_booking_row_name_composition.py` | 11 | Real flight, hotel and package bookings: first / middle / last on the rows that are written. |
| `test_customer_notifications.py` | 2 | Customer notifications: written once per event, counted, and per-customer. |
| `test_customer_wishlist.py` | 5 | Customer wishlist: saved once per item, owner-scoped, removable. |
| `test_customer_wishlist_notes.py` | 10 | Customer wishlist NOTES: owner-scoped CRUD, blank == NULL, re-save safe. |
| `test_deferred_sweep_isolation.py` | 4 | One bad deferred event must not hold the others hostage. |
| `test_deferred_sweep_products.py` | 6 | The deferred-event sweep, for every product. |
| `test_duffel_adapter.py` | 32 | The Duffel adapter, pinned without a network or a token. |
| `test_eticket.py` | 7 | E-ticket tokens: signed, per booking, unforgeable, and the public view is minimal. |
| `test_flight_conversation.py` | 83 | The flight conversation, the airport/date/slot modules, and the model layer. |
| `test_google_auth.py` | 15 | Google sign-in: identity verification, and the sign-in / link / create rules. |
| `test_hdfc_flow.py` | 28 | HDFC SmartGateway through the platform's own payment path, end to end. |
| `test_hdfc_production.py` | 37 | Production readiness of the HDFC SmartGateway integration. |
| `test_hdfc_products.py` | 7 | HDFC through the PACKAGE and FLIGHT verifiers, not just the hotel one. |
| `test_hdfc_provider.py` | 60 | The HDFC SmartGateway adapter, against HDFC's documented request/response shapes. |
| `test_hdfc_success_display.py` | 5 | The HDFC gateway order id on the reconcile response — the one thing the |
| `test_hotel_provider_images.py` | 10 | Provider-image wiring on the customer hotel responses. |
| `test_hotel_trust_signals.py` | 5 | The hotel result card's trust signals must be grounded, never inferred. |
| `test_package_departures.py` | 7 | A package departure that has already left cannot be sold. |
| `test_payment_guards_combined.py` | 22 | The Razorpay and TrustBrick test-key guards, and HDFC's, working together. |
| `test_payment_identity.py` | 10 | A provider payment id is not a stable identity; the order is. |
| `test_payment_safety_guard.py` | 9 | The guard that keeps the B2C payment fixtures off anything real. |
| `test_payment_webhook_router.py` | 4 | Router-level guards on the payment webhook endpoint. |
| `test_place_matcher.py` | 61 | Typo-tolerant place matching, and what the assistant does with a near miss. |
| `test_razorpay_test_key_guard.py` | 16 | A Razorpay TEST key (rzp_test_...) must not collect on a deployed host. |
| `test_rbac.py` | 13 | RBAC permission tests — refund lifecycle foundation. |
| `test_recently_viewed.py` | 6 | Recently viewed: chronological, deduped, resolved, owner-scoped. |
| `test_sandbox_guard_resume_and_hosts.py` | 16 | Two hardening fixes to the sandbox payment guard, each pinned by regression tests. |
| `test_sandbox_payment_guard.py` | 31 | A sandbox gateway must never quietly collect from the public. |
| `test_saved_traveller_http.py` | 14 | The saved-traveller routes, over real HTTP (FastAPI's TestClient) rather than by calling the handlers. |
| `test_saved_traveller_names_and_contact.py` | 13 | Saved travellers keep first / middle / last apart, keep their own phone and |
| `test_travel_assistant_voice.py` | 70 | The Travel / Voice Assistant — service intents, entities, follow-ups, routing. |
| `test_trustbrick_test_key_guard.py` | 14 | TrustBrick on a deployed host must never collect through a Razorpay TEST key. |

**Total: 32 files, 633 test functions.**

## 2. Frontend node:test — `frontend/tests/` + `tests/js/` (in CI)

| File | Cases | Suite |
| --- | ---: | --- |
| `flight-sort-chips.test.js` | 14 | frontend/tests |
| `hdfc-success-order-id.test.js` | 11 | frontend/tests |
| `hotel-image-map.provider.test.js` | 1 | frontend/tests |
| `offers-strip.test.js` | 7 | frontend/tests |
| `page-wiring.test.js` | 2 | frontend/tests |
| `recently-viewed.test.js` | 5 | frontend/tests |
| `saved-traveller-names-contact.test.js` | 28 | frontend/tests |
| `saved-travellers-picker.test.js` | 47 | frontend/tests |
| `saved-travellers.test.js` | 6 | frontend/tests |
| `search-live-region.test.js` | 2 | frontend/tests |
| `wishlist-account-enrichment.test.js` | 3 | frontend/tests |
| `wishlist-compare.test.js` | 4 | frontend/tests |
| `wishlist-notes.test.js` | 14 | frontend/tests |
| `wishlist-package.test.js` | 17 | frontend/tests |
| `assistant-results.test.mjs` | 69 | tests/js |
| `flight-filters.test.mjs` | 39 | tests/js |
| `header-icons.test.mjs` | 14 | tests/js |
| `round-trip.test.mjs` | 33 | tests/js |
| `voice-handoff.test.mjs` | 14 | tests/js |

## 3. Browser UI (CDP) — `tests/js/browser/` (NOT in CI; needs Chrome)

| File | Cases | Covers |
| --- | ---: | --- |
| `booking-width.ui.test.mjs` | 7 | One outer measure for the whole flight and hotel booking flows — the flight results page's. |
| `cdp.mjs` | 2 | A minimal Chrome DevTools Protocol client — no dependency. |
| `cls-sources.mjs` | 0 | Which elements move, and when? Reports every layout shift on a page with the nodes involved. |
| `destination-glance.ui.test.mjs` | 5 | The destination page's at-a-glance box: cream plate, thin gold border, circular icons, faint line-art — in the SAME |
| `flight-filters.ui.test.mjs` | 2 | The Flights filter panel, in a real browser: it filters, counts, clears and lays out at every width. |
| `hero-alignment.ui.test.mjs` | 2 | Flights and Hotels share one hero layout: the heading starts at the same distance from the header, and the |
| `hero-stability.ui.test.mjs` | 6 | The landing hero: a booking card that is as tall as its own panel, and a hero picture that stays put as the |
| `image-audit.mjs` | 2 | Walks the site in a real browser and reports every image problem it can see. |
| `image-audit.test.mjs` | 1 | The site's images, in a real browser, at the widths people actually use. |
| `image-credits.ui.test.mjs` | 1 | The Image Credits page: the one place the licences' attribution is shown, reachable from every footer. |
| `layout-stability.test.mjs` | 1 | Layout stability: the pages whose content used to jump while loading must not jump again. |
| `no-attribution.ui.test.mjs` | 3 | No photographer credit, licence label or image-source line is drawn anywhere on the site. |
| `packages-filters.ui.test.mjs` | 2 | Packages page: the filter list must not appear late and push the results down. |
| `responsive-helpers.mjs` | 8 | Shared by the responsive browser tests: the seven target viewports, the in-page measurement, and page opening. |
| `responsive-interactions.ui.test.mjs` | 17 | The controls that are the product, driven at each of the seven target viewports (375x667, 393x852, 412x968, |
| `responsive-states.ui.test.mjs` | 12 | The states a page is in when it is NOT the ideal, fully populated one - at phone, tablet and desktop widths and on a phone turned |
| `responsive-viewports.ui.test.mjs` | 6 | Every customer-facing page, at every target viewport (CSS pixels, not device pixels). |
| `results-layout.ui.test.mjs` | 7 | Flight and hotel results pages: no Booking Summary rail, and the result cards run to the right edge of the |
| `round-trip.ui.test.mjs` | 16 | Round trips, in a real browser: the checkout hold cannot be walked around, and one-way still flows. |
| `service-nav.ui.test.mjs` | 6 | The header's four service links, in a real browser: Flights, Hotels, Tour Packages, Gaming Tour Packages. |
| `summary-card.ui.test.mjs` | 15 | Fare Summary (flights) and Booking Summary (hotels): pale gold, always open, no dropdown arrow. |
| `travel-assistant.ui.test.mjs` | 15 | The Travel Assistant in a REAL browser: its panel, its conversation, its |
| `voice-handoff.ui.test.mjs` | 13 | The Voice Assistant's hand-off to the booking card, its closing, and its memory — |

## 4. End-to-end HTTP scripts — `tests/verify_*.py` (need live server + seeded DB → BLOCKED here)

| Script | Covers |
| --- | --- |
| `verify_api.py` | End-to-end API verification for the enquiry-led booking + documents work. |
| `verify_asset_versions.py` | Asset cache tags: every ?v= in the customer HTML must match its file. |
| `verify_assistant.py` | Partner Assistant — intent classification, and the wall between it and the data. |
| `verify_booking_completion.py` | Ticket Issued is not Completed — a booking completes when the journey has. |
| `verify_call_management.py` | CR-10 follow-up — call ownership, hold and transfer, verified over real sockets. |
| `verify_canonical.py` | The canonical URL on every indexable page. |
| `verify_cr2.py` | CR-2 — Manager approval step, and the payment workflow bypassed for Classic Tours. |
| `verify_cr3.py` | CR-3 — the merchant approves its own Booking Requests. |
| `verify_cr4a.py` | CR-4a — the wallet ledger: schema, arithmetic, locking, backfill. |
| `verify_cr4b.py` | CR-4b — the money moves: auto-debit at Ticket Issued, credit limit, refunds. |
| `verify_cr4c.py` | CR-4c — the merchant's wallet screen: balance, ledger, and adding money. |
| `verify_cr4d.py` | CR-4d — the staff wallet desk: payment accounts, verification, reconciliation. |
| `verify_cr5.py` | CR-5 — the enquiry answer becomes a binding quotation. |
| `verify_customer_portal.py` | Customer Portal V1 (migration 0044) — the B2C module that shares nothing with B2B. |
| `verify_direct_booking.py` | Book Directly — a booking raised with no enquiry in front of it. |
| `verify_fare_seed.py` | The price on the results card is the price the booking quotes. |
| `verify_footer.py` | The company footer, and the pages every one of its links promises. |
| `verify_group_booking.py` | Group Booking — the passenger list arrives as a spreadsheet (migration 0042). |
| `verify_guest_session.py` | Continue as guest — a real session, isolated from every other one, and keepable. |
| `verify_image_assets.py` | Image assets: what ships, what the code points at, and what the server delivers. |
| `verify_live_chat.py` | CR-9 slice 1 — the live chat data model and service layer. |
| `verify_m1.py` | M1 verification — Booking Operations backend core. |
| `verify_m1_concurrency.py` | Concurrency check for assign() and add_note() — no deadlocks, no torn writes. |
| `verify_m2.py` | M2 verification — ticket upload, invoice/confirmation PDFs, merchant delivery. |
| `verify_m3.py` | M3 verification — cancellation & reschedule workflow. |
| `verify_m4.py` | M4 — Finance, Billing & Payment Tracking. |
| `verify_m5.py` | M5 — email & in-app notifications: channels, logging, opt-out, failure surfacing. |
| `verify_m6.py` | M6 — analytics, reports and dashboard figures. |
| `verify_m7.py` | M7 — merchant booking history, ticket delivery and downloads. |
| `verify_m8.py` | M8 — security, performance and production hardening. |
| `verify_m9.py` | M9 — the checks that guard the suite itself, and the migration path. |
| `verify_manager_approval.py` | Manager approval verification — the merchant's own sign-off in front of ours. |
| `verify_manual_booking_unquoted.py` | Raise Booking on a Manual Enquiry that nobody has quoted. |
| `verify_merchant_no_approval.py` | Merchant onboarding — created is active, and there is nothing left to approve. |
| `verify_merchant_ui_parity.py` | The Merchant Portal is ONE interface for every merchant account. |
| `verify_open_graph.py` | Complete Open Graph + Twitter card metadata on every indexable page. |
| `verify_package_catalogue.py` | The tour-package journey: three shelves, filters the database applies, and a page per trip. |
| `verify_passenger_lookup.py` | Passenger auto-fill — `GET /api/passengers/lookup`. |
| `verify_passport_ocr.py` | Passport OCR (migration 0042) — extraction, confidence, duplicates, audit. |
| `verify_payment_requests.py` | Admin-initiated payment requests — the desk asks, the manager pays (0041). |
| `verify_payments.py` | The B2C payment gateway — security, integrity and concurrency. |
| `verify_providers.py` | Provider Management (0039) — the suppliers the desk buys tickets FROM. |
| `verify_responsive.py` | Every portal screen, on a phone, in a real browser. |
| `verify_seed_race.py` | The admin seed, run concurrently — the way gunicorn actually runs it. |
| `verify_storage.py` | Storage-backend verification — the local disk and S3 paths, side by side. |
| `verify_storage_s3.py` | S3 backend against the real AWS SDK. |
| `verify_structured_data.py` | Valid schema.org structured data (JSON-LD) on every indexable page. |
| `verify_support_center.py` | Support Center verification — the merchant-facing support surface. |
| `verify_travel_assistant_routing.py` | Travel Assistant — what a spoken sentence was understood to be, and where it sends the traveller. |
| `verify_trustbrick_payments.py` | The TrustBrick partner payment adapter — signing, callbacks, selection. |
| `verify_voice_calls.py` | CR-10 — voice calling, verified against a running server. |

**Total: 51 E2E scripts.** Run via `python tests/run_all.py` against a live backend.

## 5. E2E support harness — `tests/` (not tests themselves)

| File | Role |
| --- | --- |
| `config.py` | Shared configuration for the verification suite. |
| `demo_payment_flow.py` | End-to-end demonstration of the whole payment workflow, on real endpoints. |
| `flows.py` | Reusable end-to-end flows against the live API. |
| `minihttp.py` | Tiny stdlib HTTP helper so the verification scripts need no third-party deps. |
| `payfix.py` | Shared fixture for the B2C payment tests — books through the REAL API. |
| `payment_safety.py` | Refuse to run the B2C payment fixtures anywhere that can take real money. |
| `pdftext.py` | Minimal PDF text extraction — enough to assert on generated document content. |
| `run_all.py` | Run the whole verification suite, in order, against a live backend. |

## 6. Load testing — `loadtest/` (locust, staging only, not run)

| File | Role |
| --- | --- |
| `locustfile.py` | Load test for the JackpotsWorld customer site. |
| `seed_accounts.py` | Create test members and mint access tokens for the signed-in load cohort. |
