# Stage 3 — M2 Communication Management — Technical Assessment (READ-ONLY)

**Project:** JackPots World Tours & Travels · **Module:** B2C Admin Portal · **Phase:** M2
**Status:** **Assessment only. No source code, tests, migrations, or other docs were modified. No DB connection, no migration run, no deploy/commit/push.** Do not implement M2 until approved.
**Date:** 2026-11-13
**Evidence tags:** **[V]** read in repo (path:line) · **[P]** partial / confirm at build · **[NV]** needs a running DB.

Scope (approved): (1) admin → one customer **in-app notification**; (2) admin → one customer **email**; (3) admin **reply to an existing customer support ticket**. All behind `b2c.communication.send`, all audited, delivery outcome shown where the infra supports it. **Explicitly out of scope:** SMS, push, bulk/broadcast.

---

## 1. M2 technical architecture

M2 is an **additive, send-side** layer on infrastructure that already exists and is currently **read-only**. It introduces **no new table, no new enum value, no migration, no second notification/email system**.

```
Admin SPA  (#section-b2c-communication, admin/index.html)
   │  POST (new)                      ┌─ require_scope(b2c.communication.send)   [explicit grant / super-admin]
   ▼                                  ├─ require_audit_ready   (M0 gate → 503 until 0095 applied)
app/routers/admin_communication.py  ──┤
   │  (extend: add 3 POST handlers)   └─ customer_admin_audit_service (record_in_session / record_independently)
   ▼
app/services/customer_communication_admin_service.py   (extend: add send_notification / reply_ticket;
   │                                                     email via a thin email_service helper)
   ├── CustomerNotification            (customer_notifications)      ← in-app, reuse type "general"
   ├── CustomerSupportMessage          (customer_support_messages)   ← staff reply, is_staff=True
   └── email_service._send(...)        (SMTP)                        ← reuse the existing core
         │
         ▼  one PostgreSQL DB · one engine · one SessionLocal · get_db   (all reused, unchanged)
```

Reused as-is: the single engine/session (`app/database/session.py`), the audit writer + M0 readiness gate, `email_service`, and the existing customer-side read paths (so a sent notification / staff reply appears to the customer with no customer-side change).

---

## 2. Existing vs missing — per functionality

### 2.1 In-app notification (admin → one customer)
- **Existing.** Model `CustomerNotification` (`customer_notifications`): `customer_id` FK, `notification_type` enum, `title` String(150), `message` String(500), `is_read`, `related_ref`, `created_at`. [V `models_customer.py:918-934`] Enum values: `booking_created, booking_confirmed, booking_cancelled, booking_payment, general`. [V `models_customer.py:426-430`] Customer reads them: `GET /api/customer/.../notifications` + `/notifications/unread-count`. [V `customer_account.py:130,138`] Admin **views** them: `GET /api/admin/communication/notifications` → `customer_communication_admin_service.list_notifications`. [V `admin_communication.py:24-48`] The service docstring states it deliberately does **not** compose/broadcast. [V `customer_communication_admin_service.py:7`]
- **Missing.** Any admin endpoint/service to **create** a notification for a customer.
- **Reuse / new.** Reuse the model + the customer read path; add one POST endpoint + a `send_notification()` service fn. **Reuse `notification_type="general"`** (an admin ad-hoc message) so **no enum value and no migration are added**.

### 2.2 Email (admin → one customer)
- **Existing.** `email_service._send(to, subject, text_body, html_body) -> bool` is the reusable SMTP core; templated senders (password-reset, OTP, enquiries, contact) and `_send_with_reply_to` build on it. [V `email_service.py:12,40,281,307`] SMTP config is in `Settings` (`smtp_host/port/username/password/use_tls/from_email`). [V `config.py:25-30`] `_send` returns a bool = **delivery outcome** (SMTP accepted / failed).
- **Missing.** An admin→customer **ad-hoc** email sender and endpoint.
- **Reuse / new.** Add a thin `email_service.send_admin_customer_message(to, subject, body)` that calls `_send`; add one POST endpoint + service glue. No new email system.

### 2.3 Support-ticket reply (admin → existing ticket)
- **Existing.** `CustomerSupportTicket` (`customer_support_tickets`: `subject`, `description`, `priority`, `status`, `customer_id`) and `CustomerSupportMessage` (`customer_support_messages`: ticket FK, `author_name`, `is_staff` bool — **NULL author = customer**, `message` Text, `created_at`). [V `models_customer.py:980-1024`] Admin **views** tickets: `GET /api/admin/communication/tickets`, `/tickets/{id}`. [V `admin_communication.py:50-84`] Customer reads own tickets: `GET /api/customer/.../support-tickets`. [V `customer_account.py:277`] This is the **customer** ticket thread, deliberately separate from the B2B `support_tickets.py` (rooted in `models_v2.User`). [V `models_customer.py:981-983`]
- **Missing.** An admin endpoint to **post a reply** (create a `CustomerSupportMessage` with `is_staff=True`).
- **Reuse / new.** Reuse both models + the customer read path; add one POST endpoint + a `reply_ticket()` service fn. An optional `status` transition must reuse an **existing** `_TICKET_STATUS` value (confirm values before use — **no migration**). [P — `_TICKET_STATUS` values not enumerated here]

