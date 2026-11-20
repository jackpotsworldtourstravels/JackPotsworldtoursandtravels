# Stage 2 — B2C Administrative Audit Logging (`customer_admin_audit_logs`)

**Project:** JackPots World Tours & Travels
**Date:** 2026-11-12 (decisions D1–D6 resolved)
**Status:** **PLANNING / INSPECTION ONLY.** No code, model, table, migration, DB connection, or git change has been made. All code blocks are proposed contents for review.
**Context:** one PostgreSQL database; B2B/B2C logically separate; Stage 1 accepted. Gaming remains disabled. All production/DB/deploy/commit/push restrictions remain in force.

**Evidence tags:** **[V]** verified in repo (path:line) · **[NV]** needs a live DB or to be confirmed at implementation.

---

## 0. Inspection results (what exists today)

| Trail | Mechanism | Notes |
|---|---|---|
| **B2B `audit_logs`** (`models_v2`) | **trigger** `fn_write_audit_log` (0023); app only reads | whole-row copies; secrets redacted **on read** via `audit_service.SENSITIVE_KEY` [V `audit_service.py:22-39`] |
| **B2C `customer_audit_logs`** (`models_customer.CustomerAuditLog`) | the **customer's own** trail | no admin actor fields [V `models_customer.py:312-335`] |
| **B2C-admin actions TODAY** | B2B **`system_logs`** via `activity_service.log_activity` | e.g. `admin_cancellations._audit()` logs with the B2B `user_id`, `module="B2CRefunds"` [V `admin_cancellations.py:87-96`] |

**`system_logs` is a shared operational table with live readers** [V]:
- **Sessions / presence** — `session_service` stores sessions as `system_logs` rows; **Admin → Active Users** and the online-count/heartbeat read them [V `session_service.py`].
- **Activity trail** — `activity_service.list_activity` powers the **Admin → System Logs** screen; `dashboard_service` reads recent activity for the **dashboard** [V `activity_service.py:407`, `dashboard_service.py:168,329`].
- **Writers** — `activity_service.log_activity`, `session_service`, `providers.py:109`, `reports.py:356`.

→ The refund `_audit()` rows in `system_logs` are surfaced by the Admin System-Logs screen and the dashboard. **They cannot simply be removed** (D1).

**Request context carrier** [V `activity_service.py:39-51`, `main.py:212-240`]: a `contextvars.ContextVar` `_REQUEST_META`, set once per request by the `request_metadata` middleware (`bind_request`) and read by `current_request_meta()`; safe across async + threadpool; `None` in background jobs. It carries ip/browser/device to ~60 `log_activity` calls with no signature changes. **There is no request/correlation id today.**

**Alembic** [V `alembic/env.py:8,15`]: `target_metadata` is the **legacy `app.models`** Base — autogenerate sees neither `models_v2` nor `models_customer`, so B2C migrations are **hand-written**. Head: **`0094_customer_refund_attempts`** → new **`0095`**. Enums use `create_type=False` (the migration issues `CREATE TYPE`). **`models_customer.py` must not import `rbac`** [V `models_customer.py:24-29`].

---

## 1. Final decisions D1–D6

### D1 — `system_logs` vs the new table → **dual-write, new table authoritative; no removal yet**
- **`customer_admin_audit_logs` is the authoritative B2C administrative audit trail.** It holds the full, structured record (actor snapshot, before/after, outcome, correlation).
- **Keep the existing `system_logs` activity write** for every B2C-admin action during a transition, because live consumers (Admin → System Logs, the dashboard, Active Users) read `system_logs` today. The `system_logs` row stays a **short description string only** — it already carries no before/after payload and no secrets, so **no sensitive data is duplicated**.
- **Transition strategy (documented, not executed):**
  1. **Phase A (this stage):** dual-write — authoritative structured row to `customer_admin_audit_logs`; keep the existing `activity_service.log_activity` description row for backward compatibility.
  2. **Phase B (later, separate approval):** point the Admin B2C views at `customer_admin_audit_logs`; confirm no dashboard/report/monitoring depends on the `system_logs` B2C-admin rows.
  3. **Phase C (later, separate approval):** stop the `system_logs` write for these specific B2C-admin actions once Phase B confirms no remaining consumer. B2B `system_logs` (sessions, B2B activity) is untouched throughout.
- **No existing logging is removed in Stage 2.**

### D2 — Sensitive reads & exports → **audited, with a volume guard**
Audited read/egress actions (state-changing writes are always audited; these are the *read* additions):
- Viewing a **single** customer's sensitive profile/detail (`customer.view_detail`).
- Viewing **payment / refund** detail (`payment.view_detail`).
- Viewing **sensitive booking** detail (passengers, documents) (`booking.view_detail`).
- **Exporting** customer / booking / payment / financial reports (`report.export`).
- **Downloading** a sensitive document / e-ticket for a customer (`document.download`). **[NV — confirm the exact B2C-admin document endpoints at implementation]**

**Not audited:** list/search/index GETs, pagination, navigation, dashboards, counts.
**Excessive-volume guards:** (a) only **detail** reads of a specific record, never list views; (b) **de-duplicate** repeated identical reads by the same actor+entity within a short window (e.g. 5 min) into one row with a repeat count; (c) reads are written **post-response** (never blocking) and may be sampled/rolled up if volume proves high **[NV — size once live]**.

