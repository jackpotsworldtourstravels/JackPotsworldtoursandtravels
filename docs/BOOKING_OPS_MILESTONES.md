# Booking Operations — Implementation Roadmap

**Status: AUTHORITATIVE.** This is the project roadmap for the Booking Operations programme.
It is updated whenever a milestone is completed and verified, and it outranks any plan that
lives only in a chat session. If this file and a conversation disagree, this file wins.

Last updated: **2026-07-31** · Current milestone: **M4 — Finance, Billing & Payment Tracking**
· Last approved: **CR-2 — Manager approval + Classic Tours payment bypass ✅ (2026-07-31)**

---

## 0. How this programme is run

The delivery rule, agreed 2026-07-30, is one milestone at a time. Milestones are **never**
chained. For each milestone, in order:

1. **Implement** the full scope below.
2. **Verify completely** — API-level script *and* in-browser, against the live PostgreSQL
   database. Not "it should work"; it is run.
3. **Fix** everything verification turns up, then re-verify.
4. **Regression-test** every previously approved phase and milestone (§4).
5. **Write a detailed implementation summary.**
6. **Stop and wait for explicit approval** before starting the next milestone.

A milestone is not "done" when the code is written. It is done when steps 1–5 have all
happened and the approval in step 6 has been given.

### Changing approved functionality

Added 2026-07-31, on approval of CR-2. Everything in §1 is **locked**.

1. **Do not modify approved functionality.** Not to tidy it, not to make a later milestone
   simpler, not because a different pattern would have been nicer. If a later milestone appears
   to need a change here, that is a signal to check the assumption, not a licence to edit.
2. **The one exception is a bug** — approved behaviour that does not do what this file and
   `docs/API_CONTRACT.md` say it does. Fix it, say so plainly in the milestone summary, and add
   the regression to that milestone's verification script so it cannot come back.
3. **A wanted behaviour change is a change request, not a milestone task.** Write down what
   changes, which approved behaviour it alters, and why the milestone cannot proceed without it —
   then **stop and get explicit approval before altering behaviour**. CR-1 and CR-2 are the shape
   this takes.
4. **Additive is not exempt.** Adding a status, a permission code, a lifecycle edge or a field to
   an approved response changes approved behaviour. The same rule applies.

The practical test: if a reviewer who approved the milestone would be surprised by the diff, it
needed approval first.

**Currently locked:** Phases 1–3, M1, M2, M3, CR-1, CR-2.

### Where the work lives

| Layer | Path |
| --- | --- |
| Backend API | `backend/app/routers/` |
| Business logic | `backend/app/services/` |
| Schema migrations | `backend/alembic/versions/` |
| Merchant portal (Classic V2) | `frontend/merchant-classic/` |
| Admin portal | `frontend/admin/` + `frontend/assets/js/admin-*.js` |
| Operations portal (V2, role-adaptive) | `frontend/operations/` |
| Verification harness | `tests/` |
| API contract | `docs/API_CONTRACT.md` |

### Conventions that bind every milestone

These are already established in the codebase. A milestone that breaks one of them is not
production-ready, regardless of whether its own feature works.

- **One state machine.** `services/lifecycle.py::transition` is the *only* function permitted
  to change `service_requests.status`. It writes `status_history`, which is what the Activity
  Timeline renders. Never assign `request.status` directly.
- **Permissions, not roles.** Every endpoint declares a code from `auth/rbac.py::P` via
  `Depends(require(P.X))`. New behaviour reuses an existing code unless the spec genuinely
  describes a new capability.
- **Cross-tenant reads 404, not 403.** `assert_same_merchant` — a response must never confirm
  that another company's record exists.
- **No new endpoint without a contract entry.** `docs/API_CONTRACT.md` is updated in the same
  milestone that adds the endpoint.
- **Staff-only stays staff-only.** Internal notes (`request_notes`) are never carried on a
  merchant-facing response, in any schema, ever. See migration `0032`.
- **Cache-bust the frontend.** Every `frontend/**` script and stylesheet is loaded with a `?v=`
  query string. Changing a JS file without bumping it ships nothing to a returning browser.

---

## 1. Completed and approved

### Phase 1 — Merchant Ticket Enquiry ✅ **Complete & Approved**

Merchant-side enquiry capture in the Classic V2 portal. Enquiries ride `service_requests` with
`request_type = ticket_enquiry`; no new table. Inventory Search was retired in favour of it.

- Backend: `routers/enquiries.py`, `services/enquiry_service.py`
- Migration: `0030_enquiry_number_sequence`
- Frontend: `frontend/merchant-classic/js/classic-enquiry.js`

### Phase 2 — Admin Ticket Enquiry Review ✅ **Complete & Approved**

Admin-side review and response. "Start Review" is a claim, taken under `SELECT FOR UPDATE`, so
two admins cannot both believe they own an enquiry. The generic approve/reject endpoints
deliberately refuse enquiries — they have their own resolution path.

- Backend: `routers/enquiries.py` (admin section), `services/enquiry_service.py`
- Frontend: `frontend/admin/` + `frontend/assets/js/admin.js`

### Phase 3 — Booking Documents ✅ **Complete & Approved**

Passport / visa / photo-ID uploads on enquiry-led bookings, with per-file verification state.
Bytes are never statically mounted — every download re-checks merchant scope.

- Backend: `routers/documents.py`, `services/document_service.py`, `schemas/document.py`
- Migration: `0031_request_documents`
- Frontend: `classic-booking.js`, `classic-booking-detail.js`, `assets/js/admin-bookings.js`

### M1 — Booking Operations backend core ✅ **Complete & Approved**

The post-approval desk: what happens to a booking *after* it is approved, without moving its
status. Deliberately disjoint from the pre-approval Approval Queue, so a booking is in exactly
one of the two screens at any time.

- **Processing queue** — `GET /api/admin/bookings/queue`, oldest-first (it is a work queue, not
  a feed), over the four post-approval stages: Approved → Payment Pending → Paid → Ticket
  Issued. Filters: `stage`, `assigned_to`, `unassigned`, `merchant_id`, `search`.
- **Tab badges** — `GET /api/admin/bookings/queue/counts`, one grouped query, plus `unassigned`.
- **Operator assignment** — `GET /api/admin/bookings/operators` (with each operator's current
  load), `POST /api/admin/bookings/{id}/assign`. Row-locked read-modify-write; reassignment is
  allowed by design, and the activity log records the operator it moved *from*.
- **External references** — `PUT /api/admin/bookings/{id}/references` for the real airline PNR,
  ticket number and airline reference. Partial update; overwrite permitted and logged with the
  previous value; duplicate ticket number returns a 409 naming the other booking.