---

## 3. Per-functionality technical analysis

| Aspect | In-app notify | Email | Ticket reply |
|---|---|---|---|
| Existing impl | model + customer read + admin list [V] | `_send` + templated senders [V] | models + customer read + admin list [V] |
| Missing | admin create endpoint | admin ad-hoc sender + endpoint | admin reply endpoint |
| Reuse files | `customer_notifications`, `customer_communication_admin_service`, `admin_communication` | `email_service._send`, `config` SMTP | `customer_support_messages`, `admin_communication` |
| New (proposed) | 1 POST + `send_notification()` | 1 POST + `send_admin_customer_message()` glue | 1 POST + `reply_ticket()` |
| Request | `{title≤150, message≤500, notification_type="general"}` | `{subject, body}` (plain text; optional html) | `{message}` (+ optional `set_status` reusing a valid enum) |
| Response | `{id, outcome:"created"}` | `{status, delivered: bool}` (delivery from `_send`) | `{message_id, outcome:"sent"}` |
| AuthZ | `require_scope(P.B2C_COMMUNICATION_SEND)` + `require_audit_ready` | same | same |
| Audit action | `customer.notify` | `customer.email` | `support.reply` |
| SUCCESS audit | `record_in_session` (atomic with the INSERT) | `record_in_session` **after** send; post-send audit-commit fail → 500 + independent anomaly (email not recalled) | `record_in_session` (atomic with the message INSERT) |
| FAILURE/DENIED | `record_independently` (404 / validation / denied) | 422 no-verified-email, 502 SMTP → `record_independently` FAILURE; denied → DENIED | 404 / closed-ticket / denied → `record_independently` |
| DB dependency | `customer_notifications` (exists) | none (SMTP external) | `customer_support_messages` (exists) |
| Frontend | compose panel in `#section-b2c-communication`; customer screen unchanged | compose panel; customer inbox unchanged | reply box on the ticket drawer; customer thread unchanged |
| Failure handling | 404 unknown customer; validation 422; 503 if audit store absent | 422 no verified email (no send); 502 SMTP fail; 503 audit absent; post-send-audit-fail 500+anomaly | 404 unknown/foreign ticket; 409 if replying to a closed ticket (optional rule); 503 audit absent |
| Security/privacy | admin-only + audited; title/message are admin-authored (not secrets) | sends content to external SMTP (as existing emails do); **store only metadata in audit** (subject, channel, delivered, length) — not the full body — to limit PII in the trail | staff reply visible to the customer; audit stores metadata, not necessarily full body |

**Email external-side-effect rule (reuse M1 pattern):** audit SUCCESS is written only **after** `_send` succeeds and must commit durably before returning 200; if that commit fails the handler logs CRITICAL, records an independent FAILURE anomaly, and returns 500 — the sent email is not falsely reported and is not recalled. A no-verified-email request sends nothing (422 + FAILURE).

---

## 4. API endpoint proposal (all under the existing `/api/admin/communication` router)

| Method / path | Action | Gate |
|---|---|---|
| `POST /api/admin/communication/customers/{customer_id}/notify` | create in-app notification | `b2c.communication.send` + `require_audit_ready` |
| `POST /api/admin/communication/customers/{customer_id}/email` | send email to the customer | same |
| `POST /api/admin/communication/tickets/{ticket_id}/reply` | staff reply on a customer ticket | same |

Reusing the existing `admin_communication` router + extending `customer_communication_admin_service` (no new router, no duplicate system). Response models added to `schemas/` (e.g. `CustomerCommunicationResult`). No change to any GET.

---

## 5. Screen & frontend integration mapping

- **Admin:** `frontend/admin/index.html` → `#section-b2c-communication` (line 1299) is currently **read-only** (notification list, ticket list, chat overview). [V] Add three compose actions wired to the new POSTs: "Send notification", "Send email", and a reply box on the ticket view. The admin SPA is inline (no separate `frontend/admin/js` module for this section). [V — no such file]
- **Customer:** **no change required.** A new `customer_notifications` row surfaces via the existing `/notifications` reads; a staff `customer_support_messages` row surfaces in the existing ticket thread. [V `customer_account.py:130,277`]

---

## 6. Permission & audit matrix