### D3 — Database-level append-only → **approved (design only; not created)**
- **Application guarantee:** the writer service only `INSERT`s; **no UPDATE/DELETE endpoint** exists on this table; the read API is list/detail only.
- **DB enforcement (recommended):** a `BEFORE UPDATE OR DELETE` trigger `fn_block_customer_admin_audit_mutation()` that `RAISE EXCEPTION`s, so even a stray query cannot alter history.
- **Ownership & privilege model:** the table + trigger are owned by the **migration/DDL role** (the schema owner that runs Alembic), not the application login. The **application role is granted only `INSERT` and `SELECT`** on `customer_admin_audit_logs` — explicitly **not** `UPDATE`/`DELETE`/`TRUNCATE`. (Granting this is a DBA step accompanying the migration, documented here; this spec grants nothing.)
- **Exceptional retention / legal procedure:** any correction, legal hold, or court-ordered deletion is performed **out-of-band by the owner role** under a documented, approved, four-eyes procedure — never through an application API and never by the app role. Such an operation is itself logged outside this table.

### D4 — Retention → **configurable, no auto-delete by default, periods PENDING business/legal approval**
- A **configurable** retention policy with **no automatic deletion by default** (nothing is ever purged until a policy is explicitly approved and enabled).
- **Retention categories** on each row (derived from `action`): `financial` (refund/cancellation/payment), `security` (auth-adjacent, denied attempts, sensitive reads), `ordinary` (catalogue, communication, moderation).
- Any archival or deletion job requires **explicit approval**, runs under D3's owner-role procedure, honours **legal holds** (a hold flag/exclusion list suspends purge), and respects privacy obligations (data-subject requests handled via the controlled procedure, not an admin API).
- **Final periods are marked PENDING business/legal approval** — this spec proposes categories and mechanism only, not durations.

### D5 — Correlation ID → **reuse the existing ContextVar; extend it, no new middleware**
- **No correlation id exists today.** Reuse `_REQUEST_META` (`activity_service`): extend the **existing** `request_metadata` middleware's meta dict with a `request_id` — use an inbound `X-Request-ID` / `X-Correlation-ID` header when present and well-formed, else generate a UUID4; optionally echo `X-Request-ID` on the response.
- Because the audit writer reads `current_request_meta()`, `request_id` reaches it (and the ~60 existing log sites) **with no signature changes**, under both async and sync/threadpool execution.
- **Background jobs / sweeps** (the two asyncio sweeps, incl. the deferred payment sweep): bind a per-run id (`"sweep:<uuid4>"`) in the same ContextVar for the run, so sweep-originated audit rows correlate to a run; `None` outside a request reads truthfully as "no request".
- **Payment/refund:** admin actions are HTTP → covered by `request_id`; the deferred payment sweep → covered by the per-run id.
- **WebSocket (admin_chat / WiFi calling):** WS events are not HTTP and get no ContextVar binding from the middleware. Correlate WS-originated audit events by the socket **ticket** (minted by `/ws-ticket`, tied to `admin_user_id`) or a per-connection id passed explicitly to the writer. Documented as the WS correlation key.
- **Nothing is added yet** — this is the design, pending approval.

### D6 — Outcome taxonomy → **`SUCCESS` · `FAILURE` · `DENIED` · `PARTIAL`**
| Outcome | When | Transaction rule |
|---|---|---|
| `SUCCESS` | the action completed **and committed** | written in the **same transaction** as the state change, so if the business txn rolls back the SUCCESS row rolls back too — **no misleading success entry** |
| `FAILURE` | the action was authorized and attempted but did **not** complete (validation/business error, provider rejection, 4xx/5xx, exception) | written in a **separate, independently-committed** transaction (the business txn rolled back / never committed), so the attempt is recorded without claiming success |
| `DENIED` | authorization refused — the Stage 1 domain/scope gate returned 403, or 401 | written independently; the action never ran; records the actor, target and the scope that was missing |
| `PARTIAL` | a multi-step/batch operation where some steps succeeded and some failed (e.g. a reconciliation run processing N, failing M) | `new_value`/`reason` enumerate which steps succeeded and which failed; written after the run |

- **Maker-checker:** the maker's `refund.execute` and the checker's `refund.authorize` are **separate rows**, each with its own actor snapshot and reason, correlated by `entity_id` (cancellation ref / refund-attempt id) and `request_id`. The approval is reconstructed from the pair.
- **Transaction-failure safety:** the `SUCCESS`-in-same-transaction rule above guarantees a rolled-back DB transaction can never leave a `SUCCESS` audit row; `FAILURE`/`DENIED` are the outcomes that survive a rollback.

---

## 2. Updated schema (`customer_admin_audit_logs`, on `models_customer.Base`)