- **Internal notes** — `GET/POST /api/admin/bookings/{id}/notes`, `PUT/DELETE
  /api/admin/bookings/notes/{note_id}`. Staff-only at the service layer, not just the router.
  Only the author may edit or delete. The note body is never copied into the activity feed.

- Backend: `routers/booking_ops.py`, `services/booking_ops_service.py`, `schemas/booking_ops.py`
- Migration: `0032_request_notes`
- Verified by: `tests/verify_m1.py`, `tests/verify_m1_concurrency.py`

### M2 — Ticket upload, paperwork PDFs, merchant delivery ✅ **Complete & Approved**

- **Staff ticket upload** — the upload window in `document_service` widened so platform staff
  may attach `ticket` / `other` documents once a booking is **paid**. The airline's e-ticket
  does not exist before the money moves, and a merchant still may only attach while its request
  is a draft.
- **Invoice PDF** — `GET /api/requests/{id}/invoice`. Rendered on demand from the booking, its
  passengers and its payments; nothing is stored, so a refund can never leave a stale PDF
  disagreeing with the ledger. Refunds are netted into "Balance due".
- **Booking confirmation PDF** — `GET /api/requests/{id}/confirmation`. Explicitly *not* an
  e-ticket, and says so on its face.
- **Ticket documents listing** — `GET /api/requests/{id}/ticket-documents`, merchant-scoped.
- Both PDFs are gated to `ticket_issued` / `completed` (`invoice_service.INVOICEABLE`) and reuse
  `ticket_service.get_request` for scoping rather than inventing a second scoping rule.

- Backend: `services/invoice_service.py`, `routers/tickets.py`, `services/document_service.py`
- Verified by: `tests/verify_m2.py` (drives a real booking Payment Pending → Ticket Issued)

### CR-1 — Documents removed from the Classic merchant workflow ✅ **Complete & Approved**

An out-of-band change request, approved 2026-07-31, not a numbered milestone. It **reverses the
merchant-facing half of Phase 3** while leaving that milestone's backend entirely in place.

- Merchant Booking Request no longer shows a Documents section, and no upload, passport scan or
  any other file is a precondition of submitting. `Save as draft` is now genuinely optional on
  every route — on an international sector it had become mandatory, because passports could only
  be attached to a saved draft.
- Passport **details** (number, and an expiry after the travel date) are still required on an
  international sector. They are passenger data typed into the form, not an upload.
- The Admin Approval Queue's Review modal now shows the whole submitted booking read-only:
  booking reference, merchant, enquiry reference, trip type, journey, both travel dates, airline,
  flight number, passenger count, every passenger field, contact, special requests, the lifecycle
  timeline and the current status. The queue's own approve/reject workflow is untouched.
- **Kept, deliberately:** migration `0031`, `request_documents`, `document_service`,
  `routers/documents.py`, the `document.upload` / `document.verify` codes, and the Admin's
  verification controls — which now render only when a booking actually carries files. Documents
  can be reinstated without a migration.

- Backend: `services/ticket_service.py` (`_validate_enquiry_led_submission`)
- Frontend: `classic-booking.js`, `classic-booking-detail.js`, `classic-enquiry.js`,
  `classic-shell.js`, `assets/js/admin-bookings.js`
- Verified by: `tests/verify_api.py`, whose submit-validation section previously asserted the
  **opposite** rule and was rewritten to assert the new contract (including a booking that never
  touches a document endpoint at all)

### CR-2 — Manager approval step + Classic Tours payment bypass ✅ **Complete & Approved**

**Approved 2026-07-31. This workflow is LOCKED — see §0's "Changing approved functionality".**

An out-of-band change request, raised 2026-07-31. Inserts a **Manager** sign-off between the
merchant's submitted Booking Request and the Admin Booking Operations queue, and **disables the
payment workflow for enquiry-led (Classic Tours) bookings only**. Two scope decisions were taken
by the business, not assumed: the Manager is a *platform* role (not the existing merchant-side
`MerchantRole.MANAGER`), and the payment bypass is scoped to the enquiry-led flow so M4 Finance
and every other workflow keep their payment path intact.

- **New role and codes.** `UserRole.MANAGER`, `P.BOOKING_MANAGER_APPROVE`,
  `P.BOOKING_MANAGER_RETURN`. Held by the Manager alone; the Admin holds neither, which is what
  stops the desk that answered an enquiry from also signing off the booking. The Manager
  deliberately does **not** hold `ticket.view`.
- **Two migrations, not one.** `0033` adds the enum label; `0034` widens
  `ck_users_merchant_scope`. PostgreSQL cannot *use* a new enum label in the transaction that
  added it, and that constraint enumerates roles by literal — so a Manager could not be inserted
  until the second migration ran.
- **Two tracks in one state machine.** `lifecycle.CLASSIC_TRANSITIONS` replaces `TRANSITIONS`
  wholesale for a Classic Tours booking. Payment Pending and Paid have **no inbound edge** there
  — the bypass is an unreachable state, not a hidden button. `is_classic_track` returns False
  once a booking has entered a payment status, so bookings already in flight finish the way they
  started instead of becoming unmovable.
- **Reject = returned for correction.** Back to Draft with mandatory remarks, editable and
  resubmittable, not the terminal Rejected. `timeline()` now computes "already done" from history
  *since the request last entered its current status*, or a returned booking hides the
  resubmission it still owes.
- **Bypass paths closed** by track, the same treatment enquiries and change requests got:
  `/api/admin/requests/{id}/approve`, `.../reject`, `.../reprice`, `POST /api/requests/{id}/pay`,
  and the Admin Approval Queue listing.
- **M1's Booking Operations queue finally has a frontend.** It had none — the entire M1/M2
  backend was unrendered by any portal. CR-2 required it, so `frontend/assets/js/admin-booking-ops.js`
  now surfaces the queue, assignment, airline references, internal notes, multi-file ticket
  upload, Mark Ticket Issued and Mark Completed.
- **Two pre-existing M4 defects found while making the suite green**, both fixed:
  `change_request_service.approve` mutated `pricing` in place after assigning it, and an
  autoflush inside `settle_refund` made that dict the attribute's committed baseline — so
  `refund_settled`/`refund_unsettled` were written in memory and silently dropped at commit on
  **every** cancellation. And `finance_service.assert_within_credit_limit` refused *reductions*
  when a merchant was already over its limit, contradicting its caller's documented contract.
- **Test fixtures split.** `flows.make_booking` is enquiry-led and walks the Manager path;
  `flows.make_catalog_booking` is the standard track, for every money test. Asking the former for
  a paid booking now fails loudly rather than stopping short.

