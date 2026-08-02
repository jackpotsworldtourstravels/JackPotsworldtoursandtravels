# API Contract — v2 (nine-table schema), Three-Portal B2B Platform

Status: **APPROVED — 2026-07-29.** This is the single source of truth the new landing page,
OTP login, and the Merchant / Admin / Super Admin portals are built against. Nothing in
`frontend/` should call an endpoint that isn't in this document.

Scope note: the backend already has a live, working surface for auth+OTP, merchant/company
management, and the whole ticket lifecycle (catalog → request → approval → payment → issuance
→ service requests). That surface is documented here **as-is** — treat it as final, do not
redesign it. The rest of this document specs the endpoints that don't exist yet, needed to
cover the menus in the implementation order (dashboards, reports/export, documents,
notifications, live chat, support desk, communication settings, audit logs, activity timeline).
Every one of them is built on tables and permission codes that already exist in the schema — no
migration is required to add them.

---

## 0. Conventions (already established by the live code — keep following them)

- **No version prefix.** Each router owns its own full path (`/api/auth`, `/api/admin/merchants`,
  bare `/api` for tickets). New routers below follow the same pattern — do not introduce `/api/v1`.
- **Auth header:** `Authorization: Bearer <access_token>` (JWT, `python-jose`). No `scope` claim
  on core tokens; a token carrying a `scope` claim (challenge/legacy) is rejected by
  `get_current_user`.
- **Pagination:** every list endpoint returns `Page[T]` (`app/schemas/pagination.py`):
  `{items: T[], total, page, page_size, total_pages}`, driven by `page` (≥1) and
  `page_size` (1–100, default 20) query params.
- **Authorization:** every protected endpoint declares one or more permission codes from
  `app/auth/rbac.py::P` via `Depends(require(P.X))`. Roles never get bespoke checks — if a new
  screen needs a check that doesn't map to an existing `P.*` code, add the code to that file
  first (§7 lists the two additions this contract needs).
- **Cross-tenant safety:** a merchant account only ever sees its own rows. Cross-merchant access
  returns `404`, never `403`, so a response can't confirm another company's record exists
  (`assert_same_merchant`). Every new merchant-scoped endpoint below follows this rule.
- **Errors:** standard FastAPI `HTTPException` shape, `{"detail": "..."}`. Validation errors are
  Pydantic's standard 422 shape. No custom envelope.
- **Money:** `Decimal`, 2dp, serialized as JSON numbers via Pydantic.
- **IDs:** all resource IDs are surrogate integers from the underlying table's PK (e.g. a
  "request id" is `service_requests.request_id`); the human-facing identifier is a separate
  string field (`request_number`, `merchant_code`, `pnr`, …).

---

## 1. Auth & OTP — EXISTING, final (`app/routers/auth.py`, prefix `/api/auth`)

Implements the approved **Login → Password → OTP → Dashboard** flow for all three portals via
one endpoint set, discriminated by a `portal` field rather than three separate login routes.