```python
class AdminAuditOutcome(str, enum.Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    DENIED = "denied"
    PARTIAL = "partial"

_ADMIN_AUDIT_OUTCOME = SAEnum(
    AdminAuditOutcome, name="customer_admin_audit_outcome_enum",
    values_callable=lambda e: [m.value for m in e], create_type=False,
)

class CustomerAdminAuditLog(Base):
    """B2B administrator actions on B2C data, recorded in the B2C DB.
    Actor is a SNAPSHOT, never a ForeignKey — no relationship crosses the two
    Bases. Append-only (D3). No rbac import."""
    __tablename__ = "customer_admin_audit_logs"

    customer_admin_audit_log_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)

    # actor snapshot (no FK to B2B users)
    admin_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    admin_email:  Mapped[str] = mapped_column(String(255), nullable=False)
    admin_name:   Mapped[Optional[str]] = mapped_column(String(150), nullable=True)
    admin_role:   Mapped[Optional[str]] = mapped_column(String(40), nullable=True)

    environment:  Mapped[str] = mapped_column(String(8), nullable=False, server_default=text("'b2c'"))

    action:       Mapped[str] = mapped_column(String(100), nullable=False)
    entity_type:  Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    entity_id:    Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    outcome:      Mapped[AdminAuditOutcome] = mapped_column(_ADMIN_AUDIT_OUTCOME, nullable=False)

    #: Retention bucket derived from `action`: 'financial' | 'security' | 'ordinary' (D4).
    retention_class: Mapped[str] = mapped_column(String(12), nullable=False, server_default=text("'ordinary'"))

    previous_value: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)  # redacted business fields only
    new_value:      Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)  # redacted; for PARTIAL, step results
    reason:         Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    request_id:   Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)  # or ws ticket/connection id
    ip_address:   Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    browser:      Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    device:       Mapped[Optional[str]] = mapped_column(String(120), nullable=True)

    created_at:   Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("ix_cust_admin_audit_actor", "admin_user_id"),
        Index("ix_cust_admin_audit_entity", "entity_type", "entity_id"),
        Index("ix_cust_admin_audit_action", "action"),
        Index("ix_cust_admin_audit_outcome", "outcome"),
        Index("ix_cust_admin_audit_retention", "retention_class"),
        Index("ix_cust_admin_audit_created", text("created_at DESC")),
    )
```

(Changes from the draft: 4-value `outcome`; added `retention_class`; added `outcome`/`retention_class` indexes; `request_id` doubles as the WS ticket/connection id.)

---

## 3. Audit event catalogue

**Writes (always audited), with outcomes:**

| Module | `action` | entity_type | Outcomes |
|---|---|---|---|
| Cancellations | `cancellation.approve` / `cancellation.reject` | `customer_cancellation` | SUCCESS / FAILURE / DENIED |
| Refunds (maker) | `refund.execute` | `customer_refund_attempt` | SUCCESS / FAILURE / DENIED |
| Refunds (checker) | `refund.authorize` | `customer_refund_attempt` | SUCCESS / FAILURE / DENIED |
| Refunds | `refund.manual_record` | `customer_refund_attempt` | SUCCESS / FAILURE / DENIED |
| Refunds | `refund.resolve_failed` | `customer_refund_attempt` | SUCCESS / FAILURE / DENIED |
| Refunds | `refund.reconcile_run` | (batch) | SUCCESS / **PARTIAL** / FAILURE / DENIED |
| Payments | `payment.verify` / `payment.reconcile` | `payment_provider_event` / `customer_*_payment` | SUCCESS / PARTIAL / FAILURE / DENIED |
| Bookings | `booking.update` / `booking.cancel` | `customer_*_booking` | SUCCESS / FAILURE / DENIED |
| Customer mgmt | `customer.block` / `.unblock` / `.reset_password` *(if present)* | `customer` | SUCCESS / FAILURE / DENIED |
| Catalogue | `catalogue.create` / `.update` / `.delete` | `customer_hotel`/`_package`/`_destination` | SUCCESS / FAILURE / DENIED |
| Reviews | `review.moderate` | `customer_review` | SUCCESS / FAILURE / DENIED |
| Communication | `communication.send` | `customer` / `customer_conversation` | SUCCESS / FAILURE / DENIED |
| Support chat | `chat.claim` / `chat.close` / `chat.note` | `customer_conversation` | SUCCESS / FAILURE / DENIED |
| **WiFi calling** | `call.accept` / `call.reject` / `call.transfer` | `customer_call` | SUCCESS / FAILURE / DENIED — correlated by WS ticket (D5) |

**Sensitive reads / egress (audited per D2, de-duplicated, post-response):**

| Module | `action` | entity_type |
|---|---|---|
| Customer mgmt | `customer.view_detail` | `customer` |
| Payments | `payment.view_detail` | `customer_*_payment` |
| Bookings | `booking.view_detail` | `customer_*_booking` |
| Reports | `report.export` | report type |
| Documents | `document.download` | document / e-ticket **[NV — confirm endpoints]** |

**Verified against the routers (review requirement 1–5):** cancellation/refund maker-checker ✓ (two actors, two events); payment verify **and** reconcile are **separate** events ✓; document access/export covered via `report.export` + `document.download` ([NV] exact document endpoints); support + WiFi-calling admin events covered via `chat.*` + `call.*` correlated by the WS ticket ✓.

---

## 4. Existing-logging compatibility plan (D1)

- **Dual-write** in Phase A: `customer_admin_audit_service.record(...)` (authoritative) **and** the existing `activity_service.log_activity(...)` description row (for the Admin System-Logs screen, the dashboard and Active Users).
- **No duplication of sensitive data:** the `system_logs` row remains a plain description; before/after payloads live only in the new table (redacted).
- **Removal is deferred** to Phase C behind its own approval, after confirming no consumer depends on the B2C-admin `system_logs` rows. B2B `system_logs` usage (sessions/presence/B2B activity) is never touched.

---

## 5. Append-only security design (D3) + secrets (review req. 9)

- Writer service only `INSERT`s; no UPDATE/DELETE endpoint; read API is list/detail only, gated by a new `b2c.audit.view` scope (B2C domain).
- Recommended `BEFORE UPDATE OR DELETE` trigger raising an exception; table/trigger owned by the DDL role; app role granted **only INSERT + SELECT**.
- **Secrets never stored:** payloads pass through a redactor reusing `audit_service.SENSITIVE_KEY` (`password|_hash$|token|secret|otp_code|api_key`) **on write**, and only the specific changed business fields are recorded — never whole rows, never passwords/OTPs/tokens/payment credentials. Clean at rest (stronger than B2B `audit_logs`, which redacts on read).