- Backend: `services/manager_service.py`, `routers/manager.py`, `schemas/manager.py`,
  `services/lifecycle.py`, `auth/rbac.py`, `services/document_service.py`,
  `services/ticket_service.py`, `services/approval_service.py`, `services/notification_service.py`
- Migrations: `0033_manager_role`, `0034_manager_scope_constraint`
- Frontend: `frontend/manager/` (new portal), `assets/js/manager-portal.js`,
  `assets/js/admin-booking-ops.js`, `merchant-classic/js/classic-booking-detail.js`,
  `classic-requests.js`, `classic-shell.js`, `classic-payments.js`, `shared/merchant-api.js`
- Verified by: `tests/verify_cr2.py` — **118 checks**

**Completion pass (requested before approval).** The first submission left the role working but
not operable, and three checklist items unmet. All closed:

- **Super Admin → Admin Management now runs Manager accounts.** A Role dropdown on create and
  edit, a Role column and role filter on the table, and the Manager added to the Role Permission
  Matrix. `POST /api/super-admin/admins` takes `role`; `PUT .../{id}` takes an optional `role`
  that is **refused with a 409 while that Manager still holds a booking under review** — the
  claim would otherwise outlive the permission to act on it, stranding the booking In Review.
  A role change revokes the account's sessions, because its permission set changes underneath it.
  The RBAC codes arrive with the role; nothing is granted by hand.
- **Manager notifications.** `notify_managers` had been writing a row per submission since CR-2
  landed and the role held `notification.view`, but the portal had no surface — 52 unread had
  accumulated unreadable. Bell with unread dot, dropdown, a full paginated Notifications section,
  and mark-one / mark-all. No new endpoint; `/api/notifications` already serves any role holding
  the code.
- **Manager profile.** Details and password change, on the pre-existing `/api/profile` and
  `/api/auth/change-password`.
- **Modal focus trapping** — new shared `frontend/components/focus-trap.js`, applied to the
  Manager review modal and the Booking Operations work modal: focus moves to the first real
  control (not the close button), Tab and Shift+Tab cycle within the dialog, the rest of the page
  is `aria-hidden` while it is open, and focus returns to the exact trigger on close.
- **Manager queue queries indexed** — migration `0035`, a partial index on
  `(created_at, status)`. Measured, not assumed: the list query went from 192 buffers with 277
  rows discarded to 23 buffers with **none** (status became an index condition rather than a
  post-filter), and the counts query became an index-only scan, 143 buffers → 34. The obvious
  `(status, created_at)` ordering was tried first and is the worse one, because every bucket but
  *Approved* spans more than one status. `tests/minihttp.py` gained the `patch` verb it had
  always been missing.

**§3 Production Readiness Checklist — CR-2 sign-off.** §3 says it is applied to every milestone
and that an inapplicable item is marked N/A *with a reason*, not silently skipped. It had not
been recorded for CR-2. Verified item by item:

| Group | Result |
| --- | --- |
| **Security** | All 6 new endpoints authenticated (`no token -> 401/403` asserted). No secret or PII in any new response; the generated password is returned once by a pre-existing endpoint and cleared from the DOM on acknowledge. Uploads unchanged — CR-2 widened *when* staff may attach, not what or how. Every new input is a Pydantic schema; **no f-string SQL anywhere in the new services** (checked). Cross-tenant reads 404, not 403 (asserted). Auth rate limits untouched. |
| **RBAC** | All 6 manager endpoints declare a `P.*` via `Depends(require(...))`. Two new codes, justified in §6.3c of the contract. Matrix updated and now rendered in the Super Admin UI. Tested from super admin, admin, manager, merchant admin and a rival merchant. Deliberate denials hold — a Manager cannot reach the ops queue, internal notes or ticket upload. The UI offers nothing the server refuses: the Admin Approval Queue drops Classic bookings rather than showing an Approve the service would reject. |
| **Concurrency** | Manager decisions are row-locked (`SELECT … FOR UPDATE`); claim semantics are first-wins and stated. Six simultaneous approvals tested for real — exactly one wins, losers get 400/409, never a 500. Status changes go through `lifecycle.transition` exclusively. No sequence is allocated before its transition validates. |
| **Performance** | Queue relationships eager-loaded (7 `selectinload`); `documents` added to the ops queue when `has_ticket_documents` was introduced. Both new queries `EXPLAIN`ed on real data and indexed — see `0035`. `page_size` capped at 100. No unbounded query. |
| **Accessibility** | Focus trapped and restored in both new modals, verified with a real keyboard Tab. `:focus-visible` rings on every new control — **the Manager's queue tabs and notification rows were missing theirs and were fixed in this pass.** All new inputs have `for`/`id` labels; icon-only buttons have `aria-label`. Colour is never the only carrier — every badge carries text. **Contrast measured, not eyeballed: the "Pending Manager Approval" chip was 4.35:1, below AA for 11.5px bold text; `.badge.pending` and `.cl-tag-warn` moved `#a06600` → `#8f5c00`, now 5.17:1.** No horizontal overflow at 1280 / 768 / 375 on any portal. |
| **Documentation** | Contract updated in the same pass as the endpoints. All three migrations carry a *why*. Non-obvious decisions commented at the point of the decision. This file updated. Schema docs need no change — they map legacy tables to new ones and document neither enum values nor indexes. |
| **Regression** | 10/10 scripts, 594 checks. `?v=` bumped on every changed asset. Failures reported with their output; skips stated as skips. |

Two items are **N/A, with reason**: *"Uploads: size-capped, magic-byte checked"* — CR-2 changed the
upload *window*, not the upload path; `document_service`'s checks are untouched and still covered
by `verify_api.py`. *"No secret in any PDF"* — CR-2 renders no PDF.

**Known and accepted:** `#a06600` remains on icon tiles, large numerals, and `main.css`'s
public-site badges. Those meet the 3:1 non-text / large-text threshold, and restyling the public
site is outside this change request.

---

## 2. Remaining milestones

Each milestone below carries **Scope**, **Depends on**, **Verification requirements** and a
**Checklist**. Tick boxes in place as work lands; the checklist is the progress record.

---

### M3 — Cancellation & Reschedule Workflow ✅ **Complete & Approved**

**Why it comes first:** M1/M2 assume a booking moves forwards. Every real desk spends most of
its time on bookings that move sideways or backwards, and today the platform has only a thin
generic hook (`ticket_service.create_service_request` / `resolve_service_request`) with no money
handling, no effect on the parent booking, and no UI.

**Scope**

- Merchant raises a **cancellation** or a **reschedule / date change** against a confirmed
  booking (`RequestType.CANCELLATION`, `RequestType.DATE_CHANGE`), linked by
  `parent_request_id`. Both types already exist in the enum and the schema's check constraint.
