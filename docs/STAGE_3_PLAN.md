# Stage 3 — B2C Admin Functional Completion — Implementation Plan (revised, business rules approved)

**Project:** JackPots World Tours & Travels · **Date:** 2026-11-13
**Status:** PLAN ONLY — business rules approved; NOT authorized to implement. No code/DB/config change, no migration, no PostgreSQL connection, no commit/push. Gaming disabled. Single PostgreSQL DB preserved. B2B untouched.
**Supersedes** the first Stage 3 plan draft — incorporates the approved rules and **corrects the migration-0095 dependency** (§6; my earlier "no dependency" was wrong).

## 1. Approved business rules
### 1A. Customer Management — **Block / Unblock only** (no Suspend)
- **Block:** `customer.status active→blocked` **and** set `customer.auth.force_logout_at = now` so existing sessions are immediately invalidated and further auth is refused (`customer_deps` already rejects BLOCKED + honours `force_logout_at`) [V]. Reason required.
- **Unblock:** `blocked→active`. Restores login eligibility but does **not** restore old sessions (we do not clear/rewind `force_logout_at`, so previously-issued tokens stay dead; the customer logs in afresh). Reason optional.
- **Password reset:** uses the existing secure email-link workflow only — `customer_auth_service.start_password_reset(email)` emails the standard reset link; optional `force_logout`. **The admin never sees, generates or sets a password; the endpoint returns no token.**
- Suspend is explicitly **out of Stage 3**.

### 1B. Communication Management — single-customer only
- Channels: **in-app `customer_notifications`**, **SMTP email**, and **support-ticket reply** — **INCLUDED**: verified safe. `CustomerSupportMessage` carries an `is_staff` boolean and `author_name` with "NULL author = the customer" [V `models_customer.py:1008-1024`], so an admin reply is an anticipated, safe insert (a staff message on the existing thread). **No SMS/push** (not integrated).
- **Single-customer messages only — no broadcast/bulk.**
- Record: administrative **actor**, **recipient** (customer id), **channel**, **delivery outcome**. Store only minimal content (a subject/title + channel/outcome) in the audit — **not** the full message body (the delivered body lives in `customer_notifications`/the email, not duplicated into the audit).

### 1C. Navigation — existing `/api/auth/me`
- Gate the sidebar on the `role` + effective `permissions` already returned by `GET /api/auth/me` [V `auth.py:400-409,100`]: show B2C nav only to an authorized admin (super-admin or holder of a `b2c.*` scope). **No new `b2c_access` flag** (no technical requirement demonstrated — role+permissions suffice; see §6 note on super-admin). **Backend `require_scope`/`require_b2c_access` remain authoritative; nav is cosmetic.**

### 1D. Permissions — explicit scopes, no role-default grant
- `b2c.customers.manage` (block/unblock/reset) and `b2c.communication.send` (messages). Added to `P` + `B2C_SCOPES`; **not** added to any `ROLE_PERMISSIONS` default (explicit grant or super-admin only — Stage-1 rule).

## 2. Exact files, APIs, permissions
### New API endpoints (all B2C admin; all audited; all gated)
| Method · route | Scope | Action |
|---|---|---|
| `POST /api/admin/customers/{id}/block` | `b2c.customers.manage` | block + force-logout |
| `POST /api/admin/customers/{id}/unblock` | `b2c.customers.manage` | unblock |
| `POST /api/admin/customers/{id}/password-reset` | `b2c.customers.manage` | email reset link (no token returned) |
| `POST /api/admin/communication/notifications` | `b2c.communication.send` | in-app notification to one customer |
| `POST /api/admin/communication/email` | `b2c.communication.send` | SMTP email to one customer |
| `POST /api/admin/communication/tickets/{id}/reply` *(if safe)* | `b2c.communication.send` | reply on a support ticket |

