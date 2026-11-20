# Admin Portal — D1 & D2 Root‑Cause Analysis

**Date:** 2026‑11‑13 · **Investigation only.** No code or tests modified, no PostgreSQL connection, no migration, no deploy/commit/push. Gaming disabled; B2B and B2C functionality preserved. **These failures are NOT claimed fixed** — this document diagnoses them and proposes the smallest safe corrections.

**How evidence was gathered:** ran the two files read‑only on the SQLite harness (`python -m pytest … -v --tb=line`), read the test files and the source under test, and checked `git log`/working‑tree state. Observed counts match the audit: **D1 = 22 failed / 19 passed**, **D2 = 22 failed / 9 passed**.

---

## D1 — `backend/tests/test_token_revocation.py` (22 failures)

### 1–2. Failing tests & captured exception
**Every one of the 22 failures raises the same exception:**
```
jose.exceptions.ExpiredSignatureError: Signature has expired.
  at .../jose/jwt.py:331  (called from tests/test_token_revocation.py:49, _decode)
```
Failing tests (all call `_decode(mint(...))`): `test_revocation_boundary[*]` (14 params, b2b+customer), `test_a_token_issued_before_a_reset_stays_invalid_for_its_whole_life[b2b|customer]`, `test_a_second_reset_revokes_the_session_that_survived_the_first[b2b|customer]`, `test_no_force_logout_means_never_revoked[b2b|customer]`, `test_every_token_carries_iat_ms_consistent_with_iat`, `test_the_standard_iat_claim_is_unchanged_for_other_consumers`.
**The 19 that PASS never decode a minted token** — they build payload dicts directly (`_legacy(...)`, malformed‑`iat_ms`, no‑issue‑time, and the naive/aware `is_revoked_by` test).

### 3. Affected files/functions
- Test helper `_decode` (`tests/test_token_revocation.py:48‑49`): `jwt.decode(token, …)` with **no `verify_exp` override**.
- Fixture clock `_Clock.now = datetime(2026, 11, 10, 12, 0, 5)` (`:29`) and the `at(...)` fixture monkeypatching `sec.datetime` (`:32‑45`).
- Source under test: `app/auth/security.py` — token creation reads `datetime.datetime.utcnow()` (`:69`) and sets `exp`; `is_revoked_by`/`_epoch_ms` (`:34‑57`) do the ms‑revocation compare.

### 4. Trace
`mint(7)` → `create_*_access_token` → builds a payload with `iat`/`iat_ms`/`exp` from the **faked** clock (2026‑11‑10 12:00:05); access‑token TTL is 30 min → `exp = 2026‑11‑10 12:30:05`. The test then calls `jwt.decode(...)` (`_decode`), which **validates `exp` against the real system clock**. The environment clock is **2026‑11‑13** — ~3 days past that `exp` — so jose raises `ExpiredSignatureError` *before* the test ever reaches the revocation assertion (`rule(account(...), payload)`).

### 5. Classification — **Test‑fixture problem (time‑dependent); pre‑existing; NOT a revocation‑logic regression.**
Evidence: (a) the exception is expiry, not an assertion about revocation; (b) only the tests that **decode a freshly minted token** fail — the ones that construct payloads directly all pass, so the revocation comparison logic (`is_revoked_by`) is exercised and correct; (c) the fixture hard‑codes a 2026‑11‑10 clock and `security.py`'s own comment says "everything issued since 2026‑11‑10", so the suite was green on/near that date and rots once wall‑clock passes the token's 30‑minute expiry. Production `decode_token` *should* verify `exp`; nothing here indicates a production fault.

### 6. Smallest safe correction (TEST‑ONLY — do not change production)
In the test's `_decode`, skip expiry verification, since the test's purpose is the **revocation boundary**, not expiry, and the fixed historical clock is deliberate (the `iat`/`iat_ms` assertions depend on it):
```python
# tests/test_token_revocation.py:48  (proposed; not applied)
def _decode(token):
    return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm],
                      options={"verify_exp": False})
```
This is isolated to the test helper, touches no production code, and does not weaken any runtime check (production `decode_token` keeps verifying `exp`). *(Alternative — anchoring the fake clock to a dynamic "now" — is rejected: `test_every_token_carries_iat_ms_consistent_with_iat` asserts `iat` equals the fixed 2026‑11‑10 timestamp, so the fixed date is load‑bearing; disabling `verify_exp` is the minimal change.)*

### 7. Related regression tests
The 19 passing tests in the same file (legacy‑iat, malformed‑`iat_ms`, no‑issue‑time, naive/aware) must stay green. After the fix, add/confirm an assertion that production `decode_token` **still rejects** a genuinely expired token (so `verify_exp=False` in the test never leaks into runtime). Downstream: the M1 "block → old token rejected" behaviour relies on this revocation path — worth an E2E once D1 is green.

---

## D2 — `backend/tests/test_admin_supplier_reservation_http.py` (22 failures)

### 1–2. Failing tests & captured assertions
All failures are **authorization 403s reaching the assertion as the wrong status**, e.g.:
```
tests/test_admin_supplier_reservation_http.py:375  assert 403 == 409
:389 assert 403 == 409   :405 assert 403 == 500   :417 assert 403 == 422   :425 assert 403 == 200
```
Failing tests include `test_admin_holds_the_permission`, `test_admin_lists_only_held_bookings…`, `test_an_admin_resolves_a_held_booking_once…`, `test_resolution_is_audited…`, `test_a_duplicate_resolution…`, `test_invalid_or_missing_order_ids…[bad0‑7]`, `test_unknown_booking_is_404`, `test_a_booking_that_is_not_held_is_refused`, `test_a_held_marker_without_a_captured_payment…`, `test_an_invalid_state_transition…[cancelled|completed]`, `test_a_cancelled_booking…`, `test_a_failure_after_the_supplier_fields_are_written_rolls_everything_back`, `test_a_rejected_request_leaves_the_session_clean…`, `test_the_supplier_is_never_asked_to_verify`. Each expects a business status (200/404/409/422/500) but gets **403**.