- **Eligibility rules**, enforced server-side: which parent statuses may be cancelled or
  rescheduled, what happens to a booking that is already cancelled, and refusal of a second
  open change request against the same booking.
- **Cancellation charges and refund position** — the requested amount, the charge, and the net
  refund, computed and stored so the finance milestone has something real to settle against.
- **Reschedule payload** — new travel date (and return date), plus any fare difference, with the
  parent booking's `travel_date` updated **only** on approval, never on request.
- **Effect on the parent booking on approval** — a cancellation walks the parent to `CANCELLED`
  through `lifecycle.transition` (never a direct assignment); a reschedule updates the itinerary
  and leaves the parent's status alone.
- **Admin/ops review surface** — list, open, approve with amounts, reject with a mandatory
  reason. Claim semantics consistent with Phase 2's Start Review.
- **Concurrency** — row-locked resolution, so two admins cannot both approve the same
  cancellation, and a cancellation racing a reschedule on one booking resolves deterministically.
- **Notifications** on raise, approve and reject (in-app now; email lands in M5).
- **Frontend** — merchant surfaces in `frontend/merchant-classic/`, staff surfaces in the admin
  portal, both wired to the same endpoints.
- **Contract** — `docs/API_CONTRACT.md` updated with every new endpoint.

**Depends on:** Phase 3 (documents on the parent booking), M1 (the desk the staff review sits
next to), M2 (an invoice that must reflect a cancellation once it settles).

**Verification requirements**

- `tests/verify_m3.py`: raise → review → approve, and raise → reject, for both types, driven
  from a booking built by `tests/flows.py` rather than hunted for in existing data.
- Eligibility matrix: every parent status × both request types, asserting the exact refusal.
- Money: charge and net refund correct at the boundaries (zero charge, charge equal to the fare,
  charge exceeding the fare must be refused).
- Concurrency: two simultaneous approvals of one change request — exactly one wins.
- RBAC: a merchant cannot resolve its own request; a merchant of company A cannot see or touch
  company B's (404, not 403); a Super Admin's restrictions hold.
- Parent-booking integrity: after an approved cancellation the parent is `CANCELLED` with a
  complete `status_history`, and its invoice reflects the new position.
- Browser: both portals exercised end to end, console clean, no layout break at 1280 / 768 / 375.

**Checklist**

- [x] Migration — **none needed**; `RequestType.CANCELLATION` / `DATE_CHANGE`, `parent_request_id`
      and the `pricing`/`travel_details` JSONB columns have existed since the nine-table redesign
- [x] Service layer: eligibility, charge/refund computation, parent-booking effects
      (`services/change_request_service.py`)
- [x] Router + schemas, with permission codes declared (`routers/change_requests.py`,
      `schemas/change_request.py`) — no new permission codes
- [x] Concurrency guards (`SELECT FOR UPDATE`) on the request **and** its parent booking
- [x] Notifications on raise / withdraw / approve / reject
- [x] Merchant frontend (Classic V2) + `?v=` bump
- [x] Admin frontend + `?v=` bump
- [x] `docs/API_CONTRACT.md` updated
- [x] `tests/verify_m3.py` written and passing — **128 checks**
- [x] Regression suite (§4) green — **5/5 scripts, 317 checks**
- [x] Browser verification at 1280 / 768 / 375, console clean
- [x] Implementation summary written

**What M3 also closed**

Three ways to move a change request existed through generic endpoints, none of which settled
anything. All three now refuse these two types by type, the same way the generic approve/reject
refuses an enquiry:

- `POST /api/admin/requests/{id}/approve` — walked a cancellation to **Payment Pending**, showing
  the merchant a Pay button on a request to cancel.
- `POST /api/admin/service-requests/{id}/resolve` — marked it Approved and left the booking as it was.
- `POST /api/requests/{id}/cancel` — withdrew it while skipping the claim check and telling nobody.

The settlement edges (Paid → Cancelled, Ticket Issued → Cancelled) live in
`lifecycle.SETTLEMENT_TRANSITIONS`, deliberately **outside** `TRANSITIONS`, so they never appear
in `allowed_transitions` and no portal renders a bare Cancel button that would skip the charge.

---

### M4 — Finance, Billing & Payment Tracking ⏳ **Complete, awaiting approval**

**Audited 2026-07-31, then completed.** This milestone was labelled "Not started" with an
entirely unticked checklist. That was wrong in both directions: the backend was complete and
proven, and the frontend did not exist at all. The audit below is preserved as the record of what
was found; the approved remaining work (A–E) was then built and is verified. **125 checks in
`verify_m4.py`; suite 613 checks, 10/10.**

#### Audit — scope items

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Coherent merchant financial position, one computation used by **every** surface | ⚠️ Partially Complete |
| 2 | Wallet + credit limit actually enforced | ✅ Complete |
| 3 | Payment lifecycle record → verify → refund, incl. M3 cancellation refunds, ledger as source of truth | ✅ Complete |
| 4 | Statements / ledger view per merchant, **and** an admin payments desk with verification queue | ⚠️ Partially Complete |
| 5 | Invoice numbering integrity — no gaps, no reuse, verified under failure | ✅ Complete |

#### Audit — verification requirements

| Requirement | Status |
| --- | --- |
| Ledger arithmetic against hand-computed fixtures, incl. partial refunds | ✅ Complete |
| Credit-limit enforcement refused server-side | ✅ Complete |
| Every money figure on every screen traced to the same service function | ❌ Not Implemented |
| No float arithmetic anywhere in the money path (`Decimal` only) | ⚠️ Partially Complete |
| Concurrency: two simultaneous payment verifications on one booking | ✅ Complete |

#### The two partial items, in detail

**1 & 4 — the finance computation exists and nothing consumes it.**

*What exists:* `services/finance_service.py` — 13 functions covering `booking_position`,
`merchant_position`, `balance_due`, `statement`, `settle_refund`, `refundable_against`,
`assert_within_credit_limit`, `assert_wallet_covers`, `adjust_wallet`. Four endpoints in
`routers/finance.py`: merchant position, merchant statement, admin per-merchant position, admin
per-merchant statement. `shared/merchant-api.js` even declares `financePosition()` and
`financeStatement()` client methods. All of it is proven by `tests/verify_m4.py`.

*What is missing:* **every one of those has zero callers.** Verified by search:
`MerchantApi.financePosition` / `financeStatement` — 0 call sites. The admin per-merchant finance
endpoints — 0 call sites. `classic-payments.js` carries a 7-line docstring headed "ACCOUNT
POSITION AND STATEMENT (M4)" describing a KPI strip and a ledger, and a
`let clFinancePosition = null;` that is **declared and never assigned or rendered**. The screen
described in that comment was never built.