---

## 6. Correlation-ID design (D5) — see §1 D5. Reuses `_REQUEST_META`; extends the existing middleware; per-run id for sweeps; WS ticket for socket events. No new middleware created in this spec.

---

## 7. Hand-written migration design — revision `0095`

- **File:** `backend/alembic/versions/0095_customer_admin_audit_logs.py`, `down_revision = "0094_customer_refund_attempts"` (single shared `alembic_version`).
- **upgrade():**
  1. `op.execute("CREATE TYPE customer_admin_audit_outcome_enum AS ENUM ('success','failure','denied','partial')")`
  2. `op.create_table("customer_admin_audit_logs", ...)` — all columns, `server_default=sa.text('now()')` on `created_at`, `environment`/`retention_class` server defaults, the six indexes.
  3. *(D3, recommended)* `CREATE FUNCTION fn_block_customer_admin_audit_mutation() RETURNS trigger ... RAISE EXCEPTION` + `CREATE TRIGGER ... BEFORE UPDATE OR DELETE`.
  4. *(D3, DBA step — documented, not in the Python migration unless approved)* `REVOKE UPDATE, DELETE, TRUNCATE` / `GRANT INSERT, SELECT` to the app role.
- **downgrade():** drop trigger + function (if created), `op.drop_table(...)`, `op.execute("DROP TYPE customer_admin_audit_outcome_enum")`.
- **Hand-written, not autogenerated** (env.py targets the legacy Base). Verify on a disposable/CI Postgres before any approved apply — **never** against production. This spec creates nothing.

---

## 8. File-by-file implementation sequence (proposed — nothing executed)

1. `backend/app/models_customer.py` — add `AdminAuditOutcome` + `_ADMIN_AUDIT_OUTCOME` + `CustomerAdminAuditLog`.
2. `backend/app/auth/rbac.py` — add `P.B2C_AUDIT_VIEW = "b2c.audit.view"` to `B2C_SCOPES`.
3. `backend/app/services/customer_admin_audit_service.py` (new) — `record(...)` (snapshot actor, redact, derive `retention_class`, read `request_id` from `current_request_meta()`, write SUCCESS in-txn vs FAILURE/DENIED out-of-txn). No rbac import.
4. `backend/app/services/activity_service.py` — extend `request_context`/meta to include `request_id`; add a `bind_run_id(...)` helper for sweeps.
5. `backend/app/main.py` — extend the **existing** `request_metadata` middleware to set `request_id` (inbound header or UUID4); echo `X-Request-ID`. *(Only if approved — D5.)*
6. `backend/app/routers/admin_cancellations.py` — add `record(...)` at each decision point (dual-write with `_audit()` per D1); SUCCESS in the state-change txn, FAILURE/DENIED independently.
7. Other B2C admin routers (`customer_admin, admin_customer_bookings, admin_reconciliation, customer_payment_admin, admin_reviews, admin_communication, admin_catalogue*, admin_chat`) — add `record(...)` for writes + the D2 sensitive reads/exports/calls.
8. `backend/app/schemas/customer_admin_audit.py` (new) + a read endpoint `GET /api/admin/b2c-audit` behind `b2c.audit.view`.
9. `backend/alembic/versions/0095_customer_admin_audit_logs.py` (new) — §7.
10. `tests/verify_customer_portal.py` — assert the table is on the B2C Base and has no cross-Base FK.
11. `backend/tests/test_customer_admin_audit*.py` (new) — §9.

**Not touched:** `database/session.py`, `get_db`, engine/pool, `alembic/env.py` target metadata, `models_v2`, `customer_audit_logs`, `audit_logs`/`fn_write_audit_log`. One database; no second engine/session/Alembic.

---

## 9. Test & regression plan

- **SUCCESS** writes one row (actor snapshot, action, entity, redacted payload, `request_id`, `retention_class`) **in the same transaction**; if the business txn rolls back, **no row remains** (no false success).
- **FAILURE** records a row with `outcome='failure'` + reason even though the business txn rolled back (independent commit).
- **DENIED** — a B2B-only admin (no `b2c.*`) hitting a B2C admin action records `outcome='denied'` (or is simply 403 with a denial row), and the `GET /api/admin/b2c-audit` read itself requires `b2c.audit.view`.
- **PARTIAL** — a reconciliation run with mixed results records `outcome='partial'` with per-step detail.
- **Maker-checker** — `refund.execute` and `refund.authorize` are two rows, distinct actors, correlated by entity + `request_id`.
- **Append-only integrity** — no API edits/deletes; if the trigger is adopted, UPDATE/DELETE raises.
- **Secret redaction** — payloads never contain any `SENSITIVE_KEY` value.
- **Logical separation** — a B2C-admin action adds a row to `customer_admin_audit_logs` and **zero** to `customer_audit_logs` and B2B `audit_logs` (the `system_logs` description row is the intended Phase-A compatibility write).
- **Correlation** — the audit `request_id` matches the request's `X-Request-ID`; a sweep-originated row carries the per-run id; a WS call event carries the ticket id.
- **No regressions** — Stage 1 suites (refund maker-checker, permission isolation, gaming) + the broader backend suite stay green; pre-existing failures stay clearly separate.

---

## 10. Remaining business/legal decisions (need your approval before/at implementation)