| Method | Path | Auth | Request | Response | Notes |
|---|---|---|---|---|---|
| POST | `/api/auth/login` | none, `10/min` | `LoginRequest{email, password, portal}` | `LoginChallengeResponse{otp_required, challenge_token, delivery, message, dev_otp?}` | `portal` ∈ `super_admin\|admin\|manager\|merchant`. Wrong-portal account → generic 401 (doesn't reveal the account exists on another portal). `manager` added by CR-2 — see §6.3c. |
| POST | `/api/auth/verify-otp` | none | `VerifyOtpRequest{challenge_token, code}` | `TokenResponse{access_token, refresh_token, token_type, user}` | 5-min TTL on the challenge, max 5 attempts. |
| POST | `/api/auth/resend-otp` | none | `ResendOtpRequest{challenge_token}` | `LoginChallengeResponse` | Max 5 requests/hour per account. |
| POST | `/api/auth/refresh` | none | `RefreshRequest{refresh_token}` | `TokenResponse` | |
| POST | `/api/auth/logout` | bearer | — | `MessageResponse` | Revokes via `force_logout_at`. |
| POST | `/api/auth/forgot-password` | none, `5/min` | `ForgotPasswordRequest{email}` | `MessageResponse` | Always generic — doesn't confirm the email exists. |
| POST | `/api/auth/reset-password` | none | `ResetPasswordRequest{token, new_password}` | `MessageResponse` | |
| POST | `/api/auth/change-password` | bearer | `ChangePasswordRequest{current_password, new_password}` | `MessageResponse` | |
| GET | `/api/auth/me` | bearer | — | `UserResponse` (includes `permissions[]`, `portal`, `merchant_role`) | Frontend derives which nav items to show from `permissions[]`, never from `role` string matching. |

OTP delivery: email via SMTP when configured; otherwise `dev_otp` is returned in the response
body and logged, so local dev/demo needs no SMTP account.

**Sign-off (2026-07-29):** Email OTP only for now, across all three portals. `otp_service.py`'s
delivery step must stay behind a small `send_otp(user, code, purpose)`-shaped seam (channel
picked from `communication_settings`/a `delivery_channel` argument, not hardcoded to email) so an
SMS provider (e.g. Twilio) can be plugged in later without changing `LoginChallengeResponse` or
the frontend's Login→Password→OTP→Dashboard flow. No provider dependency is added in this phase.

Full field-level shapes: [`app/schemas/auth.py`](../backend/app/schemas/auth.py).

---

## 2. Merchant Portal

| Screen | Status | Endpoint(s) |
|---|---|---|
| Dashboard | **NEW** (§6.1) | `GET /api/merchant/dashboard` |
| Ticket Enquiry | EXISTING | `GET /api/catalog/search`, `GET /api/catalog/{id}/quote` |
| Request Ticket | EXISTING | `POST /api/requests`, `PUT /api/requests/{id}`, `PUT /api/requests/{id}/passengers`, `POST /api/requests/{id}/submit`, `POST /api/requests/{id}/cancel`, `POST /api/requests/{id}/pay` |
| Request History | EXISTING | `GET /api/requests`, `GET /api/requests/{id}` |
| Service Requests | EXISTING | `POST /api/service-requests` (types: cancellation, refund, date_change, passenger_modification, extra_baggage, meal, seat); list via `GET /api/requests?request_type=...` |
| Reports | **NEW** (§6.2) | `GET /api/reports/summary`, `GET /api/reports/export` |
| Live Chat | **NEW** (§6.5) | `GET/POST /api/chat/threads`, `GET/POST /api/chat/threads/{id}/messages` |
| Profile | **NEW** (§6.6) | `GET/PUT /api/profile`, `POST /api/profile/photo` |

Also usable from any merchant screen: `GET /api/merchant/team/*` (existing, own-staff CRUD —
see `app/routers/merchant_team.py`), and the cross-cutting Notification Center / Documents
below.

## 3. Admin Portal

| Screen | Status | Endpoint(s) |
|---|---|---|
| Dashboard | **NEW** (§6.1) | `GET /api/admin/dashboard` |
| Merchant Management | EXISTING | `GET/POST /api/admin/merchants`, `GET/PUT /api/admin/merchants/{id}`, `POST /api/admin/merchants/{id}/approve`, `PATCH /api/admin/merchants/{id}/status`, `GET /api/admin/merchants/{id}/users`, `POST /api/admin/merchants/{id}/users/{user_id}/reset-password` |
| Active Users | **NEW**, thin (§4.1) | `GET /api/admin/users` |
| Approval Queue | **NEW**, unified (§4.2) | `GET /api/admin/approval-queue` |
| Payment Management | **NEW**, extends existing (§4.3) | `GET /api/admin/payments`, `POST /api/admin/payments/{id}/refund`, existing `GET /api/admin/payments/pending`, `POST /api/admin/payments/{id}/verify` |
| Payment History | EXISTING, reused (§4.3) | `GET /api/admin/payments?status=success\|failed\|refunded` |
| Reports | **NEW** (§6.2) | `GET /api/reports/summary`, `GET /api/reports/export` |
| Communication | **NEW** (§4.4) | `GET/PUT /api/admin/communication-settings/{merchant_id}`, `POST /api/admin/notifications/broadcast` |
| Support Management | **NEW** (§4.5) | `POST /api/support-tickets`, `GET /api/requests?request_type=support_ticket`, `POST /api/admin/support-tickets/{id}/assign`, `POST /api/admin/support-tickets/{id}/respond`, `POST /api/admin/support-tickets/{id}/close` |
| Profile | **NEW** (§6.6) | `GET/PUT /api/profile` |

Also: `GET /api/admin/activity` (**NEW**, thin — mirrors §5's existing Super Admin activity log;
same query params, same `SystemLog` rows, scoped by `P.SYSTEM_ACTIVITY_VIEW`, which Admin already
holds). Approve/reject/issue ticket actions are the existing `tickets.py` admin endpoints
(§ handled under Ticket lifecycle, unchanged).

### 4.1 Active Users

```
GET /api/admin/users
  ?status=active|suspended|pending_approval   (UserStatus, optional)
  &role=admin|merchant_admin|merchant_user      (UserRole, optional)
  &merchant_id=<int>                            (optional)
  &search=<string>                               (name/email)
  &page, &page_size
→ Page[AccountResponse]
Permission: reuse P.MERCHANT_USER_MANAGE (Admin already holds it). No new code needed.
```

A cross-merchant view over the same `users` rows `GET /api/admin/merchants/{id}/users` already
serves per-company — this is the "all companies at once, filtered by status" screen implied by
the Active Users nav item.

### 4.2 Approval Queue

**Sign-off (2026-07-29):** one unified endpoint, not two tab-switched calls.

```
GET /api/admin/approval-queue
  ?status=pending_approval|in_review|...        (RequestStatus ∪ MerchantStatus="pending_approval"; default = every "awaiting action" state)
  &merchant_id=<int>
  &date_from=<date>&date_to=<date>
  &request_type=<RequestType>                    (merchant-approval rows are request_type=null / a synthetic "merchant" marker — see shape below)
  &priority=low|normal|high|urgent
  &page, &page_size
→ Page[ApprovalQueueItemResponse]
  ApprovalQueueItemResponse = {
    id, kind: "merchant"|"request", status, priority,
    merchant_id, merchant_name, request_type?, title, submitted_at,
    total_amount?,   # null on a merchant row; 0 marks a booking that still needs a fare
    # discriminated union in one list so the frontend renders one sortable table;
    # "kind" tells it which detail route to open (/admin/merchants/{id} vs /requests/{id})
  }
Permission: P.MERCHANT_VIEW + P.TICKET_VIEW (require(..., require_all=False) — Admin already holds both)
```

**"Awaiting action" means awaiting *ours*.** The default (no `status`) covers `pending_approval`
and `in_review`, plus one deliberate addition: a booking at **Payment Pending with
`total_amount = 0`**. Payment Pending is normally the merchant's turn and is excluded — but an
unpriced one is nobody's turn, because `record_payment` refuses `amount <= 0`, so the merchant is
shown "Awaiting amount" and can do nothing. The only move belongs to an admin, via
`POST /api/admin/requests/{id}/reprice` (§6.3b). An explicit `status=payment_pending` still lists
every Payment Pending row, priced or not.

Internally this is a `UNION ALL` (or two queries merged in Python) over `merchants` filtered to
`pending_approval` and `service_requests` filtered to the awaiting-action statuses, sorted by
`submitted_at DESC` — implemented as one `approval_service.py`, not by changing the existing
`GET /api/admin/merchants` / `GET /api/requests` endpoints, which keep working standalone for
their own screens.

### 4.3 Payment Management / Payment History

```
GET /api/admin/payments
  ?status=pending|processing|success|failed|refunded|partially_refunded
  &merchant_id=<int>
  &date_from=<date>&date_to=<date>
  &search=<string>                     (transaction_id, request_number)
  &page, &page_size
→ Page[PaymentSummary]        (existing schema, app/schemas/ticket.py)
Permission: P.PAYMENT_VIEW (list), P.PAYMENT_MANAGE (refund)
```

```
POST /api/admin/payments/{payment_id}/refund
  Body: {amount: Decimal (>0, <= original amount), reason: str}
→ PaymentSummary
Permission: P.PAYMENT_MANAGE
```

Creates a `Payment(payment_type=refund)` row against the same request and updates
`refund_amount`/`refunded_at` on the original payment, mirroring how `verify_payment` already
updates state — implemented in `ticket_service.py` alongside the existing payment functions, not
a new service module.

"Payment History" is the same endpoint with a default filter of the terminal statuses
(`success`, `failed`, `refunded`) — not a separate backend surface.

### 4.4 Communication

```
GET  /api/admin/communication-settings/{merchant_id}  → CommunicationSettingsResponse
PUT  /api/admin/communication-settings/{merchant_id}  → CommunicationSettingsResponse
  Body: {email_enabled, sms_enabled, whatsapp_enabled, otp_enabled, notification_enabled, preferred_language}
Permission: P.NOTIFICATION_SEND
```

Thin CRUD over the existing `communication_settings` table (one row per merchant, already
modeled in `models_v2.py`).

```
POST /api/admin/notifications/broadcast
  Body: {merchant_ids: int[] | null (null = all active merchants), title: str, message: str, channel: "notification"|"email"}
→ {sent: int}
Permission: P.NOTIFICATION_SEND
```

Fans out one `MsgLog(message_type=notification|email, direction=outbound)` row per recipient
user. Delivery over the `channel` follows each merchant's `communication_settings` — a merchant
with `notification_enabled=false` is skipped, not force-sent.

### 4.5 Support Management

The support desk is a `ServiceRequest` row with `request_type=support_ticket` (already in the
`RequestType` enum) — it reuses the request lifecycle's list/detail endpoints rather than a
parallel table.

```
POST /api/support-tickets                         (merchant raises one)
  Body: {subject: str, description: str, priority: "low"|"normal"|"high"|"urgent", related_request_id?: int}
→ RequestDetailResponse
Permission: P.SERVICE_REQUEST_CREATE
```

```
GET /api/requests?request_type=support_ticket&status=...    (existing list, reused)
GET /api/requests/{id}                                       (existing detail, reused)
```

```
POST /api/admin/support-tickets/{id}/assign
  Body: {admin_user_id: int}
→ RequestDetailResponse
POST /api/admin/support-tickets/{id}/respond
  Body: {message: str}
→ RequestDetailResponse         (appends to status_history / creates a linked MsgLog)
POST /api/admin/support-tickets/{id}/close
  Body: {resolution_note?: str}
→ RequestDetailResponse
Permission: P.SUPPORT_MANAGE
```

## 5. Super Admin Portal

| Screen | Status | Endpoint(s) |
|---|---|---|
| Dashboard | **NEW** (§6.1) | `GET /api/super-admin/dashboard` |
| Admin Management | EXISTING | `GET/POST /api/super-admin/admins`, `GET/PUT /api/super-admin/admins/{id}`, `PATCH /api/super-admin/admins/{id}/status`, `POST /api/super-admin/admins/{id}/reset-password`, `DELETE /api/super-admin/admins/{id}` |
| Profile | **NEW** (§6.6) | `GET/PUT /api/profile` |

Already live and unchanged: `GET /api/super-admin/activity`, `GET /api/super-admin/activity/filters`
(system-wide activity log — see `app/routers/super_admin.py:157-206`). Per the spec, Super Admin
has **no** ticket/payment permissions; `P.TICKET_*` / `P.PAYMENT_*` are absent from
`_SUPER_ADMIN` in `rbac.py` and stay that way.

---

## 6. Cross-cutting modules

### 6.1 Dashboard KPIs

Three endpoints, one per portal, each a single aggregate query (new `dashboard_service.py`):

```
GET /api/merchant/dashboard   Permission: P.TICKET_VIEW (floor permission every merchant role holds)
→ {
    wallet_balance: Decimal, credit_limit: Decimal,
    requests_by_status: {draft:int, pending_approval:int, in_review:int, approved:int,
                          payment_pending:int, paid:int, ticket_issued:int, completed:int,
                          rejected:int, cancelled:int},
    pending_payments_count: int,
    unread_notifications_count: int,
    open_chat_threads_count: int,
    recent_requests: RequestResponse[]   (latest 5, include_passengers=false)
  }
```

```
GET /api/admin/dashboard      Permission: P.MERCHANT_VIEW
→ {
    merchants: {total:int, pending_approval:int, active:int, suspended:int},
    requests_by_status: {...same shape as above, platform-wide...},
    payments_pending_count: int, payments_verified_today: int,
    open_support_tickets: int, open_chat_threads: int,
    recent_activity: SystemLogEntry[]    (latest 5, same shape as GET /api/super-admin/activity items)
  }
```

```
GET /api/super-admin/dashboard   Permission: P.ADMIN_VIEW
→ {
    admins: {total:int, active:int, suspended:int},
    merchants_total: int,
    system_activity_today: int,
    recent_activity: SystemLogEntry[]   (latest 5)
  }
```

### 6.2 Reports + Export

One reporting surface shared by all three portals; scope is inferred from the caller
(`P.REPORT_VIEW`/`P.REPORT_EXPORT`, both already assigned to Super Admin/Admin/merchant roles in
`rbac.py`) — a merchant automatically gets its own data via the same `scoped_query` pattern
`ticket_service.list_requests` already uses, no separate merchant-vs-admin endpoint needed.

```
GET /api/reports/summary                                                    (M6)
  ?type=bookings|service_requests|payments
  &date_from=<date>&date_to=<date>&search=<str>&status=<RequestStatus>
  &merchant_id=<int>                    (Admin/Super Admin only — a merchant's own scope is
                                         never widened or redirected by this parameter)
→ {type, rows: int, truncated: bool, row_cap: int,
   total_value: Decimal|null, date_field: "travel_date"|"created_at"}
Permission: P.REPORT_VIEW
```

The header for a report screen: **how many rows the current filters match, and what they are
worth**. Built from the *same* row builders `/export` uses (`reports._rows_for`), so "showing
100 of 2,631" and the file the user downloads can never describe different sets — the classic
reporting bug, and the one M6's verification requirement names. `truncated` is true when the
`row_cap` bit; a screen that reports a capped figure without saying so is lying about the
download it is offering. `total_value` is `null` for `service_requests`, which carries no money
column — **not** `0`, which would read as "nothing was charged". `date_field` names the column
`date_from`/`date_to` filtered on, and it is **not the same column for every type**: bookings
and service requests filter on `travel_date`, payments on `created_at`.

*This replaces the `group_by`/`series` shape signed off in 2026-07-29 and never built.* The time
series it described is a better fit for `/api/analytics/bookings` (§6.9), which groups in SQL and
also carries the status mix and the busiest routes; splitting the two means neither endpoint has
to be both a row-counter and an aggregator. `type=revenue` is likewise gone from both routes: it
was never implemented, and `payments` answers the same question against the ledger.

```
GET /api/reports/export
  ?type=bookings|service_requests|payments
  &format=csv|xlsx|pdf
  &date_from=<date>&date_to=<date>&search=<str>&status=<RequestStatus>&merchant_id=<int>
→ 200, file stream (Content-Disposition: attachment)
Permission: P.REPORT_EXPORT
```

Each export also writes one `SystemLog(module='reports', action='export')` row (mirrors the
legacy `report_generation_log` table per `docs/SCHEMA_V2.md:98`).

### 6.2a Merchant paperwork downloads (M2, consumed in M7)

Three routes, built in M2 and given their first callers in M7. All require `ticket.view`, all
scope through `ticket_service.get_request` — so a cross-tenant read is **404, not 403** — and all
are served as `Content-Disposition: attachment` with `Cache-Control: private, no-store`. A
booking confirmation sitting in a shared proxy cache is a passenger manifest sitting in a shared
proxy cache.

```
GET /api/requests/{id}/invoice        → 200 application/pdf   (409 unless ticketed/completed)
GET /api/requests/{id}/confirmation   → 200 application/pdf   (409 unless ticketed/completed)
GET /api/requests/{id}/tickets        → 200 [DocumentResponse]  — metadata only
```

Both PDFs are **rendered on demand and never stored**, so a refund recorded a minute ago is
already in the invoice and there is no stale file to disagree with the ledger. The 409 is not a
gap: `issue_ticket` is what allocates the invoice number, so before then there is nothing to
number. The confirmation is explicitly **not an e-ticket** and says so on its face — the airline's
own file comes from `/tickets`, whose bytes are fetched from `/api/documents/{id}/download`,
which re-checks merchant scope per file.

**Merchant surfaces consuming these:** Classic → My Requests → a booking → *Paperwork*.
**Staff:** Operations → Payment History → *Invoice*.

**Sign-off (2026-07-29):** approved. Add `openpyxl` (xlsx) and `reportlab` (pdf) to
`requirements.txt`; CSV uses the standard library `csv` module. Structure the exporter as one
`export_service.py` with a `FORMATTERS: dict[str, Callable[[ReportRows], bytes]]` registry keyed
by format string, so a future format (e.g. `xml`, a different PDF layout) is one new function
plus one registry entry — the router/permission/query-param layer above it doesn't change.

### 6.3 Document Management

Documents (passport/visa/ID/company docs) are `ServiceRequest(request_type=document)` rows; the
file itself lives on disk under the existing `uploads/` directory, never served statically —
every download goes through an authorized, ownership-checked endpoint.

```
POST /api/documents          (multipart/form-data: file, document_type, request_id?)
→ DocumentResponse
Permission: P.DOCUMENT_UPLOAD
```

```
GET /api/documents
  ?document_type=passport|visa|id|company_doc
  &status=submitted|pending_approval|verified|rejected
  &merchant_id=<int>            (Admin/Super Admin only)
  &page, &page_size
→ Page[DocumentResponse]
Permission: P.DOCUMENT_UPLOAD (own) — Admin sees all via the standard scoped_query widening
```

```
GET /api/documents/{id}/download   → file stream, 404 if caller doesn't own it and isn't platform staff
POST /api/admin/documents/{id}/verify
  Body: {approve: bool, reason?: str}
→ DocumentResponse            (status → verified | rejected)
Permission: P.DOCUMENT_VERIFY
```

`DocumentResponse`: `{id, document_type, file_name, mime_type, size_bytes, status, uploaded_at, verified_at, verified_by}`.
Stored path convention: `uploads/<merchant_id>/<uuid4>_<original_filename>`; mime/size validated
server-side before write (existing `python-multipart` dependency covers the upload parsing).

### 6.3z Booking Enquiry quotation (CR-5)

The Admin's answer to a ticket enquiry stopped being an availability flag and became a **binding
quotation**. No new endpoint and no migration — one existing request body gained a field, and one
existing response gained two.

**Naming.** The merchant portal calls this a **Booking Enquiry**; every staff surface and the API
keep **ticket enquiry** / `request_type = ticket_enquiry`. The split is deliberate and the stored
value is unchanged.

```
POST /api/admin/enquiries/{id}/respond
  Body: {available: bool,
         total_fare: Decimal|null,      # CR-5 — required and > 0 when available
         reason: str|null,              # now required on BOTH answers (≤2000)
         response: str|null}            # optional covering note (≤2000)
→ EnquiryResponse                                          200
Permission: require(TICKET_APPROVE, TICKET_REJECT), then the code matching the payload
422 available:true with no total_fare, a total_fare ≤ 0, or no reason
422 available:false carrying a total_fare  (refused, never silently dropped)
409 the enquiry is already answered, or is claimed by another admin
```

`EnquiryResponse` gains:

| Field | Type | Notes |
| --- | --- | --- |
| `quoted_fare` | `Decimal` \| null | Crosses the wire as a **decimal string**. `null` on a pending enquiry, a declined one, and every enquiry answered before CR-5 — so consumers must handle its absence rather than assume `0` |
| `quotation_remarks` | str \| null | The breakdown the merchant reads beside the amount |

**The quotation is binding.** `POST /api/enquiries/{id}/booking-request` creates the booking at
`total_amount = quoted_fare` (was hard-coded `0`), with
`pricing = {currency, quoted: true, source: "ticket_enquiry", final_amount, priced_at: "enquiry_quotation"}`.

Two consequences follow **without any change to CR-4b's frozen code**:

- The credit limit (§6.3b) now bites with the real amount at **submission and approval**, because
  both `assert_credit_available` call sites already pass the amount when it is non-zero.
- `POST /api/admin/requests/{id}/issue-ticket` no longer requires `fare_amount` on a quoted
  booking, because `_capture_fare_for_wallet_billing` no-ops above zero. It is **still required**
  on a booking sitting at `0` — that is every enquiry-led booking raised before CR-5, and they
  finish the way they were made.

`travel_class` is unchanged: still free text, `1..80`. The merchant form narrowed to a four-option
dropdown (`Economy`, `Premium Economy`, `Business`, `First Class`), which is a strict subset of
what this endpoint accepts.

---

### 6.3a Cancellation & Reschedule (M3)

A confirmed booking moving backwards. These are `ServiceRequest` rows of
`request_type = cancellation | date_change`, linked to the booking by `parent_request_id` — no new
table and no migration.

**Why these are not `POST /api/service-requests`.** That generic hook stays, for baggage, meals,
seats, refunds and passenger corrections. Cancellation and date change settle money and change the
parent booking, which the generic hook does neither of, so the three generic paths now **refuse
these two types with 400** — `/api/admin/requests/{id}/approve`, `/api/admin/requests/{id}/reject`,
`/api/admin/service-requests/{id}/resolve`, plus `/api/requests/{id}/cancel`.
Same treatment ticket enquiries got.

**No amounts are sent when raising.** The cancellation charge and the fare difference come from the
airline and are quoted by staff at approval; a pending request carries `pricing = {}` and
`total_amount = 0.00`. Amounts cross the wire as **strings**, never JSON numbers.

```
POST /api/bookings/{booking_id}/cancellation
  Body: {reason: str}
→ ChangeRequestDetail                                      201
Permission: P.SERVICE_REQUEST_CREATE
409 unless the booking is approved | payment_pending | paid | ticket_issued | completed
409 if another change request is already open against it (names it)
409 if a cancellation has EVER been raised on it and was not refused — one per booking
```

A **completed** booking may be cancelled: what is being settled after travel is the money, not the
journey. A reschedule may not — see the `RESCHEDULABLE_PARENT_STATUSES` split in
`change_request_service`. The `COMPLETED -> CANCELLED` edge lives in
`lifecycle.SETTLEMENT_TRANSITIONS`, so it is reachable only through an approved cancellation and
never appears in `allowed_transitions`.

```
POST /api/bookings/{booking_id}/reschedule
  Body: {new_travel_date: date, new_return_date?: date, reason: str}
→ ChangeRequestDetail                                      201
Permission: P.SERVICE_REQUEST_CREATE
400 if the date is not in the future, equals the current one, or return < travel
The booking's own dates are NOT touched until approval.
```

```
GET  /api/change-requests
  ?type=cancellation|date_change &request_status=<RequestStatus>
  &merchant_id=<int> (staff) &search=<request no. | booking ref | PNR | title>
  &page &page_size
→ Page[ChangeRequestItem]      newest first; merchant sees only its own
GET  /api/change-requests/counts        → ChangeRequestCounts  (adds `open` = pending + in_review)
GET  /api/change-requests/{id}          → ChangeRequestDetail
GET  /api/bookings/{id}/change-requests → ChangeRequestItem[]  (every change ever raised on it)
Permission: P.TICKET_VIEW
```

**There is no withdraw.** It existed and was removed: it let whoever raised a request pull it out
from under an operator already working it, and left no record of who changed their mind. The
merchant's manager rejects it instead — §6.3b.

```
POST /api/admin/change-requests/{id}/review   → ChangeRequestDetail   (Pending → Under Review)
POST /api/admin/change-requests/{id}/approve
  Body (cancellation): {cancellation_charge?: str, note?: str}
  Body (reschedule):   {fare_difference?: str, change_fee?: str, note?: str}
→ ChangeRequestDetail
POST /api/admin/change-requests/{id}/reject
  Body: {reason: str}                                       reason mandatory
→ ChangeRequestDetail
Permission: P.SERVICE_REQUEST_MANAGE
```

Approval is row-locked on **both** the request and its booking, and the booking's status is
re-checked under that lock (409 if it closed while queued). The refund is derived server-side as
`booking_total - cancellation_charge` and never sent; a charge above the booking total is refused.
A reschedule's amounts must both be non-negative — a date change never produces a refund.

`ChangeRequestItem`: `{id, request_number, change_type, change_type_label, status, status_label,
manager_state, manager_approval, booking_id, booking_request_number, booking_reference, pnr,
merchant_id, merchant_name, reason, pricing, amount, new_travel_date, current_travel_date,
review_claimed_by, review_claimed_by_name, rejection_reason, created_at, updated_at}`.

`ChangeRequestDetail`: `{request, booking, timeline, can_review, can_settle, can_manager_decide}`.
`can_review` and `can_settle` are false until the merchant's manager has signed the request off.

### 6.3b Manager approval — the merchant's own sign-off

Every service request a merchant raises (`cancellation`, `date_change`, `refund`,
`passenger_modification`, `extra_baggage`, `meal`, `seat`) waits for a **manager of that merchant**
before our desk can see or settle it:

```
raised  ->  Under Manager Approval  ->  Manager Approved  ->  our desk
```

**No migration, no new enum members.** The stage is a JSONB block at
`service_requests.travel_details.manager_approval`, `{state, by, by_name, at, reason?}` with
`state` one of `pending | approved | rejected`. The lifecycle `status` stays `pending_approval`
throughout — the request *is* pending; the sub-state only says whose approval is outstanding.
`status_label` is derived, so every surface reads "Under Manager Approval" / "Manager Approved"
without the state machine, its filters or its dropdowns changing. See
`services/manager_approval.py`.

A request raised **by** a manager is stamped `approved` on the spot. A request with `state = null`
predates this stage and is treated as approved, so nothing already on the desk became stuck.

```
GET  /api/manager/service-requests
  ?outstanding=bool (default true) &page &page_size
→ Page[ManagerQueueItem]     newest first; the caller's own merchant, never widenable
GET  /api/manager/service-requests/counts        → ManagerQueueCounts {pending}
POST /api/manager/service-requests/{id}/approve  → ManagerQueueItem
POST /api/manager/service-requests/{id}/reject
  Body: {reason: str}                                       reason mandatory
→ ManagerQueueItem
Permission: P.SERVICE_REQUEST_APPROVE  (NEW code)
409 if a manager has already decided it (names them); 404 for another company's request
```

`P.SERVICE_REQUEST_APPROVE` is held by `MerchantRole.MANAGER` and by `merchant_admin`, and by **no
platform role** — an admin approving on the merchant's behalf would collapse the two approvals this
stage exists to keep apart. Approving moves no status; rejecting walks the request to `cancelled`
via the existing merchant-side edge and closes it without our desk ever seeing it.

Staff paths enforce this at the service layer, not only in the UI:
`/api/admin/change-requests/{id}/review|approve|reject` and
`/api/admin/service-requests/{id}/resolve` all return **409** for a request the merchant's manager
has not signed off.

`ManagerQueueItem`: `{id, request_number, request_type, request_type_label, status, status_label,
manager_state, manager_approval, booking_id, booking_request_number, booking_reference, pnr,
raised_by, reason, details, created_at, updated_at}`.

### 6.3b Finance, Billing & Payment Tracking (M4)

One computation, in `services/finance_service.py`, behind every money figure on every screen.
Nothing here does arithmetic of its own. **No new permission codes** — reading your own money
is not a new capability.

```
GET  /api/merchant/finance/position          → MerchantPosition
GET  /api/merchant/finance/statement          ?date_from&date_to   → Statement
Permission: P.PAYMENT_VIEW   (the caller's own merchant, resolved from the token)

GET  /api/admin/merchants/{merchant_id}/finance    → MerchantPosition
GET  /api/admin/merchants/{merchant_id}/statement  ?date_from&date_to  → Statement
Permission: P.PAYMENT_VIEW   (staff see any; a merchant reaching for another id gets 404)

POST /api/admin/merchants/{merchant_id}/wallet
     {amount, reason, txn_type?}               → WalletAdjustmentResult
Permission: P.PAYMENT_MANAGE  (staff only)

POST /api/admin/requests/{request_id}/issue-ticket
     {fare_amount?: Decimal > 0}               → RequestDetailResponse
Permission: P.TICKET_ISSUE

--- CR-4d — the staff wallet desk. Reads are P.PAYMENT_VERIFY, NOT P.PAYMENT_VIEW ---
GET    /api/admin/payment-accounts                     → [PaymentAccountAdminOut]
POST   /api/admin/payment-accounts                     → PaymentAccountAdminOut (201)
PUT    /api/admin/payment-accounts/{id}                → PaymentAccountAdminOut
DELETE /api/admin/payment-accounts/{id}                → PaymentAccountAdminOut (deactivates)
POST   /api/admin/payment-accounts/{id}/qr   multipart → PaymentAccountAdminOut
GET    /api/admin/payment-accounts/{id}/qr             → image stream
Permission: P.PAYMENT_MANAGE to write, P.PAYMENT_VERIFY to read

GET    /api/admin/wallet/topups/counts   ?initiated              → TopupQueueCounts
GET    /api/admin/wallet/topups   ?bucket&merchant_id&search&initiated&page → TopupQueuePage
GET    /api/admin/wallet/topups/{id}                   → TopupDetail
GET    /api/admin/wallet/topups/{id}/proof             → attachment, private no-store
POST   /api/admin/wallet/topups/{id}/verify            → TopupDecisionResult  (CREDITS)
POST   /api/admin/wallet/topups/{id}/reject  {remarks} → TopupDecisionResult  (moves nothing)
GET    /api/admin/merchants/{id}/wallet/transactions   → MerchantLedgerPage
GET    /api/admin/wallet/reconciliation                → ReconciliationReport
Permission: P.PAYMENT_VERIFY
```

### Payment requests the desk raises (migration 0041)

```
GET  /api/admin/merchants/{id}/managers                    → [MerchantManagerOut]
POST /api/admin/wallet/payment-requests                    → TopupQueueRow (201)
     {merchant_id, manager_id, amount, method, instructions, note?}
POST /api/admin/wallet/payment-requests/{id}/cancel {remarks} → TopupQueueRow
Permission: P.PAYMENT_MANAGE

GET  /api/merchant/payment-requests/counts                 → {requests, pending, approved, rejected}
GET  /api/merchant/payment-requests  ?bucket&page&page_size → TopupPage
Permission: P.PAYMENT_VIEW
POST /api/merchant/payment-requests/{id}/settle multipart {utr?, proof} → TopupOut
Permission: P.PAYMENT_PAY

POST /api/admin/requests/{request_id}/reprice
     {amount: Decimal > 0, reason: str}        → RequestDetailResponse
Permission: P.TICKET_APPROVE   (no new code — this is the approver's own figure)
```

**CR-4d — the permission boundary, and why it is not `payment.view`.** Every merchant role holds
`payment.view`; it is what lets a merchant read *its own* wallet under `/api/merchant/wallet`,
where safety comes from no route carrying a merchant id. Every `/api/admin/...` wallet route is
platform-wide or takes another company's id, so all of them — **including the read-only ones** —
require `payment.verify` or `payment.manage`, which only the Admin role holds. Gating them on
`payment.view` let any merchant read every other merchant's ledger; `tests/verify_cr4d.py` asserts
the boundary from a real merchant token.

**`/wallet/topups/{id}/verify` is the only path that credits a wallet from a top-up.** It writes
exactly one `wallet_recharge` transaction linked by `topup_id`, guarded by
`uq_wallet_transactions_topup` (migration 0037) *and* a row lock, and returns the `WTX-…`
reference with the balance either side. A second verification returns **409**, never a duplicate
credit and never a 500. Rejection moves nothing, requires remarks, and frees the UTR for a
corrected resubmission.

**`/wallet/reconciliation`** reports `drift` = cached balance − ledger balance per merchant. It
must be zero everywhere; a non-zero row is an incident. `pending_topup_amount` sits beside the
balances and is never part of them.

**0041 — admin-initiated payment requests reuse that one credit path.** The desk raises a request
against a merchant, names the *merchant's own* manager (`merchant_role = manager`, not
`UserRole.MANAGER`, which is platform staff) and states how to pay: bank transfer (bank name,
account number, IFSC, branch), cash (token details, unique note number) or crypto (wallet address,
network ∈ {TRC20, ERC20, BEP20}). The row is a `wallet_topups` row in the new
`awaiting_payment` status.