Meanwhile the surfaces that *do* show money get it elsewhere: the merchant dashboard reads
`merchants.wallet_balance` straight from `dashboard_service` (a raw column, not a position, and
shown with no "how much of the limit is used"), and `operations/js/ops-finance.js` computes **six
separate money totals in JavaScript with `Number()`** — floats, summed client-side, from
`/api/admin/payments`. `classic-reports.js` does the same on line 136. That is precisely the
failure this milestone was written to make impossible: several surfaces each computing a total
their own way, in a numeric type the ledger does not use.

*Bug fix or new functionality?* **Both, and they should be counted separately.**
The unbuilt merchant ledger screen and the unbuilt admin per-merchant position are **new
functionality**. The seven client-side float sums are a **bug** — screens presenting numbers that
are not the ledger's, against a stated requirement of this milestone.

**"No float in the money path" — where it actually stands.**

*Backend live code is clean.* A search finds 20 `: float` money fields across
`admin_partner.py`, `booking_management.py`, `partner_booking.py`, `partner_reports.py`,
`partner_service_request.py`, `payment_management.py`, `pricing.py` and `inventory.py` — and
**every one of those schemas belongs to a router that `main.py` does not register.** They are part
of the documented dead-code set. Fixing them would be refactoring unreachable code; they are
listed here so the next reader does not re-discover them and assume a live defect.

*The live violations are all frontend:* the six `ops-finance.js` reductions, the one in
`classic-reports.js`, and `admin.js` sending `Number(amount)` on `POST /api/admin/payments/{id}/refund`.
The refund one was tested and is **not currently corrupting values** — Pydantic v2 converts
float→`Decimal` via `str()`, so `1234.56` round-trips exactly — so it is a latent violation of the
stated rule rather than an active money bug. One-word fix.

#### What is genuinely complete

- `finance_service` as the single computation, with `Decimal` throughout and `q()` quantising.
- Wallet and credit limit enforced at approval and at wallet payment, not merely displayed.
  (Two defects in this area were found and fixed during CR-2: a dropped refund-settlement write,
  and a credit check that refused fare *reductions*.)
- Record → verify → refund, row-locked (`SELECT … FOR UPDATE` on the payment), with M3's
  cancellation refund settling into the same ledger, oldest payment first, shortfall recorded
  rather than hidden.
- Invoice numbering proven gap-free and never reused, including under a failed attempt.
- An **admin payments desk does exist** — `admin.js`'s Payment Verification section over
  `/api/admin/payments`, `/pending`, `/verify`, `/refund` — as does a second one in the
  Operations portal (`ops-finance.js`, 667 lines). The verification-queue half of scope item 4 is
  met; the per-merchant position half is not.
- `docs/API_CONTRACT.md` §6.3b documents all four finance endpoints.
- `tests/verify_m4.py` — 104 checks across ledger arithmetic, statement reconciliation, wallet,
  credit limit, M3 refund settlement, payment-verification concurrency, invoice numbering,
  approval pricing, re-pricing and cross-tenant RBAC.


#### M4 — what the approved remaining work (A–E) delivered

**A. Merchant Account Position & Statement** — `classic-payments.js`. A seven-tile position strip
(balance due, billed, paid, wallet, awaiting verification, credit available *beside what is used*,
spending power) and a dated ledger with the server's own running balance, from
`GET /api/merchant/finance/position` and `/statement`. The dead `clFinancePosition` declaration is
gone. Date-range filter on the statement. No figure is derived on the page.

**B. Admin per-merchant finance** — a "Financial position" panel inside the existing Merchant
Management detail view, from `GET /api/admin/merchants/{id}/finance`, with a collapsible statement
from `/statement`. **Wallet Balance and Credit Limit were removed from the info grid above it** —
they were raw columns rendered through `money()`, and having them beside the computed position was
two answers to one question. No new endpoint, no new screen architecture.

**C. Client-side money arithmetic removed** — *bug fix.* Ten sites:
six page-scoped sums in `ops-finance.js` (one of which, "Owed now", **under-reported by design** —
it summed a single capped page and said so in its own footnote; it is now `outstanding` from the
position), the "Value listed" tile in `classic-reports.js`, the "Value shown" tile and the revenue
roll-up in `ops-insight.js`, and a per-passenger multiplication in `ops-inventory.js`. Row *counts*
are not money and were kept. Two float payloads fixed: `admin.js`'s refund and `ops-api.js`'s
reprice now send the string as typed, against `Decimal` schemas.

**D. Merchant dashboard** — *bug fix.* The "Credit limit" tile showed a ceiling with no usage,
read from a raw column. It now shows credit available with used/limit beneath it, or balance due
when no limit is set, from the position. The Account panel gained Balance due.

**E. Verification** — `verify_m4.py` grew 104 → **125 checks**, including a section asserting the
merchant and the admin read an *identical* value for all eleven position fields, that money crosses
the wire as decimal **strings** (so the browser cannot float it), and that the statement carries its
own totals so no screen has to add a column. Browser-verified on the merchant dashboard, merchant
Payments, Admin Merchant Management and the Operations finance screens at 1280/768/375, console
clean. Suite **613 checks, 10/10**.

**One shared formatter, not four.** `moneyStr()` and `moneyIsPositive()` in `shared/formatters.js`
render a decimal string without parsing it. `money()` — which does `Math.round(n)`, making a float
*and* discarding the paise — remains correct for counts and is untouched, but nothing that came
from `finance_service` goes through it any more. A ₹24,500.50 balance used to render ₹24,501.

**Deliberately not done**, per the approved scope: the 20 `: float` money fields in unregistered
dead routers; `partner-request-history.js` (the retired Premium portal, a redirect stub whose
scripts never execute); and any change to the finance arithmetic itself, which was already proven.

**Scope**

- A coherent **merchant financial position**: booking total, paid, refunded, balance due,
  outstanding across bookings — one computation, used by every surface. (A prior phase found
  `pending_payments_count` being read as money owed; that class of bug is what this milestone
  exists to make impossible.)
- **Wallet and credit limit** (`merchants.wallet_balance`, `merchants.credit_limit`) actually
  enforced rather than merely displayed.
- **Payment lifecycle**: record → verify → refund, including refunds arising from M3
  cancellations, with the `payments` ledger as the single source of truth.
- **Statements / ledger view** per merchant, and an admin payments desk with verification queue.
- **Invoice numbering integrity** — no gaps, no reuse, verified under failure.

**Depends on:** M2 (invoice rendering), M3 (cancellation refunds are the main new money event).

**Verification requirements**

