# Stage 2 — B2C Administrative Audit Logging: Recovery & Verification Progress

**Status at handover takeover (2026-11-12):** the previous session's Stage-2 code is **present in the working tree, uncommitted, and now verified sound at the foundation level**. No migration executed, no DB connection to the project database, no commit/push, no deploy. Gaming remains disabled.

This note is the continuity record for the next session. It supersedes nothing; it records what was inspected, what is verified, what was fixed, and what remains.

---

## 1. Architecture note (important)
The handover's approved architecture is **ONE PostgreSQL database with logical (separate-`Base`) separation** — B2C audit lives on `models_customer.Base`, single engine/session/Alembic history. This **reverses** the "two physical databases" direction captured earlier in `docs/B2C_DATABASE_SEPARATION_PLAN.md` / `docs/STAGE_A_FILE_LEVEL_SPEC.md` (now superseded; `docs/B2C_LOGICAL_SEPARATION_*` is the current line). All Stage-2 work below follows the single-DB / logical-separation model.

## 2. Reported Stage-2 changes — VERIFIED present & coherent (A–F)
Verified by reading the actual diff + an import smoke test, not by trusting the handover.
- **A. Model** `CustomerAdminAuditLog` + `AdminAuditOutcome` (`success/failure/denied/partial`) on `models_customer.Base`; actor is a **snapshot** (`admin_user_id` plain `BigInteger`, **no cross-Base FK**); partial unique index deliberately deferred to migration 0095; enum `create_type=False` (migration owns `CREATE TYPE`; SQLite renders a checked VARCHAR). `backend/app/models_customer.py`.
- **B. Permissions** full `b2c.*` scope namespace incl. `b2c.audit.view`; `B2C_SCOPES` frozenset; new `require_scope()` / `require_b2c_access()` enforced via explicit `users.permissions` grants (NOT the role-default matrix) — so a role-default B2B admin gains no B2C access. `backend/app/auth/rbac.py`.
- **C. Writer** `backend/app/services/customer_admin_audit_service.py`: `record_in_session`, `record_independently`, `build_entry`, `success_hook`; redaction via `audit_service.redact_values`; retention-class derivation; actor snapshot; request-id from the ContextVar. No circular import (imports only `activity_service`, `audit_service`, `SessionLocal`, `models_customer`).
- **D. Request correlation** `activity_service.request_context` now carries `request_id` (reuses a safe inbound `X-Request-ID`/`X-Correlation-ID`, else uuid4); `new_run_meta(label)` for background sweeps. `backend/app/services/activity_service.py`.
- **E. Refund atomicity (Approach C) — VERIFIED CORRECT.** Optional `audit` callback threaded `initiate_refund → authorize_refund → dispatch_attempt → apply_provider_refund` with **no change to maker-checker logic**. In `apply_provider_refund`, on `SUCCEEDED`: `_finalise_success()` → `audit(db, SUCCEEDED, attempt)` (adds the row to the same txn) → `db.commit()`. If the audit raises, the commit is never reached, the SUCCEEDED transition rolls back, the attempt stays `PROCESSING`, and reconciliation re-drives it — no succeeded-without-audit and no false success. Reconciliation callers (`handle_refund_event`, `reconcile_pending_refunds`) pass a **system-actor** hook (`_system_refund_audit()` → `refund.reconcile_finalize`). `backend/app/services/customer_refund_service.py`.
- **F. Attachment audit** `admin_chat`: `get_current_b2c_admin` on every route; download emits DENIED / FAILURE / SUCCESS with **metadata only** (conversation id, filename, content type — never bytes/credentials). `backend/app/routers/admin_chat.py`.
- Also present (B2C isolation, Stage 1B): `get_current_b2c_admin` gating across the B2C admin routers; gaming fail-closed across backend/frontend/mobile/sitemap.

## 3. Foundation verification (Stage 2A) — results
- **Import smoke test: PASS** — `app.main` imports clean; `customer_admin_audit_logs` registered on the customer `Base`; enum has 4 values; `b2c.audit.view` in `B2C_SCOPES`; writer functions present; **no Base overlap** between `models_customer` and `models_v2`.
- **Stage-2 test set: 131 passed** (`test_customer_refunds`, `test_customer_refunds_http`, `test_rbac`, `test_b2c_permission_isolation`, `test_admin_chat_b2c_isolation`, `test_gaming_fail_closed`). The refund set includes the idempotent-reconcile and two-person-flow tests.

### Fixes applied this session (TEST HARNESS ONLY — production code unchanged)
These made the already-written Stage-2 code actually runnable; they are not changes to behaviour.
1. `backend/tests/test_customer_refunds.py` — import `CustomerAdminAuditLog` and add `CustomerAdminAuditLog.__table__` to the curated `_tables()` (the sqlite harness builds a table subset; the refund success-hook now writes the audit row, so its table must exist). Also fixes `test_customer_refunds_http.py`, which reuses `_tables()`.
2. `backend/tests/conftest.py` — add `CustomerAdminAuditLog.__table__` to the shared `db` fixture's `create_all` list (server defaults are plain literals, safe on SQLite).
3. `backend/tests/test_b2c_permission_isolation.py` — rename the `app` fixture → `api_app` to avoid the `pytest-flask` plugin hijacking any fixture named `app` (it called `app.response_class` on a FastAPI object). Pure test-tooling fix.