### Files to modify (confined to B2C + additive)
- **Backend:** `app/routers/customer_admin.py` (+3 routes); `app/services/customer_admin_service.py` (`set_status`, `initiate_password_reset`); `app/routers/admin_communication.py` (+send routes); `app/services/customer_communication_admin_service.py` (`send_notification`, `send_email`, optional `reply_ticket`); `app/services/email_service.py` (`send_customer_message_email`); `app/schemas/customer_admin.py` + `app/schemas/customer_communication_admin.py`; `app/auth/rbac.py` (2 scopes); **new** `app/services/b2c_admin_readiness.py` (§6 gate); `app/main.py` (startup readiness check — additive).
- **Frontend:** `assets/js/admin-b2c-customers.js`, `assets/js/admin-b2c-communication.js`, `assets/js/admin.js` (nav gating via `/me`); `admin/index.html` (buttons/compose form). No B2B files.
- **Tests:** extend `test_b2c_permission_isolation`, `test_b2c_audit_events`; new `test_customer_admin_actions.py`, `test_admin_communication_send.py`, `test_b2c_admin_readiness.py`.

## 3. Customer block/unblock workflow
1. `POST .../{id}/block` → `require_scope(b2c.customers.manage)` → **readiness gate (§6)** → load customer (404 if absent) → `set_status(blocked)` + `auth.force_logout_at=now` → `record_in_session(customer.block, SUCCESS, reason)` → `db.commit()` (status + audit atomic) → 200. On service error → `record_independently(FAILURE)` + 4xx/5xx.
2. `POST .../{id}/unblock` → same gates → `set_status(active)` (force_logout_at left as-is) → `record_in_session(customer.unblock)` → commit.
3. Blocking is idempotent (already-blocked → no-op success). Bookings/payments untouched (status is auth-only).

## 4. Password-reset workflow
`POST .../{id}/password-reset` → scope + readiness gate → load customer (404 if absent) → **check a usable email is on file; if MISSING: do NOT initiate a reset, do NOT generate a token — return a clear `422` validation error** and write `record_independently(customer.reset_password_initiated, FAILURE, reason="no email on file")`. If present → `customer_auth_service.start_password_reset(customer.email)` (emails the standard link; respects the existing reset-token TTL) → optional `force_logout` → `record_in_session(customer.reset_password_initiated, SUCCESS)` → commit → **200 `{ "status": "reset email sent" }` (never the token/password)**. The admin never sees, generates or sets a password. SMTP failure is reported (502) and does not reveal token state.

## 5. Communication delivery & failure handling
- **In-app:** `send_notification` inserts a `customer_notifications` row → `record_in_session(communication.send, channel=in_app, SUCCESS)` → commit (notification + audit atomic). 
- **Email:** `send_customer_message_email` via SMTP. Because email is an external side-effect, the audit outcome reflects the send result: on success → `record_in_session(..., channel=email, SUCCESS)` then commit; on SMTP failure → the endpoint returns a clear 502/"email not sent" and writes `record_independently(communication.send, channel=email, FAILURE)` (no partial state committed). Email is **not** retried automatically in Stage 3.
- **Ticket reply** *(if supported safely)*: append an admin reply to the thread → `record_in_session(communication.reply, SUCCESS)` → commit.
- Audit payload: `{channel, recipient_customer_id, subject/title, outcome}` — **no full body**.

## 6. Database dependency — CORRECTED analysis + safe plan
**Correction.** My earlier claim that Stage 3 "has no dependency on migration 0095" was wrong for the **SUCCESS** path. `record_in_session` does `db.add(row)` and the row is flushed at the **caller's `db.commit()`** [V `customer_admin_audit_service.py:126-133`]. If `customer_admin_audit_logs` does not exist (0095 unapplied), that commit raises an undefined-table error and the **entire transaction — including the block/unblock/notification — rolls back**. That is the correct fail-closed, atomic behaviour (nothing swallowed, no un-audited change) — but it means **an audited state-changing operation cannot succeed while the table is absent.** So Stage 3's audited writes (and, equally, the already-wired Stage-2 `record_in_session` events) **do depend on 0095 being applied before they are used.**