1. **D1 Phase C timing** — when (and whether) to stop the `system_logs` B2C-admin write, after confirming no dashboard/report/monitoring consumer. *(Phase A dual-write proceeds on approval; Phase C is a later separate approval.)*
2. **D3 DB trigger + grants** — approve the append-only trigger and the `INSERT/SELECT`-only app-role grant (a DBA step alongside the migration).
3. **D4 retention periods** — the actual durations per category (financial / security / ordinary) and the purge/legal-hold mechanism — **pending business/legal approval**; no auto-deletion ships.
4. **D5 correlation id** — approve extending the existing middleware to set `request_id` (+ the per-run id for sweeps).
5. **D2 document endpoints** — confirm the exact B2C-admin document/e-ticket download endpoints to audit **[NV]**.
6. **Overall go-ahead** to implement Stage 2 (model + hand-written `0095` + writer service + per-router calls + read endpoint + tests) on the local dev codebase.

---

## 12. Final pre-implementation verification (2026-11-12)

### 12.1 Verified document-download / export endpoint inventory

Searched every router for file responses (`FileResponse`/`StreamingResponse`/`Response` + `Content-Disposition`) and verified each implementation — not assumed.

| # | File · function | Method · route | Existing authorization | Data returned | Proposed audit event |
|---|---|---|---|---|---|
| 1 | `admin_b2c_reports.py` · `export_report` [V:90-111] | `GET /api/admin/b2c-reports/export?type=&format=csv\|xlsx\|pdf` | `require_scope(B2C_REPORTS_EXPORT, CUSTOMER_VIEW)` | CSV/XLSX/PDF of B2C customer/booking/payment/financial report rows (≤ `ROW_CAP`), `Content-Disposition: attachment` | `report.export` — entity = report type; `new_value` = {format, row_count, filters}; `retention_class` = financial. **Already** writes `log_change(...)` then `db.commit()` → the audit row rides the **same commit** (atomic). |
| 2 | `admin_b2c_reports.py` · `preview_report` [V:71-80] | `GET /api/admin/b2c-reports/preview` | `require_scope(B2C_REPORTS_VIEW, CUSTOMER_VIEW)` | Row count, total, first rows (sensitive B2C data on screen) | `report.preview` — sensitive read, **de-duplicated** (D2), post-response |
| 3 | `admin_chat.py` · `download_attachment` [V:426-445] | `GET /api/admin/chat/attachments/{attachment_id}` | `get_current_b2c_admin` (Stage 1 B2C gate) | **Any** conversation's uploaded file — a customer-uploaded document/identity/travel file. Deliberately unscoped (agents read every thread). | `document.download` — entity = `chat_attachment/{id}` (+ conversation); the highest-sensitivity egress; `retention_class` = security |
| 4 | `admin_chat.py` · `send_attachment` [V:381-424] | `POST /api/admin/chat/conversations/{id}/messages/attachment` | `get_current_b2c_admin` | admin uploads a file into a conversation (write) | `chat.attachment_send` |

**Not B2C (excluded, verified):** `documents.py` is **B2B** — `prefix="/api"`, `from app.models_v2 import DocumentType`, gated by `require(P.DOCUMENT_UPLOAD/TICKET_VIEW/DOCUMENT_VERIFY)` over `request_documents`/`service_requests` [V `documents.py:18-24,84,105,124,173`]; `passport_ocr.py`, `reports.py`, `super_admin.py`, `tickets.py`, `group_bookings.py`, `wallet.py`, `providers.py`, `payment_admin.py`, `support_tickets.py` are all B2B. `eticket.py` (owner/public) is **customer-facing**, not an admin download. **No other B2C-admin file-download endpoint exists** — the B2C admin egress surface is exactly rows 1–4 above.

### 12.2 Audit transaction-integrity design

Two write modes in `customer_admin_audit_service`, chosen per call site by who owns the commit:

- **`record_in_session(db, ...)` — SAME transaction (atomic).** The audit row is added to the caller's session and committed by the caller's existing `db.commit()`. If the audit insert fails, the caller's commit fails and the **business change rolls back too** (fail-closed — no un-audited change). Used where the **router/service owns the terminal commit**: report export [V: already `log_change`+`commit`], catalogue create/update/delete, review moderation, communication send, chat claim/close/note. **A rollback here can never leave a false SUCCESS** — both rows live or die together.
- **`record_independently(...)` — fresh `SessionLocal()` (isolated).** Opens its own session, writes+commits only the audit row, never flushing the caller's pending business state. Used for **(a) every FAILURE and DENIED**, and **(b) SUCCESS of services that commit internally** (refunds/payments — see below).

**Per operation:**

| Operation | Commit reality | Audit mode | Outcome mapping |
|---|---|---|---|
| **Refund execute** (`customer_refund_service` [V:430-499]) | service commits internally at each outcome (FAILED/PROCESSING/MANUAL_REQUIRED/…) and **returns the outcome string** | `record_independently` **after** the call | returned `succeeded`→SUCCESS; `failed`→FAILURE; `manual_required`/`uncertain`→PARTIAL (+ provider status in `new_value`); `processing`→SUCCESS-of-submission (provider not yet confirmed, noted) |
| **Refund authorize** (checker) | same | `record_independently` after the call | as above; a **separate** row from execute, same `entity_id`+`request_id` → maker-checker pair |
| **Cancellation approve/reject** | state-machine in `customer_cancellation_admin_service`; router owns commit where applicable | `record_in_session` on success / `record_independently` on failure | SUCCESS/FAILURE/DENIED |
| **Booking change** | service/router commit | `record_in_session` on success | SUCCESS/FAILURE/DENIED |
| **Payment verify** | reads/updates provider-event state | `record_in_session` where the router commits; else independent | SUCCESS/FAILURE |
| **Payment reconcile** (batch) | processes many | `record_independently` after run | **PARTIAL** when mixed; `new_value` lists per-item results |