## 4. Broader suite — pre-existing failures (NOT caused by this work)
Full backend run: **1666 passed, 44 failed, 4 skipped.** All 44 failures are outside Stage-2 audit scope and are **not** caused by the audit code or the harness fixes:
- `tests/test_token_revocation.py` (**untracked** file; other uncommitted security work) — fails with JWT `ExpiredSignatureError` in token minting; relates to `security.py`/`auth_service.py`, not B2C audit.
- `tests/test_admin_supplier_reservation_http.py` — uses its own `db` fixture (not conftest's); exercises the supplier-reservation state machine.
Per the handover these unrelated tests were left unchanged.

## 5. Work still outstanding (Stages 2B–2F)
1. **2B — Migration `0095`** (revision `0095`, down_revision `0094`): `CREATE TYPE customer_admin_audit_outcome_enum`; `customer_admin_audit_logs` table + all columns/indexes matching the model; **partial unique index** (one terminal financial-success per attempt); **append-only** trigger+function (BEFORE UPDATE/DELETE); safe downgrade. **Create only — do NOT execute.**
2. **2C — Read API** `GET /api/admin/b2c-audit`: `b2c.audit.view`, pagination, filters (action/actor/entity/outcome/date), safe redacted response schema, no edit/delete.
3. **2D — Request-ID middleware** echo/set in `main.py`; `bind_run_id` into background sweeps via `activity_service.new_run_meta`.
4. **2E — Event wiring** into verified B2C ops: customer admin, detail reads, booking changes, cancellation/refund (refund SUCCESS already via Approach C), payment verification, payment reconciliation, catalogue, reviews, communication, report preview/export, chat upload (download already done). Not ordinary list/nav views.
5. **2F — `verify_customer_portal.py`** Stage-2 assertions; full regression.

## 6. Constraint confirmations (this session)
No migration executed · no connection to the project/staging/production DB (tests used throwaway in-memory SQLite) · no DBA grants · no deploy · **no git commit/push** · no real payment/refund · Gaming Packages remain disabled (`test_gaming_fail_closed` passes) · no legacy model/table/record removed or renamed · no reset/stash/revert of existing working-tree changes.

---

## 7. Stage 2B — migration 0095 (CREATED, NOT EXECUTED) — 2026-11-12

**File:** `backend/alembic/versions/0095_customer_admin_audit_logs.py`
**Revision:** `0095_customer_admin_audit_logs` · **down_revision:** `0094_customer_refund_attempts` (single shared Alembic history; no second history).

**Pre-write verification:** head was `0094_customer_refund_attempts` (nothing had `down_revision=0094`, no `0095` existed); enum/PG conventions taken from sibling migrations (`CREATE TYPE … AS ENUM` + `postgresql.ENUM(create_type=False)`); columns/indexes taken from the committed `CustomerAdminAuditLog` model (not the spec skeleton, which differed on two `nullable` flags — the model wins, and `nullable=True` on `admin_user_id`/`admin_email` is required by the system/`None`-actor path).

**Schema summary (19 columns, matches the model):** `customer_admin_audit_log_id` BIGINT PK; actor snapshot `admin_user_id` (BIGINT, **nullable, NO FK**), `admin_email`/`admin_name`/`admin_role`; `environment` (default `'b2c'`); `action`; `entity_type`/`entity_id`; `outcome` (enum, NOT NULL); `retention_class` (default `'ordinary'`); `previous_value`/`new_value` JSONB; `reason`; `request_id`; `ip_address`/`browser`/`device`; `created_at` (tz, default `now()`).

**Enum:** `CREATE TYPE customer_admin_audit_outcome_enum AS ENUM ('success','failure','denied','partial')` — migration owns the type (model column is `create_type=False`).

**Indexes (8 model-declared + 1 partial-unique):** `ix_customer_admin_audit_logs_admin_user_id`, `ix_customer_admin_audit_logs_request_id` (column-level `index=True`); `ix_cust_admin_audit_actor`, `ix_cust_admin_audit_entity` (entity_type, entity_id), `ix_cust_admin_audit_action`, `ix_cust_admin_audit_outcome`, `ix_cust_admin_audit_retention`, `ix_cust_admin_audit_created` (`created_at DESC`); **partial UNIQUE** `uq_cust_admin_audit_financial_success` on `(entity_type, entity_id, action) WHERE outcome='success' AND retention_class='financial'` (spec §13.5 refund-success dedup — Postgres-only, deliberately not on the SQLite-portable model).

**Append-only trigger (spec D3):** `fn_block_customer_admin_audit_mutation()` → `RAISE EXCEPTION 'customer_admin_audit_logs is append-only'`; `trg_block_customer_admin_audit_mutation BEFORE UPDATE OR DELETE … FOR EACH ROW`. **No GRANT/REVOKE in the file** — the INSERT/SELECT-only app-role privilege is a separate DBA step.

**Downgrade:** drop trigger → function → table (indexes incl. partial-unique fall with it) → `DROP TYPE` — each `IF EXISTS`. Destroys audit history; gated like any destructive op.

**Offline validation (no DB):** `alembic` `ScriptDirectory` → single linear head `0095→0094→0093`; `down_revision` correct; migration module imports/parses cleanly; automated parity check — all 19 model columns and all 8 model-declared index names appear in the file. **Pending (needs a disposable Postgres 16, not run here):** actual upgrade+downgrade apply, enum creation, and the trigger refusing an UPDATE/DELETE.

**Open item for Stage 2E (writer):** the partial-unique index is belt-and-braces; the success-writer should adopt `INSERT … ON CONFLICT DO NOTHING` so a (theoretically impossible) double-insert is a no-op rather than a caught rollback. Also note: `admin_user_id` is indexed twice (column `index=True` + named `ix_cust_admin_audit_actor`) — faithful to the model; the model could drop one later (not changed in 2B).

**2B confirmations:** migration **file created only, NOT executed** · no DB connection (local/staging/prod) · no DBA grants run · no existing migration modified · single Alembic history preserved · no commit/push · no deploy · Gaming disabled.

---

## 8. Stage 2C — B2C audit read API + two review fixes — 2026-11-12

### Pre-work review items (both resolved)
1. **Redundant `admin_user_id` index removed.** The model had both a column-level `index=True` (auto `ix_customer_admin_audit_logs_admin_user_id`) and the named `ix_cust_admin_audit_actor` on the same column. Dropped the column-level `index=True` in `models_customer.py` and the matching `op.create_index(...)` in `0095`. `request_id`'s column index is kept (no duplicate). Model and migration re-verified in parity.
2. **Partial-unique index narrowed to the intended conflict only.** Was `(entity_type, entity_id, action) WHERE outcome='success' AND retention_class='financial'` — which also covered `report.export` successes, so a legitimate repeat export could have been wrongly suppressed. Now `uq_cust_admin_audit_refund_success` on `(entity_type, entity_id) WHERE outcome='success' AND entity_type='customer_refund_attempt'`. Verified from the call sites that **every** refund money-success (sync `refund.execute`/`refund.authorize` and `refund.reconcile_finalize`) is written with `entity_type='customer_refund_attempt'` and `entity_id=refund_attempt_id`, and `apply_provider_refund` fires once per attempt — so one success per attempt, **separate attempts (distinct ids) are never suppressed**, and non-refund financial successes are untouched.

### Endpoint
`GET /api/admin/b2c-audit` — read-only; **no** create/update/delete route (append-only trail). Gated by `require_scope(P.B2C_AUDIT_VIEW)` (explicit `users.permissions` grant or super-admin short-circuit — never the role-default matrix, so a role-default B2B admin is refused: B2B/B2C isolation preserved). Uses the existing single engine/session (`get_db`). Pagination (`page`/`page_size`, `Page[...]`); filters: `actor` (admin_user_id), `action`, `entity_type`, `entity_id`, `outcome`, inclusive `date_from`/`date_to`; newest-first. Values redacted on read via `audit_service.redact_values` (defence in depth over the write-time redaction). Invalid `outcome` → 422; `date_to < date_from` → 422.

### Files modified / created
- `backend/app/models_customer.py` — dropped redundant `index=True` on `admin_user_id` (modified).
- `backend/alembic/versions/0095_customer_admin_audit_logs.py` — dropped redundant index line; narrowed partial-unique index (modified; **not executed**).
- `backend/app/services/customer_admin_audit_service.py` — added `list_entries()` read function + `select`/`func` imports (modified).
- `backend/app/schemas/b2c_audit.py` — `B2cAuditEntry` safe/redacting schema (**new**).
- `backend/app/routers/b2c_audit.py` — the read endpoint (**new**).
- `backend/app/main.py` — import + `include_router(b2c_audit.router)` (modified).
- `backend/tests/test_b2c_audit_api.py` — 9 scenarios (**new**).

### Test results (actual)
- Stage-2C + prior Stage-2 regression set: **101 passed**.
- Import smoke (`app.main` + new router): **OK**.
- Model↔migration parity after the index change: **OK** (redundant index gone both sides; partial index scoped to refund attempts).
- Full backend suite: **1675 passed, 44 failed, 4 skipped** — the +9 are the new 2C tests; the 44 failures are the **same pre-existing** `test_token_revocation.py` / `test_admin_supplier_reservation_http.py` set (unrelated to this work), so **no new regressions**.

### 2C confirmations
Local dev only · migration `0095` **not executed** · no PostgreSQL connection · no DBA grants · no production change/deploy · **no git commit/push** · Gaming Packages remain disabled · no edit/delete endpoint added · B2B/B2C permission isolation preserved.

---

## 9. Stage 2D — Request-ID middleware + background/WebSocket correlation (2026-11-12)

### Implemented
- **Request-ID middleware** (`backend/app/main.py`, existing `request_metadata`): captures the request-meta dict (now carrying `request_id` from `activity_service.request_context`), binds it to `_REQUEST_META`, resets to `None` in `finally` (so an exception can never leak an id into the next request), and **echoes `X-Request-ID`** on the response (`setdefault`). An inbound `X-Request-ID`/`X-Correlation-ID` is reused when it matches `^[A-Za-z0-9._-]{1,64}$`; otherwise a UUID4 is minted. Isolation is per-request because each request runs in its own task with its own `contextvars` copy.
- **Background sweep correlation** (`main.py` `_run_completion_sweep`, `_run_payment_sweep`): each execution binds `activity_service.new_run_meta("<label>")` (`<label>:<uuid4>`) at entry and resets in `finally` even on failure. The payment sweep's run id covers the deferred-event, stale-pending and **refund-reconciliation** work, so the `refund.reconcile_finalize` audit rows it produces share one run id. System actor: those rows are attributed to the stored approver/initiator with the reconcile action name (Stage 2 §13).
- **WebSocket correlation** (`chat_gateway.serve_agent`): after the existing ticket redemption and `accept()`, binds `activity_service.ws_run_meta(ticket)` (`ws:<ticket>`) for the connection and resets in `finally`. WebSocket auth, the ticket mechanism and call signalling are unchanged — this adds only a correlation context.
- New helpers in `activity_service`: `new_run_meta(label)`, `ws_run_meta(ticket)` (plus the `request_id` field in `request_context`).

### Files modified / created
- `backend/app/main.py` — middleware echo + reset; per-run id bound/reset around both sweeps (modified).
- `backend/app/services/activity_service.py` — `request_id` in `request_context`; `new_run_meta`, `ws_run_meta` (modified).
- `backend/app/services/chat_gateway.py` — bind/reset `ws_run_meta(ticket)` around the agent socket (modified).
- `backend/tests/test_request_id_correlation.py` — 11 scenarios (**new**).

### Test results (actual)
- Stage-2D focused + Stage-2 regression set: **151 passed** (the 11 new 2D tests over the prior 140).
- Import smoke (`app.main`): **OK**.
- Full backend suite: **1686 passed, 44 failed, 4 skipped** — every failure is in the two **pre-existing** files `test_token_revocation.py` / `test_admin_supplier_reservation_http.py` (unrelated JWT-expiry/time-sensitive WIP); **no new regressions**.
- Stage 2D scenarios covered: valid inbound id, missing id, invalid id, response header, concurrent-request isolation, ContextVar cleanup after a handler exception, unique background run ids, same run id across events in one execution, background cleanup after a failed run, WebSocket ticket correlation.

### Known limitations
- The end-to-end middleware test mounts a bare app whose middleware mirrors `main.py`'s `request_metadata` byte-for-byte (same `activity_service` primitives) to stay DB/startup-free; it does not drive the real `app` object.
- No audit event is currently *emitted* from inside the raw WebSocket message loop, so `ws_run_meta` is a forward-looking correlation hook; today's admin-chat audit actions are HTTP routes already covered by `X-Request-ID`.

### 2D confirmations
Local dev only · migration `0095` **not executed** · no PostgreSQL connection · no DBA grants · no production change/deploy · **no git commit/push** · Gaming Packages remain disabled · Stage 2A/2B/2C work untouched.

### 9a. Security correction — WebSocket correlation id (2026-11-12)
**Issue:** the first 2D cut used the raw WebSocket ticket as the correlation id (`ws:<ticket>`). A ticket is an authentication credential and must never be persisted or exposed in metadata, audit rows, logs or errors.
**Fix:** `activity_service.ws_run_meta()` now takes **no argument** and mints a **fresh UUID4** per connection (`ws:<uuid4>`); `chat_gateway.serve_agent` calls it with no ticket. WebSocket authentication, ticket redemption, authorization and call-signalling are unchanged. A whole-repo grep confirms no raw-ticket-as-correlation usage remains.
**Secret-leak audit of correlation fields:** `new_run_meta(label)` uses caller-constant labels (`payment-sweep`, `booking-completion-sweep`) → `label:uuid4`; `ws_run_meta()` → `ws:uuid4`; `request_context`'s `request_id` reuses an inbound `X-Request-ID`/`X-Correlation-ID` only when it matches `^[A-Za-z0-9._-]{1,64}$` (a client-supplied correlation value echoed back to that client, not a server secret), else UUID4. No server secret can enter a correlation/audit metadata field.
**Tests added/updated:** `ws_run_meta` mints a fresh, distinct UUID (not the ticket); the raw ticket never appears in the produced meta; `new_run_meta` carries no secret; and a new **integration test drives the real `app.main` middleware** (TestClient without startup/DB — a 404 still passes through, so `X-Request-ID` is accepted-when-valid / generated-when-missing-or-invalid and echoed).
**Still unverified:** the real-app test exercises the production middleware via a 404 path (no DB/startup); a full authenticated-route pass and a live WebSocket session are not driven in tests. No audit event is emitted from the raw WS message loop today, so the per-connection id is a forward-looking hook.
**Test results (actual):** Stage-2D focused → 14 passed; Stage-2D + Stage-2 regression set → **154 passed**; full backend suite → **1689 passed, 44 failed, 4 skipped** — all 44 failures in the pre-existing `test_token_revocation.py` / `test_admin_supplier_reservation_http.py` (no new regressions).

---

## 10. Stage 2E — Remaining B2C admin audit event coverage (2026-11-12)

### Coverage matrix (after 2E)
| Area | Route | Action / entity / outcomes | Write mode / txn | Status |
|---|---|---|---|---|
| Refund maker | POST /api/admin/cancellations/{id}/refund | refund.execute / customer_refund_attempt / SUCCESS,FAILURE,PARTIAL | success_hook in apply_provider_refund terminal txn (atomic); FAILURE/non-terminal independent | Implemented and verified (prior) |
| Refund checker | POST .../refund/attempts/{a}/authorize | refund.authorize / customer_refund_attempt | success_hook (atomic); FAILURE independent | Implemented and verified |
| Refund reconcile | background sweep | refund.reconcile_finalize / customer_refund_attempt / SUCCESS | system-actor success_hook (atomic) | Implemented |
| Booking detail read | GET /api/admin/customer-bookings/{id} | booking.view_detail / customer_booking / SUCCESS | record_in_session before existing commit | Implemented (2E) |
| Booking change | PATCH .../{id}/status | booking.update / customer_booking / SUCCESS | record_in_session (atomic) | Implemented (2E) |
| Customer detail read | GET /api/admin/customers/{id} | customer.view_detail / customer / SUCCESS | record_in_session (atomic) | Implemented (2E) |
| Payment detail read | GET .../customer-payments/{product}/{id} | payment.view_detail / customer_payment / SUCCESS | record_in_session (atomic) | Implemented (2E) |
| Payment verify | POST /api/admin/reconciliation/verify/{product}/{id} | payment.verify / payment / SUCCESS | record_in_session (atomic) | Implemented (2E) |
| Supplier reservation | POST .../supplier-reservation | booking.supplier_reservation / customer_booking / SUCCESS | record_in_session (atomic) | Implemented (2E) |
| Review moderation | PATCH /api/admin/reviews/{id} | review.moderate / customer_review / SUCCESS (only when changed) | record_in_session (atomic) | Implemented (2E) |
| Report export | GET /api/admin/b2c-reports/export | report.export / report / SUCCESS | record_in_session (atomic, beside existing log_change) | Implemented (2E) |
| Report preview (sensitive read) | GET .../b2c-reports/preview | report.preview / report / SUCCESS | record_independently (no business txn) | Implemented (2E) |
| Catalogue hotels | PATCH hotel / POST+PATCH room | catalogue.update / catalogue.create / customer_hotel[_room] / SUCCESS | record_in_session (atomic) | Implemented (2E) |
| Catalogue packages | create/update/itinerary/departure add+update | catalogue.create / catalogue.update / customer_package[_departure] / SUCCESS | record_in_session (atomic) | Implemented (2E) |
| Catalogue destinations | create/reorder/update, location create+update | catalogue.create / catalogue.update / customer_destination,_location / SUCCESS | record_in_session (atomic) | Implemented (2E) |
| Chat attachment download | GET /api/admin/chat/attachments/{id} | document.download / chat_attachment / DENIED,FAILURE,SUCCESS (metadata only) | record_independently | Implemented and verified (prior) |
| Chat claim/transfer/status | POST .../conversations/{id}/{claim,transfer,status} | chat.claim / chat.transfer / chat.set_status / customer_conversation / SUCCESS | record_in_session (atomic) | Implemented (2E) |
| Communication send | — | — | — | N/A: admin_communication is read-only (notifications/tickets/overview); no send/mutate endpoint exists |
| Customer block / reset-password | — | — | — | N/A: customer_admin exposes list + detail only; no such endpoint |
| Chat attachment send | POST .../messages/attachment | (admin upload) | — | Not wired (deferred): admin-upload write, lower sensitivity than the download egress; see limitations |
| Ordinary list/index/nav views | various GET lists | — | — | N/A: excluded by policy (no navigation/list auditing) |

### Files modified (2E event wiring)
admin_customer_bookings.py, customer_admin.py, admin_reconciliation.py, customer_payment_admin.py, admin_reviews.py, admin_b2c_reports.py, admin_catalogue_hotels.py, admin_catalogue_packages.py, admin_catalogue_destinations.py, admin_chat.py — each adds b2c_audit.record_in_session(...) immediately before the endpoint's existing db.commit() (atomic with the business change and with the existing system_logs dual-write), or record_independently(...) for the no-txn sensitive read. New test: backend/tests/test_b2c_audit_events.py (7 scenarios).

### Transaction & safety
- SUCCESS of a state change uses record_in_session, so the audit row rides the endpoint's own db.commit(); a rollback drops both (atomic), and an audit-insert failure fails the shared commit (fail-closed). Proven by test_record_in_session_rolls_back_with_the_caller.
- Refund money-success remains Approach C (unchanged); HDFC/TrustBrick/provider-verification/idempotency/reconciliation untouched.
- system_logs dual-write preserved everywhere it existed (the log_activity/log_change calls are left in place).
- Redaction before persistence proven by test_record_independently_persists_and_redacts (password/token masked, ordinary field kept). No passwords/OTPs/tokens/payment-credentials/document-contents stored.
- DENIED enforced by the Stage-1 require_scope gate before the handler (no business work, no row) — proven by test_catalogue_update_is_denied_without_the_b2c_scope.

### Test results (actual)
- Stage-2E event tests: 7 passed. Stage-2 regression set: 161 passed. Import smoke: OK.
- Full backend suite: 1696 passed, 44 failed, 4 skipped — all 44 failures in the pre-existing test_token_revocation.py / test_admin_supplier_reservation_http.py (no new regressions).

### Known limitations / unimplemented (with reasons)
- chat.attachment_send not wired — an admin uploading a file into a conversation (write, lower sensitivity than the audited download egress). Deferred to keep the 2E change bounded; a follow-up can add a record_in_session beside its existing commit.
- record_independently events are not asserted through the SQLite HTTP harness — that path opens the real SessionLocal (Postgres), which the harness does not provide, so in tests it is a logged no-op. Its behaviour is instead proven in isolation (test_record_independently_persists_and_redacts) by pointing SessionLocal at SQLite. Affected wired events: report.preview, the chat document.download outcomes, and refund FAILURE/non-terminal rows — verified by unit test, not by an end-to-end HTTP assertion.
- Representative (not exhaustive) router HTTP test — one catalogue endpoint is driven end-to-end to prove the record_in_session-before-commit pattern; the remaining record_in_session endpoints share that exact pattern and are covered by the import smoke + the writer-mode tests, not an individual HTTP test each.

### 2E confirmations
Local dev only; migration 0095 not executed; no DB connection/modification; no DBA grants; no production/deploy; no git commit/push; no payment/refund behaviour changed; Gaming Packages remain disabled; Stage 2A-2D untouched.

---

## 11. Stage 2E closure correction (2026-11-12)

### Task 1 — Chat attachment-send audit (`POST /api/admin/chat/conversations/{id}/attachments`)
Inspected the real upload flow (auth gate -> get_for_admin -> guard_open -> attachments.store -> post_admin_message [ChatError discards the stored file] -> attachments.record -> db.commit -> WS publish). Wired, metadata only:
- DENIED: a new `_send_attachment_access` dependency records `chat.attachment_send`/DENIED (entity customer_conversation) when a role-default B2B admin without a b2c scope is refused, then raises 403. Mirrors the download gate; existing auth/WS behaviour unchanged.
- FAILURE: on conversation-not-found and on ChatError (after the file is discarded), records `chat.attachment_send`/FAILURE with the reason.
- SUCCESS: before the endpoint's `db.commit()` (atomic), records `chat.attachment_send`/SUCCESS with METADATA ONLY — message_type, is_internal, content_type, filename. Never file bytes, the caption text, credentials or tokens.

### Task 2 — Route-by-route verification matrix (Stage 2E endpoints)
For each wired endpoint: action / entity_type / entity_id / actor snapshot / outcome / request_id / redaction / transaction / no-duplicate.

| Endpoint | action | entity_type / id | actor | outcome | request_id | redaction | txn | no-dup |
|---|---|---|---|---|---|---|---|---|
| booking detail read | booking.view_detail | customer_booking / {booking_id} | snapshot | SUCCESS | ContextVar | n/a (no payload) | record_in_session (rides commit) | one call -> one row |
| booking status change | booking.update | customer_booking / {booking_id} | snapshot | SUCCESS | ContextVar | new={status} redacted | record_in_session | one row |
| customer detail read | customer.view_detail | customer / {customer_id} | snapshot | SUCCESS | ContextVar | n/a | record_in_session | one row |
| payment detail read | payment.view_detail | customer_payment / {product}:{id} | snapshot | SUCCESS | ContextVar | n/a | record_in_session | one row |
| payment verify | payment.verify | payment / {product}:{id} | snapshot | SUCCESS | ContextVar | new redacted | record_in_session | one row |
| supplier reservation | booking.supplier_reservation | customer_booking / {booking_ref} | snapshot | SUCCESS | ContextVar | new redacted | record_in_session | one row |
| review moderation | review.moderate | customer_review / {review_id} | snapshot | SUCCESS (only when changed) | ContextVar | new redacted | record_in_session | one row; skipped when nothing changed |
| report export | report.export | report / {type} | snapshot | SUCCESS | ContextVar | new={format,rows} | record_in_session (beside log_change) | one row |
| report preview | report.preview | report / {type} | snapshot | SUCCESS | ContextVar | n/a | record_independently | one row/request (D2 dedup is a future enhancement) |
| catalogue hotels (hotel/rooms) | catalogue.update/create | customer_hotel[_room] / {id} | snapshot | SUCCESS | ContextVar | new={changed/room_code} | record_in_session | one row |
| catalogue packages (+itinerary/departures) | catalogue.create/update | customer_package[_departure] / {id} | snapshot | SUCCESS | ContextVar | new redacted | record_in_session | one row |
| catalogue destinations (+locations) | catalogue.create/update | customer_destination/_location / {id} | snapshot | SUCCESS | ContextVar | new redacted | record_in_session | one row |
| chat claim/transfer/status | chat.claim/transfer/set_status | customer_conversation / {id} | snapshot | SUCCESS (claim only when won) | ContextVar | new redacted | record_in_session | one row |
| chat attachment download | document.download | chat_attachment / {id} | snapshot | DENIED/FAILURE/SUCCESS | ContextVar | metadata only | record_independently | one per outcome |
| chat attachment send | chat.attachment_send | customer_conversation / {id} | snapshot | DENIED/FAILURE/SUCCESS | ContextVar | metadata only | SUCCESS record_in_session; DENIED/FAILURE independent | one per outcome |

Evidence: actor snapshot — `test_actor_snapshot_is_captured_without_a_foreign_key`; request_id — `test_request_id_flows_from_contextvar_into_the_audit_row`; redaction — `test_record_independently_persists_and_redacts`; outcomes — `test_four_outcomes_round_trip`; record_in_session atomicity + no-dup — `test_record_in_session_*`, representative router `test_catalogue_hotel_update_writes_an_audit_row`; DENIED gate — `test_catalogue_update_is_denied_without_the_b2c_scope`, `test_chat_attachment_send_denied_records_a_denied_event`.
Limitation: the `record_in_session` endpoints share one proven pattern (audit row added immediately before the endpoint's existing `db.commit()`); one catalogue endpoint is driven end-to-end, the rest are covered by that pattern + import smoke rather than an individual HTTP test each. `record_independently` endpoints are proven in isolation (SessionLocal pointed at SQLite) because the harness has no Postgres.

### Task 3 — Audit-writer failure behaviour (verified by tests)
- A failed SUCCESS audit insert cannot silently let the business op commit: `record_in_session` propagates (does not swallow), so the endpoint never reaches its `db.commit()` — `test_failed_success_audit_propagates_so_the_business_commit_cannot_proceed`. (For the refund money-success this is Approach C: the audit rides the terminal transaction; a raise rolls back the SUCCEEDED transition.)
- FAILURE/DENIED do not commit unrelated business changes: `record_independently` writes on its OWN session and never touches the caller's pending work — `test_independent_write_does_not_commit_the_callers_pending_change`.
- Independent writes do not interfere with existing transactions and never raise into the business path: `test_record_independently_never_raises_into_the_business_path` (audit DB down -> logged + swallowed -> returns None).
- `system_logs` dual-write intact: `test_system_logs_dual_write_is_preserved` (the catalogue endpoint still calls `log_change` exactly once AND writes the new B2C audit row).

### Files changed (closure)
`backend/app/routers/admin_chat.py` (attachment-send DENIED/FAILURE/SUCCESS + `_send_attachment_access`); `backend/tests/test_b2c_audit_events.py` (+6 tests: attachment-send DENIED, failed-success propagation, independent-write isolation, independent-never-raises, request-id flow, system_logs dual-write).

### Test results (actual)
- Stage-2E event + closure tests: 13 passed. Stage-2 regression set: 167 passed. Import smoke: OK.
- Full backend suite: 1702 passed, 44 failed, 4 skipped — all 44 failures in the pre-existing test_token_revocation.py / test_admin_supplier_reservation_http.py (no new regressions).

### Closure confirmations
Local dev only; migration 0095 not executed; no DB connection; no DBA grants; no production/deploy; no git commit/push; Approach C and payment/refund/HDFC/TrustBrick behaviour unchanged; Gaming Packages remain disabled; Stage 2A-2D untouched.

---

## 12. Stage 2F — Final security, audit & regression review (2026-11-13)

Verified against the ACTUAL repository (files re-read, suites re-run), not prior reports.

### A. RBAC and B2B/B2C separation — PASS
- B2C admin endpoints gate on explicit `b2c.*` scopes via `require_scope`/`require_b2c_access`/`get_current_b2c_admin`, which consult `users.permissions` (+ super-admin short-circuit) and NEVER the role-default matrix. A role-default B2B admin is refused (403) — proven by `test_b2c_permission_isolation`, `test_admin_chat_b2c_isolation`, `test_catalogue_update_is_denied_without_the_b2c_scope`, the refund B2B-only 403 test.
- `b2c.audit.view` enforced on `GET /api/admin/b2c-audit`.
- Super-admin refund behaviour preserved (view-only; cannot execute without the explicit code) and maker-checker intact — refund suites green. Existing B2B functionality unaffected (full suite: no new failures).

### B. Audit system — PASS
Actor snapshot (no cross-Base FK); SUCCESS/FAILURE/DENIED/PARTIAL; entity_type+entity_id; request_id + background run id + WebSocket UUID correlation; redaction before persistence AND on read; append-only (DB trigger in 0095 + no update/delete API); refund-success dedup (one SUCCEEDED transition per attempt + partial unique index). No credentials/passwords/OTPs/tokens/payment-details/file-bytes/document-contents persisted (payloads are redacted, metadata-only). Evidence: `test_b2c_audit_events`, `test_b2c_audit_api`, `test_request_id_correlation`, refund suites.

### C. Audit API `GET /api/admin/b2c-audit` — PASS
Explicit `b2c.audit.view`; pagination (page/page_size ≤200); filters actor/action/entity_type/entity_id/outcome/date-range; `outcome` invalid → 422; `date_to<date_from` → 422; newest-first (`created_at DESC, id DESC`); redaction on read; no edit/delete route. Verified by code read + `test_b2c_audit_api`.

### D. Refund & payment safety — PASS (unchanged)
Approach C intact: the money-success audit rides the single `apply_provider_refund` SUCCEEDED commit; a failed audit insert rolls the transaction back (no succeeded-without-audit). Maker-checker, idempotency, balance caps, provider verification, reconciliation, HDFC/TrustBrick untouched. No refund code rewritten; no real payment/refund performed.

### E. Request & background correlation — PASS
Valid/missing/invalid request id handling; `X-Request-ID` response echo; per-request ContextVar isolation; cleanup after exceptions; per-run sweep ids; WebSocket correlation is a FRESH UUID4 — the raw ticket is never used (security fix verified). Evidence: `test_request_id_correlation`.

### F. Gaming disabled — PASS functionally; minor UI/SEO residuals (one fixed, rest documented)
Functional disablement COMPLETE and tested: `settings.gaming_enabled` defaults False (fail-closed; missing/invalid env ⇒ disabled); router gate 404s every gaming route; service `_assert_enabled` blocks create/update; dashboard counts zeroed; gaming-packages.html noindex+redirect; sitemap entry removed; admin sidebar entry hidden; mobile `/gaming` route redirects; `test_gaming_fail_closed` passes; historical `gaming_tour_enquiries` data preserved (no delete). **Finding (fixed):** the home page `index.html` STATIC footer still linked `/gaming-packages` — removed (smallest-safe one-line fix; mobile parity + gaming tests stay green). **Residuals (documented, not security defects):** `packages.html` static footer link and the website search-card gaming tab (`booking-card.js`) still reference `/gaming-packages`, which now redirects to home; these are cosmetic/no-JS/SEO entry points to a redirecting, noindexed page. A full website nav/search-card sweep is Stage-1A frontend cleanup, outside the Stage-2 audit-system review, and editing the live search card is higher-risk than the already-redirecting destination warrants.

### Migration 0095 review — PASS (not executed)
revision `0095_customer_admin_audit_logs`, down_revision `0094_customer_refund_attempts` (single history). `CREATE TYPE customer_admin_audit_outcome_enum` (success/failure/denied/partial). All 18 columns match the model; actor is a plain BigInteger snapshot (no FK). Indexes map 1:1 to the model (request_id column-index + 6 named incl. created_at DESC). Partial unique `uq_cust_admin_audit_refund_success` on `(entity_type, entity_id) WHERE outcome='success' AND entity_type='customer_refund_attempt'` — PG-only, correctly off the SQLite model. Append-only trigger+function (BEFORE UPDATE/DELETE RAISE). Downgrade reverses in order, IF EXISTS, drops table (indexes with it) + type. No GRANT/REVOKE (DBA step, separate). No second DB/engine/history.

### Test results (actual, this review)
- Full backend suite: **1702 passed, 44 failed, 4 skipped**. The 44 failures are entirely in the two PRE-EXISTING files `test_token_revocation.py` (22) and `test_admin_supplier_reservation_http.py` (22) — uncommitted JWT/supplier WIP unrelated to Stage 2; **no new regressions**.
- Stage 2 focused + regression set: **167 passed**. Import smoke: OK.
- Mobile: `tsc --noEmit` exit 0; gaming + parity tests **41 passed** (after the index.html footer fix).

### Stage 2A–2F completion status
- 2A model + 2B migration 0095 + 2C read API + 2D correlation + 2E event wiring + 2E closure + 2F review — all present, verified, tested at the levels noted.

### Classification
1. **Implemented & tested:** model; writer (two modes, redaction, snapshot, retention class); `b2c.*` scopes incl. `b2c.audit.view`; refund Approach C; request-id middleware + sweep + WS-UUID correlation; read API (filters/validation/ordering/redaction/no-edit-delete); event wiring via `record_in_session` (representative router test + writer-mode + atomicity tests); gaming fail-closed.
2. **Implemented but not fully tested:** `record_independently` events (report.preview, chat document.download outcomes, chat attachment-send FAILURE, refund FAILURE/non-terminal) — proven in isolation (SessionLocal→SQLite) but not end-to-end through the HTTP harness (it has no Postgres); per-endpoint HTTP tests are representative, not exhaustive (shared pattern + import smoke cover the rest).
3. **Not implemented:** nothing required remains; `chat.attachment_send` now wired. N/A items: `communication.send`, `customer.block/reset_password` (no such endpoints). Documented cosmetic gaming UI residuals (packages.html footer, web search-card tab).
4. **Requires database execution (separate approval):** apply migration 0095 (CREATE TYPE/table/indexes/partial-unique/trigger) on Postgres; the DBA grant/revoke (app login INSERT+SELECT only; UPDATE/DELETE/TRUNCATE revoked); verify the append-only trigger live.
5. **Requires external integration / production verification:** append-only trigger behaviour on real Postgres; retention policy durations (business/legal, pending) + purge/legal-hold mechanism; a live authenticated WebSocket session + real multipart attachment send; real-provider (HDFC/TrustBrick) refund audit atomicity in staging; D1 Phase-C removal of the `system_logs` B2C-admin dual-write after confirming no dashboard/report consumer depends on it.

### Database deployment prerequisites
1. Apply migration `0095` on the single B2C Postgres DB (not executed here).
2. DBA: `GRANT INSERT, SELECT` on `customer_admin_audit_logs` to the app login; `REVOKE UPDATE, DELETE, TRUNCATE`; table/trigger/function owned by the DDL role.
3. Confirm the append-only trigger rejects UPDATE/DELETE live.
4. Agree retention durations + purge/legal-hold procedure before any deletion job.

### Production-readiness status
NOT production-ready yet — no claim of readiness. Code-complete and green at the harness level, but gated on: migration 0095 + DBA grants being applied and verified on Postgres; a live append-only-trigger check; the `record_independently` and WebSocket paths verified end-to-end against Postgres; and the retention policy decided. These are the "requires database execution / external verification" items above. No production access, deployment, commit/push, or real payment/refund was performed in Stage 2.