That status is the guarantee. `_assert_undecided` admits `submitted` only, so
`/wallet/topups/{id}/verify` returns **409** for a request nobody has paid — there is no sequence
of admin calls that credits a wallet without a manager having settled it, and it is the status
machine that enforces this rather than a hidden button. Approval and rejection are the **same two
endpoints above, unchanged**: one credit path, one unique index, one lock.

`settle` moves the request to `submitted` and **credits nothing**, exactly like
`POST /merchant/wallet/topups`. A bank transfer needs its UTR *and* the slip; cash and crypto have
no UTR and a UTR sent with either is refused, because `uq_wallet_topups_utr` is a bank-reference
namespace. Resubmitting a rejected request is that same call: the stale verdict is cleared and
`resubmission_count` records it.

`initiated` (`admin` | `merchant`, omitted = both) filters the queue and its counts. It exists
because two screens share the endpoint, and a badge counting rows the table does not show is
worse than no badge — it also keeps `total` consistent with the rows, which a client-side filter
could not.

**The wallet (CR-4, `docs/WALLET_ARCHITECTURE.md` is authoritative).** A merchant holds a running
account that **may go negative** — a negative balance is its outstanding position, bounded by
`merchants.credit_limit` rather than by a floor at zero. Every movement is one
`wallet_transactions` row written by `wallet_service.post` under a row lock, and every response
that names a movement quotes its **`WTX-…` reference, never an internal id**.

