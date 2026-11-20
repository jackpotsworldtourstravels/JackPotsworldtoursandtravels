# Admin Portal — Live Verification Tracker

**Date:** 2026-11-16
**Scope:** Live runtime verification of the Admin Portal (`frontend/admin/index.html` + `frontend/assets/js/admin*.js`) against a running backend and a **disposable** PostgreSQL database.
**Reviewer:** Claude (Opus 4.8), under the owner's supervision.

---

## 1. Environment (safe, isolated — nothing permanent touched)

| Item | Value / Approach |
|---|---|
| Database | **Disposable** `jackpots_livecheck` on the local PostgreSQL 17 instance — created fresh for this test. |
| Permanent dev DB (`jackpots_v2`) | **Not touched.** |
| Production DB | **Not touched.** No production operation performed. |
| `backend/.env` and `backend/dev.db` | **Not modified.** DB URL + flags were passed as process **environment variables only**, which override `.env` in-memory (verified). |
| Migrations | `alembic upgrade head` on the throwaway DB → reached **0095**, clean (exit 0). Reviewed before running; pure DDL on an empty DB. |
| Seed | `scripts/seed_account.py` reviewed. Startup hook `ensure_default_admin` auto-seeds a super-admin. A dedicated test **admin** account was seeded with a full permission grant (throwaway only). |
| Backend | `uvicorn app.main:app` on **127.0.0.1:8099**, `DEPLOYED=false`. |
| Email (SMTP) | **Disabled** via env override (`SMTP_HOST=""`) so **no real email can be sent** by any module during the test. OTP fell back to dev mode. |
| Payments | Local/test mode (HDFC UAT test keys from `.env`). No payment was initiated. |
| Gaming packages | Left **disabled** (fail-closed). Not enabled. |
| Refunds | **Not touched** (not implemented/tested, per instruction). |

**Login credential used (throwaway DB only):** `live.ops@jackpotsworldtours.com` / role `admin`.

---

## 2. Login & session

| Check | Result |
|---|---|
| Admin login page renders | ✅ Clean render, served from backend origin. |
| Password step → OTP challenge | ✅ Works. |
| OTP verify → tokens issued | ✅ `access`/`refresh` issued; portal authenticated. |
| Portal role-gating | ✅ Correct by design — a **super_admin cannot open the Admin portal** (it has its own portal); only role `admin` may. Returns a generic 401 (does not leak account existence). |
| Dashboard loads real data | ✅ `GET /api/admin/dashboard` 200 — showed 2 merchants / 5 users / 0 service requests / 0 chats. |

---

## 3. All 38 navigation sections

Every one of the 38 sidebar sections was loaded via the SPA router with instrumentation on all API calls and JS errors.

- **Total API calls observed:** 69
- **JavaScript errors:** **0**
- **Sections with all APIs 200 OK:** 35 (after fix, 37)
- **Sections with a defect:** 2 (**fixed** — see §5)
- **Sections returning 404 by design:** 4 (gaming — fail-closed gate, correct)

| Section group | Sections | Result |
|---|---|---|
| Overview / B2B | dashboard, reports, users (Merchant Mgmt), active-users | ✅ 200 |
| Operations | ticket-enquiries, partner-requests, booking-ops, service-requests-mgmt, providers | ✅ 200 |
| Manual booking | manual-enquiry, manual-request | ✅ 200 |
| Finance | payments, wallet-desk, customer-payments | ✅ 200 (read-only) |
| Reports/analytics | reports-export*, analytics, b2c-reports, b2c-analytics | ✅ 200 (*fixed) |
| Monitoring | audit, system-logs, b2c-activity | ✅ 200 |
| Support/comms | support, notifications*, live-support, b2c-communication | ✅ 200 (*fixed) |
| B2C mgmt | b2c-customers, b2c-bookings, b2c-refunds, b2c-reviews, b2c-reconciliation | ✅ 200 |
| B2C catalogue | b2c-cat-flights, b2c-cat-hotels, b2c-cat-packages, b2c-cat-destinations | ✅ 200 |
| Gaming (disabled) | gaming-new, gaming-requests, gaming-converted, gaming-closed | ⚠️ 404 **by design** (fail-closed; correct per brief) |
| Profile | profile | ✅ 200 |

---

## 4. Workflow tests (actual UI → API → DB)

| Workflow | How tested | Result |
|---|---|---|
| Admin login | Full OTP flow in the browser | ✅ |
| Staff & permissions | Admin seeded with role `admin` + 67 permissions; role-gating enforced at login | ✅ |
| Merchant management — **create** | Filled "+ Onboard Merchant" form in UI, submitted | ✅ `POST /api/admin/merchants → 201`; **DB row persisted** (`LIVECHECKT / LiveCheck Travels QA / active`); list auto-refreshed |
| Merchant management — list/search/pagination | UI table + controls | ✅ Real data, pagination + filter present |
| Merchant service access | Service checkboxes on onboard form (hotels enabled) | ✅ Persisted with merchant |
| Customer management | Section loads; `GET /api/admin/customers` 200 | ✅ (read verified; write actions not exercised) |
| Booking management | Booking Enquiries / Ops / Approval Queue load | ✅ 200 (empty on fresh DB) |
| Catalogue management | Flights/Hotels/Packages/Destinations load | ✅ 200 |
| Payment transaction visibility (NO REFUNDS) | Payments + Customer Payments sections | ✅ Read-only; **no refund action touched** |
| Reports & reconciliation | Reports Export + Reconciliation sections | ✅ 200 (merchant filter fixed) |
| Monitoring & audit | DB audit trail after actions | ✅ `audit_logs` captured merchant INSERT, user INSERT, admin login UPDATEs |
| Email & in-app notifications | Notifications section + broadcast picker | ✅ Picker populates (fixed); **email delivery disabled for safety** |

---

## 5. Defects found & fixed

### DEFECT-1 (fixed) — Merchant picker broken on two screens (HTTP 422)
- **Pages:** Reports Export (`repAdminMerchant` filter) and Notifications → Broadcast (`bcMerchantPicker`).
- **Action:** Open either section.
- **API:** `GET /api/admin/merchants?page_size=200` → **422** (`page_size` must be ≤ 100).
- **Symptom:** Both requests swallowed the error (`.catch`), so the merchant dropdowns silently stayed **empty** — Reports Export could not filter by merchant, and broadcasts could not target specific merchants (only "all merchants" worked).
- **Root cause:** Frontend sent `page_size: 200`, exceeding the endpoint's documented cap of 100.
- **Fix:** `frontend/assets/js/admin.js` — changed `page_size: 200` → `page_size: 100` at both call sites (`initReportsExport`, `initNotificationForm`).
- **Verification (live):** Both calls now return **200**; Reports Export dropdown shows 3 options (All + 2 merchants), Notifications picker shows 2 merchants. Re-scan of the whole frontend confirms no other `page_size > 100` call sites remain. `node --check` passes.

### NON-DEFECT — Gaming sections return 404
- The 4 gaming nav items 404 because `GAMING_TOUR_PACKAGES_ENABLED` is off and the router fails **closed** (`_require_gaming_enabled` → 404, deliberately indistinguishable from "not found"). This is **correct and required** by the brief; covered by `test_gaming_fail_closed`. No change made.

---

## 6. Exact results summary

- **Backend unit/integration suite (prior run):** 1860 passed, 4 skipped, 0 failed.
- **Live sections tested:** 38/38 loaded; 0 JS errors; 69 API calls.
- **Live defects found:** 1 (affecting 2 screens). **Fixed:** 1. **Verified:** 1.
- **Write workflow persisted to DB:** merchant create (201 + row confirmed).
- **Audit trail:** confirmed writing.

## 7. Files changed
- `frontend/assets/js/admin.js` — two one-token edits (`200` → `100`). No other files changed.

## 8. Remaining work / not exercised (honest)
- Write actions not individually driven through the UI (backed by passing backend tests instead): customer block/unblock & password-reset, booking approve/return, catalogue create/edit, review moderation, broadcast send, communication reply. The sections load and their read APIs return 200; their write paths are covered by the green backend suite but were not click-tested here.
- A live test with richer seeded data (bookings, customers, enquiries) would exercise list rendering/pagination with real rows; the fresh DB showed correct empty states.

## 9. Blockers (unchanged, out of scope by instruction)
- Alert thresholds — not defined; must not invent.
- SMS/WhatsApp providers — not configured; must not add.
- Wi-Fi calling — not built; needs approval.
- Refunds — not to be implemented/tested.

## 10. Safety confirmation
- No commit / push / merge / deploy / production migration.
- No real email sent (SMTP disabled); no payment initiated; refunds and gaming untouched.
- Permanent dev DB (`jackpots_v2`), production, `.env`, and `dev.db` untouched.
- All 148 pre-existing uncommitted/untracked changes preserved; the only change is the 2-line fix above.

---

# Phase 2 — Write-workflow verification (2026-11-16, same disposable DB)

Test data seeded in `jackpots_livecheck` only: customer `QATEST001` (id 1), pending review (id 1, on package "Dubai"), two pending booking requests (`REQ-QA-A`/`REQ-QA-B`, ids 21/22) for the test merchant `LIVECHECKT`. A **view-only admin** (user 7, perms `customer.view`+`b2c.customers.view`) was created for negative permission tests. No real customer/merchant records touched; SMTP stayed disabled.

| # | Workflow | Frontend | API | DB persistence | Audit trail | Permissions | Result |
|---|---|---|---|---|---|---|---|
| 1 | **Customer block** | ⚠️ No UI control (backend-only) | `POST …/customers/1/block` **200** | `customers.status = blocked` | `customer.block/success` | no-token **401**, view-only **403** | ✅ backend OK; **UI gap** |
| 1 | **Customer password-reset** | ⚠️ No UI control | `POST …/password-reset` **200** (no email — SMTP off) | — | `customer.reset_password_initiated/success` (+ `denied` row logged) | view-only **403** | ✅ backend OK; **UI gap** |
| 1 | Customer unblock (restore) | — | `POST …/unblock` **200** | `status = active` | `customer.unblock/success` | — | ✅ |
| 2 | **Booking approval** | ✅ Approval Queue → Approve dialog (amount ₹5000) | `POST …/requests/21/approve` **200** | `status = payment_pending`, `total_amount 5000` | `status_history` = 3 transitions (In Review→Approved→Payment Pending) | no-token **401** | ✅ |
| 2 | **Booking return/reject** | ✅ queue renders Reject | `POST …/requests/22/reject` **200** | `status = rejected` | timeline recorded | (view-only hit **400** on req 21 — already payment_pending, a state that cannot be rejected, so not a clean RBAC signal; clean 403 shown in WF1/WF3) | ✅ |
| 3 | **Catalogue editing** | B2C Packages section loads | `PATCH …/catalogue/packages/1` **200** | `blurb` updated & persisted | (catalogue edit audit via activity log) | view-only **403**, no-token **401** | ✅ |
| 4 | **Review moderation** | ✅ review renders in customer detail + Reviews section | `PATCH …/reviews/1` **200** (approved + reply) | `status=approved`, `admin_reply` set, `moderated_at` set | `review.moderate/success` | (endpoint gated by `b2c.customers.view`) | ✅ |
| 5 | **Broadcast creation + targeting** | Picker populates (fixed in Phase 1); **final send NOT triggered** (no real broadcast) | not sent | — | — | — | ⏸ **Not completed** (usage limit) |

### Key findings (Phase 2)
- **UI gap (not a bug):** the admin portal has **no UI controls** for customer **block / unblock / password-reset** — these endpoints work and are permission-gated/audited on the backend, but are not surfaced in the portal. Candidate for a small follow-up (add buttons on the customer detail) if desired.
- **Booking approval/return, catalogue edit, review moderation** all verified end-to-end: UI (where present) → API → PostgreSQL persistence → audit → RBAC.
- **Audit trail** is thorough: it records **denied** attempts as well as successes, and even logs read actions (`customer.view_detail`).
- **RBAC** confirmed live: a view-only admin gets **403** on block, password-reset and catalogue edit; unauthenticated gets **401**.
- **Broadcast (#5) not completed** due to usage limit — the targeting picker is confirmed working (Phase 1 fix), but the create/send path was not exercised (and must only ever target the test merchant, never real users).

### Safety (Phase 2)
No commit/push/deploy/prod-migration. No real email/SMS/WhatsApp/payment/refund/broadcast. Gaming left disabled. Only the throwaway DB and test accounts were used. The only repo change remains the Phase-1 two-line fix in `admin.js` plus this tracker file.

### Cleanup (when review is done)
- Stop the test server (uvicorn on :8099).
- Drop the throwaway DB: `DROP DATABASE jackpots_livecheck;`

---

# Phase 3 — Broadcast creation & targeting (2026-11-16) — PARTIALLY COMPLETED / BLOCKED

## Environment check
| Item | Status |
|---|---|
| Test server :8099 | RUNNING (PID 26436, `uvicorn app.main:app --host 127.0.0.1 --port 8099`); route `/api/admin/notifications/broadcast` present in OpenAPI. |
| Disposable DB `jackpots_livecheck` | Cannot be confirmed from here. `backend/.env` points at `jackpots_v2`; the server's override is process-env only. Direct psql with the `.env` password was REJECTED (auth failed) — no further guessing. **BLOCKED**: DB persistence/audit queries and server-to-DB binding unverified. |
| Admin test login (`live.ops@…`) | Password not recorded anywhere; no browser session open. **BLOCKED** for authenticated UI/API tests. |

## Code findings (read-only review — NOT runtime-verified)
1. **NOT IMPLEMENTED: draft / pending broadcast.** The only endpoint is `POST /api/admin/notifications/broadcast`; it sends immediately (per-recipient `notification_service.create_notification` → `delivery_service`, which can also email when SMTP is on). No draft, preview, schedule or list-all-broadcasts. Checklist item 8 and 9 (saved draft record tied to merchant) therefore do not exist.
2. **Targeting:** payload `{merchant_ids, title(1–200), message(1–2000)}`; recipients = all users of selected ACTIVE merchants. Skipped when merchant's `notification_enabled` is off.
3. **Permission:** `require(P.NOTIFICATION_SEND)` = `notification.send`.
4. **Audit:** `activity_service.log_activity` "Notification broadcast" (module Notifications), content-free (scope, counts, title/message lengths).
5. **POSSIBLE DEFECT (fail-open, code-read only): empty selection = ALL merchants.** UI: unticking "Send to all active merchants" with nothing selected sends `merchant_ids: []`; backend treats empty (`not payload.merchant_ids`) as "every active merchant". Not exercised at runtime because that would perform a real send. Status: UNCONFIRMED.

## Runtime checks performed (no send possible)
| Check | Result |
|---|---|
| POST broadcast, no token, valid body | **401** ✅ |
| POST broadcast, garbage bearer token | **401** `Invalid or expired token` ✅ |

## Not tested (and why)
- Form load, HTML required-field validation, merchant dropdown, selecting test merchant, request payload, 200 response, DB record, 403 for view-only admin, audit-log row, no-side-effect DB counts — BLOCKED (no credentials/DB access) and a valid submission is a Send, which was prohibited. Status: NOT TESTED.

## Safety
No Send/Publish, no email/SMS/push, no DB write, no file other than this tracker changed in Phase 3. Test server and DB left untouched.

---

# Phase 4 — Broadcast recipient-selection safety review (2026-11-16) — FINDINGS ONLY, NO CODE CHANGED

No broadcast was performed; the endpoint was not called with an authenticated request; no project code modified. Method: static code trace + review of `backend/tests/test_admin_broadcast_audit.py`.

## Trace of `merchant_ids`
1. **UI** (`frontend/assets/js/admin.js` ~L2424): `merchantIds = allCheckbox.checked ? null : Array.from(picker.selectedOptions).map(Number)`. Unticking "Send to all active merchants" with nothing selected → `[]`. No client-side check for an empty selection. The all-merchants checkbox is ticked by default.
2. **Schema** (`schemas/admin_ops.py` L64): `merchant_ids: list[int] | None = None`, documented "Omit or leave empty to broadcast to every active merchant". No min length, no positive-int check, no max size, no dedupe.
3. **Router** (`admin_ops.py` L238): passes the value through unchanged; audit scope = `"all"` when `not merchant_ids`.
4. **Service** (`communication_service.broadcast` L56–59): `if merchant_ids: query = query.where(Merchant.merchant_id.in_(merchant_ids))` — `None` **and `[]`** both skip the filter → every ACTIVE merchant's users.

## Findings
| # | Finding | Status |
|---|---|---|
| F1 | **CONFIRMED (code trace): empty list `[]` targets ALL active merchants.** Reachable from the UI (untick "all", select none, submit) and from any API client. Omitting the field also means "all" (fail-open default). | Defect — severity high (mass send to wrong audience) |
| F2 | No explicit "all" intent exists in the API; "all" is inferred from absence/emptiness. Existing tests pin `merchant_ids: None` = all. | Design gap |
| F3 | Nonexistent / inactive merchant IDs are silently dropped by `IN (...)`. This does NOT expand the audience (an all-invalid list yields 0 recipients), but the caller gets `sent: 0` with 200 and no explanation, and a partly-invalid list silently shrinks. | Minor |
| F4 | Zero/negative IDs, duplicates and unbounded list length are accepted. | Minor |
| F5 | No draft/preview/confirm step; POST sends immediately. | NOT IMPLEMENTED (see below) |
| F6 | Permission gate (`notification.send`) and content-free audit already pinned by existing tests (401/403 paths, one audit row, no title/body in audit). Those existing tests use a stubbed `communication_service.broadcast`, so they do not cover recipient resolution. | Existing, passing per earlier suite |

Runtime confirmation of F1 was deliberately NOT done (it would be a real send).

## Proposed fail-closed changes (AWAITING APPROVAL — not applied)
**Backend**
- `BroadcastRequest`: add required-intent field `send_to_all: bool = False`; keep `merchant_ids: list[PositiveInt] | None`.
  - `send_to_all=true` → `merchant_ids` must be absent/None (else 422: conflicting audience).
  - `send_to_all=false` → `merchant_ids` must be a non-empty list (else 422/400), each ≥ 1, max length (e.g. 200), de-duplicated.
  - Omitted/empty/`null` with `send_to_all=false` → rejected (HTTP 400/422); never "all".
- Router: for specific targeting, resolve requested IDs against ACTIVE merchants BEFORE sending; if any ID is unknown/inactive → **400** naming the bad IDs, nothing sent, no audit "success" row. Audit `recipient_scope` derives from `send_to_all`, not from emptiness.
- `communication_service.broadcast`: change signature to require explicit `all_active: bool`; raise `ValueError` if neither `all_active` nor a non-empty ID list (defence in depth so a future caller cannot recreate F1).
**Frontend** (`admin.js` submit handler): send `send_to_all` explicitly; if "all" is unticked and nothing selected, show an inline error and do not call the API. Optionally a confirm step stating the audience.
**Backward compatibility:** the only known client is this admin UI; the audit test's `merchant_ids: None` "all" cases are updated to `send_to_all: true`.

## Proposed automated tests (all with delivery mocked — `notification_service.create_notification`/`delivery_service.deliver` and `communication_service.broadcast` stubbed; no SMTP/SMS/WhatsApp/push path reachable; SQLite throwaway data)
1. `send_to_all=true` + no IDs → 200, service called with `all_active=True`, audit scope `all`.
2. `send_to_all=true` + IDs → 422, nothing delivered/logged.
3. `send_to_all=false` + `merchant_ids=[]` → 400/422, zero deliveries, no audit success row (regression test for F1).
4. `send_to_all=false` + `merchant_ids` omitted / `null` → rejected, zero deliveries.
5. Selected valid test merchant → delivery attempted only for that merchant's users (assert exact recipient set; a second merchant's user receives nothing).
6. Nonexistent ID, inactive-merchant ID, `[0]`, `[-1]`, non-int, oversize list → rejected, zero deliveries, recipient list never expands.
7. Mixed valid + invalid IDs → rejected whole (no partial send).
8. Service-level: `broadcast(db, [], …)` and `broadcast(db, None, …)` without `all_active` raise; with `all_active=True` hits all ACTIVE merchants only.
9. Permission: no token 401, role without `notification.send` 403 → nothing delivered, nothing logged; admin with grant passes.
10. Audit: one row per accepted send; content-free (no title/body); rejected requests produce no success audit.
11. Frontend: node-level/DOM test (or documented manual check with network stubbed) that "all" unticked + empty selection never issues a request.

## Draft workflow — review (design only; NOT implemented, approval required first)
Current flow is send-on-POST. A draft workflow would add: a `broadcast_drafts` (or similar) table (id, created_by, audience type, merchant_ids, title, message, status draft/approved/sent/cancelled, timestamps), `POST/GET/PATCH/DELETE` draft endpoints, a "preview recipients" count, a separate `…/send` action (ideally maker-checker: creator ≠ sender), audit on every transition, a migration, and UI list/edit/confirm screens. **Recommendation:** ship the fail-closed fix above first (small, self-contained); treat drafts as a separate feature only if the owner wants review-before-send, because it needs a schema migration and new permissions.

## Remains unverified
- F1 at runtime (intentionally not executed); live UI form load/validation/picker; real-DB persistence and audit-log rows for a broadcast; 403 for a view-only admin against the live server; behaviour of `delivery_service` email path (SMTP disabled on test server; not exercised).
- `jackpots_livecheck` connectivity and test-admin credentials still not available to me (unchanged from Phase 3).
- Proposed tests not yet written; proposed code not applied.

---

# Phase 5 — Fail-closed broadcast recipient selection IMPLEMENTED (2026-11-16) — approved by owner

No real broadcast was made; no authenticated request was sent to any running server; delivery fully mocked in tests. Nothing committed/pushed/merged/deployed. `.env`, `dev.db` (md5 unchanged), `jackpots_v2`, production, test server and `jackpots_livecheck` untouched.

## What changed (F1 — empty list = ALL merchants — FIXED in code, verified by automated tests)
- **Field:** `send_to_all` (same name in schema, endpoint, service, and all frontends).
- **Schema** `BroadcastRequest`: `send_to_all` defaults to false; `true` forbids `merchant_ids`; `false` requires a non-empty list of unique positive ints, max **100** (`BROADCAST_MAX_MERCHANTS`, = the `/api/admin/merchants` page-size cap that feeds the picker). Violations → 422. Duplicates are rejected (not silently de-duplicated).
- **Service** `communication_service.broadcast(db, send_to_all, merchant_ids, title, message)`: raises `ValueError` for empty/None ids without `send_to_all=True`, for `send_to_all=True` combined with ids, and for non-positive / non-int ids; unknown or INACTIVE ids → HTTP 400 naming them, raised before any notification is created (no partial send).
- **Router:** passes `send_to_all`; audit `recipient_scope` now derives from `send_to_all` (not emptiness). Audit remains content-free and is only written after a successful send; permission gate `notification.send` unchanged.
- **Frontends (two clients existed):** Admin portal `admin.js` (inline error + no request when "all" unticked and nothing selected; sends `send_to_all` explicitly) and Operations portal `shared/ops-api.js` + `operations/js/ops-settings.js` (sends `send_to_all: true` or `false` + ids; it already blocked an empty selection).
- **Docs:** `docs/API_CONTRACT.md` §4.4 broadcast body updated (also dropped a never-implemented `channel` field from that line).

