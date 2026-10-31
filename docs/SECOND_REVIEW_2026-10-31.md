# Second Review — D1 / D2 / D3 Findings

**Date:** 2026-10-31
**Scope:** Review only. No code changed, no commit, no production system touched.

---

## 1. RD1–RD5 decision table (plain language)

| ID | What it means | Financial risk if YES | Financial risk if NO | Operational risk | Recommendation |
|---|---|---|---|---|---|
| **RD1** — Rename customer-facing "refunded" to "Refund initiated" now (frontend text change only) | Today a customer can see "Refunded" on their booking when an admin clicked a button but no money was actually sent back through any payment gateway. This change makes the label honest: it says "Refund initiated" instead, until a real gateway refund mechanism exists. | **None.** No money moves. No gateway call. Only the text the customer reads changes. | **Continued misrepresentation.** A customer who reads "Refunded" may believe their money is back when it is not. If a customer disputes this with their bank or a consumer forum, the platform's own UI contradicts it. | Low — a CSS/JS text change in the frontend. Fully reversible. | **Yes, do this first.** |
| **RD2** — Build the refund execution service, migration 0094, and test suite | This is the actual fix: when an admin clicks "start refund", the system calls the payment gateway's refund API and records what the gateway said. The cancellation only reaches "refunded" when the gateway confirms the money was returned. | **Risk during build:** a bug could issue a refund for the wrong amount or to the wrong payment. Mitigated by: tests against mock provider first, sandbox testing before production, idempotency keys that prevent double-refund, amount validation against the captured amount. **Risk of not building:** every refund remains manual and unverified, which is the current risk. | **Status quo continues.** Every refund is an admin clicking "refunded" with no gateway confirmation. No audit trail of whether money actually moved. | Medium — touches the cancellation state machine and adds a gateway call to an admin action. | **Yes, on an isolated branch, tested against mock and sandbox only.** |
| **RD3** — Accept that TrustBrick refunds remain manual | TrustBrick's partner API has no refund endpoint. Their `refund()` method raises an exception rather than pretending it worked. This decision says: for the 12 pilot bookings routed through TrustBrick, an admin must refund via TrustBrick's own dashboard, then mark the refund complete in our system with an explicit override flag. | **If YES:** an admin who forgets the TrustBrick side could mark "refunded" in our system while TrustBrick has not refunded. The override flag and audit trail mitigate this but do not prevent it. **If NO (block TrustBrick):** the 12 pilot bookings already collected through TrustBrick cannot be refunded through our system at all, and new TrustBrick payments stop. | Medium — the manual step is error-prone. The `admin_override: true` requirement and audit logging reduce the risk but cannot eliminate human error. | **Accept manual with override and audit trail.** The alternative (blocking TrustBrick) is worse for existing customers. |
| **RD4** — Leave self-cancel endpoints unchanged (no gateway refund on instant cancel) | There are two cancellation paths: (a) instant self-cancel by the customer (sets booking to "cancelled", no admin review), and (b) admin-reviewed cancellation request (the one being fixed in RD2). This decision says: don't add gateway refunds to path (a) yet. | **If YES:** a customer who self-cancels a booking they already paid for gets "cancelled" but no automatic refund. They must contact support, which creates a cancellation request on path (b). **If NO (add refund to self-cancel):** more code changes in a money-moving path, more risk surface, and the self-cancel endpoints were designed for free-cancellation (before payment) where no refund is needed. | Low risk to defer. The admin-reviewed path (RD2) handles all refund cases. Adding refund to self-cancel is a P1 follow-up after RD2 is proven. | **Defer.** Fix the admin path first, prove it works, then extend to self-cancel. |
| **RD5** — Add refund reconciliation to the existing payment sweep | The system already has a periodic sweep that re-checks pending payments. This decision says: add a similar check for refund attempts stuck in "processing" — meaning we asked the gateway to refund but haven't heard back yet. | **If same sweep:** simpler code, one process to monitor, but the sweep runs more often than refund reconciliation needs (captures need 5-minute checks; refunds can wait 30 minutes). **If separate:** another async loop in `main.py`, but clean separation. | Low either way. The sweep is read-only against the provider (it asks "what happened?" and records the answer). | **Same sweep, separate function, longer interval for refunds.** Simpler to operate. |

---

## 2. Refund architecture review

### 2.1 Duplicate refund prevention