### 3. Affected files/functions
- Endpoint gate: `app/routers/admin_reconciliation.py` — all four routes use `Depends(require_scope(P.B2C_PAYMENTS_VERIFY, P.PAYMENT_VERIFY))` (lines 48, 85, 136, 163).
- `require_scope` semantics: `app/auth/rbac.py` — uses `User.has_permission` (super‑admin short‑circuit **or an EXPLICIT grant in `users.permissions`**), **never role defaults**; default is **OR** across the listed codes.
- Test fixture: `tests/test_admin_supplier_reservation_http.py` — `admin` fixture (`:143‑145`) → `_user(env, UserRole.ADMIN)` with `permissions=None` → **`permissions=[]`** (`:131‑140`).

### 4. Trace
`_resolve(env, ref, admin, …)` calls the endpoint with the admin's bearer token. `require_scope(B2C_PAYMENTS_VERIFY, PAYMENT_VERIFY)` evaluates `any(has(code))` where `has(c) = is_super or c in users.permissions`. The test admin is **role ADMIN, not super‑admin, with an empty `permissions` list**, so it holds *neither* `b2c.payments.verify` *nor* `payment.verify` explicitly → `any(...) = False` → **403**, before any reconciliation logic runs. Every business assertion then compares against 403.

### 5. Classification — **Intentional auth change (Stage‑1 B2C scope isolation) with a stale test fixture; NOT a business‑logic regression.**
Evidence: the test docstring states it exercises "the real `require(P.PAYMENT_VERIFY)` dependency" — i.e. when written, the gate was `require(...)`, which **is role‑aware**, so a plain ADMIN passed via role defaults. The gate is now `require_scope(...)`, which deliberately ignores role defaults so **B2B‑only admins are kept out of the B2C desks**. Git/working‑tree evidence: `app/routers/admin_reconciliation.py` is **modified in the working tree** (uncommitted — the gate was tightened), while `tests/test_admin_supplier_reservation_http.py` is unchanged since commit `c6b8a5d` and still assumes the old gate. The business paths (attestation, 409 duplicate/invalid‑state, 422 validation, 500 rollback, "supplier never called") are unreachable because auth denies first — not because they are broken.

### 6. Smallest safe correction (TEST‑ONLY — do not weaken the endpoint)
Grant the test's `admin` the explicit scope the new gate requires (OR‑semantics, so one code suffices; granting both is clearest and matches the B2C desk intent):
```python
# tests/test_admin_supplier_reservation_http.py:143  (proposed; not applied)
@pytest.fixture()
def admin(env):
    return _user(env, UserRole.ADMIN, name="Ada Admin",
                 permissions=[P.B2C_PAYMENTS_VERIFY, P.PAYMENT_VERIFY])
```
`P` is already imported in the test. This changes only the fixture — the endpoint keeps its stronger `require_scope` gate, so B2B and B2C isolation is preserved (not weakened). Do **not** revert the endpoint to `require(...)` to make the test pass; that would undo Stage‑1 isolation.

### 7. Related regression tests
- Keep/confirm a **negative** authorization test — an unprivileged user (role ADMIN, no scope, or a B2B‑only admin) must still get **403** on these endpoints. (If one of the current 9 passing tests is that denial case, it must remain passing after the fixture gains the scope; if none exists, add one.) This mirrors `test_b2c_permission_isolation.py`.
- Cross‑check: `test_admin_permissions.py` / `test_rbac.py` (authorization), and that the 4 reconciliation endpoints also behave under the M0 audit‑readiness gate (503 when `customer_admin_audit_logs` is absent) — not in scope for D2's 403 cause, but relevant when this file is next exercised against a schema that lacks 0095.

---

## Cross‑cutting findings
- **Neither D1 nor D2 is a defect in production business logic.** D1 is a time‑rotting test fixture; D2 is a stale fixture after an intentional, desirable auth tightening. Both fixes are **test‑only**; no runtime behaviour should change.
- **Do not "fix" either by weakening production:** keep `decode_token` verifying `exp` (D1) and keep `require_scope` on the reconciliation endpoints (D2). The safety of the portal depends on both.
- These two files are exactly the 44 failures flagged across the session; resolving them (test‑only) would bring the suite to green without altering shipped behaviour — but **that work is not done here** and is not claimed.

## Safest implementation order (when authorized to edit tests)
1. **D2 first** — a one‑line fixture change (`permissions=[P.B2C_PAYMENTS_VERIFY, P.PAYMENT_VERIFY]`); unambiguous, exercises real routing/auth, and immediately re‑enables 22 business assertions. Re‑run the file; confirm the negative‑auth test still 403s.
2. **D1 second** — add `options={"verify_exp": False}` to `_decode`; re‑run the file; confirm the 19 previously‑passing tests stay green and add the "production decode still rejects expired" guard.
3. **Full‑suite re‑run** to confirm the count moves from "1744 passed / 44 failed" toward green with **no change to any non‑test file**.
4. Only then consider the deeper follow‑ups the audit noted (D3 deploy 0095; the block→token‑rejected and idempotent‑reconcile E2E assertions).

---

*Investigation only. Root causes are evidenced from test output, source, and git/working‑tree state. No code/tests changed; no DB/migration/deploy/commit. Failures are diagnosed, not fixed. B2B and B2C functionality preserved; Gaming disabled; production readiness not claimed.*