## Tests
- New `backend/tests/test_admin_broadcast_recipients.py` (real `broadcast()` recipient resolution on throwaway SQLite merchants/users; delivery mocked; `delivery_service.deliver` and `smtplib` raise if reached). Covers: explicit all (active only), all+ids / all+[] rejected, empty/null/omitted/no-flag rejected with zero deliveries, exact targeting across 3 merchants, notifications-off merchant skipped, nonexistent/inactive/mixed ids → 400 with zero deliveries, 0/negative/non-int/duplicate/oversize ids, view-only (403), no-permission role (403), anonymous (401/403), audit only on success and content-free, service-level guards.
- Updated `backend/tests/test_admin_broadcast_audit.py` to the new signature / `send_to_all`.
- **Full backend suite: 1901 passed, 4 skipped, 0 failed** (was 1860 passed before; +41 = new tests). Targeted run (new + audit + `test_admin_permissions` + `test_rbac`): **133 passed, 0 failed**. `node --check` on the 3 changed JS files: OK.
- Observation: a user with role `admin` always holds `notification.send` through role defaults (effective perms = role defaults + explicit grants), so a "view-only" broadcast user must be a non-admin role with only `notification.view`.

## Still unverified
- Runtime behaviour in a browser/live server (admin and ops UIs) — not exercised (no credentials; a valid submit is a Send). Frontend change verified by syntax check and code reading only.
- Real PostgreSQL behaviour of the new `IN` / status query (tests run on SQLite).
- The running test server on :8099 is still on the OLD code until restarted (not restarted, per instruction).
- Draft workflow: NOT implemented (awaiting design approval).

---

# Phase 6 — Review + isolated browser verification of the broadcast fix (2026-11-16)

No project code changed in Phase 6 (only this tracker). Nothing committed/pushed/merged/deployed. Server on :8099 NOT restarted (still running pre-fix code). `.env`, `dev.db` (md5 unchanged), `jackpots_v2`, `jackpots_livecheck` untouched.

## Method (isolated — no real backend involved)
A throw-away mock server (kept OUTSIDE the repo, in the session scratchpad) served `frontend/` and faked `/api/*`. Its broadcast endpoint validated the body with the REAL `BroadcastRequest` schema and then ONLY RECORDED it — no DB, no notification, no network. Admin portal used `127.0.0.1:8431`; Operations portal used `ops.localhost:8431` because `ops-core.js` hard-codes `OPS_API_BASE=http://127.0.0.1:8000` on 127.0.0.1/localhost (verified nothing listens on :8000). Both mock servers were stopped afterwards. 105 synthetic merchants (every 7th inactive). Real UI controls were driven; payloads read from the mock's request log.

## Admin Portal (Notifications → Broadcast) — COMPLETED (with 1 pre-existing defect)
| Case | Result |
|---|---|
| Form loads; "all" ticked by default; picker hidden | ✅ |
| Picker request | `GET /api/admin/merchants?status=active&page_size=100` → 90 active options ✅ |
| Empty title/message | ✅ native validation blocks, 0 requests |
| All merchants | ✅ body `{send_to_all:true,title,message}` — no `merchant_ids` |
| Untick all, select none | ✅ inline error "Select at least one merchant…", 0 requests, button stays enabled |
| Specific merchants (3,5) | ✅ `{send_to_all:false,merchant_ids:[3,5],…}` |
| Select 3,5 then re-tick all | ✅ `{send_to_all:true,…}`, stale selection NOT sent |
| Untick/retick toggle round-trip | ✅ selection sent only when "all" is unticked (inactive id 7 correctly absent from the active-only picker) |
| Backend 403 | ✅ detail shown, button re-enabled |
| Backend 422 (title 201 chars) | ❌ **DEFECT (pre-existing, unfixed):** message renders `[object Object]` — `err.response.data.detail` is an array for 422 and is assigned to `textContent` as-is. Not introduced by this fix, but the new schema adds more 422 paths for API clients. |

## Operations Portal (Settings → Broadcast) — COMPLETED
| Case | Result |
|---|---|
| Picker | `GET /api/admin/merchants?page_size=100` → 100 of 105 listed, **includes 14 inactive**, last id 100 |
| No title | ✅ "A title is required.", 0 requests, no confirm dialog |
| "Selected only", none ticked | ✅ "Select at least one merchant.", 0 requests |
| All → confirm dialog → Cancel | ✅ 0 requests |
| All → confirm | ✅ `{send_to_all:true,title,message}` |
| Specific 3,5 → confirm | ✅ `{send_to_all:false,merchant_ids:[3,5],…}` |
| Tick 3,5 then switch to "all" | ✅ `{send_to_all:true,…}`, picker hidden, no ids |
| Inactive merchant (7) selected | ✅ backend 400 "Unknown or inactive merchant id(s): [7]. Nothing was sent." shown (clear message) |
| 422 (title 201 chars) | ✅ readable ("String should have at most 200 characters") |
| 403 | ✅ shown |
| Re-select after a send | not meaningfully tested (title is cleared after a success, so submit correctly blocked) |

## Contract consistency — CONFIRMED
Callers of `POST /api/admin/notifications/broadcast` in the live tree: `admin.js`, `shared/ops-api.js` (used by `ops-settings.js`), no others (mobile app has none). Both send `send_to_all` explicitly; the docs (`API_CONTRACT.md` §4.4) match. **Deployment note:** frontend and backend must ship TOGETHER. Older frontend copies (e.g. under `.claude/worktrees/*`, or any cached/old build) still send `merchant_ids`/null only and will now get 422 — fail-closed (nothing is sent), but "send to all" would stop working until the frontend is updated.

## Merchant pagination & the 100-ID limit
- `GET /api/admin/merchants` caps `page_size` at 100 and is ordered `created_at DESC`. Both pickers load ONLY page 1 and have no paging/search. With >100 eligible merchants the **oldest ones cannot be selected** in the UI; "send to all" still reaches them. Nothing is mis-targeted (no ID is ever guessed); the gap is "cannot select", not "wrong recipient". (Admin picker filters `status=active`; Ops picker does not, so it wastes slots on inactive merchants that the API will now refuse.) Not reachable today in the disposable DB (≈2 merchants); proven with 105 mock merchants.
- The 100-ID cap (`BROADCAST_MAX_MERCHANTS`) is a sound, independent payload bound; today it equals the picker's maximum so every UI-buildable selection is accepted. It would need to be revisited only together with a paged/searchable picker (new functionality — not done). Recommendation: keep 100.

## PostgreSQL verification — BLOCKED
No verified disposable PostgreSQL credentials are available: the `.env` password was rejected for `jackpots_livecheck` in Phase 3, no other credential exists in the session, and I did not guess, create or modify any database. The `IN (...)`/status lookup is therefore verified only on SQLite. Needs the owner to supply a safe connection (or run the suite against `jackpots_livecheck`) — NOT TESTED.

## Regression
Targeted: `test_admin_broadcast_recipients`, `test_admin_broadcast_audit`, `test_admin_permissions`, `test_rbac`, `test_gaming_fail_closed` → **172 passed, 0 failed** (full suite earlier: 1901 passed, 4 skipped). `node --check` OK on all 3 changed JS files.

## Incident to disclose
While debugging the Operations page the browser pane was redirected to the production public login page (`https://jackpotsworldtours.com/partner-login.html`) by the portal's own session-expired logic, and one of my scripts ran there: it wrote four MOCK localStorage keys (`jwt_access`, `jwt_refresh`, `jwt_user_name`, `jwt_user_role`) into the pane's storage for that origin and issued one `GET /__mock/reset` (a 404 on production; no data). I removed the mock values immediately. If the pane held a real production token in those keys before, it may have been overwritten (signing the pane out) — no credentials were entered, no login submitted, no production data touched.

## Remaining bugs / risks
1. Admin broadcast form shows `[object Object]` on any 422 (pre-existing; unfixed).
2. Pickers show only the first ≤100 merchants (oldest unreachable by selection); Ops picker lists inactive merchants.
3. Old frontends + new backend = send-to-all broken until frontend updated (fail-closed).
4. PostgreSQL behaviour of the new lookup unverified; live :8099 server still on old code.
5. Role `admin` always holds `notification.send` via role defaults.
6. Draft workflow still NOT implemented.

---

# Phase 7 — Completion plan: Phase 1 hardening + section audit + first gap closed (2026-11-16)

Nothing committed/pushed/merged/deployed. `.env`, `dev.db` (md5 unchanged `0c5d0c25…`), `jackpots_v2`, `jackpots_livecheck`, production untouched. Refunds untouched; gaming still disabled/fail-closed. No real email/SMS/push/payment/supplier action. Server :8099 not restarted (still pre-fix code). Browser checks again used a throw-away mock server (kept outside the repo), now stopped; mock browser storage cleared.

## Phase 1 — broadcast hardening: COMPLETED (automated + browser-mock verified)
| Item | Status | Evidence |
|---|---|---|
| Strict boolean `send_to_all` (`StrictBool`) | COMPLETED | `"yes"`, `"true"`, `"1"`, `1`, `0`, `null`, `[]`, `{}` → 422, nothing delivered (parametrised tests) |
| Strict positive integer merchant IDs (`Field(strict=True, ge=1)`) | COMPLETED | `[true]`, `["5"]`, `[1.0]`, `[2.5]` → 422 (previously `true`→1, `"5"`→5, `1.0`→1 were silently accepted) |
| PostgreSQL BIGINT upper bound (`le=9223372036854775807`, same guard in service) | COMPLETED (schema + service); PostgreSQL itself NOT TESTED | `BIGINT_MAX+1`, `2**70` → 422; `BIGINT_MAX` accepted by schema → 400 unknown merchant (not a DB overflow) |
| Reject empty / null / duplicate / invalid IDs | COMPLETED | covered in Phase 5; re-run green |
| Admin Portal 422 formatting | COMPLETED (syntax-checked; pattern verified in the browser mock earlier) | `admin.js` response interceptor gives a 422 `detail` array a readable `toString()` (array itself untouched, so modules reading `detail[0].msg` keep working). Fixes the broadcast form AND the ~40 other `textContent = detail \|\| '…'` sites |
| Cache-busting | COMPLETED | `admin.js?v=20261116bc1`, `ops-api.js` / `ops-settings.js ?v=20261116bc1`, `admin-b2c-customers.js ?v=20261116cu2`; pinned by `test_changed_scripts_carry_a_cache_busting_version`. **Verified in the browser:** it had served a cached `index.html` with the old token — HTML must not be long-cached in production or the new tokens are never seen |
| Tests | COMPLETED | broadcast tests 66 pass; full suite result below |

## Phase 2 — section audit (38 nav sections: 37 `data-section` values + default dashboard)
Evidence used: Phase 1–2 live runs on the disposable DB (all 38 loaded, 0 JS errors, 69 API calls; merchant create; booking approve/reject; catalogue edit; review moderation; customer block API), the existing automated suite, the new tests, and a code inventory of write endpoints per JS module. **No new live PostgreSQL run was possible** (no verified credentials — BLOCKED), so write paths marked NOT TESTED are code-present but unproven. The 2026-11-13 audit (`docs/ADMIN_PORTAL_COMPLETE_FUNCTIONAL_AUDIT.md`) is partly stale: it recorded 44 failing tests; the suite is now fully green.

| Status | Count | Sections |
|---|---|---|
| COMPLETE (verified) | 2 | Dashboard (`reports`); B2C Reviews (`b2c-reviews`: API 200, DB persisted, audit row, RBAC, UI renders) |
| PARTIALLY COMPLETE | 8 | Merchants (`users`: create/list/search verified; edit/status/delete/team code present, untested) · Approval Queue (`partner-requests`: approve ✅ UI+DB, reject ✅ API+DB, reprice untested) · Reports Export (merchant filter fixed; file download untested) · Audit Logs (reads + DB trail verified; filters untested) · Notifications (broadcast hardened, tested, browser-mock verified; no real send by design; inbox untested) · B2C Customers (list/detail verified; block/unblock/reset UI added this phase; API live-verified Phase 2 + 21 backend tests; UI→real API→PostgreSQL smoke NOT TESTED) · B2C Communication (backend tests green; UI not exercised) · B2C Packages catalogue (edit API+DB verified; create/delete/itinerary untested) |
| NOT TESTED (loads 200, code present, writes unproven) | 23 | active-users, ticket-enquiries, booking-ops, service-requests-mgmt, providers, manual-enquiry, manual-request, payments, wallet-desk, customer-payments, analytics, system-logs, support, live-support, profile, b2c-bookings, b2c-reconciliation, b2c-activity, b2c-reports, b2c-analytics, b2c-cat-flights (status-only by design), b2c-cat-hotels, b2c-cat-destinations |
| EXCLUDED by instruction | 1 | B2C Cancellations & Refunds (`b2c-refunds`) — not touched |
| DISABLED BY DESIGN (fail-closed, tested) | 4 | gaming-new / -requests / -converted / -closed (`test_gaming_fail_closed`, `GAMING_TOUR_PACKAGES_ENABLED=false`) |
| BROKEN | 0 confirmed | — |
| NOT IMPLEMENTED (confirmed) | 1 gap, now closed | Customer block/unblock/password-reset UI (backend existed). No other confirmed missing feature was found; I did not invent gaps. |

**Priority-list outcome:** (1) Customer management — gap found and closed. (2) Merchant management — create/edit/status/service-access/delete and team-user reset-password/status/delete all exist in UI and backend; only create is live-verified. (3) Booking management — approve/reject/reprice, booking-ops notes/references/documents, change-request approve/reject exist; approve/reject verified. (4) Reports/exports — exist. (5) Notifications — hardened. (6) Payment visibility/reconciliation — read screens exist; B2C reconciliation and supplier-reservation tests are green again. (7) Staff management and role permissions — not an Admin Portal section (lives in the Super Admin portal); whether Admins should manage staff is a business decision → BLOCKED / NOT ASSESSED. (8) Review moderation — complete. (9) Security and audit logs — read-only screens exist. (10) Remaining sections — as tabled.

## Gap closed — Customer account actions (B2C Customers)
- **Frontend only** (`admin-b2c-customers.js`): the customer detail window gains an "Account actions" panel — Block (reason required), Unblock (reason optional), Send password-reset email (optional "also sign out sessions"). Shown only if `/api/auth/me` lists `b2c.customers.manage`; the backend remains the authority (403 + DENIED audit). Inline confirm panel, no double-submit, status re-read after success, list refreshed, 403/409/422 messages shown, reset disabled when no verified email, block/unblock hidden for inactive/suspended customers. No backend change; no password is ever shown or set.
- **Browser verification (mock backend, real UI):** active customer shows Block + Reset; empty reason → inline error, 0 requests; block → `POST …/1/block {"reason":"…"}`, modal and list show *blocked*, notice "Customer blocked.", buttons flip to Unblock; unblock → `{"reason":null}`; unverified email → reset disabled; suspended → note, no block/unblock; reset with sign-out → `{"force_logout":true}`; 403 → permission message, button re-enabled; account without `b2c.customers.manage` → no controls, profile still renders.
- **Not verified:** UI against the real backend and PostgreSQL; the audit row for UI-driven calls (backend audit covered by `test_b2c_customer_admin_actions.py`, 21 tests, and Phase 2 live).

## New regression tests
- `backend/tests/test_admin_broadcast_recipients.py` (extended): strict boolean, strict int, BIGINT bounds, service guards.
- `backend/tests/test_admin_frontend_contract.py` (new, 5 tests): every `/api/…` call in `admin*.js` and `shared/ops-api.js` must exist in the real OpenAPI route table with the same verb; the scan is non-vacuous (>60 calls found); both broadcast clients send `send_to_all`; changed scripts carry cache-busting versions. URLs built at runtime (`/communication${path}`) are excluded because they cannot be resolved statically.

## Remaining blockers / not done
1. **PostgreSQL / live end-to-end — BLOCKED:** no verified disposable credentials; write workflows for the 23 NOT TESTED sections and the customer-action UI→API→DB smoke are unproven. Needs the owner to provide a safe connection (or run it) and an admin test login.
2. Staff/role management inside the Admin Portal — business decision needed.
3. First-100-merchants picker limitation (documented; needs a paged/searchable picker if >100 merchants).
4. Draft workflow — design approval pending; not implemented.
5. Production readiness: frontend and backend must ship together; HTML must not be long-cached; :8099 server restart needed to exercise new code; migration 0095 / DBA grants / super-admin default password (D3, D7 in the Nov-13 audit) are deployment tasks outside this work.

## Phase 7 test results
- **Full backend suite: 1925 passed, 4 skipped, 0 failed** (1920 after Phase 1 hardening; +5 from the new contract tests). `node --check` OK on `admin.js`, `admin-b2c-customers.js`, `shared/ops-api.js`, `operations/js/ops-settings.js`. `backend/dev.db` md5 unchanged.
- Files changed in Phase 7 (by me): `backend/app/schemas/admin_ops.py`, `backend/app/services/communication_service.py`, `frontend/assets/js/admin.js`, `frontend/assets/js/admin-b2c-customers.js`, `frontend/admin/index.html` (2 script version tokens), `frontend/operations/index.html` (2 script version tokens), `backend/tests/test_admin_broadcast_recipients.py`, `backend/tests/test_admin_frontend_contract.py` (new), this tracker. (Earlier phases: router, ops-api.js, ops-settings.js, audit test, API_CONTRACT.md.)

---

# Phase 8 — Remaining Admin Portal workflows: API-level verification batches (2026-11-16)

Nothing committed/pushed/merged/deployed. `.env`, `dev.db` (md5 unchanged), `jackpots_v2`, `jackpots_livecheck`, production untouched; no database created; refunds untouched; gaming still disabled/fail-closed; no real email/SMS/push/payment/supplier action (every test mocks delivery and makes `smtplib`/`delivery_service.deliver` raise if reached). No credentials were guessed.

## Method and its limits (read this before the statuses)
New shared harness `backend/tests/_v2_harness.py` clones the real `models_v2` tables onto throw-away in-memory SQLite (PostgreSQL-only FKs/CHECKs/indexes stripped; harmless literal defaults and `now()` kept; `INET`/`CITEXT` rendered as TEXT; `nextval()` emulated). The REAL routers, services, RBAC dependency and token decoding run unchanged. Therefore these tests verify: route behaviour, validation, state machines, persistence of what the app writes, permission enforcement (401/403), and the actor-attributed audit trail (`system_logs`).
They do **not** verify: PostgreSQL constraints/triggers/enums/partial unique indexes, row locking (`FOR UPDATE`), the DB `audit_logs` trigger, or browser behaviour against a real server. Those remain **BLOCKED** (no verified disposable PostgreSQL credentials) and are called out per workflow.

## Verification matrix (workflows exercised this phase)
| # | Section | Workflow | Endpoint(s) / verb | Permission | Validation tested | DB effect asserted | Audit asserted | Tests |
|---|---|---|---|---|---|---|---|---|
| 1 | Merchants (`users`) | Create merchant + first login | `POST /api/admin/merchants` | `merchant.create` (Admin only; Super Admin → 403) | missing/blank/over-long fields, bad emails, negative credit, bad country code/type, duplicate email | merchant ACTIVE, first user `merchant_admin`, password hashed + returned once, settings/service-access rows | "Merchant created" with actor | 12 |
| 2 | Merchants | List / search / filter / paginate / get | `GET /api/admin/merchants[/id]` | `merchant.view` | `page_size>100` → 422, 404 | deleted hidden, status filter | — | 3 |
| 3 | Merchants | Edit | `PUT /api/admin/merchants/{id}` | `merchant.edit` | email clash 400, own email OK, 404 | only supplied fields change | "Merchant updated"; none on refusal | 3 |
| 4 | Merchants | Suspend / reactivate | `PATCH …/status` | `merchant.suspend` | `deleted`/`pending_approval`/bogus/"" refused | status persisted; users notified (mocked) | "Merchant suspended/active" | 6 |
| 5 | Merchants | Soft delete | `DELETE …/{id}` | `merchant.delete` | double delete 400 | merchant + all users → DELETED | "Merchant deleted" | 2 |
| 6 | Merchants | Merchant-user create / reset password / status / delete | `…/users`, `…/reset-password`, `…/status`, `DELETE …/users/{id}` | `merchant_user.manage` / `.delete` | duplicate email, bad email, 404, cross-merchant | user rows; password hash changes | (service logs) | 3 |
| 7 | Merchants | Role/anonymous refusal on all 8 write+read verbs | — | — | 401 anonymous, 403 MANAGER, nothing changed | — | none written | 3 |
| 8 | Approval Queue (`partner-requests`) | Approve (price) / reject / reprice | `POST /api/admin/requests/{id}/approve|reject|reprice` | `ticket.approve` / `ticket.reject` | no/zero/negative amount, credit limit, mandatory reasons, >500 chars, enquiry type refused, double approve, approve-after-reject, paid cannot be rejected, reprice only at Payment Pending | status + amount, timeline ≥3 transitions, merchant notified (mocked) | "Ticket request approved"; none on refusal | 15 |
| 9 | Wallet Desk | Verify / reject top-up claim, reconciliation | `POST /api/admin/wallet/topups/{id}/verify|reject`, `GET …/reconciliation` | `payment.verify` | remarks mandatory, 404, already-decided 409 (incl. "by another operator") | wallet credited exactly once (balance + 1 ledger row), reject moves no money, verified cannot be rejected | "Wallet top-up verified/rejected" with actor | 9 |
| 10 | Providers | Create / rename / (de)activate provider; add / edit / deactivate person | `POST/PATCH /api/admin/providers…`, `PATCH /provider-users/{id}` | `provider.manage` | blank/whitespace name, case-insensitive duplicate, per-provider email uniqueness, bad email, 404, no delete endpoint | rows persisted | actor-attributed entry | 12 |
| 11 | Wallet Desk | Payment accounts (bank/UPI/QR) create / edit / retire | `POST/PUT/DELETE /api/admin/payment-accounts` | `payment.manage` (write), `payment.verify` (read) | active account must be usable, unknown keys dropped, QR needs image before activation, blank label, bad type | retire = deactivate, never delete | actor-attributed entry | 13 |

**79 new tests / 11 workflow groups (≈ 26 distinct operations)**, files: `test_admin_merchant_management_http.py` (30), `test_admin_booking_approval_http.py` (15), `test_admin_wallet_topup_http.py` (9), `test_admin_providers_http.py` (12), `test_admin_payment_accounts_http.py` (13).