- `txn_type` on the wallet endpoint (CR-4b) is optional: `manual_adjustment`, `credit_note`,
  `refund_credit` or `cancellation_charge`. Omitted, a credit defaults to `wallet_recharge` and a
  debit to `manual_adjustment`, exactly as before. `booking_debit` is **refused (422)** — only
  ticket issuance writes that type, and posting it by hand would route around the one-debit-per-
  booking unique index.
- `WalletAdjustmentResult` carries `transaction_reference`.

**`/issue-ticket` — `fare_amount` (CR-4b).** What the desk paid the airline. **Required** on a
wallet-billed (enquiry-led) booking that still carries no amount: those are created at
`total_amount = 0` and no earlier step on that track ever sets a fare, so without it the wallet
would be debited nothing. It becomes the booking's `total_amount` and is the amount debited.
Omitted or ≤ 0 on such a booking → **400**, raised *before* the transition so no ticket or invoice
number is burned. **Ignored** where an amount already exists, so every catalog-led booking behaves
exactly as it did. Issuance also writes a wallet settlement `payments` row, so the booking reads as
settled and the debt is not counted twice.

**Issuance is serialised.** The booking row is locked (`SELECT … FOR UPDATE`) for the whole
operation, so simultaneous issues of one booking resolve to **one 200 and the rest 400**
("already Ticket Issued") — never two successes, never a 500. Before the lock, six concurrent
issues returned two 200s and three 500s: the debit stayed correct (one row, enforced by
`uq_wallet_transactions_booking_debit`) but the `IntegrityError` reached callers raw and two desks
were told they had issued the same ticket. Clients should treat a 400 here as "someone else got
there first" and re-read the booking.