- Ledger arithmetic proven against hand-computed fixtures, including partial refunds.
- Credit-limit enforcement: a booking that would exceed the limit is refused server-side.
- Every money figure on every screen traced back to the same service function.
- No float arithmetic anywhere in the money path (`Decimal` only).
- Concurrency: two simultaneous payment verifications on one booking.

**Checklist** — corrected 2026-07-31 to reflect what is actually built

- [x] Single finance computation service — `finance_service.py`, `Decimal` throughout
- [x] …used by all surfaces — merchant Payments, merchant dashboard, Admin Merchant Management
      and the Operations wallet all read it; asserted equal, field by field, in `verify_m4.py`
- [x] Wallet + credit limit enforced server-side
- [x] Refund path from M3 settles correctly
- [x] Merchant statement/ledger screen — position strip + dated ledger with a server running balance
- [x] Admin payments desk — verification queue, list, verify, refund
- [x] Admin per-merchant finance position — in Merchant Management, same computation as the merchant's
- [x] Invoice numbering verified gap-free
- [x] `docs/API_CONTRACT.md` updated (§6.3b)
- [x] `tests/verify_m4.py` written and passing — **125 checks**
- [x] Regression suite green — 613 checks, 10/10
- [x] No float in the money path — 10 client-side calculations removed, 2 float payloads fixed;
      the remaining `: float` money fields are all in unregistered dead routers (out of scope)
- [x] Browser verified — 4 portals at 1280/768/375, console clean
- [x] Summary written

---

### M4 — remaining work (revised plan, 2026-07-31) ✅ **Approved, and delivered**

**This is the plan as it was approved, kept as the record of what was agreed.** What it turned
into is written up above under *"M4 — what the approved remaining work (A–E) delivered"*; if the
two disagree, the delivered section is what exists.

Only the gaps. No rewrite of the backend, no refactor of the dead-code float schemas, no second
finance computation — every item below either **consumes** what `finance_service` already exposes
or **deletes** a duplicate computation that should never have existed.

**A. Merchant account position & statement screen** — *new functionality*
Build what `classic-payments.js`'s docstring already promises: a KPI strip (billed, paid,
refunded, balance due, outstanding, wallet, credit available) and a dated ledger with a running
balance, both from `GET /api/merchant/finance/position` and `/statement`. The client methods
already exist and are unused; wire them and delete the dead `clFinancePosition` declaration.
*Touches no approved workflow — CR-2's Classic Tours bookings are non-billable and simply do not
appear, which the screen already says.*

**B. Admin per-merchant finance position** — *new functionality*
Surface `GET /api/admin/merchants/{id}/finance` and `/statement` in Merchant Management, so the
desk answering "what does this merchant owe" reads the same computation the merchant sees. This is
the concrete meaning of "one computation, used by every surface".

**C. Remove the client-side money arithmetic** — *bug fix*
Replace the six `Number()` reductions in `operations/js/ops-finance.js` and the one in
`classic-reports.js` with figures the API already returns, or add the missing figure to
`finance_service` if one is genuinely absent — never a new sum in JavaScript. Change
`admin.js`'s refund payload from `Number(amount)` to the string form.
*If any figure turns out to need a server-side total that does not exist yet, that is a small
addition to `finance_service`, not a new computation elsewhere — flagged before it is written.*

**D. Merchant dashboard honesty** — *bug fix, small*
The dashboard shows "Credit limit" with no indication of how much is used. Show `credit_available`
/ `outstanding` from the position, or drop the tile. A limit with no usage beside it is the same
class of misreading as the `pending_payments_count` bug this milestone cites.

**E. Verification** — *required by §0*
Extend `tests/verify_m4.py` to assert that the figures the new screens render equal
`finance_service`'s, browser-verify every money screen at 1280/768/375, re-run the full suite,
write the summary.

**Explicitly out of scope:** the 20 `: float` money fields in unregistered routers (dead code —
`admin_partner`, `booking_management`, `partner_*`, `payment_management`, `pricing`, `inventory`);
any change to the finance service's arithmetic, which is proven; anything in §1.

---

### M5 — Email & In-App Notifications ⬜ **Not started**

**Scope**

- Email for every lifecycle event that matters: submitted, approved, rejected, payment
  verified, ticket issued, cancellation/reschedule raised and resolved.
- Templates rendered server-side, logged to `msg_logs` with delivery status.
- Per-merchant **communication settings** (`communication_settings`) honoured — a merchant that
  has disabled email must not receive it.
- In-app notification centre completed across portals, with read state and counts.
- Failure handling: a bounced or failed send is visible to staff, not silently swallowed.

**Depends on:** M3 and M4 (they generate the events worth sending).

**Verification requirements**

- Each event type produces exactly one message per intended recipient — no duplicates, no
  missing sends.
- Opt-out respected; an admin cannot be spammed by a loop over merchant users.
- `msg_logs` rows carry accurate status; a forced failure is surfaced.
- No secret, token, password or full PII in any email body or log row.

**Checklist**

- [ ] Template set for every lifecycle event
- [ ] `communication_settings` honoured on every send path
- [ ] `msg_logs` written with accurate status
- [ ] In-app notification centre complete across portals
- [ ] Failure surfaced to staff
- [ ] `docs/API_CONTRACT.md` updated
- [ ] `tests/verify_m5.py` written and passing
- [ ] Regression suite green · Browser verified · Summary written

---

### M6 — Analytics, Reports & Dashboard Enhancements ⬜ **Not started**

**Scope**

- Role-appropriate dashboards: merchant, admin/ops, super admin.
- Operations metrics: queue age, unassigned count, per-operator load, time-to-issue.
- Cancellation / reschedule / refund analytics from M3–M4.
- Report exports (CSV / XLSX / PDF) via `services/export_service.py`, honouring the same
  filters as the on-screen list.
- Every figure traceable to a query — no client-side invention of numbers.

**Depends on:** M3, M4, M5.

**Verification requirements**

- Each dashboard tile's number reproduced independently by a direct SQL query.
- Exports match the on-screen filtered set exactly (row count and totals).
- Date-range filters state which column they filter on (a prior phase shipped a filter on
  `travel_date` that read as `created_at`).
- Large-dataset behaviour: pagination caps hold; no unbounded query.

**Checklist**

- [ ] Dashboards per role
- [ ] Ops SLA / queue metrics
- [ ] Cancellation & refund analytics
- [ ] Exports matching on-screen filters
- [ ] Every tile verified against direct SQL
- [ ] `docs/API_CONTRACT.md` updated
- [ ] `tests/verify_m6.py` written and passing
- [ ] Regression suite green · Browser verified · Summary written

---

### M7 — Merchant Booking History, Ticket Delivery & Downloads ⬜ **Not started**

**Scope**