## Defects found and fixed (each with a regression test)
| ID | Root cause | Impact | Fix (smallest) | Files | Regression test |
|---|---|---|---|---|---|
| DEFECT-2 | `merchant_service.set_merchant_status`, `update_merchant`, `PATCH /service-access` and `POST /merchants/{id}/users` never checked for the terminal `DELETED` state (the code's own comment says deleted is terminal). `PATCH …/status {"status":"active"}` flipped a deleted merchant back to ACTIVE while its users stayed deleted; edits, service-access changes and **new ACTIVE users with a one-time password** were accepted on a deleted company | data integrity / admin confusion | `_refuse_if_deleted` + `get_live_merchant` → 400 "Merchant is deleted and can no longer be changed"; used by the 4 writes | `backend/app/services/merchant_service.py`, `backend/app/routers/merchants.py` | `test_a_deleted_merchant_cannot_be_reactivated_or_edited`, `test_service_access_and_new_users_on_a_deleted_merchant_are_refused` |
| DEFECT-3 | `CreateProvider/UpdateProvider/…User` used `min_length=2` on the raw string; `"   "` passed, then the service `.strip()`ped it to `""` and stored a provider with an empty name (PRD001 with no name) | blank supplier shown in dropdowns | `StringConstraints(strip_whitespace=True, min_length=2)` on provider and provider-person names | `backend/app/schemas/provider.py` | `test_blank_provider_name_is_rejected[blank]` |
| DEFECT-4 | Same class: payment-account `label` `min_length=1` passed `"   "`, stored as `""` on an account displayed to merchants | blank account label on Add Money | `StringConstraints(strip_whitespace=True, min_length=1)` | `backend/app/schemas/payment_admin.py` | `test_blank_labels_are_rejected[blank]` |

No defects were found in approvals, wallet verify/reject, or the permission matrices — they behaved as their own docs state.

## Section status after Phase 8 (38 sections)
Status key: COMPLETE = verified end-to-end incl. persistence, permissions, audit and UI. **API-VERIFIED** (new, below COMPLETE) = write workflow proven by automated HTTP tests on disposable SQLite data; UI→real server→PostgreSQL still NOT TESTED/BLOCKED.

| Status | Count | Sections |
|---|---|---|
| COMPLETE | 2 | Dashboard (`reports`); B2C Reviews (`b2c-reviews`) |
| PARTIALLY COMPLETE — primary write workflows API-VERIFIED | 9 | Merchants (`users`) · Approval Queue (`partner-requests`; approve also UI-verified live) · Wallet Desk (`wallet-desk`: top-up verify/reject + payment accounts) · Providers (`providers`) · Notifications (broadcast) · B2C Customers · B2C Communication · B2C Packages (edit only) · Reports Export (filters only) |
| PARTIALLY COMPLETE — reads verified only | 1 | Audit Logs |
| NOT TESTED (loads 200, code present, writes unproven) | 21 | active-users, ticket-enquiries, booking-ops, service-requests-mgmt, manual-enquiry, manual-request, payments (payment requests), customer-payments, analytics, system-logs, support, live-support, profile, b2c-bookings, b2c-reconciliation, b2c-activity, b2c-reports, b2c-analytics, b2c-cat-flights, b2c-cat-hotels, b2c-cat-destinations |
| EXCLUDED by instruction | 1 | B2C Cancellations & Refunds |
| DISABLED BY DESIGN | 4 | gaming-new/-requests/-converted/-closed |
| BROKEN | 0 confirmed | — |
| NOT IMPLEMENTED | 0 confirmed | (customer actions UI added in Phase 7) |

Business decisions needed (documented, not invented): whether Admins should manage staff/roles inside the Admin Portal (today in the Super Admin portal); the merchant-picker >100 limit; broadcast drafts.

## Still BLOCKED / NOT DONE
- **PostgreSQL verification — BLOCKED** (no verified disposable credentials; I will not guess or create a database). Unproven here: partial unique index `ux_merchants_email_not_deleted`, `uq_wallet_transactions_topup`, `FOR UPDATE` locking, enum casts, the `audit_logs` DB trigger.
- **UI-level driving** of the new workflows against a real server (merchant forms, approval dialogs, top-up desk, providers, payment accounts) — NOT TESTED.
- Not reached this phase: booking-ops (notes/references/documents/assign), change-requests (approve/reject/review), enquiries respond/review, hotel-enquiries, support threads, service-request resolve, communication-settings PUT, catalogue create/delete, B2C bookings status, B2C reconciliation verify, exports/downloads, live-support, manual booking creation. These remain NOT TESTED; they are the next batches.

## Phase 8 test results
- **Full backend suite: 2004 passed, 4 skipped, 0 failed** (1925 before this phase; +79 new tests). `backend/dev.db` md5 unchanged.
- Files changed in Phase 8 (by me): `backend/app/services/merchant_service.py`, `backend/app/routers/merchants.py`, `backend/app/schemas/provider.py`, `backend/app/schemas/payment_admin.py`; new tests `backend/tests/_v2_harness.py`, `test_admin_merchant_management_http.py`, `test_admin_booking_approval_http.py`, `test_admin_wallet_topup_http.py`, `test_admin_providers_http.py`, `test_admin_payment_accounts_http.py`; this tracker.

---

# Phase 9 — Booking Operations, Change Requests, Enquiries, Service Requests (2026-11-16)

Nothing committed/pushed/merged/deployed. `.env`, `dev.db` (md5 unchanged), `jackpots_v2`, `jackpots_livecheck`, production untouched; no database created or deleted; refunds untouched (the generic `refund` service-request type was deliberately not exercised); gaming still fail-closed; no real communication, supplier or payment action (delivery mocked; `smtplib`/`delivery_service.deliver` raise if reached). Same method and same limits as Phase 8: real routers/services/RBAC on throw-away SQLite data — **PostgreSQL, row locking, DB triggers and browser/UI behaviour are NOT verified (BLOCKED).**

Harness improvements (`tests/_v2_harness.py`): bare-string server defaults (e.g. `'merchant_portal'`) are now preserved; `Harness.user()` accepts `merchant_role`.

## Workflow matrix
| # | Section | Workflow | Endpoint(s) | Permission | Tests | Result |
|---|---|---|---|---|---|---|
| 1 | Booking Operations (`booking-ops`) | Queue (stages, oldest-first, filters, counts) | `GET /api/admin/bookings/queue[/counts]` | `ticket.view` | 2 | verified |
| 2 | | Assign / unassign operator | `POST …/{id}/assign` | `ticket.approve` | 3 | verified (operator must be active staff holding `ticket.approve`; 404 for unknown / catalogue rows) |
| 3 | | Airline PNR / ticket-number references | `PUT …/{id}/references` | `ticket.approve` | 2 | verified (only confirmed bookings; PNR upper-cased; partial update keeps the other field; blank 400; duplicate ticket number 409 naming the other booking; previous value logged) |
| 4 | | Internal notes add / list / edit / delete | `…/{id}/notes`, `…/notes/{id}` | `ticket.view`/`ticket.approve` + platform staff | 6 | verified; **DEFECT-5 fixed** (edit was unaudited); note bodies never reach the audit trail |
| 5 | | Permissions | all of the above | — | 2 | 401 anonymous everywhere; merchants and role MANAGER get 403 and nothing changes |
| 6 | Service Request Mgmt (`service-requests-mgmt`) | Raise cancellation / reschedule (merchant side) | `POST /api/bookings/{id}/cancellation|reschedule` | `servicerequest.create` | 4 | verified (state windows, one open change per booking, one live cancellation, future/different date rules, cross-merchant 404, bookings untouched until approval) |
| 7 | | List / detail / counts / per-booking history | `GET /api/change-requests…` | `ticket.view` | 2 | verified; merchants see only their own |
| 8 | | Manager sign-off gate | review/approve/reject | — | 1 | verified: staff get 409 until the merchant's manager signs off |
| 9 | | Claim (review) | `POST /api/admin/change-requests/{id}/review` | `servicerequest.manage` | 1 | verified; second admin 409 |
| 10 | | Approve cancellation / reschedule | `…/approve` | `servicerequest.manage` | 6 | verified: booking → Cancelled / dates rewritten + history, charge ≤ booking total, negative/invalid amounts 400 with nothing changed, double approval 409, booking moved on while queued 409. Money: bookings were unpaid so refund settles 0 — ledger/wallet settlement NOT exercised |
| 11 | | Reject | `…/reject` | `servicerequest.manage` | 2 | verified: reason mandatory, booking unchanged, can be re-raised |
| 12 | | Permissions | all | — | 1 | 401/403; platform staff cannot raise merchant requests |
| 13 | Service requests (generic) | Raise passenger-mod / baggage / meal / seat; refuse cancellation/date-change here; refuse unconfirmed bookings | `POST /api/service-requests` | `servicerequest.create` | 8 | verified; **DEFECT-6 fixed** (whitespace-only remarks stored) |
| 14 | | Resolve approve / reject | `POST /api/admin/service-requests/{id}/resolve` | `servicerequest.manage` | 7 | verified (walks through Under Review, reason mandatory on reject, no double resolve, manager gate, 400 for non-service requests and for cancellation/date-change pointing to change-requests) |
| 15 | Manual Enquiry / Ticket Enquiries | Merchant enquiry + manual enquiry on a merchant's behalf | `POST /api/enquiries` | `ticket.enquiry` / `ticket.manual` | 4 + 9 validation cases | verified (desk-raised rows belong to the merchant, attributed to the admin, `received_date_time` required and not future; merchants can never file for another merchant; flights access gate) |
| 16 | | List / detail scoping | `GET /api/enquiries[/id]` | `ticket.view` | 1 | verified (merchant/staff/source/status filters; cross-merchant 404). Free-text `search` uses PostgreSQL JSONB → BLOCKED |
| 17 | | Review (claim), quotation, decline | `POST /api/admin/enquiries/{id}/review|respond` | `ticket.approve` / `ticket.reject` | 10 | verified (binding quotation stored as 2-dp string, remarks mandatory, no fare on decline, final answer, claim blocks other admins, approve-only vs reject-only reviewers) |
| 18 | Booking documents | Verify / reject a document | `POST /api/admin/documents/{id}/verify` | `document.verify` | 5 | verified (independent of booking status; reason mandatory; audit with from/to). Upload/download/delete need file storage → NOT TESTED |

**86 new tests / 18 workflow groups:** `test_admin_booking_ops_http.py` (16), `test_admin_change_requests_http.py` (19), `test_admin_enquiries_http.py` (29), `test_admin_service_requests_http.py` (17), `test_admin_document_verification_http.py` (5).

## Defects found and fixed
| ID | Root cause | Fix | Files | Regression test |
|---|---|---|---|---|
| DEFECT-5 | `booking_ops_service.edit_note` rewrote an internal note with no audit entry, while add and delete were both logged | log "Internal note edited" (content-free, same pattern as add) | `backend/app/services/booking_ops_service.py` | `test_note_edits_are_audited` |
| DEFECT-6 | `CreateServiceRequest.remarks` was `min_length=1` on the untrimmed string; `"   "` was accepted and stored, giving the desk a request with no content (same class as DEFECT-3/4) | `StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)` | `backend/app/schemas/ticket.py` | `test_whitespace_only_remarks_are_rejected` |
| DOC-1 (docs only) | `POST /bookings/{id}/cancellation` description claimed a Completed booking returns 409, but `CANCELLABLE_PARENT_STATUSES` deliberately INCLUDES `COMPLETED` (documented in the service) | description corrected, behaviour unchanged | `backend/app/routers/change_requests.py` | `test_raise_validation_and_state_rules` pins the real behaviour |

## Observations that are business decisions (documented, nothing changed)
- A booking that has already been completed can still be cancelled (money-settlement case) — intentional per the service comment; the router text was stale (DOC-1).
- A document's verification decision can be revised (rejected → verified) with no guard; the reasoning in the service says documents are independent of the booking lifecycle. Whether to lock a decision after first review is the owner's call.
- Cancellation approval on a PAID booking moves internal wallet/ledger money (`settle_refund`, `refund_booking_to_wallet`); that path was intentionally not exercised here (unpaid bookings only).

## Section status after Phase 9 (38 sections)
| Status | Count | Sections |
|---|---|---|
| COMPLETE (verified end-to-end incl. UI/DB) | 2 | Dashboard; B2C Reviews |
| PARTIALLY COMPLETE — primary writes API-VERIFIED (SQLite) | 13 | Merchants, Approval Queue, Wallet Desk, Providers, Notifications, B2C Customers, B2C Communication, B2C Packages (edit only), Reports Export (filters only), **Booking Operations, Service Request Mgmt, Ticket Enquiries, Manual Enquiry** |
| PARTIALLY COMPLETE — reads only | 1 | Audit Logs |
| NOT TESTED | 17 | active-users, manual-request (direct booking creation), payments (payment requests), customer-payments, analytics, system-logs, support, live-support, profile, b2c-bookings, b2c-reconciliation, b2c-activity, b2c-reports, b2c-analytics, b2c-cat-flights, b2c-cat-hotels, b2c-cat-destinations |
| EXCLUDED | 1 | B2C Cancellations & Refunds |
| DISABLED BY DESIGN | 4 | gaming-* |
| BROKEN / NOT IMPLEMENTED | 0 confirmed | — |

Evidence-based completion: 2 of 33 in-scope sections fully verified (6%); 13 of 33 (39%) have their primary write workflows verified at API level; 17 of 33 (52%) have none.

## Still BLOCKED / NOT DONE
- PostgreSQL (row locks, partial unique indexes such as `uq_sr_ticket_number`, JSONB search, enum casts, DB audit trigger) — no verified disposable credentials; nothing guessed or created.
- UI-level verification of all new workflows against a running server.
- Not reached: booking document upload/download/delete (file storage), manual-request/direct booking creation, hotel enquiries, enquiry → booking-request conversion, issue-ticket, payment verification (`/api/admin/payments/{id}/verify`), support threads, communication-settings, catalogue create/delete, B2C bookings status, B2C reconciliation verify, exports, live support.

## Phase 9 test results
- **Full backend suite: 2090 passed, 4 skipped, 0 failed** (2004 before this phase; +86 new tests). `backend/dev.db` md5 unchanged.
- Files changed in Phase 9 (by me): `backend/app/services/booking_ops_service.py`, `backend/app/schemas/ticket.py`, `backend/app/routers/change_requests.py` (description text only), `backend/tests/_v2_harness.py`; new tests `test_admin_booking_ops_http.py`, `test_admin_change_requests_http.py`, `test_admin_enquiries_http.py`, `test_admin_service_requests_http.py`, `test_admin_document_verification_http.py`; this tracker.

---

# Phase 10 — Booking/ticket, payments & reconciliation, documents, support & communication, catalogue & reports (2026-11-16)

Nothing committed/pushed/merged/deployed. `.env`, `dev.db` (md5 unchanged), `jackpots_v2`, `jackpots_livecheck`, production untouched; no database created or deleted; Refund Management not touched; gaming still fail-closed; no real payment, supplier action or customer communication (delivery mocked, `smtplib` / `delivery_service.deliver` raise if reached; the payment gateway is a mock). The two open business decisions were NOT changed: cancelling a completed booking is still allowed, and a document verification decision can still be revised.

Same method and limits as Phases 8–9: real routers/services/RBAC on throw-away in-memory SQLite data. **PostgreSQL-specific behaviour is reported as NOT VERIFIED, never assumed.**

## Workflow matrix (new this phase)
| # | Priority / section | Workflow | Endpoint(s) | Tests | Result |
|---|---|---|---|---|---|
| 1 | P1 Manual/direct booking (`manual-request`) | Direct booking by merchant, or by the desk for a merchant; submit; one-call submit all-or-nothing; international passport / six-month / shared-passport rules | `POST /api/bookings/direct`, `POST /api/requests/{id}/submit` | 11 | verified |
| 2 | P1 Enquiry → booking | Conversion copies the journey and the BINDING quoted fare, once per enquiry; merchant cannot convert pending/declined; desk may convert a manual enquiry but cannot move it to another merchant | `POST /api/enquiries/{id}/booking-request` | 8 | verified |
| 3 | P1 Hotel enquiries | Create (rooms/guests/PAN/dates rules, Hotels access gate), list scope, review/claim, quotation, decline | `/api/hotel/enquiries`, `/api/admin/hotel-enquiries/{id}/review\|respond` | 22 | verified; **DEFECT-7 fixed** |
| 4 | P1 Ticket issuing | Standard track (only from Paid; PNR/ticket/invoice allocated once, unique; supplier validation burns no number); Classic track (needs ticket documents + fare, debits the wallet exactly once, never twice) | `POST /api/admin/requests/{id}/issue-ticket` | 10 | verified |
| 5 | P2 Payment handling / verification | Merchant payment (amount rules, no overpay, wallet debit and its return on rejection) and Admin verification (partial ≠ Paid, no double verify, queue) | `POST /api/requests/{id}/pay`, `GET /api/admin/payments/pending`, `POST /api/admin/payments/{id}/verify` | 15 | verified |
| 6 | P2 Customer payments (`customer-payments`) | B2C payment list / filters / counts / detail (no phone, card or secret returned) + sensitive-read audit | `GET /api/admin/customer-payments…` | 5 | verified |
| 7 | P2 B2C reconciliation (`b2c-reconciliation`) | List (all `not_checked`, no gateway call); verify against a MOCKED gateway → matched / mismatch / no_reference / not_configured / gateway_unavailable; read-only guarantee (payment rows unchanged) | `GET /api/admin/payment-reconciliation`, `POST …/{product}/{id}/verify` | 9 | verified (explicit `b2c.payments.verify`/`payment.verify` grant required — role defaults refused) |
| 8 | P3 Documents | Upload (merchant draft-only; staff late window incl. classic track), magic-byte/type/size/empty checks, safe filenames, passenger scoping; download (private attachment, exact bytes, scope, missing file, tampered path); delete (rules after draft, file removed, audit) | `/api/requests/{id}/documents`, `/api/documents/{id}/download`, `DELETE /api/documents/{id}` | 18 | verified on a tmp storage root (repo `uploads/` untouched); S3 backend NOT exercised |
| 9 | P4 Support threads (`support`) | Open, list/filter/scope, detail, reply (auto-claim), claim, triage, internal notes (staff-only, content-free audit), resolve, reopen (14-day window), unread count | `/api/support/threads…` | 21 | verified; **DEFECT-8 fixed**. WebSocket live support / WebRTC / Wi-Fi calling: NOT TESTED, not claimed |
| 10 | P4 Communication settings / inbox | Per-merchant channel switches (partial update, validation, 404, permissions) and the in-app notification inbox (list/unread/mark read/all, owner-only) | `/api/admin/communication-settings/{id}`, `/api/notifications…` | 12 | verified; **DEFECT-9 fixed** |
| 11 | P5 Destinations (`b2c-cat-destinations`) | Create (slug, duplicate 409), edit (slug immutable), list/get, reorder (must list every id once), locations create/edit (per-destination uniqueness), audit + B2C audit row | `/api/admin/catalogue/destinations…` | 8 | verified |
| 12 | P5 Hotels (`b2c-cat-hotels`) | Validation / 404 / permissions only | `/api/admin/catalogue/hotels…` | (in #11) | PostgreSQL ARRAY columns cannot be bound on SQLite → create/edit persistence **NOT VERIFIED** |
| 13 | P5 Reports & exports (`reports-export`) | Summary == export rows and total; filters (status, statuses, request type, merchant, date range); CSV / XLSX / PDF parsed back; merchant scope cannot be widened; audit of each export | `GET /api/reports/summary\|export` | 19 | verified; **DEFECT-10 fixed**; free-text `search` NOT VERIFIED (JSONB) |

**158 new tests** in 9 files: `test_admin_ticketing_payments_http.py` (25), `test_admin_direct_booking_http.py` (19), `test_admin_hotel_enquiries_http.py` (22), `test_admin_b2c_payments_reconciliation_http.py` (14), `test_admin_documents_files_http.py` (18), `test_admin_support_threads_http.py` (21), `test_admin_communication_settings_http.py` (12), `test_admin_catalogue_destinations_http.py` (8), `test_admin_reports_exports_http.py` (19).

## Defects found and fixed (each with a regression test)
| ID | Root cause | Impact | Fix | Files | Regression test |
|---|---|---|---|---|---|
| DEFECT-7 | `hotel_enquiry_service.respond` set `REJECTED` directly for a decline, so a decline with no reason was accepted (200) although the endpoint documents the reason as mandatory and the flight-enquiry decline refuses it | merchant told "declined" with no explanation | 400 when the reason is blank; reason stored trimmed | `backend/app/services/hotel_enquiry_service.py` | `test_decline_needs_a_reason_and_permissions_hold` |
| DEFECT-8 | `chat_service.open_thread` wrote `opened a chat: {subject}` into the audit entry and the desk notification; `subject` is optional, so both said "opened a chat: None" | misleading audit/notification text | use the derived `thread.title` | `backend/app/services/chat_service.py` | `test_a_blank_subject_is_derived_from_the_message_and_never_printed_as_none` |
| DEFECT-9 | `PUT /api/admin/communication-settings/{id}` (switch a merchant's email/notifications off) left no actor-attributed trail, unlike every other admin write | unaudited admin change | log "Communication settings updated" (field NAMES only, no values) | `backend/app/routers/admin_ops.py` | `test_settings_changes_are_audited_without_leaking_values_beyond_the_changed_fields` |
| DEFECT-10 | Report exports wrote merchant-controlled text (passenger names, remarks) verbatim into CSV/XLSX; a value starting with `= + - @` is executed as a formula when opened in Excel (CSV/formula injection; openpyxl also turns a leading `=` into a real formula cell) | security: formula execution on the admin's machine | `_safe_cell` prefixes such non-numeric text with `'`; plain signed numbers (`-25.00`) are untouched | `backend/app/services/export_service.py` | `test_exports_are_safe_to_open_in_a_spreadsheet` |

No defect was found in ticket issuing, payment verification, direct booking, enquiry conversion, documents, support threads (beyond DEFECT-8), reconciliation, destinations or the permission matrices — they behaved as their own documentation states.

## NOT IMPLEMENTED (confirmed in the routers — nothing invented)
- Hotel **create** and hotel **delete**; destination and location **delete** (retire with `is_active=false`); there is no destination/hotel "create via API for hotels" endpoint at all.
- **Flight catalogue** create/edit/delete: the flight screen is a read-only supplier status page (no stored inventory) — by design per the earlier audit.
- Wi-Fi calling: not claimed (no test of any calling path).

## NOT VERIFIED — PostgreSQL-specific (SQLite proves nothing here)
`support` list `category` filter (JSONB `@>`); enquiry free-text `search` and report `search` (JSONB `astext`); hotel/room catalogue persistence (ARRAY columns); `uq_wallet_transactions_booking_debit`, `uq_sr_ticket_number`, `FOR UPDATE` locking and real sequences (emulated); enum casts; the `audit_logs` DB trigger. No verified disposable PostgreSQL credentials exist; none were guessed or created.

## Section status after Phase 10 (38 sections)
| Status | Count | Sections |
|---|---|---|
| COMPLETE (verified end-to-end incl. UI/DB) | 2 | Dashboard; B2C Reviews |
| PARTIALLY COMPLETE — primary writes API-VERIFIED (SQLite) | 19 | Merchants, Approval Queue, Wallet Desk, Providers, Notifications, B2C Customers, B2C Communication, B2C Packages (edit only), Reports Export, Booking Operations, Service Request Mgmt, Ticket Enquiries, Manual Enquiry, **Manual Request, Customer Payments, B2C Reconciliation, Support, B2C Destinations, Payments (booking-payment verification; wallet payment-request creation NOT TESTED)** |
| PARTIALLY COMPLETE — reads / validation only | 2 | Audit Logs; B2C Hotels catalogue (create/edit persistence NOT VERIFIED — ARRAY) |
| NOT TESTED | 10 | active-users, analytics, system-logs, live-support, profile, b2c-bookings, b2c-activity, b2c-reports, b2c-analytics, b2c-cat-flights (read-only by design) |
| EXCLUDED | 1 | B2C Cancellations & Refunds |
| DISABLED BY DESIGN | 4 | gaming-* |
| BROKEN | 0 confirmed | — |

Evidence-based completion: **2 / 33** in-scope sections fully verified (6%); **19 / 33 (58%)** have their primary write workflows verified at API level; **2 / 33 (6%)** reads/validation only; **10 / 33 (30%)** with no verified writes.

## Remaining untested workflows
B2B wallet payment-request creation/cancel; booking-ops document upload via the booking UI; `active-users`, B2B `analytics`, `system-logs`, `profile`; B2C bookings status update, B2C user activity, B2C reports/analytics endpoints; package catalogue create/itinerary/departures; hotel/room catalogue persistence; live-support WebSocket and calling; UI-level behaviour of every workflow in this tracker; manual-booking passenger import / group manifests.

## Phase 10 test results
- **Full backend suite: 2248 passed, 4 skipped, 0 failed** (2090 before this phase; +158 new tests). `backend/dev.db` md5 unchanged.
- Files changed in Phase 10 (by me): `backend/app/services/hotel_enquiry_service.py`, `backend/app/services/chat_service.py`, `backend/app/routers/admin_ops.py`, `backend/app/services/export_service.py`; new tests `test_admin_ticketing_payments_http.py`, `test_admin_direct_booking_http.py`, `test_admin_hotel_enquiries_http.py`, `test_admin_b2c_payments_reconciliation_http.py`, `test_admin_documents_files_http.py`, `test_admin_support_threads_http.py`, `test_admin_communication_settings_http.py`, `test_admin_catalogue_destinations_http.py`, `test_admin_reports_exports_http.py`; this tracker.

---

# Phase 11 — Final remaining sections, remaining workflows, Live Support WebSocket (2026-11-17)

Nothing committed/pushed/merged/deployed. `.env`, `dev.db` (md5 unchanged), `jackpots_v2`, `jackpots_livecheck`, production untouched; no database created or deleted; Refund Management untouched; gaming still disabled / fail-closed (a package cannot be created or edited into a gaming package — pinned by a test); no real payment, supplier action or communication (delivery and the payment gateway are mocked; every external channel raises if reached). Both open business decisions are unchanged (completed bookings can still be cancelled; document verification decisions can still be revised).

Method and limits as before: real routers/services/RBAC on throw-away SQLite. **Where the SQL is PostgreSQL-only the test detects it and is reported NOT VERIFIED (skipped), never assumed.**

## What was tested
| # | Section / workflow | Endpoints | Tests | Result |
|---|---|---|---|---|
| 1 | **Admin Profile** (`profile`) | `GET/PUT /api/profile`, `POST /api/profile/heartbeat` | 9 | verified; **DEFECT-11, DEFECT-12 fixed**. Email / role / status / permissions cannot be changed here; only the caller's own account is touched |
| 2 | **Active Users** (`active-users`) | `GET /api/admin/users` | 7 | verified: filters (status/role/merchant/search/presence), deleted hidden, paging, no password hash, `merchant_user.manage` gate |
| 3 | **System Logs** (`system-logs`) | `GET /api/super-admin/activity` | 1 (+perm) | verified: filters, paging, actor name; staff-only. Writes are the audit trail itself |
| 4 | **Audit Logs** | `GET /api/super-admin/audit-logs[/tables]` | 1 | verified: secrets redacted (keys stay visible), filters, `audit.view`. The DB trigger that WRITES `audit_logs` is PostgreSQL-only → NOT VERIFIED |
| 5 | **B2B Analytics** (`analytics`) | `GET /api/analytics/bookings\|change-requests\|operations` | 2 | **NOT VERIFIED on SQLite** (PostgreSQL-only SQL → skipped); validation/401/403 parts that run before the SQL are covered |
| 6 | **B2C Bookings** (`b2c-bookings`) | `GET/PATCH /api/admin/customer-bookings…` | 6 | verified: list/filters/search/paging/counts, gaming always empty, detail (audited), status update (validation, audit, payment untouched). **Two decisions pinned, not changed — see below** |
| 7 | **B2C Activity** (`b2c-activity`) | `GET /api/admin/user-activity/logs\|sessions\|summary` | 3 | logs verified (filters, no secrets, validation, permissions); sessions/summary **NOT VERIFIED on SQLite** (naive-vs-aware datetime) |
| 8 | **B2C Reports** (`b2c-reports`) | `GET /api/admin/b2c-reports/types\|preview\|export` | 4 | verified: preview count == CSV rows, CSV/XLSX/PDF, validation, audit rows, explicit report permissions, customer text defused against formulas |
| 9 | **B2C Analytics** (`b2c-analytics`) | `GET /api/admin/b2c-analytics/overview` | 1 | validation/permissions verified; figures **NOT VERIFIED on SQLite** |
| 10 | **B2C Flight catalogue** (`b2c-cat-flights`) | `GET /api/admin/catalogue/flights/supplier` | 1 | verified read-only: no write verbs, no credential-like fields. It is a supplier STATUS page, not an inventory |
| 11 | **Wallet payment requests** (inside `payments`) | `POST /api/admin/wallet/payment-requests`, `…/{id}/cancel`, `GET …/merchants/{id}/managers` | 20 | verified; **DEFECT-13 fixed** |
| 12 | **Package catalogue** — create, edit, itinerary, departures | `/api/admin/catalogue/packages…` | 11 | verified (SQLite ARRAY shim — see limits) |
| 13 | **Hotel + room edit persistence** | `/api/admin/catalogue/hotels…` | 1 | verified with the ARRAY shim; there is still no create-hotel / delete-hotel endpoint |
| 14 | **Live Support WebSocket** | `WS /api/customer/chat/ws`, `WS /api/admin/chat/ws` | 9 | verified (see below) |

## Defects found and fixed (each with a regression test)
| ID | Root cause | Impact | Fix | Files | Regression test |
|---|---|---|---|---|---|
| DEFECT-11 | `UpdateProfileRequest.full_name` was `min_length=1` on the untrimmed string, so `"   "` was stored as the account's name (same class as DEFECT-3/4/6) | unnamed account in the portal header and logs | `StringConstraints(strip_whitespace=True, min_length=1, max_length=150)` | `backend/app/schemas/profile.py` | `test_a_whitespace_only_name_is_rejected` |
| DEFECT-12 | `PUT /api/profile` changed name / phone / profile fields with no actor-attributed audit entry | unaudited account edit | log "Profile updated" with the changed field NAMES only | `backend/app/routers/profile.py` | `test_profile_changes_are_audited_without_values` |
| DEFECT-13 | `payment_admin_service.raise_request` passed its description as the 4th POSITIONAL argument of `log_activity`, i.e. into the `ip_address` slot, where `clean_ip()` discarded it (the audit row carried only the bare action); and `cancel_request` (withdrawing a payment request) wrote no audit entry at all. An AST scan of `app/` found no other call with this mistake | payment-request audit trail was empty of detail / missing | keyword `description=`; add a "Payment request withdrawn" entry | `backend/app/services/payment_admin_service.py` | `test_raise_is_audited_with_its_description_and_actor`, `test_cancel_withdraws_an_unpaid_request_with_a_mandatory_reason_and_is_audited` |

## Findings that are decisions, not defects (nothing changed — owner approval needed)
1. **B2C booking status change is gated by the VIEW scope** (`customer.view` / `b2c.customers.view`): a view-only admin can change a customer booking's status. There is no dedicated "manage bookings" permission to require instead, and inventing one is a policy decision. Pinned by `test_current_status_rules_are_pinned…`.
2. **No transition rules** on that endpoint: any status → any status (e.g. cancelled → confirmed). It does not touch payment state or refunds (asserted).
3. Agents holding a valid agent ticket may join ANY customer conversation (`get_for_admin` has no per-agent ownership check). Ticket minting is already gated (existing tests); whether agents should be limited to assigned/waiting chats is a product decision.

## Live Support WebSocket — results (local, isolated; real gateway + in-process broker + temp SQLite)
- **Authentication:** missing / empty / garbage ticket → close **4401** on both sockets; a ticket is **single-use** (replay → 4401); a customer ticket cannot open the agent socket and an admin ticket cannot open the customer socket even when the numeric ids collide; malformed actor strings refused.
- **Customer flow:** `joined` → `send_message` → `message_ack` + `receive_message`; the message is persisted exactly once; `client_msg_id` makes a re-send idempotent (`created:false`, same id); bad JSON → `bad_frame`; unknown event → `unknown_event`; oversize → `too_long`; blank → `rejected`; non-integer `up_to_message_id` → `bad_frame`; none of these creates a message or drops the socket; a flood is cut off by the per-socket rate limiter (`rate_limited`, at most `chat_rate_burst` accepted).
- **Message delivery:** customer → joined agent and agent → customer, both live; persisted rows match.
- **Internal notes:** delivered to agents (flagged internal), **never** to the customer's socket (proven by ordered drain), stored as internal.
- **Isolation:** two customers never hear each other; an agent only hears threads it joined; joining a non-existent conversation → `not_found`.
- **Disconnect / reconnection:** closing a socket clears presence; the conversation and messages survive; reconnecting with a NEW ticket lands in the SAME live conversation (one conversation row, history intact); an abrupt agent disconnect does not break the customer's conversation.
- **NOT TESTED / NOT CLAIMED:** Redis fan-out across workers (with more than one worker and no Redis the code itself logs that half the messages would be lost — a deployment requirement), WebRTC / calling / Wi-Fi calling media, attachments over the socket, browser client behaviour, proxy / TLS behaviour.

## SQLite limits on this phase (PostgreSQL NOT VERIFIED)
B2B analytics SQL; B2C analytics overview; B2C activity sessions/summary state logic (timezone-aware vs naive datetimes); free-text `search` (JSONB) on enquiries / reports; support `category` filter (JSONB `@>`); the DB `audit_logs` trigger; row locking, real sequences, unique partial indexes, enum casts. **Package / hotel / room persistence was exercised through a test-only ARRAY shim that stores a JSON string — it proves the application logic, not PostgreSQL ARRAY behaviour.**

## Section status after Phase 11 (38 sections)
| Status | Count | Sections |
|---|---|---|
| COMPLETE (verified end-to-end incl. UI/DB) | 2 | Dashboard; B2C Reviews |
| PARTIALLY COMPLETE — primary workflows API-VERIFIED (SQLite) | 25 | the 19 from Phase 10 (Payments, B2C Packages and Hotels-edit gained their remaining workflows this phase) + **Profile, Active Users, System Logs, B2C Bookings, B2C Reports, Live Support (WebSocket chat)** |
| PARTIALLY COMPLETE — reads / validation / partly NOT VERIFIED | 6 | Audit Logs; B2B Analytics; B2C Analytics; B2C Activity (logs only); B2C Flight catalogue (read-only status by design); B2C Hotels catalogue (no create/delete endpoint exists) |
| EXCLUDED | 1 | B2C Cancellations & Refunds |
| DISABLED BY DESIGN | 4 | gaming-* |
| BROKEN | 0 confirmed | — |
| NOT TESTED (no verified workflow at all) | 0 | — |

(Counts above are by primary evidence; sections that mix verified and unverified parts are listed under the row that matches their weakest primary workflow. Totals: 2 + 25 + 6 + 1 + 4 = 38.)

Evidence-based completion: **2 / 33** in-scope sections fully verified (6%); **25 / 33 (76%)** with primary write/read workflows verified at API level; **6 / 33 (18%)** partly verified or PostgreSQL-only; **0** with nothing verified. UI-level and PostgreSQL verification of every workflow remains outstanding, so this is NOT a production-readiness claim.

## Phase 11 test results
- **Full backend suite: 2335 passed, 8 skipped, 0 failed** (2248 passed / 4 skipped before; +87 passed). Skips: the 4 pre-existing ones (PostgreSQL-only refund tests and an email-mode test) plus **4 new, deliberate "NOT VERIFIED on SQLite" skips** (B2B analytics, B2B operations metrics, B2C analytics, B2C activity sessions/summary). `backend/dev.db` md5 unchanged.
- Files changed in Phase 11 (by me): `backend/app/schemas/profile.py`, `backend/app/routers/profile.py`, `backend/app/services/payment_admin_service.py`, `backend/tests/_v2_harness.py` (default test-user email domain only); new tests `test_admin_profile_users_logs_analytics_http.py`, `test_admin_b2c_bookings_activity_reports_http.py`, `test_admin_wallet_payment_requests_http.py`, `test_admin_catalogue_packages_hotels_http.py`, `test_live_support_websocket.py`; this tracker.

---

# Phase 12 — PostgreSQL integration & browser verification (2026-11-17) — BLOCKED; decisions analysed; regression run

Nothing committed/pushed/merged/deployed. No database connected to, created, migrated or deleted. `.env`, `dev.db` (md5 `0c5d0c25…` unchanged), `jackpots_v2`, production untouched. No code changed in this phase (tracker only). Gaming still fail-closed; refunds untouched; TrustBrick / payment-provider configuration untouched; no external action of any kind.

## 1. Environment verification — result: BLOCKED (stopped before connecting, as instructed)
| Check | Finding |
|---|---|
| Local PostgreSQL | Windows service `postgresql-x64-17` running, listening on 5432. It is the SAME server that hosts the permanent dev database `jackpots_v2`. |
| Disposable DB `jackpots_livecheck` | Was created in an earlier session on that same server. Its identity cannot be proven now: the only credential available is the one in `backend/.env` (which points at `jackpots_v2`, and must not be used blindly); in Phase 3 that password was REJECTED for `jackpots_livecheck`. No other credential exists in the session. Per the rules ("never guess database identity from a name alone") no connection was attempted. |
| Earlier test server on :8099 | No longer running (no listener on 8099). |
| Docker (an isolated throw-away PostgreSQL container would be provably disposable) | Docker CLI installed but the Docker engine is NOT running, and no PostgreSQL image is present locally — creating one would mean a download + creating a database, both of which need your approval. Not done. |
| `REFUND_TEST_POSTGRES_URL` / other test-DB variables | Not set. |

Consequently **every PostgreSQL item and every browser item in this phase is BLOCKED**. Nothing below is labelled VERIFIED or BROWSER VERIFIED.

## 2. PostgreSQL integration — all BLOCKED (not run)
| Area | Status | What would be run once unblocked |
|---|---|---|
| B2B + B2C analytics SQL; B2C activity sessions/summary | BLOCKED | the 4 tests currently self-skipping on SQLite, unchanged, against PostgreSQL |
| Free-text JSONB search (enquiries, reports), support `category` filter (`@>`) | BLOCKED | existing list endpoints with `search` / `category` |
| `audit_logs` trigger (`fn_write_audit_log`) | BLOCKED | insert/update/delete a merchant/user/payment row → assert the trigger row + redaction on read |
| Row locking / concurrency (`FOR UPDATE` on top-up verify, ticket issue, change-request settle, payment verify) | BLOCKED | two concurrent sessions racing the same row → exactly one success, the other 409/400, one ledger row |
| Unique / partial unique indexes (`uq_wallet_transactions_topup`, `uq_wallet_transactions_booking_debit`, `uq_sr_ticket_number`, `ux_merchants_email_not_deleted`, `uq_customer_conversation_live`) | BLOCKED | direct duplicate inserts + API duplicates |
| Real sequences (REQ/SRQ/TKT/INV/ENQ/PRD numbering), enum casts | BLOCKED | numbering continuity + every enum value round-trip |
| Package / hotel ARRAY persistence | BLOCKED (SQLite only proved via JSON shim) | package/hotel/room create/edit round-trip |
| Wallet debit/reversal, payment request lifecycle, booking payment verification, ticket issuance, duplicate prevention | BLOCKED on PostgreSQL (API VERIFIED on SQLite in Phases 8–11) | the existing HTTP suites re-pointed at PostgreSQL, plus concurrency |

## 3. Browser verification — BLOCKED (not run)
No backend can be started against a verified disposable PostgreSQL database, so no workflow was exercised in the browser this phase. Previously, only these were exercised in a browser: Phase 1–2 (all 38 sections loaded, merchant create, booking approve) against the old disposable server, and Phases 6–7 (both broadcast forms, the customer account-actions panel) against a MOCK API. None of the Phase 12 list is BROWSER VERIFIED.

## 4. Defects / fixes this phase
None found (no new testing was possible beyond regression). No files changed except this tracker.

## 5. The three business decisions — analysis and proposals ONLY (nothing changed)

### Decision 1 — B2C booking status change needs only VIEW permission
- **Current code:** `PATCH /api/admin/customer-bookings/{ref}/status` (`backend/app/routers/admin_customer_bookings.py`) uses `require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW)` — the same scope as the read endpoints.
- **Risk:** anyone allowed only to *look at* customer bookings can mark a booking confirmed, cancelled or completed. Combined with Decision 2 (no rules) this is the larger exposure: see the risks listed there.
- **Existing permissions:** `b2c.customers.view` (read), `b2c.customers.manage` (already used for block / unblock / password reset — the B2C "act on a customer" scope), `customer.view` (B2B legacy read). No booking-specific manage permission exists.
- **Smallest safe change (proposal):** gate only the PATCH with `require_scope(P.B2C_CUSTOMERS_MANAGE)` (super-admin passes automatically). Reads unchanged. No migration. Frontend: hide the status dropdown in `frontend/assets/js/admin-b2c-bookings.js` unless `/api/auth/me` lists `b2c.customers.manage` (same pattern as the customer account-actions panel); the backend stays the authority.
- **Impact:** admins who currently change statuses with only a view grant will get 403 until granted `b2c.customers.manage` (a data step in the Super Admin portal, no migration).
- **Approval needed:** "Yes — require `b2c.customers.manage` for B2C booking status changes" (or name a different existing permission).

### Decision 2 — B2C booking status has no transition rules
- **Current code:** `customer_booking_admin_service.update_status` accepts any of `pending | confirmed | cancelled | completed` from any status and writes it directly.
- **Risks found in the code (facts, not policy):**
  1. **Confirming bypasses the money and supplier checks.** The normal path to `confirmed` is payment verification (`payment_verification_*_service.py`), which refuses to confirm a live-supplier flight without a supplier order id (`supplier_guard.hold_if_unreserved`). The admin PATCH skips both: an unpaid or supplier-unreserved booking can be shown to the customer as confirmed.
  2. **Cancelling bypasses the refund-owed flag.** The customer cancellation path (`customer_booking_service` ~line 320) flags a paid-but-unreserved booking as refund-owed for the Cancellations desk (`supplier_guard.flag_refund_owed`). The admin PATCH to `cancelled` does not, so a captured payment can sit unflagged.
  3. **Terminal states can be reopened** (cancelled → confirmed, completed → pending).
- **Proposal (choose; none invented as policy):** (a) minimal — refuse leaving `cancelled`/`completed` via this endpoint; (b) safer — additionally refuse `confirmed` unless the booking already has a captured payment and is not held by the supplier guard, and route `cancelled` through the existing cancellation function so the refund-owed flag is applied; (c) remove `confirmed`/`cancelled` from this endpoint entirely and leave only `completed` (and `pending`?) as manual corrections. No migration in any option; frontend: limit the dropdown options to what the backend allows and show the 409 message.
- **Impact:** any desk procedure that currently fixes bookings by hand-setting status would need the proper path (payment verification / cancellation desk).
- **Approval needed:** which of (a)/(b)/(c), or an explicit transition table from the owner.

### Decision 3 — any agent can join any customer conversation
- **Current code:** both the agent WebSocket (`chat_gateway.AgentConnection._join` / `_send_message`) and the REST thread/reply/status endpoints in `routers/admin_chat.py` resolve the conversation with `customer_chat_service.get_for_admin(db, id)`, which only checks the row exists — no assignment check. Access to the whole chat console is gated by `get_current_b2c_admin`, which admits a super admin or ANY explicit `b2c.*` scope (e.g. `b2c.reports.view` alone is enough), not specifically `b2c.chat.manage`.
- **Existing mechanisms:** `b2c.chat.manage` permission (defined, "B2C live-chat / support console"); `assigned_admin_id` on the conversation; `claim` (409 if someone else owns it), `transfer`, auto-assignment (`chat_assignment.auto_assign`), the `mine` queue filter; internal notes; per-agent personal channel for calls.
- **Risks:** a report-only or catalogue-only admin can read and reply to every customer conversation (personal data exposure, impersonation of the support desk); two agents can answer the same customer simultaneously despite the claim mechanism.
- **Smallest safe changes (proposals, independent):** (A) narrow the console gate to `b2c.chat.manage` (+ super admin) instead of "any b2c.* scope" — no migration; affected admins need the grant; (B) for WRITE actions (reply, internal note, status, transfer) require that the conversation is unassigned-and-being-claimed or assigned to the caller, keeping READ/`join` open for supervision — no migration; frontend shows the existing 409 text.
- **Impact:** (A) admins currently using chat with another b2c scope lose access until granted; (B) supervisors who reply into colleagues' chats would need to transfer/claim first.
- **Approval needed:** whether to apply (A), (B), both, or neither; and whether supervisors (super admin) are exempt from (B).

## 6. Production-readiness gaps (unchanged by this phase)
PostgreSQL verification of everything listed in §2; browser verification of every workflow; Redis for multi-worker live chat; migration 0095 / DBA grants / role separation and the default super-admin password from the Nov-13 audit; the three decisions above; HTML cache headers so new script versions reach browsers; nothing has been committed, so nothing is deployed.

## 7. What is needed to unblock
Either (i) a PostgreSQL connection the owner confirms is disposable (host, database name, a role with no access to `jackpots_v2` or production), or (ii) approval to start Docker Desktop and run a throw-away `postgres:17` container (image download ≈ 150 MB, a new local database that is deleted afterwards), then run migrations to head on it and point a local backend at it for both the PostgreSQL suite and the browser pass.

## Phase 12 regression results (SQLite — API level)
- **Full backend suite: 2335 passed, 8 skipped, 0 failed** (identical to Phase 11; the 8 skips are the 4 PostgreSQL-only / email-mode tests and the 4 deliberate "NOT VERIFIED on SQLite" skips).
- Focused safety suites re-run together — broadcast recipient safety, customer account actions (permission-protected), merchant management (deleted merchants cannot be reactivated/modified), payment + ticket rules, wallet payment requests, profile/audit fixes, gaming fail-closed: **214 passed, 2 skipped (the analytics SQLite skips), 0 failed**.
- Refunds: no refund code was added or changed in any phase of this work. Gaming: `GAMING_TOUR_PACKAGES_ENABLED` unset → disabled; `test_gaming_fail_closed` passes. No real external action occurred (all delivery mocked; no database connected).
- `backend/dev.db` md5 unchanged. Git: 195 modified/untracked entries (unchanged count), nothing committed.

---

# Phase 12 (approved run) — Isolated PostgreSQL 17 + browser verification (2026-11-17)

Approved by the owner: download the official PostgreSQL 17 image, create a disposable container + empty database, run PostgreSQL integration and browser verification, then remove the temporary container/volume/files. Nothing committed/pushed/merged/deployed. `.env`, `dev.db` (md5 unchanged), `jackpots_v2`, the local PostgreSQL service and production were NOT touched. Gaming stays disabled (`GAMING_TOUR_PACKAGES_ENABLED=false` for the test process); refunds untouched; TrustBrick/payment configuration untouched (`PAYMENT_PROVIDER=none` for the test process only); no external action of any kind (SMTP blank, OTP in dev-echo mode, notifications/deliveries mocked in tests).

Evidence labels: **VERIFIED** = PostgreSQL tested · **BROWSER VERIFIED** = done in the browser against the disposable backend · **API VERIFIED** = backend routes (SQLite, earlier phases).

## 1. Docker environment and isolation
| Item | Value |
|---|---|
| Docker | Docker Desktop started by me (engine 29.5.3). **Side effect to note:** starting Docker auto-started a PRE-EXISTING container `jpw-uat-pg-persist` (postgres:16, bound 127.0.0.1:55433) because of its own restart policy. I did not touch, stop or modify it. |
| Image | `postgres:17` (official) pulled — PostgreSQL 17.12. Image kept (shared images are not removed). |
| Container | `jpw-phase12-pg-5fe16b20` (id `e54268c47b15`), label `purpose=phase12-disposable` |
| Volume | `jpw_phase12_pgdata_5fe16b20` — new, dedicated; no host directory or existing volume mounted |
| Port | `127.0.0.1:55432 -> 5432` (localhost only; 5432/55433 avoided after a conflict check) |
| Database / role | `jackpots_phase12_test`, role `phase12_admin`, password freshly generated, kept in a scratch file only, never printed |
| Identity proof (from inside the container, before migrating) | `current_database()=jackpots_phase12_test`, the only non-system database, **0 tables**, PostgreSQL 17.12 |
| App wiring | A guarded runner set PROCESS-ONLY env vars (`DATABASE_URL` and `MIGRATION_DATABASE_URL` → the container; SMTP blank; `PAYMENT_PROVIDER=none`; `OCR_PROVIDER=none`; `DEPLOYED=false`; gaming false; `REDIS_URL` empty; test-only seed admin) and, before EVERY migration/test/server start, imported the app settings and refused to run unless both the runtime and the Alembic URL resolved to `@127.0.0.1:55432/jackpots_phase12_test` and contained no `jackpots_v2`. `.env` was not edited. |
| Migration | `alembic upgrade head` → **`0095_customer_admin_audit_logs`** (head), 75 tables, exit 0 |

## 2–4. PostgreSQL integration tests — `backend/tests/test_phase12_postgres_integration.py` (13 tests)
The module skips itself unless `PHASE12_PG=1` AND the settings point at the disposable DB, so a normal `pytest` run can never reach another database (it shows 13 skips in the regular suite).

| # | Test | Database objects | Result |
|---|---|---|---|
| 1 | Audit trigger records INSERT and UPDATE on `merchants` with old/new values; the audit reader redacts every captured `password_hash` | `audit_logs`, `fn_write_audit_log` trigger | **VERIFIED – PASS** |
| 2 | Partial unique merchant email: duplicate active email refused; allowed again once the first is `deleted` | `ux_merchants_email_not_deleted` | **VERIFIED – PASS** |
| 3 | Every `RequestStatus` enum value round-trips; duplicate ticket number refused | `request_status_enum`, `uq_sr_ticket_number` | **VERIFIED – PASS** |
| 4 | Real sequences give distinct, increasing request numbers | `seq_*` sequences via `_next_number` | **VERIFIED – PASS** |
| 5 | Enquiry free-text search on JSONB `origin_city`; support thread `category` filter (JSONB `@>`) | `service_requests.travel_details` | **VERIFIED – PASS** |
| 6 | Report summary with `search` equals the export rows and total | JSONB `astext` search | **VERIFIED – PASS** |
| 7 | B2B analytics (bookings, change-requests, operations) run; operations refused for a merchant | analytics SQL | **VERIFIED – PASS** |
| 8 | B2C activity summary + sessions (active vs ended states) + B2C analytics overview | `customer_sessions`, `customer_audit_logs`, analytics SQL | **VERIFIED – PASS** |
| 9 | Package highlights/inclusions/exclusions, itinerary meals, hotel amenities, room perks round-trip as real ARRAYs (values containing commas); duplicate departure date refused (409) | ARRAY columns, departure uniqueness | **VERIFIED – PASS** |
| 10 | **Concurrency:** two simultaneous verifies of one top-up → `[200, 409]`, wallet credited once, ONE ledger row | `FOR UPDATE` on `wallet_topups`, `uq_wallet_transactions_topup` | **VERIFIED – PASS** |
| 11 | **Concurrency:** two simultaneous classic ticket issues → one 200, one refused; wallet debited once; ONE booking-debit row | `FOR UPDATE` on `service_requests`, `uq_wallet_transactions_booking_debit` | **VERIFIED – PASS** |
| 12 | **Concurrency:** two simultaneous payment verifications → `[200, 400]`, payment SUCCESS once, booking PAID once, exactly one "paid" timeline entry | `FOR UPDATE` on `payments` | **VERIFIED – PASS** |
| 13 | Wallet payment request (crypto, network normalised) raised; an `awaiting_payment` request cannot be verified (409); withdrawn | `wallet_topups` | **VERIFIED – PASS** |

**13 passed, 0 failed.** Items that were NOT VERIFIED before and are now VERIFIED: analytics SQL (B2B + B2C), B2C activity sessions/summary, JSONB search and category filter, the audit trigger, row locking under real concurrency, unique/partial unique indexes, real sequences, enum casts, ARRAY persistence, wallet/payment-request/payment-verification/ticket integrity on PostgreSQL.

Still NOT VERIFIED on PostgreSQL: `uq_customer_conversation_live` race; Redis fan-out; the B2C refund PostgreSQL tests (Refund Management is EXCLUDED, so they were deliberately not run).

## 5. Browser workflows tested (BROWSER VERIFIED — real Admin Portal served by the disposable backend on 127.0.0.1:8440)
Test-only accounts seeded by me: `phase12.admin@tt-qa.com` (admin + explicit b2c scopes) and `phase12.viewer@tt-qa.com` (view-only); test merchant "Phase12 Alpha Travels", test customer P12CUST1, one pending booking, one submitted top-up. Login used the real password + OTP screens (dev-echo OTP on this test host).

| Workflow | Evidence | Result |
|---|---|---|
| Admin login (password → OTP) for two accounts | real form typing | **BROWSER VERIFIED** |
| All 38 sections opened from a fresh page load | 78 API calls: 34 sections all-200; the 4 gaming sections 404 by design (fail-closed); **0 JavaScript errors**; Live Support makes no REST call on open (WebSocket screen) | **BROWSER VERIFIED (load)** |
| Dashboard | shows the PostgreSQL counts | **BROWSER VERIFIED** |
| Customer account actions: block (empty reason refused inline, then blocked with reason) → **status still "blocked" after a full page refresh** → unblock | `customers.status`, `customer_admin_audit_logs` row `customer.block/success` | **BROWSER VERIFIED + VERIFIED** |
| Wallet desk: Review → Verify & credit wallet → Confirm | `wallet_topups.status=verified`, merchant wallet 1000 → 3500, one ledger row, `system_logs` "Wallet top-up verified" | **BROWSER VERIFIED + VERIFIED** |
| Approval Queue: Approve with empty amount refused inline ("Enter an amount greater than zero"), then approved at 4999.50 | `POST …/approve 200`; booking `payment_pending`, 3 timeline steps, `audit_logs` trigger rows | **BROWSER VERIFIED + VERIFIED** |
| B2C booking status change (Pending → Confirmed via the dropdown + Save) | `PATCH …/status 200`; row `confirmed` | **BROWSER VERIFIED** (demonstrates Decision 2's risk: no rule stops it) |
| Destination create: empty name → server 422 shown as "name: is required"; then created | `customer_destinations` row, slug `phase12-andaman` | **BROWSER VERIFIED + VERIFIED** |
| Profile: rename | header chip updates; `users.full_name` changed; `system_logs` "Profile updated" with `["full_name"]` (DEFECT-12 fix confirmed on PostgreSQL) | **BROWSER VERIFIED + VERIFIED** |
| Broadcast: "all" unticked + no merchant | inline error, **no request sent** (no real broadcast was ever sent) | **BROWSER VERIFIED** |
| Permission visibility as the view-only admin | customer account-actions panel absent; catalogue screens get 403 | **BROWSER VERIFIED** |

## 6. Browser workflows NOT tested this run (and why)
Merchant create/edit/suspend/delete in the UI, booking-ops notes/references/assign, change requests, enquiries/quotations, payment-request raise/withdraw form, payment accounts and providers forms, support thread replies, live chat in the agent console (WebSocket UI), communication settings form, reports/exports downloads (API-checked only), hotels/packages editors, audit/system log filters, analytics charts, flight catalogue page content, document upload/download. Reason: time-boxed to the highest-value flows; all of these remain API VERIFIED (SQLite) and, where listed in §2, VERIFIED on PostgreSQL — but **not BROWSER VERIFIED**.

## 7. Defects discovered / fixes made this run
No code defect found, and no product code changed. One test-data observation: the wallet desk reconciliation banner reported "3 of 14 merchants DO NOT reconcile" — those are the test merchants the integration tests created with a starting `wallet_balance` written directly (no opening ledger row), which is exactly what the drift check exists to flag. Not a product defect.

New findings for the owner (not changed — policy):
- **F-12a (extends Decision 3):** on the real stack, an admin holding only `b2c.customers.view` can mint a live-chat agent ticket (`POST /api/admin/chat/ws-ticket` 200) and read the chat queue — the console gate admits ANY `b2c.*` scope.
- **F-12b:** B2C report preview/export is gated by `require_scope(B2C_REPORTS_*, CUSTOMER_VIEW)` (any-of). The view-only test admin (explicit `customer.view`, role-default `report.export`) downloaded the **customers** report (names, emails, mobiles) as CSV. This matches the endpoint text ("Requires `report.export` and `customer.view`") only because `report.export` is an Admin role default; whether customer-PII exports should instead require the explicit `b2c.reports.export` scope is an owner decision.

## 8. Three business decisions (unchanged; analysis in the previous Phase 12 section)
Decision 1 (booking status needs only view permission), Decision 2 (no transition rules — demonstrated in the browser above) and Decision 3 (any agent can join any conversation — reinforced by F-12a) remain **open, no code changed**.

## 9. Remaining production-readiness gaps
Browser verification of the workflows in §6; Redis for multi-worker chat; the decisions in §8 and F-12a/F-12b; HTML caching so new script versions load; migration 0095 + DBA grants + role separation on the real servers; confirm the live super-admin password is not the repository default; commit/review/deploy (nothing is committed).

## 10. Regression (normal settings, SQLite) after the PostgreSQL run
- **Full backend suite: 2335 passed, 21 skipped, 0 failed.** The 21 skips = the 8 from Phase 11 + the 13 new Phase 12 PostgreSQL tests, which correctly skip themselves when the settings do not point at the disposable database.
- Phase 11 fixes, broadcast recipient safety, permission-protected customer actions, deleted-merchant protection, payment/ticket rules and gaming fail-closed are all inside that green run. No refund code was added. `backend/dev.db` md5 unchanged.

## 11. Cleanup verification
- Removed ONLY: container `jpw-phase12-pg-5fe16b20` and volume `jpw_phase12_pgdata_5fe16b20` (both carried the label `purpose=phase12-disposable`, checked before removal), the scratch folder holding the generated test credentials / runner / seed script / logs, the test backend process on 127.0.0.1:8440, and the browser storage for that origin.
- Verified after cleanup: no container or volume from this phase remains; nothing listens on 55432 or 8440. The pre-existing containers (`jpw-uat-pg-persist` running — it was auto-started by Docker's restart policy when Docker Desktop started, `jpw_qa_pg`, `jpw-uat-pg-dbf48d`) and volumes (`9ebc36c1…`, `jpw_uat_pgdata_13679d2a`) are unchanged. The `postgres:17` image was kept (shared images are not removed). Docker Desktop was left running.
- Kept on purpose: `backend/tests/test_phase12_postgres_integration.py` (re-runnable against any future disposable database; skips otherwise).

## 12. Files changed in Phase 12
`backend/tests/test_phase12_postgres_integration.py` (new) and this tracker. No application code changed.

---

# Phase 13 — Security & workflow investigation (2026-11-17) — INVESTIGATION AND PLANNING ONLY

Nothing was implemented. No product code, permission code, migration, database record, `.env`, `dev.db` (md5 `0c5d0c25…` unchanged) or workflow was changed. Git: 196 entries before and after (only this tracker changed). **None of the five issues is fixed.** Gaming stays disabled; Refund Management stays EXCLUDED; Activities & Tours stay out of scope.

Method: code reading, plus one in-memory check of the permission functions with stub users (no database touched).

## 1. Executive summary
All five issues are confirmed in the code. There is one correction to Phase 12, and there are six related findings (X1–X6 in section 2).
- **Correction to F-12b:** the cause is NOT the `report.export` role default. The B2C export endpoint never looks at role defaults. It accepts *either* `b2c.reports.export` *or* an explicit `customer.view` grant, so an explicit `customer.view` alone is enough to download every B2C report, including the customers file. In-memory check: `customer.view` only → ALLOW; `b2c.customers.view` only → 403; no explicit grants → 403.
- **Tests that should catch this have never run.** In `backend/tests/test_admin_b2c_bookings_activity_reports_http.py`, the assertions "an admin with only `customer.view` gets 403 on export" come *after* a `pytest.skip` that always fires on SQLite (around line 359), so they never execute. The Phase 12 PostgreSQL browser pass showed the real behaviour: export allowed.
- The fixes are permission and workflow changes only. **No database migration is expected.** Rollout needs a data step: granting the right codes to the right admins before deploying.

## 2. Root causes
| # | Issue | Root cause (file → function) |
|---|---|---|
| 1 | A view-only admin can change a booking status | `backend/app/routers/admin_customer_bookings.py` → `update_booking_status` uses `require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW)`, the same read scope as the GET routes. |
| 2 | Any status → any status | `backend/app/services/customer_booking_admin_service.py` → `update_status` only checks the value is one of the four statuses and writes `booking.status` directly. It does not run payment confirmation, the supplier guard, the per-product `cancel()`, the refund-owed flag, package seat release, `cancelled_at` or the customer notification. It also **commits before** the router writes the two audit entries, so a failed audit write would leave an un-audited status change. The audit stores only the new status, not the old one. |
| 3 | Any B2C admin can read and write any conversation | `backend/app/routers/admin_chat.py` → `get_current_b2c_admin` admits a super admin or ANY `b2c.*` scope. Every route then uses `customer_chat_service.get_for_admin`, which only checks the row exists. The WebSocket (`backend/app/services/chat_gateway.py` → `AgentConnection._join`, `_send_message`, `_mark_read`, `_typing`, `_dispatch_call`) has the same gap. `transfer` and `set_status` do not check who owns the conversation. |
| 4 (F-12a) | A view-only admin gets an agent ticket and the queue | Same gate as Issue 3: `b2c.customers.view` is a `b2c.*` scope, so `get_current_b2c_admin` lets it through for `POST /api/admin/chat/ws-ticket` and every chat REST read. |
| 5 (F-12b) | A view-only admin exports customer personal data | `backend/app/routers/admin_b2c_reports.py` → `_EXPORT = require_scope(P.B2C_REPORTS_EXPORT, P.CUSTOMER_VIEW)` means "either one". The module docstring says "both required", so code and documentation disagree. `_VIEW` (types, preview, analytics) has the same shape. |

Related findings (documented only; nothing changed):
- **X1 — cancellation approval also bypasses the cancel workflow.** `backend/app/routers/admin_cancellations.py` → `decide_cancellation` (gated by `require(P.CUSTOMER_VIEW)`, which *includes* the Admin role default, plus the router-level `require_b2c_access`) → `customer_cancellation_admin_service.decide` sets `booking.status = "cancelled"` directly. It does not call the product `cancel()`, so there is no refund-owed flag, no package seat release, no `cancelled_at` and no customer notification. This sits inside the cancellation/refund module, which is EXCLUDED, so it is reported only.
- **X2 — hotel cancellation never flags "refund owed".** `customer_hotel_booking_service.cancel` has no refund-owed step. Packages flag any captured payment; flights flag only when `supplier_status = reservation_missing`. A paid hotel cancelled by the customer leaves no "refund owed" marker. Whether it should is an owner decision.
- **X3 — "completed" can only be set through this admin PATCH.** No other B2C code sets a booking to `completed` (`booking_management_service.complete_booking` belongs to the older non-B2C model). Removing `completed` from the PATCH would leave no way to complete a trip.
- **X4 — chat auto-assignment and the transfer list ignore B2C scopes.** `chat_assignment.candidates` and `GET /api/admin/chat/agents` use every ACTIVE `admin`/`super_admin` user. A chat can therefore be auto-assigned to a B2B-only admin who gets 403 on the console. `transfer` accepts any `users` id (`db.get(User, …)`) with no role, status or scope check, so even a merchant user or a suspended admin could be the target.
- **X5 — the WebSocket checks permission only when the ticket is issued.** An open socket keeps working after the admin's permissions are removed, until it disconnects. `typing_start`/`typing_stop` publish to any conversation id without an existence check. `call_request` accepts any conversation id.
- **X6 — frontend permission data.** `GET /api/auth/me` returns *effective* permissions (role defaults included). The frontend can mirror `b2c.*` checks reliably (no role default holds them), but must not use `customer.view` to mirror a `require_scope` check. Also, `AdminLiveSupport.boot()` (called at sign-in from `frontend/assets/js/admin.js`, around line 93) opens the agent socket for every admin. After the fix, admins without the chat scope would hit a 403 at every sign-in unless boot is skipped for them.

## 3. Exact backend files and functions
| Area | File → function |
|---|---|
| Permission codes, role defaults, checkers | `backend/app/auth/rbac.py` → `P`, `B2C_SCOPES`, `_ADMIN`, `_SUPER_ADMIN`, `effective_permissions`, `require`, `require_scope`, `require_b2c_access` |
| Booking status PATCH | `backend/app/routers/admin_customer_bookings.py` → `update_booking_status`; `backend/app/services/customer_booking_admin_service.py` → `update_status`, `_find_product`, `BOOKING_STATUSES` |
| Booking status values | `backend/app/models_customer.py` → enum `customer_booking_status_enum` (pending, confirmed, cancelled, completed), `CustomerBookingStatus` |
| Confirmation (the only legitimate writers of `confirmed`) | `payment_verification_flight_service.confirm_booking`, `payment_verification_hotel_service.confirm_booking`, `payment_verification_service.confirm_booking` (packages). Each needs a captured payment equal to the booking total, refuses cancelled/completed bookings, and runs once under a row lock. Flights also pass `supplier_guard.hold_if_unreserved`. The reconciliation "verify" (`customer_reconciliation_service.verify_payment`) only reads the gateway; it confirms nothing. |
| Held-flight resolution | `supplier_guard.complete_reservation`, via `POST /api/admin/reconciliation/flight-bookings/{ref}/supplier-reservation` (`admin_reconciliation.record_supplier_reservation`, scope `b2c.payments.verify` or `payment.verify`) |
| Cancellation | `customer_booking_service.cancel` (flight: refund-owed flag if the reservation is missing), `customer_hotel_booking_service.cancel` (no flag), `customer_package_booking_service.cancel` (`_flag_refund_owed` + seat release). All three refuse to cancel an already-cancelled or completed booking. The customer routes then write the customer audit (`customer_audit_service.log`) and send the `booking_cancelled` notification (`acct.notify`). |
| Live chat | `backend/app/routers/admin_chat.py` → `get_current_b2c_admin`, `queue`, `thread`, `claim`, `transfer`, `set_status`, `reply`, `_send_attachment_access`/`send_attachment`, `_attachment_access`/`download_attachment`, `mark_read`, `conversation_calls`, `conversation_context`, `agents`, `analytics`, `ice_config`, `ws_ticket`, `agent_socket`. `backend/app/services/chat_gateway.py` → `serve_agent`, `AgentConnection._dispatch/_join/_send_message/_typing/_mark_read/_dispatch_call`; the customer socket's `_pump` drops frames marked `internal`. `backend/app/services/customer_chat_service.py` → `_visible`, `get_for_customer`, `get_for_admin`, `claim`, `transfer`, `set_status`, `post_admin_message`. `backend/app/services/chat_assignment.py` → `candidates`, `auto_assign`. `backend/app/models_customer.py` → `CONVERSATION_TRANSITIONS`. |
| Reports | `backend/app/routers/admin_b2c_reports.py` → `_VIEW`, `_EXPORT`, `report_types`, `preview_report`, `export_report`, `analytics_overview`. `backend/app/services/customer_report_service.py` → 5 reports (bookings, payments, cancellations, customers, reviews), `ROW_CAP` 5000; the customers report has Name, Email, Mobile; the other four include customer name and email. `backend/app/services/export_service.py` → `build_export` (CSV / Excel / PDF, formula defusing). |

## 4. Exact frontend files and functions
| Area | File → function |
|---|---|
| Booking status control | `frontend/assets/js/admin-b2c-bookings.js` → `renderBookingDetail` (always renders the 4-option dropdown and Save), `saveBookingStatus` (shows the server's `detail` on error) |
| Permission pattern to reuse | `frontend/assets/js/admin-b2c-customers.js` → the cached `/api/auth/me` permission set (around lines 214–224) that shows the account-actions panel only with `b2c.customers.manage` |
| Live chat | `frontend/assets/js/admin-live-support.js` → `boot` (socket at sign-in), `init`, `loadQueue`, `openConversation`, `paintActions` (Claim shown only when unassigned; Resolve/Close/Reopen by status only), `act`, `openTransfer`/`doTransfer`, the reply sender (`is_internal`), the attachment sender. `frontend/assets/js/admin.js` → `AdminLiveSupport.boot()` (around line 93) and section open (around line 268) |
| Reports | `frontend/assets/js/admin-b2c-reports.js` → `rprDownload` and the CSV/Excel/PDF buttons (enabled whenever the preview has rows; no permission check) |
| Cache tokens | `frontend/admin/index.html` → bump the `?v=` token of every changed script |

## 5. Existing permission and role mappings (facts)
- `b2c.*` codes are in **no** role default. They are granted per user from the Super Admin portal (`PUT /api/super-admin/admins/{id}/permissions`). A super admin passes every `require_scope` check. No migration, seed or script grants any `b2c.*` code (searched `backend/alembic`, `backend/app`, `backend/scripts`).
- `require_scope` ignores role defaults; `require` uses them. The same code `customer.view` therefore behaves differently by endpoint: under `require` every Admin has it by default; under `require_scope` only an explicit grant counts.
- Admin role default (`_ADMIN`) includes `report.view`, `report.export`, `customer.view`, `refund.view/execute/reconcile`, `chat.manage` (B2B support), and more. Super Admin default includes `report.view`, `report.export`, `refund.view` (not `customer.view`).
- Existing B2C codes: `b2c.customers.view`, `b2c.customers.manage` (today: block / unblock / password reset), `b2c.catalogue.manage`, `b2c.payments.verify`, `b2c.refunds.*`, `b2c.reports.view`, `b2c.reports.export`, `b2c.chat.manage` (**defined, but no endpoint checks it today**), `b2c.audit.view`, `b2c.communication.send`. **There is no booking-specific permission.**
- Which real admin accounts hold which grants cannot be determined from code. Production was not queried. Before rollout the owner needs to list (or approve a read-only listing of) admins holding `customer.view`, `b2c.customers.view`, `b2c.chat.manage` and `b2c.reports.*`.

## 6. Proposed permission matrix (proposal — needs approval)
| Action | Today | Proposed | Loses access | Keeps access |
|---|---|---|---|---|
| List / read B2C bookings | `b2c.customers.view` OR explicit `customer.view` | unchanged | — | — |
| Change booking status (PATCH) | same as read | **`b2c.customers.manage`**, or a new `b2c.bookings.manage` if the owner does not want "manage" to cover more than account actions (Q1) | admins with only view grants | super admin; holders of the manage code |
| Live-chat console (queue, thread, ws-ticket, socket, calls, context, agents, analytics, attachments, ICE) | super admin OR any `b2c.*` | **super admin OR `b2c.chat.manage`** | everyone whose only B2C grants are other `b2c.*` codes | super admin; `b2c.chat.manage` holders |
| B2C report types / preview / analytics | `b2c.reports.view` OR explicit `customer.view` | **`b2c.reports.view`** (drop the `customer.view` fallback) | admins relying on `customer.view` alone | super admin; `b2c.reports.view` holders |
| B2C report export (all 5 reports; CSV, Excel, PDF) | `b2c.reports.export` OR explicit `customer.view` | **`b2c.reports.export` AND `b2c.reports.view`** | admins relying on `customer.view` alone | super admin; holders of both |
| B2B reports `/api/reports/export`, providers export | `report.export` (role default) | **unchanged** — merchant-scoped / B2B data used by merchants and Admin; no B2C customer data found there | — | — |
| Cancellation approval (X1) | `require(customer.view)` incl. role default | **no change in Phase 13** (Refund Management EXCLUDED) | — | — |

## 7. Proposed booking transition matrix (proposal — needs approval)
"Manual PATCH" = `PATCH /api/admin/customer-bookings/{ref}/status`. Every allowed row needs the Issue 1 permission. Refused rows return 409 with a message naming the correct desk. Same → same returns 200 with no write and no audit.
| Current | Requested | Allowed via manual PATCH? | Payment condition | Supplier condition | Existing function to run |
|---|---|---|---|---|---|
| pending | confirmed | **No** | captured payment equal to the total | flights: valid `supplier_order_id` when a live supplier is required | gateway path: `payment_verification_*.confirm_booking`; held flight: reconciliation desk → `supplier_guard.complete_reservation` |
| pending | cancelled | Yes | none needed; if a captured payment exists, the product's existing refund-owed flag runs | flight: flag only if `reservation_missing` | product `cancel()`, then the same customer audit as the customer route; notification only if Q5 = yes |
| pending | completed | **No** | — | — | — |
| confirmed | pending | **No** | — | — | — |
| confirmed | cancelled | Yes | as above | as above | product `cancel()` + audit (+ notification per Q5) |
| confirmed | completed | **Owner decision (Q4)** — see X3: this PATCH is the only way to complete a booking | captured payment required? (owner) | — | none exists; would stay a direct status write, audited old → new |
| cancelled | anything else | **No** (terminal) | — | — | — (a payment captured on a cancelled booking is already routed to "needs review" by `confirm_booking`) |
| completed | anything else | **No** (terminal) | — | — | — |

## 8. Proposed chat access and ownership matrix (proposal — needs approval)
"Agent" = holds `b2c.chat.manage`. "Owner" = the conversation's `assigned_admin_id` is the caller.
| Action | Endpoint / socket event | No chat scope (view-only) | Agent, not owner | Owner | Super admin |
|---|---|---|---|---|---|
| View queue | `GET /conversations`, `/analytics`, `/agents` | **403** | allowed | allowed | allowed |
| Read conversation (incl. internal notes, call log, context, attachment download) | `GET /conversations/{id}`, `/calls`, `/context`, `GET /attachments/{id}`; socket `join_chat` | **403** | allowed for supervision (Q8) | allowed | allowed |
| Claim | `POST /claim` | 403 | allowed only if unassigned (existing conditional update; 409 otherwise) | already owner | allowed if unassigned |
| Reply to the customer | `POST /messages` (is_internal=false), `POST /attachments`; socket `send_message` | 403 | **409 "assigned to X — claim or ask for a transfer"** | allowed | Q7 |
| Internal note | the same endpoints with is_internal=true | 403 | Q9 (notes never reach the customer, so allowing colleagues is reasonable) | allowed | allowed |
| Change status | `POST /status` | 403 | 409 | allowed (existing state machine) | allowed |
| Transfer | `POST /transfer` | 403 | 409 | allowed; target must be an ACTIVE super admin or `b2c.chat.manage` holder (X4) | allowed, same target rule |
| Mark read / typing | `POST /read`; socket `message_read`, `typing_*` | 403 | owner only; typing must name an existing conversation | allowed | allowed |
| Calls | socket `call_*` | 403 | owner only (or via the existing call transfer) | allowed | allowed |
| Ticket / socket / reconnect | `POST /ws-ticket`, `GET /ws` | **403; no ticket issued** | allowed | allowed | allowed |

Also proposed: limit the auto-assignment pool and `/agents` to active super admins and `b2c.chat.manage` holders (X4), and re-check the scope on the socket's `join_chat` and `send_message` so a revoked admin is cut off without waiting for a reconnect (X5).
Customers are unchanged and already isolated: `get_for_customer` filters by owner; the customer socket drops `internal` frames; `_visible` hides internal notes on every customer read; `attachment_for_customer` cannot return an internal attachment.

## 9. Database / migration changes
**None expected.** Every proposal reuses existing columns (`assigned_admin_id`, booking `status`, `supplier_status`, payment rows) and existing codes. A new code such as `b2c.bookings.manage` (Q1) would be one line in `rbac.py`, because grants are stored per user in `users.permissions`. Rollout needs a **data step only**: grant `b2c.chat.manage`, the booking manage code, and `b2c.reports.view` + `b2c.reports.export` to the right admins through the Super Admin portal *before* deploying.

## 10. Backward-compatibility risks
- Admins who work B2C bookings, chat or reports through `customer.view` or an unrelated `b2c.*` code lose access until granted the specific code (403 with a clear message). Mitigation: list the current grants and grant first.
- Chats already auto-assigned to admins without `b2c.chat.manage` cannot be answered by their owner after the change. Mitigation: a super admin transfers them, or the owner is granted the scope. Restricting the auto-assign pool stops new ones.
- Any desk habit of fixing bookings by setting `confirmed`/`pending` by hand, or reopening cancelled/completed bookings, stops working (409). Those cases go through payment verification, the reconciliation desk or the cancellation path.
- Running the product `cancel()` from the admin screen releases package seats and writes refund-owed flags that the old PATCH did not. That is the intended fix, but the Cancellations desk will see newly flagged cases.
- Browsers with cached old JavaScript would still show the dropdown, chat or export buttons. The backend refuses regardless; bump the `?v=` tokens.
- Tests that pin the current behaviour (in `test_admin_b2c_bookings_activity_reports_http.py`, `test_admin_chat_b2c_isolation.py`, `test_live_support_websocket.py`, `test_b2c_audit_events.py`, `test_b2c_admin_readiness.py`) must be updated on purpose, not deleted.

## 11. Customer and admin workflow impact
- **Customers:** no change to their own screens. A customer can no longer be shown "confirmed" for an unpaid or unreserved trip because an admin changed a dropdown. If Q5 = yes, they get a cancellation notification when an admin cancels.
- **Admins:** view-only staff keep read access to bookings, but lose the status dropdown, the live-chat console and B2C report downloads. Agents must claim a chat (or have it transferred to them) before replying. Supervisors read freely, subject to Q7/Q8.

## 12. Required regression tests (to write at implementation)
Bookings
1. Admin with only `b2c.customers.view`, and separately only an explicit `customer.view`: PATCH → 403; status and audit unchanged.
2. Admin with the manage code: pending → cancelled → 200 through the product `cancel()`: `cancelled_at` set; package seats released; refund-owed flag written when a captured payment exists; flight flag only when `reservation_missing`; audit records old and new status.
3. Invalid transitions → 409 with no write: pending → confirmed, pending → completed, confirmed → pending, cancelled → any, completed → any.
4. Confirmation bypass: a pending booking with no captured payment, and a held flight (`reservation_missing`), cannot be confirmed by PATCH. The payment-verification and `complete_reservation` paths still confirm (existing tests stay green).
5. Same → same → 200, no audit row.
6. Frontend contract: the dropdown appears only when `/api/auth/me` lists the manage code, and offers only the allowed targets.

Chat
7. View-only admin (`b2c.customers.view` only): `POST /ws-ticket` → 403; queue, thread, context, calls and attachment download → 403; a socket with a forged or missing ticket closes with 4401.
8. `b2c.chat.manage` agent: claim an unassigned chat → 200; a second agent's claim → 409; the owner replies → 200; a non-owner reply by REST and by socket `send_message` is refused, and nothing is stored or published.
9. Status change and transfer by a non-owner are refused and by the owner allowed; transfer to a B2B-only admin, a suspended admin or a merchant user → 400.
10. Internal notes sent by REST and by socket never reach the customer socket, the customer thread read, or the customer attachment download.
11. Customer A cannot read or join customer B's conversation (existing tests kept).
12. Auto-assign never picks an admin without `b2c.chat.manage`; `/agents` lists only eligible agents.
13. Super-admin behaviour per Q7/Q8.

Reports
14. Explicit `customer.view` only → types, preview, analytics and export → 403, with the assertions **moved before the SQLite skip** so they actually run.
15. `b2c.reports.view` only → preview 200, export 403. `b2c.reports.view` + `b2c.reports.export` → export 200 in CSV, Excel and PDF, with an audit row.
16. B2B `/api/reports/export` and the providers export are unchanged for Admin and merchant roles.

General
17. Full suite green. Re-run the Phase 12 PostgreSQL module on a fresh disposable database, with new cases for the admin cancel path (seat release + refund flag under row locks) and the chat claim race. Browser pass with a view-only admin, an agent and a super admin.

## 13. Recommended implementation order
1. **Issue 5 (exports):** the smallest and self-contained change. `_VIEW`/`_EXPORT` use the `b2c.reports.*` codes only; fix the docstring; move the skipped test assertions; gate the frontend buttons. No business rule involved.
2. **Issue 4 + the console gate from Issue 3:** `get_current_b2c_admin` → super admin or `b2c.chat.manage`; limit the auto-assign pool, `/agents` and the transfer target; the frontend skips `boot()` and the socket without the scope. Needs none of Q1–Q9.
3. **Issue 1 (booking permission):** after Q1.
4. **Issue 3 ownership rules for writes:** after Q7–Q9.
5. **Issue 2 (transitions):** after Q3–Q5; reuse the product `cancel()` functions; refuse confirm and reopen.
6. Not in Phase 13 unless approved: X1 (inside the excluded refund module), X2 (hotel refund-owed), X5 if not folded into step 2.
Before deploying any step: list current grants and grant the new codes (data step, no migration).

## Owner questions
- **Q1** Reuse `b2c.customers.manage` for booking status, or add `b2c.bookings.manage`?
- **Q2** Should customer-data reports need a stronger code than the others? (Smallest safe change: no — one `b2c.reports.export` code for all five.)
- **Q3** Is there any legitimate case for an admin to confirm a booking by hand (for example an offline or TrustBrick payment recorded outside the gateway)? Today no admin path confirms an unpaid booking except this PATCH. If yes, it needs its own audited "record offline payment" flow.
- **Q4** Keep `confirmed → completed` on this endpoint, and must it require a captured payment?
- **Q5** Should an admin-initiated cancellation notify the customer, as the customer's own cancellation does?
- **Q6** (X2) Should a paid hotel cancellation also flag "refund owed"?
- **Q7** May a super admin reply in a conversation assigned to someone else without claiming it?
- **Q8** May any agent read any conversation (supervision), or only the owner and super admins?
- **Q9** May an agent who is not the owner add internal notes?

**Status: all five issues OPEN. Awaiting owner approval and answers to Q1–Q9.**

---

# Phase 13 (part 2) — Owner decisions and final implementation plan (2026-11-17) — PLAN ONLY

Still no product code, permission code, migration, database record or workflow changed. Git 196 entries; `dev.db` md5 unchanged. **None of the five issues or X1–X6 is fixed yet.**

## A. Owner decisions recorded (proposed requirements)
| # | Owner decision | Verified against the code | Result |
|---|---|---|---|
| D1 | Booking status changes require `b2c.customers.manage` | Code exists; super admin passes `require_scope` | **Supported** |
| D2 | Customer reports with names, emails and mobiles need a separate permission for sensitive exports | No such code exists; one new code is needed. All five B2C reports contain customer name + email; only the Customers report also has mobile | **Supported with one new code**; scope across the five reports needs clarification (C1) |
| D3 | Manual confirmation only after payment verification and supplier confirmation; reuse the existing offline and TrustBrick verification workflows | TrustBrick is verified by the SAME verifier as every gateway payment (`verify_and_capture` → `confirm_booking`, reached by webhook, the customer return page and the background sweep). **There is no B2C offline or manual payment verification workflow.** The admin reconciliation "verify" only reads the gateway and changes nothing. | **Partly supported.** Confirm-after-captured-payment can reuse `confirm_booking`. **Offline payments: STOPPED** — no workflow exists to reuse, and creating one would be a new payment process (C2) |
| D4 | Keep confirmed → completed, but require captured payment and evidence of service completion | A captured payment can be checked (`captured_payment()` per product). **No "service completion evidence" exists anywhere** (no field, document type or supplier signal). Dates exist (flight `travel_date` nullable, hotel `check_out_date`, package `departure_date`), but using them would be a rule I would be inventing. | **Captured-payment part supported. Evidence part STOPPED** until defined (C3) |
| D5 | Admin cancellation uses the existing cancellation workflow and customer notification | Product `cancel()` functions + `customer_account_service.notify(... "booking_cancelled" ...)`. `notify` only writes an in-app notification row (idempotent per customer + type + title + reference); no email, SMS or push is sent | **Supported** |
| D6 | Paid hotel cancellation: record the amount owed, no actual refund | Existing "refund owed" mechanism = an ERROR log line + a FAILED `customer_audit_logs` entry whose text carries the amount and currency (package `_flag_refund_owed`, flight `supplier_guard.flag_refund_owed`). No column or queue holds it; nothing reads it automatically. | **Supported by reusing the same audit-entry mechanism** (no refund code, no new table) |
| D7 | Authorised super admins may reply in conversations assigned to another agent, with audit logging | Super admin role passes every `require_scope`; chat replies are currently **not** written to the B2C admin audit at all | **Supported**, plus a new audit event. "Authorised" = which super admins? (C4) |
| D8 | Conversation reading: assigned agent and authorised super admin only | Queue rows already carry customer name/email/mobile and the last message preview. Customer calls ring EVERY admin and the answerer claims the chat only if it is unassigned (`call_handlers.py` ~line 258) | **Supported for chat**; calls on an assigned chat need a rule (C5) |
| D9 | An agent must own or claim the conversation before adding internal notes | Claim exists with a race-safe conditional update | **Supported** |

## B. Exact backend changes (files → functions)
**Permissions — `backend/app/auth/rbac.py`**
- Add `P.B2C_CUSTOMERS_EXPORT = "b2c.customers.export"` (sensitive customer-data export) and include it in `B2C_SCOPES`. Like every other `b2c.*` code, it stays out of all role defaults. It appears automatically in `ALL_PERMISSION_CODES`, so the Super Admin grant screen and `account_service.set_admin_extra_permissions` accept it without other changes.
- New helper `has_b2c_scope(user, code)` (super admin, or an explicit grant) so services and the socket use the same rule as `require_scope`.

**Issue 1 / D1 — `backend/app/routers/admin_customer_bookings.py` → `update_booking_status`**
- Dependency becomes `require_scope(P.B2C_CUSTOMERS_MANAGE)`. Refusals write a DENIED B2C audit entry (`record_independently`), the same pattern as the chat attachment gate.

**Issue 2 / D3 / D4 / D5 / X3 — `backend/app/services/customer_booking_admin_service.py` → `update_status` (rewritten as a dispatcher)**
- Lock the booking row (`with_for_update`), read the old status, and apply the matrix in section D:
  - → `cancelled`: call the product's own `cancel()` (`customer_booking_service.cancel` / `customer_hotel_booking_service.cancel` / `customer_package_booking_service.cancel`). This brings the existing refund-owed flag, package seat release and `cancelled_at`. Then the same customer audit + `acct.notify("booking_cancelled", "Booking cancelled", ...)` that the customer routes use.
  - → `confirmed`: find the product's captured payment (`captured_payment()`), lock it (lock order **payment → booking**, as `confirm_booking` requires), then call the product's `confirm_booking` (`payment_verification_flight_service` / `_hotel_service` / `payment_verification_service`). That function rechecks amount = total, refuses cancelled/completed, runs the flight supplier guard, and sends the existing "confirmed" notification once. If it returns False, or there is no captured payment, refuse with 409 and say why (no payment / amount mismatch / held flight → reconciliation desk).
  - → `completed`: only from `confirmed`, only with a captured payment, plus the evidence rule once C3 is answered. Until then this branch is **not implemented** (see section L).
  - Everything else → 409. Same → same → 200 with no write.
- Return `"invalid"` / `None` / a new `("refused", reason)` result; the router maps it to 400 / 404 / 409.
- Commit once. The router's two audit writes join the **same transaction** as the status change, and the audit stores old → new status.

**X2 / D6 — `backend/app/services/customer_hotel_booking_service.py` → `cancel`**
- Before changing the status, read `captured_payment(db, booking)`. If one exists, write a refund-owed entry with the payment amount and currency, copying the package `_flag_refund_owed` shape (ERROR log + FAILED customer audit entry, `commit=False`). No refund call, no amount decision beyond "the captured amount". This also changes the **customer's own** hotel cancel route, which calls the same function — intended per D6.

**X1 — `backend/app/services/customer_cancellation_admin_service.py` → `decide` (approve branch)**
- Replace `booking.status = "cancelled"` with the product `cancel()` (via the same dispatcher as above) and the same customer notification. If the booking is **already cancelled** (the customer cancelled directly after requesting), skip `cancel()` and approve. If it is **completed**, refuse with "wrong_state" (C6 asks the owner to confirm this).
- **No refund code is touched.** `start_refund` / `/refund*` routes and `customer_refund_service` stay as they are. The router permission on `decide_cancellation` (`require(P.CUSTOMER_VIEW)`) is left unchanged unless the owner asks (C7), because it belongs to the excluded refund desk.

**Issues 3 + 4 / D7–D9 / X4 / X5 — chat**
- `backend/app/routers/admin_chat.py`
  - `get_current_b2c_admin` → super admin OR explicit `b2c.chat.manage`; DENIED audit on refusal. It gates every route including `/ws-ticket`; the two attachment gates (`_send_attachment_access`, `_attachment_access`) get the same rule.
  - New dependency/helper `require_conversation_access(conversation, admin, *, write: bool)` following the matrix in section E. Used by `thread`, `conversation_calls`, `conversation_context`, `download_attachment`, `mark_read` (read rule) and by `reply`, `send_attachment`, `set_status`, `transfer` (write rule).
  - `queue`: agents see unassigned rows plus their own; super admin sees all. Row fields are unchanged (they already show customer name/email/mobile; see C8).
  - `transfer`: the target must be an ACTIVE user with role `admin`/`super_admin` and (super admin or `b2c.chat.manage`); otherwise 400 "Not an eligible agent".
  - `agents`: same eligibility filter.
- `backend/app/services/chat_assignment.py` → `candidates`: same eligibility filter. This also narrows who is rung for customer calls (`call_handlers._candidates` reuses it).
- `backend/app/services/chat_gateway.py` → `AgentConnection`: on `join_chat`, `send_message`, `message_read`, `typing_*` and `call_*`, re-load the user and re-check (a) ACTIVE, (b) chat scope, (c) the conversation rule. If (a) or (b) fails, close the socket with a new code `CLOSE_FORBIDDEN = 4403` (X5). If (c) fails, send an error frame and do not store or publish anything. `typing_*` must name an existing conversation.
- `backend/app/services/customer_chat_service.py`: no change to `_visible`, `get_for_customer`, `claim`, `transfer` or `set_status` logic. Ownership is enforced by the caller, so customer isolation code is not touched.

**Issue 5 / D2 — `backend/app/routers/admin_b2c_reports.py`**
- `_VIEW = require_scope(P.B2C_REPORTS_VIEW)`, so the `customer.view` fallback goes.
- `_EXPORT = require_scope(P.B2C_REPORTS_VIEW, P.B2C_REPORTS_EXPORT, require_all=True)`.
- In `export_report`: if `type` is in a `SENSITIVE_REPORTS` set, also require `b2c.customers.export` (403 + DENIED audit). The set starts as `{"customers"}`; whether bookings/payments/cancellations/reviews join it is C1.
- Fix the module docstring and endpoint descriptions; add `require_audit_ready` to export as preview has, so export also refuses when the audit store cannot be written.

## C. Exact frontend changes (files → components)
| File | Change |
|---|---|
| `frontend/assets/js/admin-b2c-bookings.js` → `renderBookingDetail`, `saveBookingStatus` | Show the "Update Status" block only when `/api/auth/me` lists `b2c.customers.manage`; offer only the targets allowed from the current status (matrix D); show the server's 409 text. Reuse the cached-permissions helper pattern from `admin-b2c-customers.js`. |
| `frontend/assets/js/admin-live-support.js` → `boot`, `init`, connect/`onclose`/`scheduleReconnect`, `paintActions`, reply/note/attachment senders, `openTransfer`/`doTransfer` | `boot()` and the socket run only with `b2c.chat.manage` or as super admin (X6). Stop reconnecting on close code 4403 or a 403 from `/ws-ticket`. Disable reply/note/status/transfer buttons until the conversation is owned (or super admin per D7); show "Claim to reply". Handle 403/409 on opening a thread. |
| `frontend/assets/js/admin.js` (~line 93 `AdminLiveSupport.boot()`, sidebar) | Call `boot()` only when permitted; hide the Live Support menu item without the scope. |
| `frontend/assets/js/admin-b2c-reports.js` → button state and `rprDownload` | Enable Excel/CSV/PDF only with `b2c.reports.export`; for sensitive reports also require `b2c.customers.export`, otherwise show "Needs the customer-data export permission". |
| `frontend/admin/index.html` | Bump the `?v=` tokens of every changed script. |

The backend stays the authority; frontend changes are convenience only.

## D. Booking status transition matrix (manual PATCH; all rows need `b2c.customers.manage`)
| Current → Requested | Allowed | Payment condition | Supplier condition | Function executed | Customer notification |
|---|---|---|---|---|---|
| any → same | 200, no write | — | — | — | none |
| pending → confirmed | only if `confirm_booking` succeeds | captured payment, amount = total (checked inside `confirm_booking`) | flights: `hold_if_unreserved` passes (demo supplier passes; a live supplier needs `supplier_order_id`) | product `confirm_booking` under payment → booking lock | existing "confirmed" notification, sent once by `confirm_booking` |
| pending → confirmed, held flight (`reservation_missing`) | 409 → "Record the supplier reservation on the reconciliation desk" | — | — | none (the existing desk route `complete_reservation`) | — |
| pending → confirmed, offline payment | **not supported (C2)** | — | — | — | — |
| pending → cancelled | yes | none; captured payment → refund-owed entry (flight only if `reservation_missing`; package and, after X2, hotel: any captured payment) | — | product `cancel()` | `booking_cancelled` (in-app) |
| confirmed → cancelled | yes | same as above | — | product `cancel()` | `booking_cancelled` |
| confirmed → completed | **pending C3** — captured payment required + evidence (undefined) | captured payment | — | direct status write, audited old → new | none today (C9) |
| pending → completed | no (409) | | | | |
| confirmed → pending | no (409) | | | | |
| cancelled → anything | no (409, terminal) | | | | |
| completed → anything | no (409, terminal) | | | | |

## E. Chat access and ownership matrix
"Eligible agent" = ACTIVE admin with explicit `b2c.chat.manage`. "Owner" = `assigned_admin_id` is the caller. "SA" = super admin (subject to C4).
| Action | No chat scope | Eligible agent, not owner | Owner | SA |
|---|---|---|---|---|
| Ticket / open socket / reconnect | 403 / 4401; no reconnect loop | yes | yes | yes |
| View queue | 403 | unassigned + own rows | own + unassigned | all |
| Read thread, notes, call log, context, attachments; socket `join_chat` | 403 | **403** (D8) | yes | yes |
| Claim | 403 | unassigned only (409 otherwise) | — | unassigned only |
| Reply / attachment to customer | 403 | 409 "claim first" | yes | **yes, audited `chat.reply_override`** (D7) |
| Internal note | 403 | 409 (D9) | yes | yes, audited when not owner |
| Change status | 403 | 409 | yes (existing state machine) | yes, audited |
| Transfer | 403 | 409 | yes, to an eligible agent only (X4) | yes, same target rule |
| Mark read / typing / calls | 403 | refused | yes | yes |
| Revoked or suspended while connected | socket closed 4403 at the next frame (X5) | | | |
Unchanged: customer isolation (`get_for_customer`), internal-note filtering (`_visible`, the customer `_pump` drop, `attachment_for_customer`).

## F. Customer export permission matrix
| Report | Columns with personal data | Preview (on screen) | Export (CSV / Excel / PDF) |
|---|---|---|---|
| Customers | name, email, mobile, verification flags | `b2c.reports.view` | `b2c.reports.view` + `b2c.reports.export` + **`b2c.customers.export`** |
| Bookings, Payments, Cancellations, Reviews | customer name + email | `b2c.reports.view` | `b2c.reports.view` + `b2c.reports.export`; **+ `b2c.customers.export` if C1 = yes** |
| B2B `/api/reports/export`, providers export | merchant/B2B data | unchanged (`report.view`) | unchanged (`report.export`) |
Super admin passes all. `customer.view` no longer grants any B2C report access.

## G. Audit logging requirements
| Event | Where | Store | Content |
|---|---|---|---|
| Booking status change (each allowed transition) | `update_booking_status` | `system_logs` ("Customer booking status changed") + `customer_admin_audit_logs` `booking.update` SUCCESS, **same transaction** | booking ref, old → new status, the function used (cancel/confirm/complete) |
| Booking status refused (permission) | dependency | `customer_admin_audit_logs` DENIED (`record_independently`) | action, entity, reason "missing b2c.customers.manage"; no payload |
| Booking status refused (transition) | service | `customer_admin_audit_logs` FAILURE | old, requested, reason |
| Admin cancellation side effects | product `cancel()` | existing refund-owed customer audit entry; customer audit "Booking cancelled by support" | amount + currency in the refund-owed entry (no refund) |
| X1 approval | `decide` | existing activity log + the side effects above | — |
| Chat: console denied | gate | DENIED, `chat.access` | reason only |
| Chat: reply/note/status/transfer by a non-owner super admin | routes + socket | `customer_admin_audit_logs` `chat.reply_override` / `chat.note_override` / `chat.set_status` / `chat.transfer` | conversation id, assigned admin id, `is_internal`; **never the message text** |
| Chat: non-owner write refused | routes + socket | FAILURE | conversation id, reason |
| Chat: socket closed for revocation | gateway | DENIED `chat.socket_revoked` | admin id; never the ticket |
| Report export allowed / denied | `export_report` | existing `report.export` SUCCESS (now behind `require_audit_ready`); DENIED with the missing code | type, format, row count |

## H. Database changes
**None.** A new code is a string in `users.permissions` (JSONB array, checked only as "is an array"). Reused: booking `status`, `cancelled_at`, `supplier_status`, payment rows, `assigned_admin_id`, `customer_audit_logs`, `customer_admin_audit_logs`, `customer_notifications`. No migration and no seed change. Rollout needs **data steps** done by the owner in the Super Admin portal (section J).

## I. Regression tests (new or updated; all SQLite harness unless noted)
| Finding | Tests |
|---|---|
| Issue 1 | `b2c.customers.view` only → PATCH 403 + DENIED audit, nothing changed; explicit `customer.view` only → 403; `b2c.customers.manage` → allowed transitions work; super admin works |
| Issue 2 | every refused row of matrix D → 409 with no write; same → same no audit; pending → confirmed with no captured payment → 409; with a captured payment of the right amount → confirmed once, one "confirmed" notification (a second PATCH is a no-op); amount mismatch → 409; held flight → 409 naming the reconciliation desk; existing `complete_reservation` tests stay green |
| D5 | admin cancel: product `cancel()` ran (`cancelled_at`, package seats +pax, refund-owed entry when captured, flight entry only when `reservation_missing`), one `booking_cancelled` notification, audit old → new, all in one transaction (a forced audit failure rolls the status back) |
| X2 / D6 | customer and admin hotel cancel with a captured payment → refund-owed entry with amount + currency; without payment → none; no refund/provider call (provider mock asserts not called) |
| X3 / D4 | once C3 is answered: confirmed → completed needs a captured payment + the evidence rule; pending → completed 409 |
| X1 | approve → product `cancel()` side effects + notification; booking already cancelled → approved, no second flag; booking completed → refused; reject unchanged; refund routes untouched (existing refund tests unchanged and green) |
| Issue 4 / X6 | `b2c.customers.view` only: `/ws-ticket` 403, queue 403, thread 403, attachments 403; frontend contract: `boot()` not called and no menu item without the scope |
| Issue 3 / D8 / D9 | agent A claims → 200; agent B claim → 409; B reads A's thread → 403; B reply/note/status/transfer → 409 by REST and socket, nothing stored or published; A's actions → 200 |
| D7 | super admin replies into A's conversation → 200 + `chat.reply_override` audit without message text |
| X4 | transfer to a merchant user, a suspended admin, or a B2B admin without the scope → 400; `/agents` and `candidates()` exclude them; auto-assign never picks them; the call ring list excludes them |
| X5 | revoke the scope (or suspend) while connected → the next frame closes the socket with 4403 + DENIED audit; frontend stops reconnecting |
| Internal notes | a note by REST and by socket never reaches the customer socket, customer thread or customer attachment download (existing tests kept) |
| Customer isolation | existing customer A/B tests kept |
| Issue 5 / D2 | explicit `customer.view` only → types/preview/analytics/export 403 (**moved before the SQLite skip** so they run); view only → export 403; view + export → bookings export 200 in CSV/Excel/PDF; customers export without `b2c.customers.export` → 403 + DENIED, with it → 200 |
| Unrelated permissions | the full existing suite (2335) stays green; B2B `/api/reports/export`, providers export, B2B support chat and merchant reports unchanged |
| PostgreSQL | re-run the Phase 12 module on a fresh disposable database, plus: admin cancel of a package under concurrency (seats released once), and two agents claiming at once |
| Browser | view-only admin, eligible agent, second agent, super admin — against a disposable backend |

## J. Rollout and backward-compatibility risks
1. **Grant before deploy** (owner, Super Admin portal; listing the current holders first): `b2c.customers.manage` to booking-desk staff; `b2c.chat.manage` to every live-chat agent; `b2c.reports.view` (+ `b2c.reports.export`, + `b2c.customers.export` where justified) to report users who today rely on `customer.view`.
2. **Open chats owned by ineligible admins** become unanswerable by their owner after deploy. Before deploy, a super admin transfers them, or the owners are granted the scope.
3. Agents lose the ability to read colleagues' conversations (D8). Supervision becomes super-admin only.
4. **Calls:** the ring list narrows to eligible agents; see C5 for calls on assigned chats.
5. Booking desk: by-hand confirm/reopen stops working (409); cancellations now release package seats, write refund-owed entries and notify the customer in-app (no email/SMS/push).
6. **Customer-visible change (X2):** a customer's own paid hotel cancellation now also writes a refund-owed entry. It is internal only; the customer sees no difference.
7. Browsers with cached scripts still show old controls until `?v=` tokens change; the backend refuses regardless.
8. One deploy for backend + frontend, after the full suite, the PostgreSQL re-run and a browser pass. Nothing is committed or deployed without separate approval.

## K. Items still requiring clarification
- **C1** Do the bookings, payments, cancellations and reviews reports (customer name + email, no mobile) also need `b2c.customers.export`, or only the Customers report?
- **C2 (STOPPED)** D3 offline payments: no B2C offline/manual payment-verification workflow exists to reuse. Until one is approved as a separate project, a booking paid offline cannot be confirmed from the admin screen. Is that acceptable for now?
- **C3 (STOPPED)** D4 "evidence of service completion": what counts? Options: (a) the travel/check-out/departure date has passed; (b) a mandatory admin completion note; (c) an uploaded document; (d) a supplier status. Until answered, confirmed → completed keeps its current behaviour (allowed, now behind `b2c.customers.manage` and audited old → new), or is refused if you prefer — please choose.
- **C4** "Authorised super admin": every active super admin (the current model), or only super admins also holding explicit `b2c.chat.manage`?
- **C5** A customer call on a conversation assigned to agent A: ring only A (+ super admins), or keep ringing every eligible agent and let the answerer take over the conversation?
- **C6** Approving a cancellation request whose booking became completed in the meantime: refuse (proposed)?
- **C7** Should `decide_cancellation` move from `require(customer.view)` (Admin role default) to `b2c.customers.manage`? It is in the excluded refund desk, so it is left unchanged unless you say so.
- **C8** The queue shows customer name/email/mobile and the last message preview to every eligible agent, including for chats they do not own. Keep, or reduce to name only for non-owners?
- **C9** Should completing a booking notify the customer? No notification exists for it today.

## L. Parts stopped (not to be implemented until clarified)
- Offline payment confirmation (C2): no existing workflow; creating one would be a new payment process.
- The completion-evidence rule (C3): no existing data defines it.
Everything else in sections B–J can be implemented with existing services once approved.

**Status: plan complete; implementation awaits approval. Recommended order: (1) Issue 5 + D2, (2) Issue 4 + X6 + X4 + console gate, (3) Issue 3 ownership + D7–D9 + X5, (4) Issue 1 + Issue 2 + D5 + X2 + X1, (5) X3/D4 after C3.**

---

# Phase 13 (part 3) — Final owner decisions C1–C9 and pre-implementation confirmation (2026-11-17)

## Final decisions (recorded verbatim in substance)
| # | Decision |
|---|---|
| C1 | `b2c.customers.export` is required for all five B2C reports (bookings, payments, cancellations, customers, reviews) — each exposes customer name and email. Unrelated reports untouched. |
| C2 | Accepted limitation: offline-paid bookings cannot be confirmed from the admin screen until a separately approved offline-payment verification workflow exists. No new payment process. |
| C3 | Confirmed → Completed is BLOCKED for now (no approved completion-evidence workflow). The `completed` state and all other behaviour stay. **Pending business requirement: define completion evidence.** |
| C4 | Active Super Admin accounts may access and supervise conversations without `b2c.chat.manage`; every such access and write is audited. |
| C5 | Calls: assigned conversation → ring the assigned eligible agent + super admins; unassigned → ring all eligible active agents + super admins. Only one may claim. No other call change. |
| C6 | Refuse approval of a cancellation request when the booking is already completed. No refund, no change to the completed booking. |
| C7 | Approving/rejecting cancellation requests requires `b2c.customers.manage` (booking-management only; refund routes untouched). |
| C8 | Ordinary agents see only the customer's NAME for unassigned conversations — no email, mobile or last-message preview. Assigned agent and super admin see details. |
| C9 | Future completion sends an in-app notification only. Not enabled while C3 blocks completion. |

## Pre-implementation confirmation
1. **Permissions / roles.** Super Admin role verified: `UserRole.SUPER_ADMIN`; `require_scope` short-circuits it; `get_current_user` refuses non-ACTIVE accounts, so "authorised super admin" = an ACTIVE super-admin account. New code `b2c.customers.export` (in `B2C_SCOPES`, in no role default). Existing codes used: `b2c.customers.manage` (booking status, cancellation decisions), `b2c.chat.manage` (chat console), `b2c.reports.view` / `b2c.reports.export` (reports). `customer.view` no longer grants these B2C endpoints. No role-default change.
2. **Endpoints / components.** As in part 2 §B–C, plus `PATCH /api/admin/cancellations/{id}` (C7, approve/reject branch only; `start_refund` keeps its own `refund.execute` check; refund routes untouched).
3. **Chat & calls.** Eligible agent = ACTIVE admin with explicit `b2c.chat.manage`; super admin always eligible. Read/write only by owner or super admin; non-owner agents may claim unassigned chats and see name-only rows for them. Super-admin non-owner access audited. Call ring list per C5 (`call_handlers._candidates`); claim race unchanged (conditional UPDATE).
4. **Cancellation & refund-owed.** Admin cancel → product `cancel()` (flight: flag only if `reservation_missing`; package: flag any captured payment + seat release; hotel: NEW flag of the captured amount, X2) → in-app `booking_cancelled` notification. Cancellation approval reuses the same path; already-cancelled → approve without a second cancel; completed → refused (C6). No refund code touched.
5. **Export protection.** Preview needs `b2c.reports.view`; export needs `b2c.reports.view` + `b2c.reports.export` + `b2c.customers.export`; super admin passes.
6. **Audit.** As part 2 §G; plus super-admin `chat.supervise_read` on thread reads of conversations not assigned to them.
7. **Tests.** As part 2 §I, adjusted: confirmed → completed now 409 (C3); C5 ring lists; C8 queue masking; C6/C7.


---

# Phase 13 (part 4) — Implementation completed, tested, PostgreSQL + browser verified (2026-11-17)

Continued from the earlier session's untested Phase 13 changes (15 files, 11:26–11:37). Nothing committed/pushed/merged/deployed. No production migration. `.env` (md5 `5715c721…`) and `dev.db` (md5 `0c5d0c25…`) unchanged. Gaming still disabled; no Activities & Tours; Refund Management untouched; no refund-execution workflow created; no approved decision changed.

## ⚠ Safety incident (read first)
> **CORRECTED in "Phase 13 (part 5)" below.** Three statements in this subsection were wrong: the connection lasted about 4 minutes (11:50:20–11:54:05 IST), not 8; the PostgreSQL server log shows the run's 3 audit INSERTs **failed** (`relation "customer_admin_audit_logs" does not exist`), so "what that run wrote is unknown" is superseded; and "0 blocked connection attempts" proved nothing (pytest prints captured logs only for failing tests). The original text is kept below unedited for the record.

`backend/tests/conftest.py` does **not** override `DATABASE_URL`. Code that uses the real `SessionLocal` without a test patch (e.g. `customer_admin_audit_service.record_independently`) follows `backend/.env` → the local **`jackpots_v2`** on 127.0.0.1:5432. My first baseline run (started 11:50:20) held a live connection to it for about 8 minutes before I noticed and stopped it. I did **not** connect to `jackpots_v2` to inspect it (forbidden), so **what that run wrote is unknown**. The writes it could have made are B2C admin audit rows (`customer_admin_audit_logs`, e.g. `chat.access` / `document.download` DENIED rows from tests whose audit writer was not patched), if that table exists there. **Earlier phases' "jackpots_v2 untouched" claims have the same gap**: the same unpatched paths existed in their regression runs.
- Owner action: check `customer_admin_audit_logs` in `jackpots_v2` for rows created on 2026-11-17 around 11:50–11:58 IST (and during earlier regression runs) by test-looking admins (`full_name` "A"/"R"/"B", ids 1/7/8, `@example.test` / `@tt-qa.com` emails).
- Every later run in this phase used a guarded runner that sets a PROCESS-ONLY `DATABASE_URL=…127.0.0.1:9/blocked_no_such_db` (closed port) and refuses to start unless the settings resolve to it. After the fixture fixes below, the final run logged **0** blocked connection attempts, so no test now reaches the real `SessionLocal`. Recommended (not done, needs approval): make `conftest.py` force a dead `DATABASE_URL` for every test run.

## 1. Code changes this session (completed)
| File | Change | Why |
|---|---|---|
| `frontend/assets/js/admin-b2c-bookings.js` | The status block renders only when `adminCan('b2c.customers.manage')`. It offers only pending → confirmed/cancelled and confirmed → cancelled; cancelled/completed bookings show "status can no longer be changed"; there is no Completed option; cancelling asks for confirmation; a 409 message is shown verbatim and a 403 is explained. It uses the existing PATCH (the shared cancellation path), with no separate workflow. | Step 1 |
| `frontend/admin/index.html` | `?v=` → `20261117p13` for admin-live-support, admin-b2c-bookings and admin-b2c-reports (and admin-b2c-communication, changed in an earlier phase but never re-versioned); admin.js → `20261117p13b` (bumped again after the fix below) | cache busting |
| `frontend/assets/js/admin.js` | **DEFECT (found in the browser):** Live Support was still shown to a view-only admin because `.nav-item{display:flex}` overrides the `hidden` attribute. It now also sets `style.display='none'`. | X6 |
| `frontend/assets/js/admin-live-support.js` | null guard in the `left` frame handler | robustness |
| `backend/app/routers/admin_chat.py` | **DEFECT:** `download_attachment` read `attachment.conversation_id`, which does not exist (attachments hang off a message), so every admin download, owner and super admin included, would return 500. It now resolves the conversation through the message (`_attachment_conversation`), and the SUCCESS audit records the real conversation id. | D8 |
| `backend/app/services/customer_call_service.py` (`may_answer`) + `call_handlers.py` (`accept`) | **DEFECT:** C5 rings super admins for an assigned conversation, but `may_answer` allowed only the owner, so every super admin who was rung got "assigned to another agent". An ACTIVE super admin may now answer; answering does not take the conversation and is audited `chat.call_answer_supervisor` in the same transaction. | C4/C5 |
| `backend/app/routers/admin_customer_bookings.py` | audit `new.status` is stored lowercase like `previous.status` (it was the upper-cased display value) | audit consistency |
| `backend/app/routers/admin_cancellations.py` | corrected a misleading comment (see finding F-13b) | — |

Reviewed with no change needed: `rbac.py` (`B2C_CUSTOMERS_EXPORT`, `has_b2c_scope`), `admin_b2c_reports.py`, `chat_access.py`, `chat_assignment.py`, `chat_gateway.py` (re-check on every frame, 4403, audited supervised join/write, `left` on transfer), `customer_booking_admin_service.py` (dispatcher, lock order payment → booking, single commit by the router), `customer_hotel_booking_service.py` (refund-owed flag), `customer_cancellation_admin_service.py` (shared cancel path, completed refused, an already-cancelled booking is not cancelled again), `admin-b2c-reports.js`, `admin-live-support.js`.

## 2. Tests
New: `test_phase13_bookings_cancellations_http.py` (37), `test_phase13_chat_access.py` (23), `test_phase13_postgres_integration.py` (5, PostgreSQL-only; skipped otherwise).
Updated (each change is justified by an approved Phase 13 decision; no assertion weakened, none deleted):
- `test_admin_b2c_bookings_activity_reports_http.py`: the test that PINNED "no transition rules / view scope can write" now pins the approved rules. The report permission assertions were **moved before the SQLite skip** and extended to all five exports (view-only, `customer.view`, B2B `report.*`, and view+export without `b2c.customers.export` → 403 + 15 DENIED audit rows; a full grant and a super admin pass). The fixture admin was given the approved scopes, and the notifications table was added (the real confirmation path writes one).
- `test_admin_chat_b2c_isolation.py`: users are ACTIVE; refusals are captured in memory (they previously went through the real `SessionLocal`); new case: `b2c.customers.view` alone can no longer mint a ticket.
- `test_b2c_admin_readiness.py`: the attachment fixtures use an eligible agent who owns the conversation (both fail-closed assertions unchanged).
- `test_live_support_websocket.py`: agents hold `b2c.chat.manage` and are assigned before joining; the audit writer is pointed at the test DB.
- `test_admin_frontend_contract.py`: Phase 13 re-versioning, the booking transition table, 4403/403 handling, report export codes.

Coverage: the five report exports, `customer.view` not granting export, and audited refusals. The agent, second agent, view-only admin and super admin on every chat route. The claim race, replies, notes, transfers (ineligible targets → 400), status changes and ownership. C8 masking, including search on hidden fields. Socket checks on join, send, note, typing and read, and on every pushed frame. Revoking the scope or suspending the account → 4403 + `chat.socket_revoked`; a ticket minted before revocation is refused; a stream transferred away stops (`left`). The call ring list (assigned / unassigned / owner lost the scope) and who may answer. The booking permission and the full transition matrix (9 refused pairs). Confirmation only with a matching captured payment (one notification, idempotent); amount mismatch; held flight → reconciliation desk. Cancellation via the product `cancel()` (cancelled_at, seats, refund-owed rules per product, one in-app notification, no email, no refund row); a customer-side hotel cancellation also writes the refund-owed entry. A failing audit write rolls back the status and its side effects. Approve/reject need the manage scope; approval uses the shared path; a completed booking is refused; an already-cancelled booking is not cancelled or flagged twice; reject leaves the booking alone; refund actions are not widened.

## 3. Results (exact)
| Run | Result |
|---|---|
| Baseline before any fix (guarded) | 15 failed, 2320 passed, 21 skipped. 11 = outdated expectations replaced by approved decisions, or fixtures lacking ACTIVE status / scope / ownership; 2 = attachment tests hitting the real `conversation_id` defect; 2 = my runner's `MIGRATION_DATABASE_URL` export (environment artefact; runner fixed) |
| Phase 13 targeted | bookings/cancellations 37 passed · chat/socket/calls 23 passed · reports/bookings module 16 passed, 2 skipped (pre-existing SQLite limits: sessions/summary timezone, analytics SQL; both VERIFIED on PostgreSQL in Phase 12 and §4 below) · contract 9 passed · readiness + isolation 28 passed · websocket 9 passed |
| Full suite mid-phase (before the admin.js/token edits) | 2401 passed, 0 failed, 21 skipped |
| **Final full suite (all changes, guarded)** | **2401 passed, 0 failed, 26 skipped** (12m42s). Skips = the 21 pre-existing (13 Phase 12 PostgreSQL-only + 8 earlier SQLite limits) + the 5 new Phase 13 PostgreSQL-only tests. 0 blocked database connection attempts *(withdrawn — not valid evidence; see part 5)*. |

## 4. PostgreSQL verification (disposable; VERIFIED)
Container `jpw-phase13-pg-ac1a8beb` + volume `jpw_phase13_pgdata_ac1a8beb` (label `purpose=phase13-disposable`), `postgres:17` (17.12), bound to `127.0.0.1:55434` only, role `phase13_admin` with a generated password kept in a scratch file (since deleted). Before migrating: `current_database()=jackpots_phase13_test`, the only non-system database, 0 tables. A guarded runner (process-only env: `DATABASE_URL` → the container, `DEPLOYED=false`, SMTP blank, `PAYMENT_PROVIDER=none`, OCR none, demo flight supplier, gaming false, Redis empty) checked the runtime URL, the Alembic URL and the live `current_database()` before every step. `alembic upgrade head` → `0095_customer_admin_audit_logs`, 75 tables.
`test_phase13_postgres_integration.py`: **5 passed, 0 failed**:
1. All five B2C exports and previews on the real report SQL: view-only and view+export-only refused, full grant and super admin 200, 5 DENIED + 5 SUCCESS audit rows, analytics gate.
2. Booking matrix on FK-constrained rows: confirm without payment 409, captured confirm 200, completed 409, cancel 200 with `cancelled_at`, reopen 409, refund-owed row with amount + INR, notifications `booking_confirmed` + `booking_cancelled`, audit 2 success / 3 failure / 1 denied.
3. **Concurrency:** two admins cancelling one package → `[200, 409]`, seats 5 → 7 exactly once, one refund-owed row.
4. Cancellation approval via the shared path; a completed booking refused (request stays `requested`); view-only 403.
5. **Concurrency:** two agents claiming one chat → `[200, 409]`; the loser gets 403 on read and 409 on reply; super admin read + reply audited; C8 masking.

Not re-run: the Phase 12 module (its guard is hard-wired to `55432/jackpots_phase12_test`; not modified).

## 5. Browser verification (BROWSER VERIFIED against the disposable backend on 127.0.0.1:8441)
Test-only accounts (`phase13.*@tt-qa.com`), real login form + dev-echo OTP. The first steps used real mouse and keyboard input; the pane was then hidden, so later steps dispatched clicks on the real DOM elements (the page's own handlers ran; no UI code was bypassed). Every outcome was cross-checked in the disposable DB.
| Account | Verified |
|---|---|
| View-only (`b2c.customers.view`, `customer.view`, `b2c.reports.view`) | Live Support hidden (after the admin.js fix; before it the item was visible, see the defect above); the booking modal shows no status controls; a hand-built PATCH gets 403 "Missing required scope: b2c.customers.manage"; customers export 403; ws-ticket 403; report Excel/CSV/PDF buttons disabled with the explanatory note; DENIED audit rows for all three |
| Agent A (chat + manage + full export) | Socket "Live"; queue shows the own row with details and the unassigned row with the name only; opening the unassigned chat shows "Claim this conversation…" with the composer hidden; Claim → thread + composer; reply delivered and stored; bookings: pending offers Confirmed/Cancelled, confirmed offers Cancelled only, cancelled shows the final text; confirm without payment → server message shown; confirm with a captured payment → confirmed + one `booking_confirmed`; package cancel → cancelled, seats 5 → 7, refund-owed FAILED entry, `booking_cancelled`; exports enabled, customers CSV 200 |
| Agent B (chat + view) | Empty queue (both chats are A's); read A's chat 403, reply 409, claim 409; socket join/send refused `not_assigned` (audited); no booking controls; **scope withdrawn while connected → closed at the next heartbeat, status "Live-chat access withdrawn", no further ticket requests**, `chat.socket_revoked` audited |
| Super Admin | Cannot sign in to the Admin Portal (finding F-13a); signed in to the Super Admin portal; with that session: all 3 conversations unmasked, read A's thread 200 (`chat.supervise_read`), reply 201 (`chat.reply_supervisor`, no message text in the audit), export 200, completion 409, cancel 200; `b2c.customers.export` present in the permission matrix |

No real email/SMS/push, payment, refund or supplier action. The exports were fetched into page memory only (no files saved).

## 6. Findings for the owner (not changed; these are decisions)
- **F-13a** The login maps each role to ONE portal, so a Super Admin cannot open the Admin Portal, and the Super Admin portal has no Live Support or B2C Bookings screens. C4/D7 supervision and super-admin booking changes work only through the API/WebSocket today, with no UI.
- **F-13b** The cancellations desk routes keep their pre-existing `customer.view` gate, which the Super Admin role does not hold, so a super admin cannot approve or reject requests (pinned by a test). Whether super admins should pass is a decision.
- **F-13c** The Super Admin portal has no screen to grant individual permissions; `b2c.customers.export`, `b2c.customers.manage` and `b2c.chat.manage` can be granted only through `PUT /api/super-admin/admins/{id}/permissions` (rollout step J.1 depends on this).
- **F-13d** A masked unassigned queue row reads "No messages yet". That is accurate for the agent but could mislead; the wording is a UI choice.
- **F-13e** `conftest.py` database isolation (see the safety incident).

## 7. Not verified / limitations
Redis multi-worker fan-out; WebRTC media; real call ringing in the browser (call routing is verified by unit/integration tests only); real-mouse interaction for the later browser steps (DOM-dispatched clicks); the Phase 12 PostgreSQL module was not re-run; offline-payment confirmation (C2) and completion (C3) remain intentionally unavailable; the production data steps of part 2 §J are not done.

## 8. Status (kept separate)
- **Implementation:** Phase 13 parts 2–3 complete in code (C3 completion and C2 offline confirmation intentionally blocked).
- **Testing:** automated suite, PostgreSQL module and browser pass done; results above.
- **Production readiness:** NOT ready to deploy until the jackpots_v2 test-write question above is answered, F-13a/F-13b/F-13c are decided, the §J grants are made before deploy, and backend + frontend ship in one deploy. Nothing is committed yet.

## 9. Cleanup verification
Removed only what this phase created: the backend process on 8441 (stopped); container `jpw-phase13-pg-ac1a8beb` and volume `jpw_phase13_pgdata_ac1a8beb` (label checked before removal); the scratch folder with the generated credentials, seed script and runner; browser storage for 127.0.0.1:8441; and the temporary `phase13-pg-verify` entry in `.claude/launch.json` (the file is back to its committed content, 0-line diff). Unchanged: `jpw-uat-pg-persist` (running), `jpw_qa_pg`, `jpw-uat-pg-dbf48d`, volumes `9ebc36c1…` and `jpw_uat_pgdata_13679d2a`, the `postgres:17` image, and the native PostgreSQL service. Nothing listens on 55434 or 8441.


---

# Phase 13 (part 5) — Incident correction, permanent test-database isolation, CI-only mode (2026-11-17)

No application code changed. Nothing committed/pushed/merged/deployed. No migration run. `jackpots_v2` was never connected to or inspected. `.env` (md5 `5715c721…`) and `dev.db` (md5 `0c5d0c25…`) unchanged. Working-tree entries: 211 → 215 (`.github/workflows/ci.yml`, `backend/tests/test_customer_refunds_postgres.py` newly modified; `backend/tests/_db_guard.py`, `backend/tests/test_db_isolation_guard.py` new; `conftest.py` and `test_customer_refunds_http.py` were already modified).

## 1. Corrected incident timeline (17 Nov 2026, IST)
Evidence: the pytest process start time, the stopped run's output marker, and the native PostgreSQL 17 server log `C:\Program Files\PostgreSQL\17\data\log\postgresql-2026-11-16_000000.log` (read as a file; no database connection was made).
| Time | Event |
|---|---|
| ~11:49–11:50 | Unguarded run 1 (`pytest -x`) ran briefly and stopped at its first failure |
| 11:50:20 | Unguarded run 2 (full suite) started (process start time) |
| 11:51:09–11:51:10 | 3 × `INSERT INTO customer_admin_audit_logs …` → **`ERROR: relation "customer_admin_audit_logs" does not exist`** — every write failed, nothing was stored |
| 11:53:57 | Run stopped (output marker) |
| 11:54:05 | Server log: client connection closed |
**Duration ≈ 4 minutes (not 8).** On 17 Nov the log has no other errors and no failed logins. Successful statements are not logged by this server (`log_statement` default), but the only test write path that bypasses the test database is the B2C audit writer, and its table does not exist there.
Earlier entries in the same log show the same failed audit INSERTs on 12, 14, 15 and 16 Nov and on 17 Nov at 10:07, 10:25, 10:33 and 11:02 — earlier phases' regression runs (or a local server). The "jackpots_v2 untouched" statements in Phases 1–12 are therefore inaccurate: connections were made; the audit INSERTs failed. Limitation: `log_line_prefix = '%t '` records no database or user name.
**Read-only DBA checks still recommended:** in `jackpots_v2`, `SELECT to_regclass('public.customer_admin_audit_logs')` (expected NULL) and `SELECT version_num FROM alembic_version`; if the table exists, rows created 12–17 Nov with `@example.test` / `@tt-qa.com` emails or admin ids 1/2/3/7/8; test-looking rows (`@tt-qa.com`) in `users` / `customers` / booking tables for those dates; the list of databases on that server. Optional: add `%d %u` to `log_line_prefix`.
"0 blocked connection attempts" in part 4 is withdrawn: pytest prints captured logs only for failing tests, so it proved nothing.

## 2. Permanent isolation (approved and implemented)
- `backend/tests/_db_guard.py` (new), installed from the top of `backend/tests/conftest.py` before any `app` import:
  - **Default (isolated):** the process `DATABASE_URL` is forced to `postgresql+psycopg2://pytest_blocked:…@127.0.0.1:9/pytest_blocked_no_such_db`; `psycopg2.connect` is replaced by a blocker that records the test id (host/port/dbname, never the password) and raises.
  - **Phase 12 / 13 disposable mode:** exactly one of `PHASE12_PG=1` / `PHASE13_PG=1` plus the exact URL (driver, user, `127.0.0.1`, port 55432/55434, database `jackpots_phase12_test` / `jackpots_phase13_test`, no query string).
  - **Abort (exit 4) before any app import:** any URL containing `jackpots_v2`; a flag with a non-matching URL; both flags; `MIGRATION_DATABASE_URL` set in an isolated run or differing from the approved URL; `REFUND_TEST_POSTGRES_URL` outside CI mode; app settings already imported.
  - `pytest_sessionstart` re-checks that the settings, the Alembic URL and the app engine equal the guarded URL. An autouse fixture fails any test during which a connection attempt was blocked (even when the code swallowed it), and the terminal summary prints the mode and the attempt count every run.
- `test_customer_refunds_http.py`: audit-writer leak removed (in-memory capture); the over-refund test now asserts the refusal is still audited.

## 3. CI-only database mode (approved and implemented)
The `postgres-migrations` job starts a throw-away `postgres:16-alpine` service (ci_user / ci_pass / ci_migrations, `5432:5432`); its URL is written literally in the workflow. The guard now accepts a third mode, but only when all of these hold:
- `JACKPOTS_CI_PG=1` (exactly), with neither Phase flag set;
- GitHub-hosted runner markers: `CI=true`, `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`, `RUNNER_OS=Linux`, `GITHUB_JOB=postgres-migrations`, and `GITHUB_RUN_ID` present;
- `DATABASE_URL` is exactly the service URL (`postgresql+psycopg2`, `ci_user`, `ci_pass`, host `localhost` or `127.0.0.1`, port 5432, `ci_migrations`, no query string); `REFUND_TEST_POSTGRES_URL` and any `MIGRATION_DATABASE_URL` are identical to it.

**The blocker stays armed in CI mode.** It passes only a connect whose host/port/dbname/user match the service, and it rejects `hostaddr` and `service` indirection. `test_customer_refunds_postgres.py` also asserts the live identity (`current_database()`, `current_user`, port) = `('ci_migrations', 'ci_user', 5432)` before using the connection. `.github/workflows/ci.yml` gained one line: `JACKPOTS_CI_PG: "1"` on the refund concurrency step only. The SQLite CI job sets no flag and stays isolated.

## 4. Results (exact)
| Run | Result |
|---|---|
| `test_db_isolation_guard.py` | 73 passed (27 isolation + 46 CI-mode: valid config, each missing/mismatched runner marker, 11 unsafe URLs incl. `jackpots_v2`, remote/production host, wrong port/db/role/password, query smuggling, other driver; inconsistent/combined settings; allowlist pass-through (stubbed connect, no network) and 9 blocked targets; the default blocker blocks even the CI target; the workflow stays in sync with the guard) |
| Full suite after the isolation fix | 2428 passed, 0 failed, 26 skipped, exit 0; guard: isolated, 0 blocked; OS port-5432 monitor: 0 connections |
| **Full suite after CI mode** | **2474 passed, 0 failed, 26 skipped, exit 0** (4m32s); guard: `mode=isolated`, 0 blocked attempts; OS port-5432 monitor (2 s sampling): 0 client connections |
| Abort checks (real pytest invocations) | flag + `jackpots_v2`, flag + wrong port, both flags, `REFUND_TEST_POSTGRES_URL`, `MIGRATION_DATABASE_URL`, `jackpots_v2` without flag → all exit 4 with the guard's message |
| CI-mode simulation (collection only, runner markers simulated) | `mode=ci`, 3 refund PostgreSQL tests collected (not skipped), session checks passed; same with `RUNNER_ENVIRONMENT=self-hosted` → refused; CI URL without the flag → refused; 0 connections |
Skips (26): 13 Phase 12 + 5 Phase 13 PostgreSQL-only, 3 refund PostgreSQL (no CI mode), 5 pre-existing SQLite limits.
How "no real connection was possible" was established: the settings and engine assertions (sentinel URL), the in-process psycopg2 blocker with per-test attribution, the per-test failure fixture, and an independent OS-level `netstat` monitor sampling for client connections to port 5432 during each full run.

## 5. Not verified
- **The refund PostgreSQL tests were NOT run end-to-end** against a fresh database under CI rules. CI mode pins `localhost:5432`, which on this workstation is the native server that hosts `jackpots_v2`, so the faithful local reproduction needs the tests to run inside a container sharing a disposable PostgreSQL container's network. No Python image is available locally; downloading one (plus pip packages) needs separate approval. The first real proof will be the GitHub `postgres-migrations` job.
- The blocker covers psycopg2, the only PostgreSQL driver installed; adding another driver needs the same treatment.


---

# Phase 13 (part 6) — Guard review fixes: blocker armed in every mode, libpq redirects rejected (2026-11-17)

Implements only the two issues from the read-only guard review. No application code changed. Nothing committed/pushed/merged/deployed. No migration run; no database (including `jackpots_v2` and the native PostgreSQL service) connected to; no images downloaded. `.env` / `dev.db` hashes unchanged; working tree still 215 entries; HEAD `1e7cd98`; stash count 4; Docker containers unchanged.

## 1. Changes
| File | Change |
|---|---|
| `backend/tests/_db_guard.py` | **Fix 1:** `install()` now arms the blocker in EVERY mode via `allowlist_for(mode, flag)`: isolated → block everything; CI → only `CI_TARGET`; PHASE12_PG / PHASE13_PG → only `disposable_target(flag)` = host `127.0.0.1` (not `localhost`), the flag's port, database and user. `matches_target` (formerly CI-only) also refuses `hostaddr`/`service` overrides and any parameter that mentions `jackpots_v2`. **Fix 2:** in CI and disposable modes the run aborts before collection if any of `PGHOST`, `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGSYSCONFDIR` is set (non-empty); the guard never unsets them. New pure `settings_problems(...)` holds the session-start consistency checks (now also comparing the Alembic URL in every mode). Docstrings updated. |
| `backend/tests/conftest.py` | `pytest_sessionstart` calls `_db_guard.settings_problems(...)` (same checks, now unit-tested). |
| `backend/tests/test_db_isolation_guard.py` | +59 regression tests (below). |

## 2. libpq variables — which ones matter and why
Our connections always pass host, port, dbname and user explicitly, and libpq gives explicit parameters precedence. A variable is dangerous only if it supplies a parameter we never pass or changes where service definitions come from:
- `PGHOSTADDR`: used as the network address when no `hostaddr` is passed (we never pass one) — direct redirect.
- `PGSERVICE`: a `pg_service.conf` entry fills every parameter not given, including `hostaddr`.
- `PGSERVICEFILE` and `PGSYSCONFDIR`: relocate the service file that such entries come from.
- `PGHOST`: overridden by the explicit host today; rejected as requested, as defence in depth.

Not added, with reasons:
- `PGPORT`, `PGDATABASE`, `PGUSER`: the blocker passes a connect only when these are given explicitly, so these variables cannot apply.
- `PGOPTIONS`, `PGSSL*`, `PGPASSWORD`/`PGPASSFILE`, `PGTARGETSESSIONATTRS`, `PGLOADBALANCEHOSTS`, `PGCONNECT_TIMEOUT`, etc.: they change session, TLS, credentials or multi-host behaviour, not the destination of a single-host connect.

Isolated mode deliberately does not abort on these variables: every connect is blocked anyway, and a developer's own `PGHOST` must not stop the normal suite.

## 3. Tests (+59; all stub/mock-based or pure — no socket can be opened)
- Mode → allowlist mapping (1).
- Disposable mode passes exactly the approved database, via kwargs, a DSN string and a string port (4); blocks 14 other targets: another database, the other phase's database, `jackpots_v2` as the database or as the user, the native port 5432, the Phase 12 port, `localhost`, a remote host, the wrong role, `hostaddr`, `service`, a DSN with `hostaddr`, a DSN `service=`, and an empty connect (14).
- CI blocker refuses `jackpots_v2` in dbname / user / `options` (3).
- Each of the 5 libpq variables × {CI, PHASE12_PG, PHASE13_PG} aborts (15); the list is exactly the five (1); modes still resolve with empty `PGHOST` and non-redirecting variables (3); isolated mode is unaffected by them (5).
- Settings / engine / Alembic consistency: consistent cases (1); 7 mismatch cases, including an engine pointing at `jackpots_v2` and an isolated run without the sentinel (7).
- **The real `install()`** in a fresh `python -I` subprocess, with `psycopg2.connect` replaced by a stub BEFORE the guard arms, probing 7 targets: isolated → all 7 blocked and recorded, the stub never called; PHASE13 → only the phase 13 database passes; PHASE12 → only phase 12; CI → only the CI service; `jackpots_v2`, `hostaddr` and `service` probes blocked in every mode (4). The real `install()` aborts on `PGHOSTADDR` in disposable mode (1).

## 4. Results (exact)
| Run | Result |
|---|---|
| `tests/test_db_isolation_guard.py` | **132 passed** (73 before + 59 new) |
| Full isolated suite | **2533 passed, 0 failed, 26 skipped, exit 0** (4m44s) |
| Guard summary line | `mode=isolated flag=None blocked real-connection attempts=0` |
| OS-level port-5432 monitor (`netstat`, about every 2 s, 140 samples across the run) | **0** client connections / connection attempts to port 5432 |
Skips unchanged (26): 13 Phase 12 + 5 Phase 13 PostgreSQL-only, 3 refund PostgreSQL (no CI mode), 5 pre-existing SQLite limits.
Modes exercised: isolated (the real suite and a real `install()`), disposable PHASE12_PG and PHASE13_PG, and CI (real `install()` with a stubbed connect, plus pure `resolve()`). No mode connected to a real database.

## 5. Remaining limitations
- Not run end-to-end against a real database in disposable or CI mode (no disposable container this round; CI needs the GitHub job, or approval to download a Python image).
- `pytest --noconftest` bypasses the guard (deliberate bypass; documented here).
- Only psycopg2 is blocked (the only PostgreSQL driver installed).
- Host-name resolution (`localhost` in CI mode) relies on the runner's hosts file.
- The read-only `jackpots_v2` DBA checks from part 5 remain outstanding.
