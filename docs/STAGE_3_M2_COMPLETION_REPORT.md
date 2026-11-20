# Stage 3 — M2 Communication Management — Completion & Integration Report

**Project:** JackPots World Tours & Travels · **Module:** B2C Admin Portal · **Phase:** M2 (M2.1 + M2.2 + M2.3)
**Status:** Implemented, integrated and reviewed at the **local development** level. **Not production-deployed.** Migration `0095` **UNAPPLIED**. Single database preserved; B2B untouched; Gaming disabled.
**Date:** 2026-11-13

This is an integration/correctness review of the three communication send actions together, plus the consolidated record. Historical M0/M1 record (`STAGE_3_M0_M1_REPORT.md`) is unchanged — no genuine inconsistency found there.

---

## 1. Architecture

M2 is an **additive, single-recipient send layer** on the existing B2C communication infrastructure — **no new table, no enum value, no migration, no second notification/email system**. All three actions share one pattern: explicit-scope gate → audit-readiness gate → business write → audit (SUCCESS atomic, FAILURE/DENIED resilient). One PostgreSQL database, one engine/session (`get_db`), reused throughout.

| Action | Reuses | Business write |
|---|---|---|
| M2.1 in-app notify | `CustomerNotification` (type `general`) | one row, customer-visible via existing `/notifications` |
| M2.2 email | `email_service._send` (existing SMTP) | one email to the customer's verified address |
| M2.3 ticket reply | `CustomerSupportTicket` / `CustomerSupportMessage` | one `is_staff=True` message, customer-visible via `/support-tickets/{id}` |

## 2. Endpoints (all under `/api/admin/communication`, admin-only)

| Method / path | Scope | Readiness | Success codes | Failure codes |
|---|---|---|---|---|
| `POST /customers/{customer_id}/notify` | `b2c.communication.send` | `require_audit_ready` | 200 | 403, 404, 422, 503 |
| `POST /customers/{customer_id}/email` | `b2c.communication.send` | `require_audit_ready` | 200 | 403, 404, 422, 502, 500, 503 |
| `POST /tickets/{ticket_id}/reply` | `b2c.communication.send` | `require_audit_ready` | 200 (TicketDetail) | 403, 404, 422, 503 |

Existing reads (`GET /notifications`, `/tickets`, `/tickets/{id}`, `/chat-overview`) are unchanged, still gated on `customer.view`.

## 3. Files (M2 changeset)

**Backend**
- `app/routers/admin_communication.py` — 3 POST endpoints; `_send_gate` / `_ticket_send_gate`; `email_service` import + module logger; module docstring updated to describe all three actions (**integration fix** — it previously still said M2.2/M2.3 were unimplemented).
- `app/services/customer_communication_admin_service.py` — `send_notification`, `get_customer`, `reply_ticket` (mutate-only; caller commits for atomic audit); module docstring updated for the approved single-recipient exception.
- `app/services/email_service.py` — `send_admin_customer_email` (reuses `_send`).
- `app/schemas/customer_communication_admin.py` — `CustomerNotifyRequest/Response`, `CustomerEmailRequest/Response`, `CustomerTicketReplyRequest` (length + non-blank validators).

**Frontend**
- `frontend/admin/index.html` — "Send a notification" + "Send an email" buttons in `#section-b2c-communication`.
- `frontend/assets/js/admin-b2c-communication.js` — `comOpenCompose`/`comSubmitNotification`, `comOpenEmail`/`comSubmitEmail`, and a ticket-drawer reply box + `comSubmitReply` (replacing the old "cannot be answered" note).

**Tests (new)**
- `backend/tests/test_b2c_communication_notify.py` (11), `..._email.py` (14), `..._ticket_reply.py` (12).

> Note: `app/services/customer_refund_service.py` also shows modified in the tree — that is the **Stage-2** refund Approach-C audit hook, **not** an M2 change. M2 did not touch the refund service; maker-checker is unchanged.

## 4. Permissions

All three send actions require the **explicit** `b2c.communication.send` scope — enforced by `has_permission` in the gate (super-admin short-circuits; everyone else needs the code in `users.permissions`), **never** a B2B role default (the code is in no role default; `B2C_SCOPES` only). A B2B-only admin is 403 and the denial is audited DENIED. This mirrors M1's `_manage_gate` and keeps B2B/B2C isolation.

## 5. Audit coverage (SUCCESS / FAILURE / DENIED)

| Endpoint | SUCCESS (atomic, in-session) | FAILURE (independent) | DENIED (independent) | Metadata stored (content-free) |
|---|---|---|---|---|
| notify | `customer.notify` | 404 unknown customer | missing scope | `{notification_id, notification_type, message_length}` |
| email | `customer.email` (after send) | 422 no verified email, 502 SMTP, 500 post-send-audit-fail anomaly | missing scope | `{channel, subject_length, message_length}` |
| reply | `support.reply` | 404 unknown ticket | missing scope | `{message_length, author:"staff"}` |