- Merchant-facing booking history: filter, search, paginate, open.
- Booking detail showing the full timeline, passengers, documents, payments and any
  cancellation/reschedule raised against it.
- Downloads: airline e-ticket, invoice, booking confirmation — all merchant-scoped, all
  re-checked per request.
- Delivery: the merchant is told when paperwork is available, and can re-fetch it.
- Explicitly **not** exposing internal notes anywhere on these surfaces.

**Depends on:** M2 (the documents), M3 (change requests shown on the booking), M5 (delivery
notifications).

**Verification requirements**

- A merchant of company A gets 404 for every one of company B's bookings, documents and PDFs.
- Internal notes absent from every merchant response — asserted on the raw JSON, not the UI.
- Downloads served as attachments with `Cache-Control: private, no-store`.
- Pagination and filters correct on a merchant with many bookings.

**Checklist**

- [ ] Booking history list with filters and pagination
- [ ] Booking detail with timeline, documents, payments, change requests
- [ ] Ticket / invoice / confirmation downloads
- [ ] Delivery notification + re-fetch
- [ ] Staff-only data proven absent from merchant responses
- [ ] `docs/API_CONTRACT.md` updated
- [ ] `tests/verify_m7.py` written and passing
- [ ] Regression suite green · Browser verified · Summary written

---

### M8 — Security, Performance & Production Hardening ⬜ **Not started**

**Scope**

- Rate limiting on every auth and OTP path; brute-force and enumeration resistance.
- Upload hardening: size caps, content-type vs. magic-byte agreement, path traversal,
  never-executable serving.
- Session and token handling: expiry, revocation, `force_logout_at`, no `scope`-claim tokens.
- Response headers, CORS, secret management, debug surfaces off.
- Query performance: N+1 elimination, index coverage for every list filter, pagination caps.
- Audit and activity logging complete for every state-changing action.

**Depends on:** everything before it — hardening a moving target is wasted work.

**Verification requirements**

- Authenticated-but-unauthorised access attempted for every endpoint added in M3–M7.
- Cross-tenant probe over the full endpoint list; every result is 404.
- Upload attack set: oversized, mislabelled, traversal-named, executable content.
- `EXPLAIN` on every list query added in this programme; no sequential scan on a large table.
- No secret in the repository, in a log line, or in an API response.

**Checklist**

- [ ] Rate limiting verified on auth/OTP
- [ ] Upload attack set repelled
- [ ] Session/token lifecycle verified
- [ ] Headers, CORS, secrets reviewed
- [ ] N+1s eliminated; indexes verified with `EXPLAIN`
- [ ] Audit coverage for every state change
- [ ] Full cross-tenant probe green
- [ ] `tests/verify_m8.py` written and passing
- [ ] Regression suite green · Summary written

---

### M9 — Final Regression Testing & Bug Fixes ⬜ **Not started**

**Scope**

- Run the entire suite (§4) against a freshly migrated database.
- Exercise every portal in the browser at 1280 / 768 / 375, on every screen touched by this
  programme.
- Fix everything found. Nothing is deferred out of M9 without being written down here.
- Known pre-existing issue to resolve or formally accept: the portal-wide horizontal overflow
  at 375px, which predates this programme.

**Depends on:** M3–M8.

**Verification requirements**

- Clean migration from empty → head, then the full suite green.
- Every previously approved phase re-verified, not assumed.
- Zero console errors on any screen.
- A written list of every bug found and its resolution.

**Checklist**

- [ ] Clean-database migration run
- [ ] Full verification suite green
- [ ] All portals browser-swept at three widths
- [ ] Bug list written, each item resolved or explicitly accepted
- [ ] 375px overflow resolved or accepted in writing
- [ ] Summary written

---

### M10 — Documentation & Production Readiness Review ⬜ **Not started**

**Scope**

- `docs/API_CONTRACT.md` reconciled against the live OpenAPI document, endpoint by endpoint.
- `docs/DATABASE_STRUCTURE.md` and `docs/SCHEMA_V2.md` brought in line with migrations
  `0030`–onwards.
- `README.md` quick-start verified by following it on a clean checkout.
- Deployment notes (`deploy/`), environment variables, and a runbook: how to migrate, how to
  roll back, what to watch.
- Dead code removed — this repository has a documented history of stale router files surviving
  a migration and misleading later readers.
- Final pass over the Production Readiness Checklist (§3), signed off item by item.

**Depends on:** M9.

**Verification requirements**

- Every documented endpoint exists; every existing endpoint is documented.
- Quick-start followed literally on a clean checkout and it works.
- Migration up **and** down exercised.
- No file in `backend/app/routers/` that nothing imports.

**Checklist**

- [ ] API contract reconciled with live OpenAPI
- [ ] Schema docs match migrations
- [ ] README quick-start followed on a clean checkout
- [ ] Deploy notes + runbook written
- [ ] Dead code removed
- [ ] §3 checklist signed off in full
- [ ] Summary written

---

## 3. Production Readiness Checklist

Applied to **every** milestone before it is submitted for approval. An item that does not apply
to a given milestone is marked N/A with a reason — it is not silently skipped.

### Security

- [ ] No new endpoint reachable without authentication
- [ ] No secret, token, password hash or full PII in any response, log line or PDF
- [ ] Uploads: size-capped, magic-byte checked, never statically mounted, served as attachments
- [ ] All user input validated by a Pydantic schema; no raw string interpolated into SQL
- [ ] Errors leak nothing about other tenants' data (404, not 403, on cross-tenant reads)
- [ ] Rate limiting intact on auth paths after any change to them

### RBAC

- [ ] Every endpoint declares a `P.*` code via `Depends(require(...))`
- [ ] New capability reuses an existing code, or the new code is justified in writing
- [ ] Permission matrix in `auth/rbac.py` updated if a role's abilities changed
- [ ] Tested from **each** role: super admin, admin, merchant admin, merchant user, and each
      merchant sub-role that the feature touches
- [ ] Deliberate denials still hold — a Super Admin still cannot raise tickets
- [ ] UI hides nothing the server allows, and offers nothing the server refuses

### Concurrency

- [ ] Every read-modify-write on a shared row uses `SELECT FOR UPDATE`
- [ ] Claim/assignment semantics stated: first-wins or last-wins, and which is intended
- [ ] Two-actor race tested for real, not reasoned about
- [ ] Sequences allocated only after the transition that needs them is validated (no burnt
      invoice numbers on a rejected attempt)
- [ ] Status changes go through `lifecycle.transition` exclusively

### Performance

- [ ] No N+1 — relationships the view renders are eager-loaded
- [ ] Every list filter is index-covered; verified with `EXPLAIN` on realistic data
- [ ] Pagination enforced server-side with a hard cap
- [ ] Counts computed in one grouped query, not one query per tab
- [ ] No unbounded query anywhere in the request path