**Credit limit (CR-4b) is a hard block**, enforced at `POST /api/requests/{id}/submit` and at
`POST /api/manager/bookings/{id}/approve`. It is deliberately **not** applied at issuance: a ticket
already bought must be recorded.

The 400 `detail` is built by `wallet_service.credit_refusal_message` — one text shared by both
gates, so the same refusal does not read two different ways depending on which one caught it. It
names all five figures the business asked for: **wallet balance, outstanding, credit limit,
available credit**, and — where the amount is known — **the amount required and the shortfall**. On
the enquiry-led track at submission the fare is genuinely unknown, so that last pair is omitted
rather than guessed. Because there is no per-booking override, this message is the merchant's whole
remedy, which is why it carries the numbers rather than only a refusal.

### The merchant's own wallet (CR-4c)

```
GET  /api/merchant/wallet                                  → WalletSummary
GET  /api/merchant/wallet/transactions ?date_from&date_to&page&page_size
                                                           → WalletTransactionPage
GET  /api/merchant/wallet/payment-accounts                 → [PaymentAccountOut]
GET  /api/merchant/wallet/payment-accounts/{id}/qr         → image stream
GET  /api/merchant/wallet/topups       ?status&page&page_size → TopupPage
POST /api/merchant/wallet/topups       (multipart)         → TopupOut          201
GET  /api/merchant/wallet/topups/{id}/proof                → file stream
Permission: payment.view on every read; payment.pay to submit a top-up. No new codes.
```

**Every route is implicitly scoped to the caller's own merchant — no path carries a
`merchant_id`,** so there is no id to tamper with. The two that take an id (a top-up, its proof)
re-check ownership and return **404, not 403**. A platform staff account has no merchant of its own
and gets a **400** pointing at `/api/admin/merchants/{id}/finance`.

**`POST /topups` records a claim and credits nothing.** This is the rule the whole flow rests on:
the wallet moves only when an admin verifies the claim (CR-4d), which is what stops a merchant
raising its own spending power by typing a number into a form. Multipart fields:

| Field | Rule |
| --- | --- |
| `amount` | Decimal > 0. Required. |
| `method` | `bank_transfer` \| `upi` \| `qr`. `cash`/`other` are **refused** — a merchant cannot claim an instrument nobody can check. |
| `payment_account_id` | Optional; must be an **active** account, else 404. |
| `utr` | **Required for `bank_transfer`.** Otherwise required *unless* a proof file is attached. |
| `proof` | Optional file. Same allowlist, magic-byte sniff and 10 MB streaming cap as a passport scan — literally the same `document_service.store_upload`. 415 / 400 / 413. |

**A UTR may be claimed once.** `uq_wallet_topups_utr` is platform-wide and excludes rejected
claims; a repeat returns **400** naming the reference, not a 500. The message never says *who* holds
the existing claim — the index spans every merchant, and confirming it would let anyone probe for
other companies' bank references.

**`WalletSummary` reports `pending_topups` separately and never inside `balance`.** `balance` may
be **negative** (that is the outstanding position) and is `SUM(credit) - SUM(debit)` over the
ledger; a submitted claim is not in it. Adding the two together on a client is the bug this shape
exists to prevent. `credit_available` is `null` when no limit is configured — not zero.

Transactions come back **oldest first, ordered by `txn_id`**, each carrying the `balance_after` the
server stored when the balance moved; clients render it and never accumulate their own (see
`WALLET_ARCHITECTURE.md` §6). Proofs are served as **attachments** with `Cache-Control: no-store`;
QR images stream inline from an authenticated route and are **never** public URLs.