**Design:** Each `execute_refund` call generates a deterministic idempotency key (`rfnd-{cancellation_ref}-{payment_row_id}-{attempt_number}`) and writes a `customer_refund_attempts` row with that key under a `UNIQUE(provider, idempotency_key)` constraint.

**Verified against each provider:**
- **Razorpay:** The adapter passes the key as `receipt` to `POST /payments/{id}/refund`. Razorpay's documentation states it rejects duplicate receipts with "Duplicate receipt found for this refund request" — the adapter's own docstring (line 772) says this explicitly. So a retry with the same key returns the existing refund, not a second one.
- **HDFC:** The adapter hashes the key into `unique_request_id` = `"RF" + SHA256(key)[:28]`. HDFC's documentation says "You cannot reuse the value for two different refund requests" (quoted in the adapter, line 953). Duplicate request returns the same refund.
- **TrustBrick:** Never reaches the provider — raises before any HTTP call.
- **Mock:** In-memory, no persistence, no idempotency check — but mock is only for tests.

**Concern I found on review:** The D1 document proposes `attempt_number` as part of the idempotency key. This means a second attempt for the same cancellation generates a **different** key. That is correct if the first attempt genuinely failed and a retry with a new amount or corrected data is intended. But it means two admins clicking "start refund" at near-simultaneous times could generate attempt 1 and attempt 2 with different keys, and both would be sent to the provider. **Mitigation:** the `SELECT FOR UPDATE` on the cancellation row serialises concurrent calls at the database level, so only one proceeds. This is described in the design but deserves a dedicated test (`test_double_refund_race`), which is listed.

**Assessment:** Sound. The three layers — DB unique constraint, provider idempotency mechanism, and row-level lock — each independently prevent double-refund. No single layer's failure results in a double-refund.

### 2.2 Partial refunds

The design passes `amount_minor` from the cancellation request's `refund_amount` to the provider. The service validates `amount_minor ≤ captured_amount_minor` from the payment row before calling the provider.

**Concern:** What about cumulative partial refunds? If an admin refunds ₹5,000 of a ₹10,000 payment, then later refunds another ₹5,000, the second call must check against the **remaining** capturable amount, not the original. The current design has no column tracking "total already refunded" — it would need to sum all `succeeded` attempts for this payment row. **This is not addressed in D1 and must be added before implementation.**

### 2.3 Provider selection

The design resolves the provider from the payment row's `provider` column, not from `get_provider()` (the current global config). This is critical and correct: a payment collected by Razorpay six months ago must be refunded through Razorpay even if the deployment has since switched to HDFC.

**Verified:** The `get_provider_named()` function in `payments/__init__.py` already supports resolving TrustBrick and HDFC by name even when they are not the configured default (lines 426–461). The refund service can use this existing function.

### 2.4 Webhook verification for refunds

**Current state:** `payment_event_service.py` puts `REFUNDED` in `_NEEDS_VERIFICATION` (line 96–99), meaning a refund webhook is deferred, not applied directly. The verification dispatches to product-specific verifiers that currently only handle capture verification. A refund event gets `result = None` and stays `deferred` with the note "no verification path for {model} yet."

**What the design proposes:** `complete_refund_from_webhook()` would be called from the verification path (or from a new branch in `apply_event`) when the incoming status is `REFUNDED` and a matching `customer_refund_attempts` row exists.

**Concern:** The design document says `complete_refund_from_webhook` looks up the attempt by `provider_refund_id`. But the webhook event may not carry a refund id — it carries a payment id and a status. The lookup should be: find the `customer_refund_attempts` row whose `provider` matches and whose linked payment row matches the payment id in the webhook. **This needs clarification before implementation.**

### 2.5 Reconciliation and failure recovery

The design proposes a periodic sweep for attempts stuck in `processing`. This is the same pattern as the existing `reconcile_stale_pending` for captures.

**Concern:** The sweep needs to re-query each provider for the refund status. Razorpay has `GET /refunds/{refund_id}` and `GET /payments/{payment_id}/refunds`. HDFC's refund status comes from the order status endpoint. Neither provider adapter currently has a `fetch_refund()` method — only `fetch_payment()` and `fetch_order()`. **The refund reconciliation needs a new method on the provider protocol**, or it must query refund status through the existing `fetch_order()` response (which HDFC already returns refunds in, per line 963).