| Endpoint | Permission (explicit; super-admin short-circuits; NO role default) | SUCCESS | FAILURE | DENIED | Retention class (proposed) |
|---|---|---|---|---|---|
| notify | `b2c.communication.send` [V `rbac.py:206,217`] | `customer.notify` (in-session) | invalid/404 (independent) | independent DENIED + 403 | ordinary |
| email | `b2c.communication.send` | `customer.email` (in-session, post-send) | 422 no-email / 502 SMTP (independent) | independent DENIED + 403 | security (external channel) |
| reply | `b2c.communication.send` | `support.reply` (in-session) | 404 / closed (independent) | independent DENIED + 403 | ordinary |

All three also sit behind `require_audit_ready` (M0) → **503 until migration 0095 is applied**, identical to M0/M1. Audit `new_value` carries **metadata only** (e.g. `{channel, subject, delivered, length}` / `{ticket_id, length}`), never full secret-bearing content.

---

## 7. Database impact assessment

- **No new tables, no new columns, no enum changes, no migration.** Reuses `customer_notifications` (type `"general"`), `customer_support_messages` (`is_staff=True`). [V]
- **One PostgreSQL DB, one engine, one `SessionLocal`, `get_db`** — all reused unchanged. No second engine/pool/history.
- **Migration 0095 remains UNAPPLIED.** M2's audited sends therefore return 503 in any environment until 0095 is applied (separate authorization), exactly as M0/M1.
- **No DB connection/read/write performed** in this assessment. [NV] A live check of enum values / row shapes is deferred to build time against the dev DB.

---

## 8. Implementation sequence (when approved)

1. `email_service.send_admin_customer_message()` thin helper over `_send` (unit-tested with a fake SMTP).
2. `customer_communication_admin_service`: `send_notification()`, `reply_ticket()` (mutate-only; caller commits for atomic audit) + an email-orchestration path mirroring M1's reset (verified-email → send → audit → post-send-fail handling).
3. `schemas/`: request/response models (reason/subject/message validation, length caps matching the columns).
4. `admin_communication.py`: three POST handlers (`require_scope(B2C_COMMUNICATION_SEND)`, `require_audit_ready`, `_manage_gate`-style DENIED audit).
5. `customer_admin_audit_service._SECURITY_ACTIONS` / retention: register `customer.email` (security); `customer.notify` / `support.reply` ordinary.
6. Tests (below). No migration, no DB apply.

---

## 9. Test plan

- **notify:** success creates a row + atomic SUCCESS audit; 404 unknown customer; validation (title/message length) 422; denied without scope → 403 + DENIED audit; 503 when audit table absent (readiness gate); row surfaces via the customer `/notifications` read.
- **email:** verified-email success → `delivered:true` + SUCCESS audit (metadata only, no body/secret leak); no-verified-email → 422 + FAILURE, nothing sent; SMTP failure → 502 + FAILURE; post-send audit-commit failure → 500 + independent anomaly (email not recalled, no false success); denied → 403 + DENIED; 503 when audit absent.
- **reply:** success creates `is_staff=True` message + atomic SUCCESS audit; 404 unknown/foreign ticket; optional closed-ticket rule; denied → 403 + DENIED; 503 when audit absent; reply surfaces in the customer ticket thread.
- **Regression:** existing `admin_communication` GETs, customer notification/ticket reads, B2B `support_tickets.py`, M0/M1 suites, gaming-disabled — all unchanged.
- **Harness:** mirror the M1 tests (temp-file SQLite so the readiness probe takes its own connection; create the `customer_*` + `customer_admin_audit_logs` tables; fake SMTP + fake audit to force the failure branches).

---

## 10. Risks & dependencies

- **R1 — audit dependency (expected).** All sends 503 until 0095 is applied; same as M0/M1. Dependency: DBA applies 0095 (separate authorization).
- **R2 — email external side effect.** Covered by the M1 post-send pattern; residual: a sent email can't be recalled if the SUCCESS audit then fails (500 + anomaly, documented).
- **R3 — PII in the audit trail.** Mitigated by storing metadata only (not full bodies) in `new_value`; existing `redact_values` still masks any secret-looking key.
- **R4 — `_TICKET_STATUS` / status transition.** Any optional status change on reply must reuse an existing enum value (no migration); confirm the enum before wiring. [P]
- **R5 — scope provisioning.** `b2c.communication.send` is in no role default; an operator must be explicitly granted it (or be super-admin) — intended, matches M1.
- **R6 — no duplicate systems.** Must extend the existing router/service/email core, not introduce parallel ones (enforced by this design).
- **Preserved throughout:** single DB; B2B (incl. `support_tickets.py`) untouched; M0 readiness + M1 audit atomicity reused; Gaming disabled; 0095 unapplied.

---

**This is an assessment only — nothing was implemented. Awaiting approval before building M2.**