**Safe resolution (no swallow, no weakened atomicity):**
1. **0095 is a hard deployment prerequisite.** It stays UNAPPLIED until you separately authorize it. Stage 3 is **developed and tested now** against the SQLite test harness, where `conftest.py` already creates `CustomerAdminAuditLog.__table__` [V] — so dev/test proceed without touching Postgres.
2. **Readiness gate — fail closed AT THE DOOR, not mid-transaction — covering ALL audit-dependent operations (Stage 2 + Stage 3).** New `app/services/b2c_admin_readiness.py`:
   - **Existence + schema compatibility:** at startup, `sqlalchemy.inspect(engine)` checks `customer_admin_audit_logs` exists **and** carries every column the `CustomerAdminAuditLog` model declares (names compared to `CustomerAdminAuditLog.__table__.columns`). A missing table **or** an incompatible/partial schema ⇒ not ready (so a half-applied 0095 also fails closed).
   - **Fail closed when DB / audit storage is unavailable:** if the startup probe cannot reach the database, readiness = False (fail closed). Readiness is re-probed lazily while currently-not-ready, so applying 0095 later flips it true without a restart; once ready it is cached.
   - **Dependency `require_audit_ready()`** returns **503 "B2C admin audit unavailable — migration 0095 not applied / schema incompatible"** *before any business work runs*.
   - **Coverage (per-endpoint, not router-level, to keep unaudited reads up):** applied to every endpoint that writes an audit row via `record_in_session` or the refund Approach-C hook — i.e. **all new Stage 3 mutations** AND **all existing Stage 2 audit-dependent operations**: `admin_cancellations` refund execute/authorize/manual/resolve-reconcile (the Approach-C terminal write — gating here also prevents a provider call that could not be audited), `admin_customer_bookings` booking.update + the audited booking detail-read, `customer_admin` customer detail-read, `customer_payment_admin` payment detail-read, `admin_reconciliation` verify + supplier-reservation, `admin_reviews` moderate, `admin_b2c_reports` export + preview, `admin_catalogue_hotels/packages/destinations` create/update, `admin_chat` claim/transfer/set_status/attachment-send/attachment-download.
   - **Unaffected:** unaudited reads (customer/booking/payment **list** screens, dashboards, analytics, overviews) and **all B2B** functionality (B2B uses the always-present `audit_logs` trigger + `system_logs`, not this table).
   This neither swallows a SUCCESS audit failure nor weakens atomicity — it refuses an operation that cannot be audited *before it starts*, instead of letting it reach a commit that would roll the whole transaction back with a 500.
3. **Deployment order (separate authorization):** (a) you authorize + apply `0095` and the DBA grants on the single Postgres DB; (b) the readiness check flips true; (c) Stage 3 B2C features become usable. Before (a), the new mutating endpoints return 503; nothing is half-done.
4. **No second DB/engine/history; no new migration in Stage 3** (block/unblock use existing `customers.status`/`force_logout_at`; reset uses existing `customer_password_resets`; notifications use existing `customer_notifications`). The only DB prerequisite is the already-written, still-unapplied 0095.

> Note on `/api/auth/me` + super-admin (why no `b2c_access` flag is needed): `effective_permissions` omits `b2c.*` for a super-admin (those codes are in no role default), but the `/me` response also carries `role`; the nav simply treats `role==super_admin` as "show B2C" in addition to "holds any `b2c.*`". Role + permissions therefore suffice — no new flag.

## 7. Audit event design
Reuses the Stage-2 writer, outcomes and redaction:
| Action | entity_type / id | mode | outcome(s) | payload (redacted, minimal) |
|---|---|---|---|---|
| `customer.block` / `customer.unblock` | customer / {id} | record_in_session (atomic) | SUCCESS; FAILURE/DENIED independent | `{reason, from_status, to_status}` |
| `customer.reset_password_initiated` | customer / {id} | record_in_session | SUCCESS / FAILURE / DENIED | `{channel: email}` (no token) |
| `communication.send` | customer / {id} | in_app: record_in_session; email: record_in_session on success / independent on SMTP failure | SUCCESS / FAILURE / DENIED | `{channel, subject, outcome}` (no body) |
| `communication.reply` | customer_support_ticket / {id} | record_in_session | SUCCESS / FAILURE / DENIED | `{ticket_id}` |