**Privacy (#8):** no title, subject, email body, or ticket-reply body is ever written to the audit — only ids, type/channel, and lengths. The acting admin's identity is in the audit actor snapshot, not duplicated in the payload. `audit_service.redact_values` still masks any secret-looking key on read. Consistent across all three.

## 6. Transaction atomicity & external email side effect (#9)

- **notify / reply (pure DB):** the business row and the SUCCESS audit are added to the same session and committed once — atomic; if the commit fails, both roll back (nothing half-written).
- **email (external side effect):** SUCCESS audit is written then committed **before** 200. SMTP failure (`_send`→False) → 502 + FAILURE, nothing sent. If the email was sent but the SUCCESS-audit commit fails, the handler rolls back the audit, logs `CRITICAL`, records an independent FAILURE anomaly, and returns **500** — it never falsely claims the email was unsent and never claims a recorded success. Mirrors the M1 password-reset rule.
- All FAILURE/DENIED writes use an independent session, so no unrelated business transaction is ever committed.

## 7. Customer visibility & ownership isolation (#10)

- **Visible:** an in-app notification appears via the customer's existing `/notifications`; a staff ticket reply appears via the customer's `/support-tickets/{id}` thread (owner-scoped). An email goes to the customer's own verified address only (the admin cannot set the recipient).
- **Isolation:** notify targets one `customer_id`; email resolves the recipient server-side from that customer; reply is scoped to one `ticket_id` and the response returns only that ticket's thread. A test confirms replying to ticket A neither mutates nor exposes ticket B. Unknown customer/ticket → 404.

## 8. Existing B2B & controls preserved (#11, #12, refund)

- **B2B support tickets** (`app/routers/support_tickets.py`, `models_v2`) — **not modified** (confirmed by changeset inspection). The B2C ticket system is a separate Base.
- **Refund maker-checker** — unchanged by M2 (the only refund-service edit in the tree is the Stage-2 Approach-C audit hook; maker/checker authorization untouched).
- **Gaming Tour Packages** — remain disabled; `test_gaming_fail_closed` passes in the integrated run.
- **Single DB** — one engine/session reused; no second DB/engine/history introduced.

## 9. Integration review findings

- **Consistency:** the three endpoints share the gate pattern, the readiness gate, the SUCCESS-atomic / FAILURE-DENIED-independent audit model, and content-free metadata. Validation is uniform (non-blank + length caps sized per channel: notify 150/500, email 200/5000, reply 5000).
- **Duplicated logic:** `_send_gate` and `_ticket_send_gate` are near-identical, differing only by the path-param name (`customer_id` vs `ticket_id`) and the audit `entity_type`. The duplication is small and driven by FastAPI path binding; left as two readable factories rather than over-abstracted. No other duplication found.
- **Fixed:** the `admin_communication` module docstring was stale (said ticket reply/email were unimplemented); corrected to describe all three actions.
- **Error handling:** notify/reply wrap the service call (rollback + FAILURE + re-raise on unexpected error); email handles verified-email/SMTP/post-send-audit explicitly and relies on `_send`'s documented bool contract (never raises). No missing-handler gaps found.
- **Security:** no arbitrary email recipient; per-request single recipient/ticket; no cross-customer/ticket exposure; DENIED/FAILURE resilient; audit content-free. No gaps found.

## 10. Test results (actual, 2026-11-13)

- Integrated M2 + audit + readiness + M1 + rbac + gaming: **140 passed** (`notify 11`, `email 14`, `reply 12`, `readiness 24`, `audit_api 9`, `customer_admin_actions 21`, plus rbac/gaming).
- Import smoke (all three routes registered): **OK** (re-confirmed after the docstring fix).
- Full backend suite (last run, M2.3): **1781 passed, 44 failed, 4 skipped** — the 44 are exactly the pre-existing `test_token_revocation.py` + `test_admin_supplier_reservation_http.py` (unrelated to M2). The only change since is a comment-only docstring edit, which cannot affect test outcomes. **No new regressions.**

## 11. Frontend verification

**Not performed as an authenticated end-to-end browser check** — honestly documented as a limitation. A real check requires a running backend with a seeded admin/auth user, the `customer_*` + `customer_admin_audit_logs` tables, and migration `0095` applied so the readiness gate passes — none available here without a database connection, seeding, or deployment, all of which are out of scope under the restrictions. Frontend correctness was instead verified by: (a) **code inspection** of the compose/reply handlers (axios + `authHeaders`, disabled-during-submit duplicate guard, inline error via `catErr`, toast, thread reload), and (b) **static presence tests** asserting the buttons/handlers and the exact POST paths (`/notify`, `/email`, `/reply`) are wired. These pass.

## 12. Limitations & remaining deployment dependencies

1. **Migration `0095` must be applied** (separate DBA authorization) before any M2 action works in a real environment — until then the readiness gate returns **503** and nothing is sent/created (by design). This is the single blocking dependency.
2. **Full authenticated UI verification** is pending a local authenticated environment (see §11).
3. **SMTP configuration** (`smtp_host`/`smtp_from_email`) must be set for M2.2 in the target environment; unset → `_send` returns False → 502 (no false success).
4. No auto email/SMS on ticket reply — intentional; a notify-on-reply workflow would need separate approval.

---

**M2 is complete and internally consistent at the local level. No new features started; `0095` unapplied; no PostgreSQL connection / DB change; no deploy/commit/push; single DB, B2B, refund maker-checker and Gaming-disabled all preserved. Awaiting approval before any subsequent stage.**
