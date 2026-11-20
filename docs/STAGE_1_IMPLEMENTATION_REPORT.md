# Stage 1 Implementation Report — Gaming Fail-Closed + B2B/B2C Permission Isolation

**Project:** JackPots World Tours & Travels
**Date:** 2026-11-12
**Scope:** Local development codebase only. No production change, no deployment, no git push, no database migration, no payment/refund. Gaming remains disabled.

> **STAGE 1 CLOSURE (2026-11-12):** the three residuals from the first pass are resolved — the refund/cancellation module, the admin live-chat/WiFi-calling console, and the Expo mobile app. See the **Stage 1 Closure** section at the end of this report (the required 8-point closure report).

---

## 1. Summary of implemented functionality

**Stage 1A — Gaming Tour Packages fail-closed.** A new `GAMING_TOUR_PACKAGES_ENABLED` setting defaults to disabled and is interpreted fail-closed (missing / empty / invalid / "false" ⇒ disabled; only an explicit truthy value enables it). Every gaming backend route (public submission + admin queue) is gated and returns **404** while disabled, the service layer refuses to create or mutate gaming records, the admin dashboard shows zero gaming activity, and the public web entry points (nav link, page, sitemap, admin nav) are hidden. Existing gaming tables and rows are untouched.

**Stage 1B — B2B/B2C permission isolation.** A new `b2c.*` permission namespace and a `require_scope` dependency enforce, on the backend, that a B2B-only administrator cannot reach protected B2C admin endpoints and vice versa. `require_scope` consults *explicit* per-user grants (never the role-default matrix), so a `role=admin` account no longer implicitly gains B2C access. A super admin still holds everything; an operator granted both domains can use both.

No second database, engine, pool, session factory, or Alembic history was introduced. One `DATABASE_URL`, one engine, one `get_db` — unchanged.

---

## 2. Every modified file and why