**Why SUCCESS is never false on rollback:** for internally-committing services, the business state is durably committed *before* the service returns its outcome; the router then writes the audit reflecting that committed outcome, so a rolled-back attempt returns a non-success and is recorded as FAILURE/PARTIAL — never SUCCESS. For router-owned commits, the audit shares the transaction, so a rollback removes the SUCCESS row with it.

**Audit-writer failure handling:**
- *In-session mode:* an audit-insert failure fails the shared commit → business change rolls back → request errors (fail-closed). No un-audited state change.
- *Independent mode:* wrapped in `try/except`; on failure, log at **ERROR** with full context and emit an alert metric; the business response is unchanged (the committed money action cannot be undone, and FAILURE/DENIED protect no business state). This is a **lost-audit alert**, never a silent drop and never a false SUCCESS.
- *DENIED* is raised at the Stage 1 gate before any handler/business work, so its independent write commits only the denial row.

### 12.3 Final migration `0095` — reviewable specification (NOT executed)

```python
"""0095 customer_admin_audit_logs — B2C administrative audit trail (Stage 2).

Hand-written (alembic/env.py targets the legacy Base, so autogenerate does not
see models_customer). Creates the enum type, the table, its indexes and the
append-only trigger. No GRANT/REVOKE here — the privilege change (D3) is a
separate, explicitly-authorized DBA step.
"""
revision = "0095_customer_admin_audit_logs"
down_revision = "0094_customer_refund_attempts"
branch_labels = None
depends_on = None

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

OUTCOME = "customer_admin_audit_outcome_enum"

def upgrade() -> None:
    op.execute(f"CREATE TYPE {OUTCOME} AS ENUM ('success','failure','denied','partial')")
    op.create_table(
        "customer_admin_audit_logs",
        sa.Column("customer_admin_audit_log_id", sa.BigInteger, primary_key=True),
        sa.Column("admin_user_id", sa.BigInteger, nullable=False),          # no FK (cross-Base)
        sa.Column("admin_email", sa.String(255), nullable=False),
        sa.Column("admin_name", sa.String(150)),
        sa.Column("admin_role", sa.String(40)),
        sa.Column("environment", sa.String(8), nullable=False, server_default=sa.text("'b2c'")),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("entity_type", sa.String(60)),
        sa.Column("entity_id", sa.String(64)),
        sa.Column("outcome", postgresql.ENUM(name=OUTCOME, create_type=False), nullable=False),
        sa.Column("retention_class", sa.String(12), nullable=False, server_default=sa.text("'ordinary'")),
        sa.Column("previous_value", postgresql.JSONB),
        sa.Column("new_value", postgresql.JSONB),
        sa.Column("reason", sa.Text),
        sa.Column("request_id", sa.String(64)),
        sa.Column("ip_address", sa.String(64)),
        sa.Column("browser", sa.String(120)),
        sa.Column("device", sa.String(120)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_cust_admin_audit_actor", "customer_admin_audit_logs", ["admin_user_id"])
    op.create_index("ix_cust_admin_audit_entity", "customer_admin_audit_logs", ["entity_type", "entity_id"])
    op.create_index("ix_cust_admin_audit_action", "customer_admin_audit_logs", ["action"])
    op.create_index("ix_cust_admin_audit_outcome", "customer_admin_audit_logs", ["outcome"])
    op.create_index("ix_cust_admin_audit_retention", "customer_admin_audit_logs", ["retention_class"])
    op.execute(
        "CREATE INDEX ix_cust_admin_audit_created "
        "ON customer_admin_audit_logs (created_at DESC)"
    )
    # Append-only (D3): reject UPDATE/DELETE at the database.
    op.execute("""
        CREATE OR REPLACE FUNCTION fn_block_customer_admin_audit_mutation()
        RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'customer_admin_audit_logs is append-only';
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("""
        CREATE TRIGGER trg_block_customer_admin_audit_mutation
        BEFORE UPDATE OR DELETE ON customer_admin_audit_logs
        FOR EACH ROW EXECUTE FUNCTION fn_block_customer_admin_audit_mutation();
    """)

def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_block_customer_admin_audit_mutation ON customer_admin_audit_logs")
    op.execute("DROP FUNCTION IF EXISTS fn_block_customer_admin_audit_mutation()")
    op.drop_table("customer_admin_audit_logs")      # drops its indexes with it
    op.execute(f"DROP TYPE IF EXISTS {OUTCOME}")
```

- **Ownership & privilege (D3, separate DBA authorization):** table/trigger/function owned by the Alembic/DDL role; the application login is granted **`INSERT, SELECT` only** — `REVOKE UPDATE, DELETE, TRUNCATE`. Issued out-of-band alongside the migration, not inside this Python file, and not executed by this spec.
- **Safe downgrade:** drops trigger → function → table (indexes fall with it) → type, each `IF EXISTS`. The downgrade **destroys audit history** — so it is gated behind the same approval as any destructive op and never run against a populated environment without explicit sign-off; normal rollback of a bad deploy reverts *code*, not this migration.
- **Verification before any approved apply:** run upgrade+downgrade on a disposable Postgres 16 (or the CI `postgres-migrations` job). Confirm the enum, the append-only trigger (an UPDATE/DELETE raises), and that the chain `0094 → 0095` is linear with a single head. **Not** against production.

### 12.4 Remaining risks and assumptions