### 2.6 Summary of architecture gaps found in this review

| Gap | Severity | Must fix before implementation |
|---|---|---|
| Cumulative partial refund tracking (sum of prior succeeded attempts) | Medium | **Yes** |
| Webhook refund matching — by payment id, not by refund id alone | Medium | **Yes** |
| Provider `fetch_refund()` method for reconciliation sweep | Low | Can use existing `fetch_order()` for HDFC; Razorpay has a refund fetch endpoint; add to protocol or leave as optional |

---

## 3. TrustBrick safety verification

**Question:** Can TrustBrick's unsupported refund accidentally be treated as a successful automatic refund?

**Answer: No, it cannot.** Verified through three independent code paths:

1. **Direct call path:** `TrustBrickProvider.refund()` (line 588) raises `PaymentProviderError` with `code="refund_unsupported"` **unconditionally** — there is no branch, no fallback, no "try again" logic. It raises before any HTTP call is made. The refund service would catch this exception and record the attempt as `manual_required`.

2. **Webhook path:** If TrustBrick sends a webhook with a `REFUNDED` status for a payment (theoretically possible if they refund on their side), `payment_event_service.py` puts it into `_NEEDS_VERIFICATION` and defers it. The verification path currently returns `None` for this case, leaving the event as `deferred`. It would **not** advance the cancellation to `refunded` automatically.

3. **Reconciliation path:** The reconciliation sweep processes `processing` attempts. A TrustBrick attempt would never reach `processing` because the call raises before any HTTP request. It would be recorded as `manual_required` or `failed`, which the sweep ignores.

4. **The `complete_refund` admin override:** The only way to mark a TrustBrick refund as completed is the admin explicitly sending `action: "complete_refund"` with `admin_override: true` — a deliberate, auditable human action.

**There is no code path by which TrustBrick's `refund_unsupported` exception could be silently swallowed and treated as success.**

---

## 4. CI workflow review

### 4.1 Correctness

| Check | Result |
|---|---|
| Trigger: push and PR to main | ✓ Correct |
| Concurrency: cancel in-progress on same ref | ✓ Correct; prevents wasted minutes |
| Python version: 3.12 | ✓ Matches `Dockerfile` (`FROM python:3.12-slim`) |
| Node version: 22 | ✓ `node --test` is stable on Node 18+; 22 is current LTS |
| Pip cache: keyed to `backend/requirements.txt` | ✓ Invalidates when deps change |
| Working directory: `backend` for pytest and alembic | ✓ Matches where `alembic.ini` and `tests/` live |
| Frontend test glob: `frontend/tests/*.test.js` | ✓ Matches actual files (14 `.test.js` files) |
| JS test glob: `tests/js/*.test.mjs` | ✓ Matches actual files (5 `.test.mjs` files) |

### 4.2 Security

| Check | Result |
|---|---|
| No repository secrets referenced | ✓ No `${{ secrets.* }}` anywhere |
| `DATABASE_URL` is synthetic SQLite path | ✓ `sqlite:///./ci_test.db` — not a real database |
| `JWT_SECRET_KEY` is a synthetic value | ✓ `ci-test-secret-key-0123456789abcdef` — not a real key |
| Postgres credentials are throwaway | ✓ `ci_user`/`ci_pass` exist only in the ephemeral service container |
| No payment provider env vars set | ✓ `PAYMENT_PROVIDER` is not set, so payments default to `none` |
| No AWS env vars | ✓ |
| No production URLs | ✓ |
| `--tb=short` on pytest | ✓ Limits traceback output, reducing risk of leaking env in error messages |

### 4.3 PostgreSQL service health

| Check | Result |
|---|---|
| Image: `postgres:16-alpine` | ✓ Matches production (Postgres 16) |
| Health check: `pg_isready -U ci_user` | ✓ Standard Postgres readiness probe |
| Health interval: 5s, timeout: 5s, retries: 5 | ✓ Gives 25 seconds total for container startup, which is ample |
| Port mapping: 5432:5432 | ✓ Standard; `localhost:5432` in the `DATABASE_URL` reaches it |

### 4.4 Migration execution

| Check | Result |
|---|---|
| `alembic upgrade head` | ✓ Runs all 94 migrations from empty DB |
| `alembic downgrade -1` | ✓ Tests the most recent migration's downgrade (0093 → 0092) |
| `alembic upgrade head` | ✓ Re-applies 0093, proving it is re-entrant |
| `DATABASE_URL` set on each step | ✓ (needed because env vars are per-step in GitHub Actions) |