### Stage 1A
| File | Change |
|---|---|
| `backend/app/config.py` | Added `gaming_tour_packages_enabled` (raw `str`, not `bool`, so an invalid value can't crash startup) + `gaming_enabled` property (fail-closed interpretation). |
| `backend/app/routers/gaming_tour_enquiries.py` | Added a **router-level** `_require_gaming_enabled` dependency → 404 on every gaming route (public + admin) while disabled. |
| `backend/app/services/gaming_tour_enquiry_service.py` | Added `GamingDisabledError` + `_assert_enabled()`; `create()` and `update()` refuse when disabled (blocks indirect creation by jobs/integrations); `counts()` returns zeros without querying the table. |
| `frontend/assets/js/jw-header.js` | Removed the public "Gaming Tour Packages" nav link. |
| `frontend/sitemap.xml` | Removed the `/gaming-packages` URL entry. |
| `frontend/gaming-packages.html` | `noindex,nofollow` + redirect to home (page hidden from the public site). |
| `frontend/admin/index.html` | Hid the Gaming Tour Packages admin sidebar entry. |

### Stage 1B
| File | Change |
|---|---|
| `backend/app/auth/rbac.py` | Added the `b2c.*` permission codes to `P`, a `B2C_SCOPES` set, and the `require_scope(...)` dependency (explicit-grant semantics; role defaults never consulted). |
| `backend/app/routers/admin_customer_bookings.py`, `admin_reviews.py`, `admin_user_activity.py`, `admin_communication.py`, `customer_admin.py` | Swapped `require(P.CUSTOMER_VIEW)` → `require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW)`. |
| `admin_catalogue.py`, `admin_catalogue_hotels.py`, `admin_catalogue_packages.py`, `admin_catalogue_destinations.py` | Swapped `require(P.CATALOG_MANAGE)` → `require_scope(P.B2C_CATALOGUE_MANAGE, P.CATALOG_MANAGE)`. |
| `admin_reconciliation.py`, `customer_payment_admin.py` | Swapped `require(P.PAYMENT_VERIFY)` → `require_scope(P.B2C_PAYMENTS_VERIFY, P.PAYMENT_VERIFY)`. |
| `admin_b2c_reports.py` | `_VIEW`/`_EXPORT` now `require_scope(P.B2C_REPORTS_VIEW/EXPORT, P.CUSTOMER_VIEW)`. |
| `backend/tests/test_rbac.py` | Updated the permission-catalogue snapshot to exclude the new `b2c.*` namespace and assert no role default holds a `b2c.*` scope. |

### New test files
`backend/tests/test_gaming_fail_closed.py`, `backend/tests/test_b2c_permission_isolation.py`.

### NOT my changes (pre-existing uncommitted work, visible in `git diff` but untouched by Stage 1)
`backend/app/auth/security.py`, `super_admin.py`, `services/audit_service.py`, `auth_service.py`, `customer_auth_service.py`, `otp_service.py`, `frontend/about.html`, `about-page.css`, `backend/tests/test_admin_permissions.py`. These were already `M`/`??` at the start of the session.

---

## 3. Gaming entry points found and how each is disabled

| Entry point | How disabled |
|---|---|
| Public `POST /api/customer/gaming-tour-enquiries` | Router-level 404 gate (fail-closed). |
| Admin `GET/GET{id}/PATCH /api/admin/gaming-tour-enquiries` | Same router-level 404 gate. |
| Service `create()` / `update()` (any indirect caller: jobs, integrations) | `_assert_enabled()` raises `GamingDisabledError`. |
| Admin dashboard gaming counts (`dashboard_service` → `gaming_tour_enquiry_service.counts`) | `counts()` returns zeros without touching the table. |
| Public website nav link | Removed from `jw-header.js`. |
| Public gaming page `gaming-packages.html` | `noindex` + redirect to home. |
| SEO sitemap entry | Removed from `sitemap.xml`. |
| Admin portal sidebar entry | Hidden in `frontend/admin/index.html`. |
| Gaming DB table + rows | **Preserved** — nothing dropped or deleted. |

**Backend is the authoritative gate** (404 on direct API/URL/manipulated requests); frontend hiding is secondary.

---

## 4. B2B/B2C permission architecture and enforcement

- **Mechanism:** `require_scope(*codes)` authenticates the caller (`get_current_user`) and passes only if the user is a super admin **or** explicitly holds one of the `b2c.*` codes in `users.permissions`. It never consults the role-default matrix, so `role=admin` alone grants nothing in B2C.
- **B2B side unchanged:** B2B endpoints keep their existing `require(...)` / role gates and permission codes.
- **Outcome:** B2B-only admin → **403** on B2C; B2C-only operator → **403** on B2B; dual-grant and super admin → both. Frontend mode selection is never trusted; enforcement is server-side.
- **Backward compatibility:** each swapped endpoint accepts the new `b2c.*` code **or** its legacy code, so an operator explicitly granted the legacy code keeps working while role-default-only B2B admins are now excluded.

---

## 5. Tests executed, with actual results

Runner: `venv` pytest (SQLite harness). Commands and real outcomes:

- `tests/test_gaming_fail_closed.py` + `tests/test_b2c_permission_isolation.py` → **46 passed**.
- Regression (refunds, rbac, admin permissions, gaming, isolation) → **197 passed, 3 skipped**.
- **Full backend suite excluding the two pre-existing-broken files** → **1631 passed, 4 skipped, 0 failed**.

New tests cover: missing/invalid/empty/false config ⇒ disabled; explicit truthy ⇒ enabled; public + admin + direct-URL gaming access blocked when disabled; service create refused + counts zeroed when disabled; normal (non-gaming) flows unaffected (whole suite green); B2B-only→403 on B2C; B2C-only→403 on B2B; dual-grant and super admin reach both; unauthenticated rejected.

---

## 6. Failing tests / unresolved issues

- **44 failures in `tests/test_token_revocation.py` and `tests/test_admin_supplier_reservation_http.py` are PRE-EXISTING and unrelated to Stage 1.** Proven by stashing only my edits and re-running: they fail identically at baseline (JWT `ExpiredSignatureError` / token-`iat` timing, part of the uncommitted `security.py`/`auth_service.py` work in progress). My changes add **zero** regressions.

---

## 7. Single-database architecture confirmation

Unchanged. No `CUSTOMER_DATABASE_URL`, `CustomerSessionLocal`, `get_customer_db`, second engine, second pool, or second Alembic history. One `DATABASE_URL`, one engine, one `SessionLocal`/`get_db`. **No database migration was created or run.**

---

## 8. Production / deployment / git confirmation

No production database was connected or queried. No production configuration changed (no `.env`/secrets touched). No deployment. **No git commit, push, merge, or release.** (A temporary local `git stash`/`pop` was used solely to establish the pre-existing-failure baseline in §6 and was immediately reverted — no commit.)

---

## 9. Gaming Packages remain disabled

Confirmed: `settings.gaming_enabled` is `False` by default (no env value set). All gaming routes return 404, the service refuses writes, and the public/admin surfaces are hidden. Gaming was **not** enabled.

---

## 10. Remaining risks and recommended next stage

**Known residuals (backend authorization present, but NOT yet moved to the `b2c.*` isolation):**
1. **`admin_cancellations.py` (B2C refund/cancellation maker-checker).** Left on the existing role-aware `require(P.REFUND_*)`/`require(P.CUSTOMER_VIEW)` deliberately: that module depends on the `effective_permissions` model (role defaults + super-admin-is-not-auto-executor) that its two-person suite encodes. Forcing it onto `require_scope` changed that behavior and broke the refund suite, so I reverted it to protect the refund workflow. It therefore remains reachable by a role-default B2B admin. **Follow-up:** isolate it with a coordinated update to the maker-checker permission model and its tests.
2. **`admin_chat.py` (B2C live-chat/WiFi-calling console).** Still authorizes via `get_current_admin` (any B2B admin). It has WebSocket routes whose auth I could not safely re-gate without a WS-capable test, and live chat/WiFi-calling are on the preserve list. **Follow-up:** add `require_scope(P.B2C_CHAT_MANAGE)` to its HTTP routes (and design WS auth) with WS testing.

**Other residuals:**
3. **Mobile app (`mobile-app/`)** gaming screen/nav were **not** edited. The screen already fails closed functionally (its submission hits the now-404 backend), but the UI entry points remain. Editing them needs the Expo/jest/tsc toolchain (not runnable here) to avoid breaking the mobile build/tests. **Follow-up:** hide the mobile gaming route/nav and update its tests under the mobile toolchain.
4. **Landing-page gaming card / package-listing shelf** still render an entry that now leads to the redirecting (hidden) page; harmless but cosmetic. **Follow-up:** remove those cards for tidiness.
5. **Provisioning:** existing non-super admins who relied on role-default B2C access now need explicit `b2c.*` grants in `users.permissions`. The super-admin seed is unaffected. This is a data/provisioning step (no migration), to be done when the change is deployed.

**Recommended next stage:** (a) isolate `admin_cancellations` and `admin_chat` with the coordinated permission-model + test updates above; (b) the frontend admin portal nav scope-gating (hide unauthorized items per `b2c.*`, backend already enforces); (c) the mobile hide; then Stage 2 (the `customer_admin_audit_logs` table) which was explicitly out of scope here.

---

**Honest status (first pass):** Stage 1A (gaming fail-closed) complete; Stage 1B isolation enforced on most B2C admin endpoints but not yet on the refund/cancellation and live-chat modules. **Those two, plus the mobile app, are now closed below.**

---

# Stage 1 Closure (2026-11-12)

Resolves the three residuals (§10.1–3). Still local-only: no migration, no second database, no production access, no git commit/push, no real payment/refund, Gaming never enabled, no gaming data/table deleted.

## 1. Files changed (closure)

**Backend**
| File | Change |
|---|---|
| `backend/app/auth/rbac.py` | Added `require_b2c_access()` — a B2C **domain gate** (super admin or any explicit `b2c.*` scope) that carries no capability of its own. |
| `backend/app/routers/admin_cancellations.py` | Router-level `dependencies=[Depends(require_b2c_access())]`. The per-endpoint `require(P.REFUND_*/CUSTOMER_VIEW)` capability checks are **unchanged**. |
| `backend/app/routers/admin_chat.py` | Added `get_current_b2c_admin` (admin role gate + B2C domain) and applied it to every HTTP route, including `POST /ws-ticket`. The `/ws` WebSocket route, ticket broker, heartbeat and call-signalling are **untouched**. |

**Frontend (website, for mobile⇄website parity consistency)**
| File | Change |
|---|---|
| `frontend/index.html` | Removed the Gaming link from the primary header nav and the mobile drawer nav; renumbered the drawer (Contact 05→04). |
| `frontend/assets/js/site-footer.js` | Removed `Gaming Packages` from the footer `travel` list. |

**Mobile (Expo)**
| File | Change |
|---|---|
| `mobile-app/src/app/gaming/index.tsx` | Replaced the enquiry screen with `<Redirect href="/" />` — direct navigation to `/gaming` is blocked and no form renders. |
| `mobile-app/src/features/search/SearchCard.tsx` | Removed the Gaming tab (type, `TABS`, render branch, `GamingTab`). |
| `mobile-app/src/components/HeaderActions.tsx` | Removed the Gaming drawer menu item. |
| `mobile-app/src/features/home/SiteFooter.tsx` | Removed the Gaming footer link. |

**Tests added / updated**
- Added `backend/tests/test_admin_chat_b2c_isolation.py` (WebSocket/ticket authorization).
- Updated `backend/tests/test_customer_refunds.py` + `test_customer_refunds_http.py` (operators now hold an explicit `b2c.*` domain scope; added a B2B-only→403 isolation test).
- Updated mobile `tests/screens/{gaming,search-card,header-actions,home}.test.tsx` to reflect gaming removal.
- *Kept `gamingForm.ts` / `enquiries.ts` intact so re-enabling is a single change and the form-logic tests still run.*

## 2. Authorization changes

- **`require_b2c_access`** (domain) vs the existing **`require` / `require_scope`** (capability) are now two orthogonal axes. Refund endpoints keep `require(P.REFUND_*)` for capability and gain `require_b2c_access` for domain — so a role-default B2B admin (no `b2c.*` scope) is refused at the door, while every capability rule (maker-checker, super-admin-view-only, "authorize held by no role") is byte-for-byte unchanged.
- **`get_current_b2c_admin`** on `admin_chat` = the unchanged admin role gate **plus** the B2C domain. Because the agent WebSocket admits only a ticket minted by the (now-gated) `/ws-ticket` route, a B2B-only admin cannot obtain a socket ticket — isolation without touching the socket.

## 3. Refund maker-checker verification

`tests/test_customer_refunds.py` + `test_customer_refunds_http.py` pass in full. Verified unchanged: the maker (`refund.execute`) and checker (`refund.authorize`, held by no role) separation; two-person flow; idempotency; over-refund 409; fractional-paise rejection; reconcile/resolve-failed; **super admin can view but cannot execute** (`test_view_only_role_can_read_but_not_act`). New: a role-default B2B admin receives **403** on read and on act (`test_b2b_only_admin_is_refused_b2c_refund_admin`). No financial authorization was weakened — a domain gate was added in front of the unchanged capability checks.

## 4. WebSocket security verification

`tests/test_admin_chat_b2c_isolation.py` (6 tests) pass: a B2C support admin and a super admin can mint a socket ticket; a role-default B2B admin and a non-admin (even one holding a `b2c.*` scope) are refused (403); an unauthorized socket connection (invalid or missing ticket) is closed before `accept()`. The socket handshake, ticket broker, heartbeat, call-signalling, acceptance/rejection, transfer and reconnection code were not modified, so live chat and WiFi calling are preserved for authorized B2C support admins.

## 5. Mobile Gaming changes

Gaming navigation removed from the search tabs, the header drawer and the footer; the `/gaming` route redirects to Home, so direct navigation is blocked and the enquiry form never renders; a submission cannot be made from the app, and the backend enquiry API returns 404 regardless. Flights, Hotels and normal Tour Packages are untouched (their tests pass). `npx tsc --noEmit` is clean.

## 6. Actual test results

- **Mobile:** `tsc --noEmit` exit 0. `jest`: **858 passed, 3 failed, 861 total.** The 3 failures (`info-links.parity` ×2, `gaming.parity` ×1) are **pre-existing** — they fail identically on a clean baseline (verified by stashing my edits). **Zero new mobile failures.**
- **Backend:** full suite **1666 passed, 44 failed**; excluding the two pre-existing-broken files → **1638 passed, 0 failed**. All 44 failures are confined to `test_token_revocation.py` and `test_admin_supplier_reservation_http.py` (uncommitted WIP, JWT-expiry/timing), unchanged from baseline. **Zero new backend failures.**

## 7. Remaining limitations

- **Pre-existing failures (not mine, not touched):** backend token-revocation + supplier-reservation suites (44); mobile `info-links.parity` (2) and `gaming.parity` (1). The mobile `gaming.parity` test compares app copy to `gaming-packages.html`; it was already failing and is now moot since Gaming is disabled — left as-is rather than edited, to avoid masking a pre-existing failure.
- **Provisioning (no migration):** B2C operators now need explicit `b2c.*` grants in `users.permissions`; the super-admin seed is unaffected. A data/provisioning step for whenever this is deployed — not performed here.
- **Partner-login decorative list:** `frontend/index.html` still shows a static `<li>Gaming</li>` chip on the B2B partner-login panel (not a nav link or entry point). Left untouched as an unrelated B2B surface; noted for tidiness.
- **WebSocket test depth:** authorization is verified at the ticket boundary and the invalid-ticket close; a full end-to-end authenticated socket session (broker + call lifecycle) was not driven in tests.

## 8. Restrictions followed

Local development only ✓ · one PostgreSQL database ✓ · no second database/engine/pool/session/Alembic ✓ · no production database access ✓ · no migration created or run ✓ · no production deployment ✓ · no git commit or push ✓ (a transient local `git stash`/`pop` was used only to confirm pre-existing baselines and reverted) · no real payment/refund ✓ · Gaming never enabled ✓ · no gaming record or table deleted ✓.