- **Refund/payment SUCCESS is post-commit** (independent-mode) because those services commit internally; making it strictly same-transaction would require refactoring a money path (rejected for Stage 2). Mitigation: SUCCESS only on confirmed success + lost-audit alerting.
- **`report.preview` auditing** (row 2) adds read volume; mitigated by D2 de-duplication. Confirm during implementation it is not a hot path.
- **Customer-management mutations** (`customer.block`/`reset_password`) are listed **conditionally** — `customer_admin` currently exposes list + detail; the exact mutation endpoints are confirmed at implementation before wiring their events.
- **`request_id` for WS events** uses the socket ticket (D5); a ticket is per-connection, so multiple call events share one correlation id — acceptable and documented.
- **Decisions still pending (business/legal / DBA):** D1 Phase-C removal timing; D3 trigger + grant execution (DBA); D4 retention durations; D5 middleware extension; final go-ahead — see §10.

---

## 13. Transaction-integrity correction — refund atomicity + attachment lifecycle (2026-11-12)

Supersedes §12.2's "independent fresh session for refund/payment SUCCESS". The refund SUCCESS audit is now **atomic with the state change**, so a succeeded refund can never exist without its audit row.

### 13.1 Inspection — where a refund becomes SUCCEEDED

`apply_provider_refund()` is, by its own contract, **"the ONLY place an attempt becomes succeeded"** [V `customer_refund_service.py:516`]. The success path is a **single** terminal commit [V:561-567]:
```python
if refund.status == P_REFUNDED:
    attempt.status = SUCCEEDED
    attempt.completed_at = _now()
    attempt.failure_reason = None
    _finalise_success(db, attempt)
    db.commit()            # the one and only SUCCEEDED commit
    return SUCCEEDED
```
Two properties make this ideal:
- **Idempotent** — a repeat/duplicate delivery finds `status == SUCCEEDED` and returns harmlessly without a second commit [V:526-528].
- **Re-driven by reconciliation** — an attempt left `processing`/`uncertain` is finalized later by the existing `refund.reconcile` sweep, which calls `apply_provider_refund` again [V:502-512]. The provider is always re-queried via its authenticated API (never a webhook) [V:519-520].
- Both the synchronous admin `execute` path **and** the reconciliation sweep flow through this one function, so a hook here covers both.

### 13.2 Approaches compared

| | Approach | Atomicity | Risk to the money path | Verdict |
|---|---|---|---|---|
| **A** | **Transactional outbox** — write an outbox row in the refund txn; a relay moves it to the audit table | Yes | The audit sink is the **same database**, so a relay/worker/delivery-tracking adds a moving part and a new sweep for **no cross-system benefit**. More code on a money path. | Over-engineered here |
| **B** | **Refactor so the caller owns the transaction** (service stops committing; router commits refund + audit once) | Yes | **High.** The intermediate `db.commit()` at [V:460] ("releases the payment lock; the row now counts") is deliberately **before** the external provider call so a crash leaves a durable `processing` row for reconciliation. Removing the service's internal commits rewrites the crash-safety + locking model of a live money path. | Rejected |
| **C** | **In-transaction audit at the single SUCCEEDED commit**, via a pre-commit hook the router injects | Yes | **Low.** One added `db.add(audit_row)` inside the existing terminal transaction; the lock release at :460, balance caps, provider verification, idempotency key and reconciliation are **untouched**. | **Recommended** |

**Recommended: C.** It gives B's atomicity with A-level durability but the smallest possible change, and it reuses the existing idempotency + reconciliation as the retry path.

### 13.3 Design of approach C

- The money-success audit is written **in the same transaction** as the transition to `SUCCEEDED`: the audit row is `db.add(...)`-ed to the refund's own session immediately **before** the `db.commit()` at [V:566]. Status + audit commit together; if the audit insert raises, the commit fails, the transaction rolls back, **the attempt does not become SUCCEEDED**, and reconciliation re-drives it later. **No succeeded refund without its audit; no false SUCCESS on rollback.**
- **No coupling to HTTP/rbac.** `apply_provider_refund` / `execute` gain an optional `audit: Callable[[Session, str, CustomerRefundAttempt], None] | None = None`. The router builds the callback, closing over an already-resolved actor **snapshot** (admin id/email/name/role) and `request_id` captured before the call, and the callback only does `db.add(CustomerAdminAuditLog(...))` — no commit, no rbac import, no `Request`. `models_customer` stays rbac-free (§0 constraint).
- **Actor for the two entry points:** synchronous admin `execute`/`authorize` supply the admin snapshot; when the **reconciliation sweep** finalizes a `processing` attempt there is no HTTP admin, so the writer attributes the money-success event to the attempt's recorded `approved_by_user_id`/`initiated_by_user_id` with `action="refund.reconcile_finalize"` and the per-run correlation id (D5), rather than inventing an actor.
- **Maker-checker, idempotency, balance caps, provider verification, reconciliation, HDFC/TrustBrick — all preserved:** the only change is an extra INSERT in the existing terminal transaction. No authorization check is weakened; `refund.execute` (maker) and `refund.authorize` (checker) remain distinct authorization events recorded at their decision points.
- **FAILURE / DENIED / non-terminal** (`failed`, `manual_required`, `uncertain`, `processing`) are **not** money-success events; they are recorded via the independent-session path (§12.2) — they protect no committed money state, so a lost one is an alertable lost-attempt record, never a false success.
- **Payment reconcile batch** keeps `outcome=PARTIAL` with per-item detail (independent session, after the run).

### 13.4 Failure recovery & retry strategy

