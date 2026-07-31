# Booking Operations — Implementation Roadmap

**Status: AUTHORITATIVE.** This is the project roadmap for the Booking Operations programme.
It is updated whenever a milestone is completed and verified, and it outranks any plan that
lives only in a chat session. If this file and a conversation disagree, this file wins.

Last updated: **2026-07-30** · Current milestone: **M3 — implemented and verified, awaiting approval**

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

---

## 2. Remaining milestones

Each milestone below carries **Scope**, **Depends on**, **Verification requirements** and a
**Checklist**. Tick boxes in place as work lands; the checklist is the progress record.

---

### M3 — Cancellation & Reschedule Workflow ✅ **Implemented & verified — awaiting approval**

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

### M4 — Finance, Billing & Payment Tracking ⬜ **Not started**

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

**Checklist**

- [ ] Single finance computation service, used by all surfaces
- [ ] Wallet + credit limit enforced server-side
- [ ] Refund path from M3 settles correctly
- [ ] Merchant statement/ledger screen
- [ ] Admin payments desk
- [ ] Invoice numbering verified gap-free
- [ ] `docs/API_CONTRACT.md` updated
- [ ] `tests/verify_m4.py` written and passing
- [ ] Regression suite green · Browser verified · Summary written

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
| `tests/verify_m4.py` … | one per milestone, added as each lands |

Each milestone adds its own script and **all** prior scripts must still pass. See
`tests/README.md` for how to run them and how to write a new one.

**Last full run: 2026-07-30 — 317 checks, 5/5 scripts passed, 0 failures.**

Note: `POST /api/auth/login` is rate-limited to 10/minute *per IP*, which a full suite run
exceeds. `config.login` caches tokens per process and waits out a 429 rather than failing. The
limit is correct behaviour and is not to be weakened for the suite's convenience.

---

## 5. Change log for this document

| Date | Change |
| --- | --- |
| 2026-07-30 | Created. Phases 1–3, M1, M2 recorded as complete & approved. M3–M10 planned. |
| 2026-07-30 | M3 implemented and verified (128 checks); suite green at 317 checks. Awaiting approval. |