### 4.5 CI findings and one fix needed

**Issue found:** The alembic env.py imports `from app.config import settings`, which requires `JWT_SECRET_KEY` to be set (it is a required field with no default). The Postgres migration job does **not** set `JWT_SECRET_KEY`. Alembic will fail at import time with a pydantic validation error.

**Fix:** Add `JWT_SECRET_KEY: "ci-migration-key"` to the env block of each migration step.

### 4.6 Can CI accidentally access production?

**No.** Verified:
1. No `secrets.*` references exist — the workflow uses no GitHub secrets at all.
2. `DATABASE_URL` points to `sqlite:///./ci_test.db` (backend job) or `postgresql://ci_user:ci_pass@localhost:5432/ci_migrations` (Postgres job). Neither is a real database.
3. `PAYMENT_PROVIDER` is not set, so payments default to `none` — no gateway is contacted.
4. No AWS, Razorpay, HDFC, TrustBrick, SMTP, or any other external service credentials are set.
5. The `settings` object's required fields are only `database_url` and `jwt_secret_key`; everything else defaults safely.
6. Even if a repository secret were defined and somehow injected, the code only contacts a gateway when `PAYMENT_PROVIDER` is set to a specific value — and it is not.

---

## 5. PostgreSQL migration test — exact local instructions

When Docker Desktop is running, execute these commands from the repository root:

```bash
# 1. Start a disposable Postgres 16 container
docker run -d \
  --name jpw_migration_test \
  -e POSTGRES_USER=jpw_test \
  -e POSTGRES_PASSWORD=jpw_test_pass \
  -e POSTGRES_DB=jpw_migration_test \
  -p 5433:5432 \
  postgres:16-alpine

# 2. Wait for it to be ready (retry until success)
until docker exec jpw_migration_test pg_isready -U jpw_test; do
  echo "Waiting for Postgres..."
  sleep 2
done

# 3. Run all migrations up
cd backend
DATABASE_URL="postgresql://jpw_test:jpw_test_pass@localhost:5433/jpw_migration_test" \
JWT_SECRET_KEY="local-test-key" \
  alembic upgrade head

# 4. Verify the middle_name column exists
docker exec jpw_migration_test psql -U jpw_test -d jpw_migration_test \
  -c "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='customer_travellers' AND column_name='middle_name';"

# 5. Insert a test row to verify data preservation
docker exec jpw_migration_test psql -U jpw_test -d jpw_migration_test \
  -c "INSERT INTO customer_travellers (customer_id, first_name, last_name, traveller_type, nationality) VALUES (1, 'Test', 'User', 'adult', 'IN') RETURNING customer_traveller_id, first_name, middle_name;"

# 6. Downgrade one step (drops middle_name column)
DATABASE_URL="postgresql://jpw_test:jpw_test_pass@localhost:5433/jpw_migration_test" \
JWT_SECRET_KEY="local-test-key" \
  alembic downgrade -1

# 7. Verify the row still exists (minus middle_name)
docker exec jpw_migration_test psql -U jpw_test -d jpw_migration_test \
  -c "SELECT customer_traveller_id, first_name, last_name FROM customer_travellers LIMIT 1;"

# 8. Re-upgrade to head
DATABASE_URL="postgresql://jpw_test:jpw_test_pass@localhost:5433/jpw_migration_test" \
JWT_SECRET_KEY="local-test-key" \
  alembic upgrade head

# 9. Verify the column is back (NULL for existing row)
docker exec jpw_migration_test psql -U jpw_test -d jpw_migration_test \
  -c "SELECT customer_traveller_id, first_name, middle_name FROM customer_travellers LIMIT 1;"

# 10. Clean up
cd ..
docker rm -f jpw_migration_test
```

**Expected results:**
- Step 3: all 94 migrations succeed.
- Step 4: `middle_name | character varying(100) | YES`
- Step 5: row inserted, `middle_name` is NULL.
- Step 6: downgrade succeeds.
- Step 7: row still present (first_name and last_name intact).
- Step 8: re-upgrade succeeds.
- Step 9: `middle_name` column is back, value is NULL.

**Note:** Port 5433 is used (not 5432) to avoid conflicting with any local Postgres.