**`/reprice` — correcting what a booking owes.** The only way to change `total_amount` after
approval *on the standard track*. Rules, all server-side:

- **Payment Pending only.** Before it, approval carries the amount; after it money has moved and
  a change is a refund or an extra charge — the change-request and refund paths, which quote and
  settle, not a silent overwrite of the figure the invoice was raised on. Any other status → 400
  naming the current one.
- **The status is untouched**, so it does not call `lifecycle.transition` — there is no movement
  to record. The trail is `pricing.history[]` (`{from, to, reason, by, by_name, at}`), the
  activity log, and a notification telling the merchant the new amount and why.
- **Row-locked**, with the scope filter inside the locked `SELECT … FOR UPDATE`, so two admins
  cannot both price against a total the other is replacing.
- **Credit is checked on the delta** (`new − previous`), not the new total: whatever has been
  paid cancels out, and a reduction can never breach a limit.
- `reason` is mandatory (the merchant reads it), `amount` must be `> 0`, and re-sending the
  amount it already has returns 400. Enquiries and change requests are refused by type, like
  approve and reject.

`MerchantPosition`: `{merchant_id, merchant_name, currency, bookings_billable, billed, paid,
refunded, net_paid, awaiting_verification, outstanding, overpaid, wallet_balance, credit_limit,
credit_used, credit_available, has_credit_limit, spending_power}`.

`Statement`: `{merchant_id, merchant_name, currency, date_from, date_to, opening_balance,
closing_balance, total_debits, total_credits, entries[], position}` where an entry is
`{at, kind, reference, request_id, description, debit, credit, balance, wallet_movement,
unverified}` and `kind` ∈ `charge | payment | refund | payment_pending | wallet_topup |
wallet_adjustment`.

**Rules this milestone made binding, all enforced server-side:**

- **Money is `Decimal` everywhere.** No `float` appears in the money path, in any service,
  schema or response. Amounts serialise as decimal strings.
- **`credit_limit = 0` means *no limit configured*, not a limit of zero.** Every merchant
  carries the column default, so a literal reading would refuse every booking on the platform.
  `credit_available` is `null` while unconfigured. Decided 2026-07-31; see the M4 entry in
  `BOOKING_OPS_MILESTONES.md`.
- **The credit limit is checked at admin approval**, against `final_amount`, because an
  enquiry-led booking carries ₹0 until the desk prices it. A refusal leaves the booking
  completely untouched rather than half-priced.
- **A booking cannot be approved at 0.** Approval ends at Payment Pending, where
  `record_payment` refuses `amount <= 0` — so approving without a fare produced a booking the
  merchant was asked to pay and could not, and which no admin could re-price either, since
  Payment Pending has no edge back to Approved. `final_amount` stays optional on the wire
  (a catalog-led booking carries its own quote); what is enforced is that the **resulting
  total is positive**. See §6.3b for correcting one after the fact.
- **A partial payment no longer marks a booking Paid.** It moves to Paid only when the ledger
  says nothing is left. Previously *any* verified payment settled it.
- **A merchant cannot pay more than is owed**, counting payments already awaiting verification.
- **A `wallet` payment moves the wallet** at submission, and a refused verification returns it.
- **`verify_payment` and `refund_payment` are row-locked** (`SELECT … FOR UPDATE`).
- **A wallet never moves without a `payments` row** explaining why.
- **M3's cancellation refund settles here**, oldest payment first, clamped to what those
  payments actually took; any shortfall is recorded as `refund_unsettled` rather than hidden.

### 6.3c Manager Approval & the Classic Tours payment bypass (CR-2)

A **Manager** sign-off sits between the merchant's submitted Booking Request and the Admin
Booking Operations queue, and the payment workflow is bypassed entirely for enquiry-led
(Classic Tours) bookings. Approved 2026-07-31.

**The Manager is a platform role of its own** (`UserRole.MANAGER`, migrations `0033`/`0034`),
not an Admin with an extra code. The Admin who answers a Ticket Enquiry must not also be able
to sign off the booking that came out of it, and a separate role is what makes that
enforceable. It signs into its own portal (`portal=manager`, `frontend/manager/`).

**Two new permission codes**, held by the Manager role alone:

| Code | Grants |
|---|---|
| `booking.manager_approve` | read the manager queue, claim a booking, approve it |
| `booking.manager_return` | return a booking to the merchant with remarks |

The Manager deliberately holds **no** `ticket.view` — that code opens the Admin's booking
screens, the operations queue and the internal-notes API. Its own endpoints scope by
`is_platform_staff` instead.

```
GET  /api/manager/bookings
     ?bucket=awaiting|approved|returned|ticketed   (server-side tabs)
     &status=<RequestStatus>  &merchant_id  &search  &page  &page_size
   → Page[ManagerBookingSummary]
   Waiting requests sort OLDEST FIRST (a work queue); decided ones newest first.
   `bucket` and `status` compose; a contradictory pair is a 400, not an empty page.

GET  /api/manager/bookings/counts        → ManagerQueueCounts
   One count per status plus one roll-up per tab, from one grouped query.

GET  /api/manager/bookings/{id}          → ManagerBookingDetail
   {request, timeline, actions, reviewer_id, reviewer_name, can_decide}
   The whole submitted booking, read-only. No payments, no internal notes.

POST /api/manager/bookings/{id}/start-review   → ManagerBookingDetail
   Claim, under SELECT FOR UPDATE. Re-claiming your own is a no-op; another
   manager's claim is a 409.

POST /api/manager/bookings/{id}/approve  {note?}      → ManagerBookingDetail
POST /api/manager/bookings/{id}/return   {remarks}    → ManagerBookingDetail
Permission: the two codes above. Every one of these is 403 for an Admin, a
Super Admin and a merchant, and 400 for anything that is not a Classic Tours
booking (an enquiry, a change request, a catalog-led booking).
```

#### §6.3d — Merchant approval desk (CR-3)

**CR-3 moved this sign-off to the merchant that raised the booking.** The endpoints above still
work and the platform Manager role still exists, but in practice its queue stays empty: a merchant
approves before the platform ever sees the booking. Same statuses, same lifecycle edges, **no
migration** — only who may walk the approval edge changed.

**Two more permission codes**, held by `MerchantRole.MANAGER` and by `merchant_admin`:

| Code | Grants |
|---|---|
| `booking.merchant_approve` | read this merchant's approval queue, claim, approve |
| `booking.merchant_return` | return a booking to the raiser with remarks |

Deliberately **not** the `booking.manager_*` codes: those are gated on `is_platform_staff`, and a
merchant must not be able to address the platform queue at all rather than be refused by it late.
`merchant_admin` holds them as well as the manager sub-role because every merchant has a Merchant
Admin by construction, and one manager's absence must not stop a merchant submitting work.

```
GET  /api/merchant/approvals
     ?bucket=awaiting|approved|returned|ticketed  &status  &search  &page  &page_size
   → Page[ManagerBookingSummary]
   NO merchant_id parameter: scope comes from the token and cannot be widened.

GET  /api/merchant/approvals/counts       → ManagerQueueCounts
GET  /api/merchant/approvals/{id}         → ManagerBookingDetail
POST /api/merchant/approvals/{id}/start-review        → ManagerBookingDetail
POST /api/merchant/approvals/{id}/approve  {note?}    → ManagerBookingDetail
POST /api/merchant/approvals/{id}/return   {remarks}  → ManagerBookingDetail
```

Two refusals specific to this surface:

* **Another merchant's booking is a 404, not a 403** — confirming it exists would leak request
  numbers to anyone willing to enumerate them.
* **The raiser cannot decide their own booking → 403.** The manager sub-role holds
  `ticket.request`, so without this the same person could raise and sign off the same booking.
  `ManagerBookingDetail.can_decide` is false in that case, so the UI never offers the buttons.

**Two tracks in one state machine** (`services/lifecycle.py`). `is_classic_track(request)` is
true for a booking raised from an answered enquiry — and **false once a booking has entered
Payment Pending or Paid**, so bookings already in the payment workflow when this shipped finish
the way they started rather than becoming unmovable.

```
Classic Tours:  Created → Pending Manager Approval → Under Manager Review
                        → Manager Approved → Ticket Issued → Completed
                Pending / Under Review → Created  ("returned for correction", remarks required)
```

- **Payment Pending and Paid have no inbound edge on this track.** That is the bypass: not a
  hidden button, an unreachable state. `record_payment` refuses these bookings by name.
- **Reject means returned, not Rejected.** Rejected is terminal; the change request says the
  merchant corrects and resubmits. The booking goes back to **Created** — editable, with its
  passengers, enquiry link and history intact — carrying `travel_details.manager_remarks`,
  which is cleared on resubmission.
