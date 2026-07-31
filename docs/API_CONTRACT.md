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
| POST | `/api/auth/login` | none, `10/min` | `LoginRequest{email, password, portal}` | `LoginChallengeResponse{otp_required, challenge_token, delivery, message, dev_otp?}` | `portal` ∈ `super_admin\|admin\|merchant`. Wrong-portal account → generic 401 (doesn't reveal the account exists on another portal). |
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
    # discriminated union in one list so the frontend renders one sortable table;
    # "kind" tells it which detail route to open (/admin/merchants/{id} vs /requests/{id})
  }
Permission: P.MERCHANT_VIEW + P.TICKET_VIEW (require(..., require_all=False) — Admin already holds both)
```

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
GET /api/reports/summary
  ?type=bookings|revenue|service_requests|payments
  &date_from=<date>&date_to=<date>
  &group_by=day|week|month
  &merchant_id=<int>                    (Admin/Super Admin only — ignored/403 if a merchant passes someone else's id)
→ {type, date_from, date_to, group_by, series: [{bucket: str, count: int, total_amount: Decimal}]}
Permission: P.REPORT_VIEW
```

```
GET /api/reports/export
  ?type=bookings|revenue|service_requests|payments
  &format=csv|xlsx|pdf
  &date_from=<date>&date_to=<date>&merchant_id=<int>
→ 200, file stream (Content-Disposition: attachment)
Permission: P.REPORT_EXPORT
```

Each export also writes one `SystemLog(module='reports', action='export')` row (mirrors the
legacy `report_generation_log` table per `docs/SCHEMA_V2.md:98`).

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

### 6.3a Cancellation & Reschedule (M3)

A confirmed booking moving backwards. These are `ServiceRequest` rows of
`request_type = cancellation | date_change`, linked to the booking by `parent_request_id` — no new
table and no migration.

**Why these are not `POST /api/service-requests`.** That generic hook stays, for baggage, meals,
seats, refunds and passenger corrections. Cancellation and date change settle money and change the
parent booking, which the generic hook does neither of, so the three generic paths now **refuse
these two types with 400** — `/api/admin/requests/{id}/approve`, `/api/admin/requests/{id}/reject`,
`/api/admin/service-requests/{id}/resolve`, plus `/api/requests/{id}/cancel` (withdraw instead).
Same treatment ticket enquiries got.

**No amounts are sent when raising.** The cancellation charge and the fare difference come from the
airline and are quoted by staff at approval; a pending request carries `pricing = {}` and
`total_amount = 0.00`. Amounts cross the wire as **strings**, never JSON numbers.

```
POST /api/bookings/{booking_id}/cancellation
  Body: {reason: str}
→ ChangeRequestDetail                                      201
Permission: P.SERVICE_REQUEST_CREATE
409 unless the booking is approved | payment_pending | paid | ticket_issued
409 if another change request is already open against it (names it)
```

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

```
POST /api/change-requests/{id}/withdraw → ChangeRequestDetail
Permission: P.SERVICE_REQUEST_CREATE
Only while Pending — 409 naming the operator once claimed.
```

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
booking_id, booking_request_number, booking_reference, pnr, merchant_id, merchant_name, reason,
pricing, amount, new_travel_date, current_travel_date, review_claimed_by, review_claimed_by_name,
rejection_reason, created_at, updated_at}`.

`ChangeRequestDetail`: `{request, booking, timeline, can_review, can_settle, can_withdraw}`.

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

---

## 7. RBAC additions needed

Everything above reuses an existing `P.*` code **except**:

- Nothing, actually — every new endpoint above maps onto a permission code that already exists
  in `app/auth/rbac.py`. This was checked deliberately while drafting this contract so the RBAC
  matrix doesn't need to change; only new routers/services do.

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