### Accessibility

- [ ] Every interactive control is keyboard-reachable and has a visible focus state
- [ ] Form inputs have associated labels; icon-only buttons have `aria-label`
- [ ] Modals set `role="dialog"` / `aria-modal`, trap focus, and restore it on close
- [ ] Colour is never the only carrier of meaning (status chips carry text)
- [ ] Text contrast meets WCAG AA
- [ ] Live regions announce async results (toasts use `aria-live`)
- [ ] Layout holds at 1280 / 768 / 375 with no horizontal overflow

### Documentation

- [ ] `docs/API_CONTRACT.md` updated in the same milestone as the endpoint
- [ ] Migrations carry a docstring explaining *why*, not just what
- [ ] Non-obvious decisions commented at the point of the decision
- [ ] This file's checklist ticked and status line updated
- [ ] Schema docs updated when a table or column changed

### Regression testing

- [ ] Every previously approved phase and milestone re-verified (§4)
- [ ] The new milestone's own verification script committed under `tests/`
- [ ] Browser sweep of every portal the change could touch, console clean
- [ ] Frontend `?v=` cache-bust incremented for every changed asset
- [ ] Result reported honestly — failures stated with their output, skips stated as skips

---

## 4. Regression suite

Committed under `tests/`, so regression testing survives a session ending. Run against a live
backend (default `http://127.0.0.1:8000`) with the seeded dev accounts:

```bash
python tests/run_all.py
```

| File | Covers |
| --- | --- |
| `tests/config.py` | base URL + accounts (all env-overridable), fixtures, `login`/`H`/`Checker` |
| `tests/minihttp.py` | stdlib HTTP helper — the suite has no third-party dependency |
| `tests/pdftext.py` | PDF text extraction, so a generated PDF is asserted on by content |
| `tests/flows.py` | builds a booking at any requested stage, so suites are order-independent |
| `tests/run_all.py` | runs every script in order, prints a summary, non-zero on any failure |
| `tests/verify_api.py` | Phases 1–3 — enquiry, draft conversion, passenger identity, documents, submit rules |
| `tests/verify_m1.py` | M1 — queue, assignment, references, notes, staff-only boundary |
| `tests/verify_m1_concurrency.py` | M1 — 8 simultaneous assignments, 10 simultaneous notes |
| `tests/verify_m2.py` | M2 — ticket upload, invoice/confirmation PDFs, merchant delivery, reissue |
| `tests/verify_m3.py` | M3 — cancellation & reschedule, money bounds, cross-tenant, concurrency, bypass guards |
| `tests/verify_m4.py` | M4 — ledger arithmetic, wallet, credit limit, refunds, payment concurrency, and merchant/admin surface parity (the same eleven position fields, as decimal strings) |
| `tests/verify_cr2.py` | CR-2 — manager approval, payment bypass, ticket delivery, RBAC, concurrency |
| `tests/verify_m5.py` … | one per milestone, added as each lands |

Each milestone adds its own script and **all** prior scripts must still pass. See
`tests/README.md` for how to run them and how to write a new one.

**Last full run: 2026-07-31 — 613 checks, 10/10 scripts passed, 0 failures.**

Note: `POST /api/auth/login` is rate-limited to 10/minute *per IP*, which a full suite run
exceeds. `config.login` caches tokens per process and waits out a 429 rather than failing. The
limit is correct behaviour and is not to be weakened for the suite's convenience.

---

## 5. Change log for this document

| Date | Change |
| --- | --- |
| 2026-07-30 | Created. Phases 1–3, M1, M2 recorded as complete & approved. M3–M10 planned. |
| 2026-07-30 | M3 implemented and verified (128 checks); suite green at 317 checks. Awaiting approval. |
| 2026-07-31 | M3 approved. CR-1 (documents removed from the Classic merchant workflow, expanded Admin review) implemented, verified and approved. `tests/verify_api.py` rewritten where it asserted the old mandatory-document rule; suite green at 332 checks, 7/7. M4 started. |
| 2026-07-31 | **M4 audited, status corrected.** Was "Not started" with an unticked checklist; is in fact backend-complete (104 checks) with **no frontend at all** — `financePosition`/`financeStatement` and the admin per-merchant finance endpoints have zero callers, and `classic-payments.js` carries a docstring describing a ledger screen that was never built. Found 8 live float money computations, all frontend; the 20 backend `: float` money fields are all in unregistered dead routers and are out of scope. Revised plan covering only the remaining work recorded above. No code changed. |
| 2026-07-31 | **CR-2 approved and locked.** §0 gained "Changing approved functionality": everything in §1 is frozen, a bug is the only unilateral edit, and any wanted behaviour change is a change request needing approval *before* the behaviour moves. Final regression 594 checks, 10/10. |
| 2026-07-31 | CR-2 completion pass before approval: Super Admin can now create/edit/re-role Manager accounts from the UI, Manager notifications and profile added, modal focus trapping (`components/focus-trap.js`), Manager queue indexed (migration `0035`). Two accessibility defects found by measuring rather than asserting — missing `:focus-visible` on the Manager's tabs, and a `.badge.pending` contrast of 4.35:1 against AA's 4.5 (now 5.17:1). §3 checklist signed off for the first time. `tests/verify_cr2.py` 91 → 118 checks. |
| 2026-07-31 | CR-2 (Manager approval step, Classic Tours payment bypass) implemented and verified — `tests/verify_cr2.py`, 91 checks. Two pre-existing M4 defects fixed in passing (dropped refund-settlement figures; credit limit refusing reductions). `flows.py` split into enquiry-led and catalog-led builders; 20 call sites across `verify_m2/m3/m4` moved to the catalog builder, and `verify_api.py`'s "reaches the approval queue" assertion rewritten to the new contract. Awaiting approval. |
| 2026-07-31 | **M4's approved remaining work (A–E) built and verified.** The milestone was never a backend one: the merchant position + statement screen and the admin per-merchant position were wired to endpoints that had existed with **zero callers**, and ten client-side money calculations were deleted — including Operations' "Owed now", which summed one *capped* page and admitted in its own footnote that the true figure was higher. `shared/formatters.js` gained `moneyStr()`/`moneyIsPositive()`, which format the API's decimal **string** without parsing it; `money()` floated the value and dropped the paise (₹24,500.50 → ₹24,501) and is now used only for counts. `verify_m4.py` 104 → **125 checks**, asserting merchant and admin read an identical value for all eleven position fields. Suite **613 checks, 10/10**. The revised plan section retitled *approved and delivered*. M4 awaiting approval. |