- **`RequestResponse.workflow`** (`classic_tours` | `standard`) is on every request response, and
  `status_label` is track-aware. Frontends branch on those rather than re-deriving the rule.

**Closed bypass paths.** `ticket_service._reject_enquiry_here` now refuses Classic Tours
bookings **by track**, which covers `/api/admin/requests/{id}/approve`, `.../reject` and
`.../reprice`; `approval_service` drops them from the Admin Approval Queue.

**Ticket delivery.** `document_service.staff_upload_stages` widens the staff upload window to
**Manager Approved → Ticket Issued → Completed** on this track (there is no Paid stage to wait
for). `issue_ticket` refuses to mark a Classic Tours booking issued with **no ticket document
attached** — on this track that status is what tells the merchant its paperwork is ready, and
there is no later stage at which the file could arrive. Merchants read them from
`GET /api/requests/{id}/tickets` and fetch bytes from `/api/documents/{id}/download`.

**Staff accounts.** `POST /api/super-admin/admins` takes `role: admin|manager` (default
`admin`), and `GET /api/super-admin/admins` lists both, narrowable with `?role=`. Every other
staff-account endpoint (edit, suspend, reset password, delete) already covers Managers via
`account_service.get_admin`.

`PUT /api/super-admin/admins/{id}` takes an **optional** `role`. Omitted, the role is left
alone — an edit that only changes a phone number cannot reclassify anybody by omission. Supplied,
it moves the account between Admin and Manager and:

- **409 while that Manager still holds a booking under review.** Only the claim-holder may decide
  a booking; converting the holder would leave the claim standing with nobody able to act on it.
  The refusal names the booking requests to decide first. It is refused rather than silently
  released — releasing would rewrite booking status as a side effect of an account edit.
- **revokes the account's sessions**, because its permission set changes underneath it, and
  notifies the holder.
- refuses a self-role-change, and refuses any role outside `admin|manager`.

**Performance.** Migration `0035` adds `ix_sr_classic_queue`, a partial index on
`service_requests (created_at, status)` whose predicate is character-for-character what
`manager_service._classic_bookings_filter` emits — a partial index is only used when the planner
can *prove* the query implies its predicate. It serves both the queue list and the counts.

### 6.4 Notification Center

Backed by the existing `msg_logs` table, `message_type=notification`.

```
GET /api/notifications
  ?unread_only=bool
  &page, &page_size
→ Page[NotificationResponse]   {id, title(subject), message, is_read, created_at}
Permission: P.NOTIFICATION_VIEW
```

```
GET /api/notifications/unread-count       → {count: int}
PATCH /api/notifications/{id}/read        → NotificationResponse
POST /api/notifications/read-all          → {updated: int}
Permission: P.NOTIFICATION_VIEW
```

Broadcasts (Admin → merchants) are covered under §4.4 — `POST /api/admin/notifications/broadcast`
writes the same `msg_logs` rows this section reads.

### 6.5 Live Chat

A chat thread is a `ServiceRequest(request_type=live_chat)` row; each message in it is a
`MsgLog(message_type=live_chat)` row with `request_id` set to the thread.

```
GET  /api/chat/threads                    → Page[ChatThreadResponse]  {id, subject, status, last_message_at, unread_count}
POST /api/chat/threads
  Body: {subject: str, message: str}
→ ChatThreadResponse
Permission: P.CHAT_CREATE (merchant), P.CHAT_VIEW (Admin/Super Admin — read/manage only, cannot open new threads on a merchant's behalf)
```

```
GET  /api/chat/threads/{id}/messages
  ?after_id=<int>                          (cheap polling — return only newer messages)
  &page, &page_size
→ Page[ChatMessageResponse]   {id, sender_name, sender_role, message, created_at}
POST /api/chat/threads/{id}/messages
  Body: {message: str}
→ ChatMessageResponse
PATCH /api/chat/threads/{id}/close
Permission: P.CHAT_VIEW to read, P.CHAT_CREATE (merchant, own thread) or P.CHAT_MANAGE (Admin) to post/close
```

**Sign-off (2026-07-29):** Phase 1 (this contract) ships short-polling — frontend polls
`GET /api/chat/threads/{id}/messages?after_id=...` every **15–30s** while a thread is open, plus
a lighter poll on `GET /api/chat/threads` for unread badges elsewhere in the UI. Keep the request
schema WebSocket-ready: `ChatMessageResponse` is exactly what a future `ws://.../chat/{id}` push
would emit per message, and `POST .../messages` is exactly what it would accept — migrating later
means adding a connection/broadcast layer in front of the same read/write functions, not
reshaping the message contract or touching the frontend's message-list rendering.

### 6.6 Profile (shared by all three portals)

```
GET /api/profile         → UserResponse                    (identical shape to GET /api/auth/me — same underlying row)
PUT /api/profile
  Body: {full_name?, phone?, gender?, dob?, country?, state?, city?, address?}
→ UserResponse
POST /api/profile/photo   (multipart/form-data: file)
→ {profile_photo: str}
Permission: P.PROFILE_MANAGE (all three portal roles hold it)
```

`email` is intentionally not editable here — changing the sign-in identity is a separate,
higher-friction flow (not in scope for this milestone).

### 6.7 Audit Logs

Read-only, trigger-written (`fn_write_audit_log` on `users`/`merchants`/`service_requests`/`payments`).

```
GET /api/audit-logs
  ?table_name=users|merchants|service_requests|payments
  &record_id=<int>
  &changed_by=<int>
  &date_from=<datetime>&date_to=<datetime>
  &page, &page_size
→ Page[AuditLogResponse]   {id, table_name, record_id, operation, old_value, new_value, changed_by, changed_by_name, changed_at}
Permission: P.AUDIT_VIEW   (Admin and Super Admin only — matches rbac.py; no merchant role holds it)
```

### 6.8 Activity Timeline

Two layers, both already partially built — no new concept, just filling the one gap:

- **Per-request timeline** (what happened to *this* booking/service request): already returned
  inline as `RequestDetailResponse.timeline` (`app/services/lifecycle.py::timeline`) — nothing
  to add.
- **Portal-wide activity feed** (what happened across the system): `GET /api/super-admin/activity`
  already exists; `GET /api/admin/activity` is the one-line gap noted in §3 — same
  `activity_service.list_activity_logs_paginated`, scoped by `P.SYSTEM_ACTIVITY_VIEW`, which Admin
  already holds. No merchant-portal equivalent — a merchant never sees the platform-wide log,
  only its own requests' timelines.

### 6.9 Analytics (M6)

`app/routers/analytics.py` over `app/services/analytics_service.py`. **Every figure is a SQL
aggregate.** Nothing is counted in Python over a fetched page and nothing is left for a browser
to add up — M6's stated requirement is that each tile be reproducible by a direct query, and
`tests/verify_m6.py` re-derives them from hand-written SQL rather than by calling the service.

Separate from §6.2, which exports *rows*. These endpoints only ever return aggregates.

**Permission codes are reused, not invented.** `report.view` gates the two caller-scoped
endpoints; the service scopes them through `ticket_service.scoped_query`, the same predicate the
list endpoints use. The operations endpoint is gated on `ticket.approve` — Admin-only, and
already meaning "may work a booking" — plus an `is_platform_staff` check in the service. CR-4d
shipped a staff read on `payment.view`, a code every merchant role holds, and any merchant could
read every other merchant's position; **a code a merchant holds may only ever gate a
merchant-scoped read.**

```
GET /api/analytics/bookings
  ?date_field=travel_date|created_at        (default travel_date)
  &date_from=<date>&date_to=<date>&merchant_id=<int>   (merchant_id: platform staff only)
→ {scope: "merchant"|"platform", date_field, date_from, date_to, merchant_id,
   totals: {bookings: int, value: Decimal, average_value: Decimal},
   by_status: [{status, label, count, value}],
   by_month:  [{month: "YYYY-MM"|"unscheduled", count, value}],
   top_routes:[{route, count, value}]        (max 10, busiest first)}
Permission: P.REPORT_VIEW
```

`date_field` chooses the column the range filter **and** the monthly series run on, and the
response echoes it back. Two invariants hold and are asserted: `by_status` and `by_month` each
**partition** the same population as `totals`, so either column adds back up to the headline;
and a row with no date in the chosen column lands in an explicit `unscheduled` bucket rather
than being dropped, because a series that silently omits rows stops summing to its own total.

```
GET /api/analytics/change-requests
  ?date_from=<date>&date_to=<date>&merchant_id=<int>
→ {scope, date_field: "created_at", date_from, date_to,
   totals: {requests, approved, rejected, pending},
   by_type: [{type, label, total, approved, rejected, pending}],
   money: {basis, cancellation_charges, refunds_due, refunds_settled,
           refunds_outstanding, refunds_short_settled, fare_differences}}
Permission: P.REPORT_VIEW
```