## 8. Security & transaction guarantees
- Admin never sets/sees a password (email-link only; no token in the response).
- Block/unblock/notification: audit row is `record_in_session` → committed atomically with the business change; a rollback drops both; an audit-insert failure fails the whole op (fail-closed) — and the readiness gate ensures that failure can't be caused by a missing table at runtime.
- FAILURE/DENIED use `record_independently` (own session) — never commit the caller's pending change, never raise into the business path.
- Email failure → explicit error + independent FAILURE audit; no partial commit.
- New scopes are explicit-grant only; nav hiding is cosmetic; backend authorization authoritative; B2B untouched; single DB preserved; Gaming untouched.

## 9. Testing & acceptance criteria
Full test matrix (your list):
- **0095 absent:** with the audit table NOT created (SQLite harness variant omitting `CustomerAdminAuditLog.__table__`), every audit-dependent endpoint (Stage 2 + Stage 3) returns **503** and writes **nothing**; unaudited reads + B2B still work.
- **Audit storage available:** with the table present (the standard harness), all audited operations succeed and write their row.
- **Database-unavailable behaviour:** when the session/engine errors, the readiness probe fails closed (503) / an in-flight audited op rolls back — never a partial commit, never un-audited success.
- **No-commit-without-SUCCESS-audit:** with the audit insert forced to raise, the audited business operation (block, booking.update, catalogue, refund) does **not** commit — asserted (extends `test_failed_success_audit_propagates…`).
- **Stage 2 refund + booking preserved:** `test_customer_refunds*` and the booking audit tests stay green (Approach C unchanged); refund maker-checker + idempotency intact.
- **Block/unblock + session invalidation:** block sets status=blocked + `force_logout_at` (old tokens rejected), unblock restores login without reviving tokens; audited; idempotent.
- **Password reset with/without verified email:** with email → reset link sent, no token returned, audited SUCCESS; **without email → 422, no token, no reset, audited FAILURE**.
- **Communication success + failure:** in-app row created + audited; email SUCCESS (mock SMTP) and FAILURE (502 + independent FAILURE audit, no partial commit); ticket reply inserts an `is_staff` message + audited.
- **Authorization for both new scopes:** `b2c.customers.manage` and `b2c.communication.send` each required (super-admin or explicit grant); a B2B-only admin → 403; neither scope granted by any role default.
- **Frontend:** nav shows B2C only to authorized admins (role/`b2c.*`); manage/send buttons hidden without the scope; server still 403s hidden actions.
- **Regression:** full backend suite green (save the 2 pre-existing unrelated failures); Gaming disabled (`test_gaming_fail_closed`); mobile tsc unaffected.

## 10. Milestones
- **M0 — Scopes + readiness gate (foundation):** add the 2 scopes; `b2c_admin_readiness` (existence + schema check + fail-closed + lazy re-probe) + startup check + `require_audit_ready`; **apply the gate to the existing Stage-2 audit-dependent endpoints as well as the new Stage-3 ones** (§6 coverage list). *Accept:* scopes in `B2C_SCOPES` (not in any role default); readiness returns 503 when the table is absent or schema-incompatible and passes when present; unaudited reads + B2B unaffected (SQLite tests both ways).
- **M1 — Customer block/unblock + reset:** routes + service + schema + audit + frontend buttons. *Accept:* §9 backend + block/unblock/reset behave per §3–§4; audited; isolated.
- **M2 — Communication send:** in-app + email (+ ticket reply if safe) + frontend compose. *Accept:* §9 comms; single-customer only; audit records actor/recipient/channel/outcome, no body.
- **M3 — Navigation gating:** `admin.js` + `index.html` gate on `/me`. *Accept:* §9 frontend; backend authoritative.
- **M4 — Testing & regression:** all suites green; readiness-gate tests; no new regressions.
- **Deployment (separate authorization):** apply 0095 + grants → readiness true → enable Stage 3.

## 11. Confirmations — RESOLVED
1. **Support-ticket reply: INCLUDED** — `CustomerSupportMessage.is_staff`/`author_name` make a staff reply a safe, anticipated insert (§1B).
2. **Password reset with no email on file: 422 validation error** — no token generated, no reset initiated, audited FAILURE, admin never sees/sets a password (§4).
No open confirmations remain.

**This is approval of business rules + revised planning only. Awaiting your explicit implementation authorization. 0095 remains unapplied until you separately authorize it.**