- **The retry mechanism is the existing reconciliation sweep** — no new infrastructure. If the atomic success commit (status + audit) ever fails, the attempt stays `processing`; the next `refund.reconcile` run re-queries the provider and calls `apply_provider_refund` again, which re-attempts the atomic commit. On eventual success exactly one SUCCEEDED transition commits, carrying exactly one success audit row.
- **A persistently failing audit insert** (e.g. a constraint bug) therefore **holds the refund at `processing`** rather than marking it succeeded un-audited — fail-closed, visible on the reconciliation/ops dashboards, and surfaced by the existing `uncertain`/`processing` alerting.
- Independent-session writes (FAILURE/DENIED/reads) keep the §12.2 handling: `try/except`, ERROR log + alert metric on failure, business response unchanged.

### 13.5 Duplicate-event prevention & idempotency

- **Primary guarantee:** only **one** transition to `SUCCEEDED` ever commits per attempt (the status guard at [V:526-528]), so the in-transaction success audit is written **once** by construction; a repeat sweep short-circuits before the commit and writes nothing.
- **Belt-and-braces:** a **partial UNIQUE index** on `(entity_type, entity_id, action)` for terminal financial success events, and the writer uses `INSERT ... ON CONFLICT DO NOTHING`, so no code path (execute vs reconcile) can ever double-insert a money-success row. (Proposed addition to migration `0095`.)
- **Correlation, not deduplication, links maker↔checker:** `refund.execute` and `refund.authorize` are intentionally distinct rows sharing `entity_id` (+ `request_id`); they are never collapsed.

### 13.6 Attachment-download audit lifecycle (`admin_chat.download_attachment` [V:426-445])

Flow: `get_current_b2c_admin` gate → `chat.attachment_for_admin(db, id)` (raises `ChatNotFound`) → `attachments.download(attachment)` (serves the file).

| Lifecycle point | Exact location | Audit event |
|---|---|---|
| **Denied access** | the `get_current_b2c_admin` dependency raises 403 (not admin / no `b2c.*`) — before the handler body | `document.download`, `outcome=DENIED`, `entity_id` = attachment id from the path, actor snapshot, **no file data** — independent session |
| **Failed retrieval — not found** | `except ChatNotFound` branch, before the 404 | `outcome=FAILURE`, `reason="attachment not found"` — independent session |
| **Failed retrieval — file missing on disk** | `attachments.download` raises (missing/unreadable file), caught and mapped to 5xx | `outcome=FAILURE`, `reason="stored file unavailable"` — independent session |
| **Successful retrieval** | after `attachment_for_admin` resolves and the file is confirmed and handed to the response, just before returning | `outcome=SUCCESS` with **metadata only**: attachment id, conversation id, filename, content_type, byte size — independent session, **de-duplicated** per D2 (same actor+attachment within the window → one row + repeat count) |

- **Authorized vs successful are separate facts:** passing the gate (authorized) is necessary but the event recorded is the *retrieval* (SUCCESS/FAILURE); a DENIED event is written only when the gate refuses.
- **Never stored:** file bytes/content, credentials, tokens, signed URLs, or any sensitive file data — only the metadata above.
- A download opens **no business transaction**, so there is no atomicity concern here; the independent-session write + D2 de-duplication is the correct, lowest-overhead choice. A lost download audit is an alertable lost-read record (never a money-integrity issue).

### 13.7 Updated tests for audit-write failure

- **Refund atomicity (C):** with the success-audit insert forced to raise (monkeypatched), `apply_provider_refund` **rolls back** — the attempt is **not** `SUCCEEDED` (stays `processing`), no success audit row exists, and a subsequent reconciliation re-drive commits exactly one SUCCEEDED + one success audit. Asserts **no succeeded-without-audit** and **no duplicate** success audit.
- **Idempotent success audit:** running `apply_provider_refund` twice (duplicate delivery / repeat sweep) yields exactly **one** success audit row (status guard + `ON CONFLICT DO NOTHING`).
- **Independent-write failure (FAILURE/DENIED/reads):** with the independent writer forced to raise, the business response is unchanged and an ERROR/alert is emitted (asserted via a captured logger/metric), and no business state is mutated.
- **Attachment lifecycle:** DENIED (B2B-only admin → 403 + denial row), FAILURE (unknown id → 404 + failure row), SUCCESS (valid id → file served + one metadata row, no bytes), and de-duplication of repeated downloads.
- Plus the §9 suite (success/failure/denied/partial, maker-checker two rows, redaction, logical separation, no regressions).

### 13.8 Remaining technical limitations

- **Approach C adds one parameter** (`audit` callback) to `apply_provider_refund`/`execute`. It is optional/default-None, so existing callers and tests are unaffected until wired; still, it is a touch to a money-path signature and must be reviewed with the refund suite green.
- **Reconciliation-finalized refunds** attribute the money-success event to the stored approver + a reconcile tag, not to a live admin — correct, but means some success rows are system-attributed; documented, not a defect.
- **Non-success refund outcomes** remain independent-session (acceptable — no committed money state to protect); their loss is alertable, not a false success.
- **The belt-and-braces UNIQUE index** assumes a stable natural key for terminal financial events (`entity_type,entity_id,action`); confirmed sufficient because only one SUCCEEDED transition is possible per attempt.

---

## 11. Restriction confirmation

No table created · no model added · no migration generated or run · no database connection or change · no production access · no deployment · no git commit/push · no payment/refund · Gaming untouched and still disabled. **This document is specification text only.**

**Awaiting your explicit authorization before implementing Stage 2.**