The money block covers **approved requests only** — a rejected cancellation charged nothing and
refunded nothing. `refunds_outstanding` is `refunds_due − refunds_settled`: everything still
owed. It is **not** the sum of M3's `pricing.refund_unsettled`, which is written only when a
settlement actually ran and fell short, so a cancellation approved and never settled carries
neither key and would vanish from the debt. That shortfall is reported separately as
`refunds_short_settled` — a *subset* of `refunds_outstanding`, never a second figure to add.

```
GET /api/analytics/operations
→ {queue: {approved, payment_pending, paid, ticket_issued, total, unassigned},
   waiting: {stages: [...], count, oldest_hours, average_hours, median_hours,
             buckets: {under_24h, h24_to_72h, over_72h}},
   sla: {threshold_hours, breached},
   operators: [{user_id, full_name, active_load, issued_last_30d}],
   time_to_issue: {window_days, sample, average_hours, median_hours, p90_hours}}
Permission: P.TICKET_APPROVE — and platform staff
```

Ageing is measured over **Approved / Payment Pending / Paid only**, named in `waiting.stages`.
A ticketed booking is in M1's queue because paperwork is still filed against it, but nobody is
waiting for it to be booked — counting its age makes an idle number grow for ever and drowns the
bookings that need attention. `time_to_issue` reads the append-only `status_history` entry that
recorded the move to `ticket_issued`, so the figure is auditable against the Activity Timeline
the desk already sees; `updated_at` would have been simpler and wrong, because any later edit
moves it.

`GET /api/super-admin/reports/summary` (§5) gained a `totals` block in M6 for the same reason:
its four stat cards were summed in the browser with `Number()`, which floats a Decimal and drops
the paise.

---

## 7. RBAC additions needed

Everything above reuses an existing `P.*` code **except**:

- Nothing in the original contract — every endpoint drafted here mapped onto a permission code
  that already existed in `app/auth/rbac.py`. This was checked deliberately so the RBAC matrix
  did not need to change; only new routers/services did.
- **CR-2 (2026-07-31) added two, and one role.** `P.BOOKING_MANAGER_APPROVE`
  (`booking.manager_approve`) and `P.BOOKING_MANAGER_RETURN` (`booking.manager_return`), held by
  the new `UserRole.MANAGER` and by nothing else. They are new because the capability is
  genuinely new: reusing `ticket.approve` would have handed every Admin the Manager's job on day
  one, and handing the Manager `ticket.approve` would have given it the Admin's catalog queue.
  See §6.3c.

---

## 8. What this contract deliberately does not touch

- The 18 unmounted legacy router files (`admin.py`, `booking_management.py`, `partner_*`, etc.)
  and their paired legacy schemas/models (`app/models/`) — dead code today, superseded by the
  nine-table schema. Left in place per "don't break working functionality unless necessary";
  they're not wired into `main.py` and aren't reachable, so removing them is a separate cleanup
  task, not a prerequisite for this build.
- `frontend/login.html`, `register.html`, `admin/admin.js`, `partner/partner-auth.js`,
  `super-admin/super-admin-auth.js` currently call endpoints that don't match this contract
  (old partner-then-OTP order, old admin surface, etc.). They will be superseded by the new
  landing page + portal builds in the implementation order — not patched in place.
- No new database migration. Every new endpoint above is served entirely from the nine tables
  and enum values already migrated in `0023_nine_table_redesign` / `0025` (see the `RequestType`,
  `MessageType` values already carrying `document`, `live_chat`, `support_ticket`, etc.).

---

## 9. Sign-off record (2026-07-29)

All four open questions are resolved — decisions are inlined at point of use above (§1 OTP
delivery, §4.2 Approval Queue, §6.2 export deps, §6.5 chat transport). Approved development
order:

- **Phase 1** — Landing page, 3-way login, OTP authentication, session management. Built
  entirely against §1, which is already live — **zero backend changes**.
- **Phase 2** — Merchant Portal (Dashboard, Ticket Enquiry, Request Ticket, Request History,
  Service Requests, Reports, Profile). Live Chat is deferred out of Phase 2 to Phase 5 per the
  approved order.
- **Phase 3** — Admin Portal (Dashboard, Merchant Management, Active Users, Approval Queue,
  Payment Management, Reports, Communication).
- **Phase 4** — Super Admin Portal (Dashboard, Admin Management, Profile).
- **Phase 5** — Remaining cross-cutting modules: Dashboard KPIs/Analytics, Reports & Export,
  Document Management, Notification Center, Audit Logs, Activity Timeline, Live Chat.

Standing rules for every phase: reuse existing endpoints wherever this contract marks them
EXISTING; don't modify working auth/RBAC/schema unless a phase genuinely requires it; every new
endpoint enforces a `P.*` permission code; UI must be responsive (desktop/tablet/mobile),
consistent across portals, and cover loading/empty/error states.

---

## §12. M10 — reconciliation against the live OpenAPI document (2026-08-01)

**Status: reconciled.** This section closes the gap M10 exists to find. Every path was taken from
`GET /openapi.json` on a running server and compared with what this document names, rather than
from anyone's memory of what was built.

**Result: 144 live endpoints, 126 documented, 32 undocumented** (some paths appear under more than
one method). Every one of the 32 is listed below with its gate. **None was undocumented because it
was secret** — they are M1/M2-era operations endpoints, the support desk, the super-admin tools and
the two M5 additions, all shipped before or alongside the convention that a contract entry lands in
the same milestone as the endpoint.

### Booking Operations (M1/M2) — `ticket.view` / `ticket.issue`

```
GET    /api/admin/bookings/queue              the post-approval work queue, oldest first
GET    /api/admin/bookings/queue/counts       tab badges, one grouped query
GET    /api/admin/bookings/operators          operators with their current load
POST   /api/admin/bookings/{id}/assign        row-locked; reassignment allowed and logged
PUT    /api/admin/bookings/{id}/references    airline PNR / ticket no / airline ref
GET    /api/admin/bookings/{id}/notes         staff-only internal notes
POST   /api/admin/bookings/{id}/notes
PUT    /api/admin/bookings/notes/{note_id}    author only
DELETE /api/admin/bookings/notes/{note_id}    author only
POST   /api/admin/requests/{id}/complete      Ticket Issued -> Completed
```

**`request_notes` is staff-only at the service layer, not merely absent from a schema.** It is
never carried on any merchant-facing response, in any shape. `verify_m7.py` asserts this on the raw
JSON of every merchant endpoint rather than on a rendered screen.

### Ticket enquiries (Phase 1/2) — `ticket.enquiry` / `ticket.view`

```
GET  /api/enquiries                           merchant's own; staff see every merchant
GET  /api/enquiries/{id}
POST /api/admin/enquiries/{id}/review         the claim, taken under SELECT ... FOR UPDATE
```

### Documents (Phase 3) — `document.upload` / `document.verify`

```
POST /api/requests/{id}/documents             multipart; magic-byte checked, size-capped
GET  /api/documents/{id}                      attachment, private no-store, merchant-scoped
```

### Support desk (Phase 3) — `support.manage` / `chat.create` / `chat.view`

```
GET  /api/support/threads                     GET/POST
GET  /api/support/threads/{id}
GET  /api/support/threads/{id}/messages       GET/POST
POST /api/support/threads/{id}/claim
POST /api/support/threads/{id}/resolve
GET  /api/support/unread-count
```

### Merchant team (existing) — `merchant_user.create` / `merchant_user.manage`

```
PUT    /api/merchant/team/{id}
POST   /api/merchant/team/{id}/reset-password
PATCH  /api/merchant/team/{id}/status
```

### Super Admin (Phase 4) — `admin.view` / `audit.view` / `system.activity.view`

```
GET /api/super-admin/admins/{id}/permissions
GET /api/super-admin/audit-logs
GET /api/super-admin/audit-logs/tables
GET /api/super-admin/permissions/matrix
GET /api/super-admin/system-info
```

### Delivery failures (M5) — `notification.send`

```
GET /api/admin/messages/failed                sends that did not go out, newest first
GET /api/admin/messages/counts                how much delivery is failing
```

### Unauthenticated by design

```
GET /api/health                               liveness; no data
GET /api/status                               which modules are ported; no data
GET /api/profile/heartbeat                    authenticated; drives the Active Users screen
```

### The rule this reconciliation restores

**No new endpoint without a contract entry, in the same milestone that adds it.** The 32 above are
the accumulated cost of that rule being applied from M3 onwards but not retrospectively. Every
endpoint added by M3–M10 and CR-1–CR-5 *was* documented in its own milestone; the backlog is
entirely pre-M3. A future audit should find this number at zero, and `verify_m9.py` is where a
check for it belongs if it ever drifts again.