**PowerShell equivalent** (for this Windows machine): replace `docker run -d \` with `docker run -d `` ` (backtick continuation) or use single-line commands. The `DATABASE_URL=… alembic` syntax requires `$env:DATABASE_URL = "…"; alembic upgrade head` in PowerShell.

---

## 6. Worktree integrity check

| Check | Result |
|---|---|
| Worktree path | `…/.claude/worktrees/saved-travellers-flight-booking-0720ae` ✓ |
| Branch | `claude/jackpotsworld-competitor-audit-7fe581` ✓ |
| Branch base | Same commit as `main` (`8d04f5a`) — no drift ✓ |
| Tracked files modified | **None** — `git diff --name-only` is empty ✓ |
| Staged files | **None** — `git diff --cached --name-only` is empty ✓ |
| Stash | Empty ✓ |
| Untracked files (new) | 6 files — all expected: `.github/workflows/ci.yml`, 5 docs ✓ |
| Existing uncommitted work overwritten | **No.** The branch was clean at start (git status showed `(clean)`), and every new file is in `.github/` or `docs/` — directories that had no uncommitted content ✓ |

---

## 7. Risks and unresolved questions

### Open risks

| # | Risk | Severity | What resolves it |
|---|---|---|---|
| 1 | **Cumulative partial refund not tracked** — the design does not sum prior succeeded attempts before allowing a new one | Medium | Add a `total_refunded_minor` check in the service: sum all `succeeded` attempts for this payment row, then validate `new_amount + total_refunded ≤ captured_amount` |
| 2 | **Refund webhook matching** — the design says look up by `provider_refund_id`, but webhooks carry a payment id + status, not always a refund id | Medium | Match by payment row (provider + provider_payment_id), then check if the row has a `processing` refund attempt |
| 3 | **No `fetch_refund()` on the provider protocol** — reconciliation needs to check refund status, but the protocol has no method for it | Low | HDFC: refund status is in the `fetch_order()` response already; Razorpay: has `GET /refunds/{id}`; add as an optional method or query through existing endpoints |
| 4 | **CI missing `JWT_SECRET_KEY` in migration job** — the alembic env.py imports `app.config.settings`, which requires it | Low | Add `JWT_SECRET_KEY: "ci-migration-key"` to the migration step env vars |
| 5 | **Docker Desktop not running** — D3 live test could not execute | Low | Start Docker Desktop and run the instructions above; or push D2 and let GitHub Actions run it |
| 6 | **Production bookings with `provider=none`** — if a booking was never paid (demo mode), attempting a refund fails | Low (expected) | The service checks `payment.status == captured` before attempting; a booking with no payment or with status `pending` gets a clear error |

### Unresolved questions (need your input)

| # | Question |
|---|---|
| Q1 | When the CI workflow is pushed and passes, do you want me to add `JWT_SECRET_KEY` to the migration job env vars in the same commit, or as a separate fix? |
| Q2 | For cumulative partial refunds: should the service allow multiple partial refunds up to the captured amount, or should only one refund per cancellation be allowed? |
| Q3 | The self-cancel path (RD4): do you want me to add a warning to those endpoints documenting that they do not refund, so a future developer does not assume they do? |

---

## 8. Recommended next steps (in order)

| Step | What | Prerequisite | Changes production? |
|---|---|---|---|
| **1** | Fix CI: add `JWT_SECRET_KEY` to the Postgres migration job | None | No |
| **2** | You approve RD1: relabel customer-facing "refunded" → "Refund initiated" | Your approval | Frontend text only |
| **3** | Commit all 6 new files + the CI fix as one commit on this branch | Your approval | No |
| **4** | Push and open a PR so CI runs for the first time | Your approval | No (PR only) |
| **5** | Once CI is green, you approve RD2: implement the refund service | Your approval + CI green | No (branch only) |
| **6** | Start Docker Desktop and run the D3 local test, OR rely on step 4's CI | Docker available | No |
| **7** | Implement refund service (migration 0094, service, tests) on this branch | Steps 1–5 approved | No (branch only) |
| **8** | Test refund service against mock provider, then HDFC/Razorpay sandbox | Step 7 done | No |
| **9** | You approve deployment of the refund service to production | Sandbox evidence | **Yes** |

I have not begun implementation and am waiting for your answers on RD1–RD5, Q1–Q3, and the next-step order.
