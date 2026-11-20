# Admin Portal — Final Regression Review (post D1/D2 test corrections)

**Date:** 2026‑11‑13 · **Read‑only verification.** No code edited, no PostgreSQL connection, no migration, no deploy/commit/push/merge. Nothing discarded, reset, stashed or overwritten. Gaming disabled. All results below are quoted from **actual** `pytest`/`git` output run during this review.

---

## 1. Exact diffs reviewed

### D2 — `backend/tests/test_admin_supplier_reservation_http.py` (tracked; `git diff` = +38 / −3)
Four changes, **all in the test file**:
1. Imports `os`, `tempfile` (for the temp‑file DB).
2. Imports `CustomerAdminAuditLog` and creates its table in the `env` fixture, so the audited POST's M0 readiness check (`require_audit_ready` via `record_in_session`) does not 503 — the same table `conftest.py` creates.
3. `env` fixture engine switched from StaticPool in‑memory to a **temp‑file SQLite DB** (with `os.unlink` teardown), so the readiness probe's `inspect(engine)` uses its own connection and cannot roll back the request transaction. (See §5.)
4. `admin` fixture granted explicit `permissions=[P.B2C_PAYMENTS_VERIFY, P.PAYMENT_VERIFY]`; added negative test `test_an_admin_role_without_explicit_scope_is_refused` (ADMIN with no explicit grant → 403 on both endpoints, nothing written).

### D1 — `backend/tests/test_token_revocation.py` (**untracked** working‑tree file; no git base, so no `git diff` — regions captured directly)
Two changes, **all in the test file**:
1. `_decode` helper now passes `options={"verify_exp": False}` (lines 48‑55). Comment documents that the fixed historical clock (`_Clock = 2026‑11‑10`) is deliberate for the `iat`/`iat_ms` assertions and that production enforcement is asserted separately.
2. Added `test_production_decode_token_rejects_an_expired_token` (lines 176‑184): encodes a token with an explicitly past `exp` and asserts production `sec.decode_token(...) is None`.

**No other files were edited by this task.**

---

## 2. Production‑invariant confirmations (evidence)

| Invariant | Evidence | Verdict |
|---|---|---|
| `decode_token` still validates expiry | `app/auth/security.py:210‑214` — `jwt.decode(token, …)` with **no** `options`/`verify_exp=False`; `except JWTError: return None` (ExpiredSignatureError ⊂ JWTError). The `verify_exp=False` exists **only** in the test `_decode`. | **Intact** — and now guarded by `test_production_decode_token_rejects_an_expired_token`. |
| `require_scope` still requires explicit permission or super‑admin | `app/auth/rbac.py` `require_scope._dependency`: `is_super = role is UserRole.SUPER_ADMIN`; `held = set(current_user.permissions or [])`; `has = lambda c: is_super or c in held`; role defaults never consulted. Unchanged. | **Intact** — the D2 fix added the scope to the **test** admin, not to the gate. |
| No production authorization/business logic weakened | Only two test files changed (§3). `admin_reconciliation.py` keeps `require_scope(P.B2C_PAYMENTS_VERIFY, P.PAYMENT_VERIFY)` on all four routes; `supplier_guard.complete_reservation` untouched. | **Confirmed** |
| B2B/B2C separation intact | `require_scope` semantics unchanged; `test_b2c_permission_isolation.py`, `test_admin_chat_b2c_isolation.py`, `test_rbac.py`, `test_admin_permissions.py` → **99 passed**; D2 negative test proves a role‑only ADMIN is 403. | **Confirmed** |
| Gaming Tour Packages disabled | `config.gaming_tour_packages_enabled` defaults unset (disabled); `test_gaming_fail_closed.py` → **39 passed**. | **Confirmed** |

---

## 3. Working‑tree status (nothing changed by this review)

`git status --short`: **59 tracked‑modified** + **54 untracked** files. These are overwhelmingly the **pre‑existing, uncommitted Stage‑1/2/3 work** from before this task (routers, services, schemas, migrations‑adjacent, mobile‑app, frontend, docs, and the new B2C test files). **This task touched only two of them.**

**The two latest (this‑task) changes — isolated from the pre‑existing set:**
| File | Git state | Origin |
|---|---|---|
| `backend/tests/test_admin_supplier_reservation_http.py` | **tracked, modified (` M`)** | **This task** (was *not* in the session‑start modified list). |
| `backend/tests/test_token_revocation.py` | **untracked (`??`)** | Pre‑existing uncommitted file; **this task edited its contents** (so edits don't appear in `git diff`, but are on disk and effective — D1 passes). |

**Pre‑existing (NOT this task) — examples for separation:**
- Tracked‑modified tests already present at session start: `tests/conftest.py`, `tests/test_customer_refunds.py`, `tests/test_customer_refunds_http.py`, `tests/test_rbac.py`, plus `mobile-app/tests/*`, `tests/js/*`, `tests/run_all.py`, `tests/verify_m1.py`, `tests/verify_payments.py`.
- Untracked (newly created before this task): `tests/test_b2c_*`, `tests/test_admin_chat_b2c_isolation.py`, `tests/test_admin_permissions.py`, `tests/test_b2c_admin_readiness.py`, `tests/test_b2c_customer_admin_actions.py`, etc.
- Tracked‑modified production (pre‑existing, **untouched here**): `backend/app/routers/admin_reconciliation.py`, `customer_admin.py`, `admin_reviews.py`, services, schemas, etc.

No file was discarded, reset, stashed, or overwritten.

---

## 4. Verified test results (actual output, this review)

| Run | Command | Result |
|---|---|---|
| D1 | `pytest tests/test_token_revocation.py` | **42 passed** |
| D2 | `pytest tests/test_admin_supplier_reservation_http.py` | **32 passed** |
| Authorization/isolation | `pytest tests/test_rbac.py test_admin_permissions.py test_b2c_permission_isolation.py test_admin_chat_b2c_isolation.py` | **99 passed** |
| Gaming disabled | `pytest tests/test_gaming_fail_closed.py` | **39 passed** |
| **Full suite** | `pytest tests/` | **1827 passed, 4 skipped, 0 failed, 0 errors** |

**Resolution of the 44:** both target files previously reported **22 + 22 = 44 failures**; they are now **0 failures** (D1 42 passed = the 22 + the new guard + the 19 that already passed; D2 32 passed = the 22 + the new negative test + the 9 that already passed). The full suite shows **no failures or errors**. *(The absolute "passed" total differs from earlier runs because the working tree's untracked test corpus has grown across the broader Stage‑3 work; the material facts — 0 failed, both target files green — are directly measured.)*

---

## 5. Side‑effect assessment of the test‑only changes

| Area | Assessment |
|---|---|
| Production runtime | **None.** No production file changed; `decode_token` and `require_scope` verified unchanged (§2). |
| D1 `verify_exp=False` scope | Confined to the test `_decode`; cannot leak to runtime; the new guard test fails if production ever stops enforcing `exp`. |
| D2 temp‑file DB | Each `env` creates one temp `.sqlite`, removed in teardown (`os.unlink`, after `engine.dispose()`). A hard crash mid‑test could orphan a temp file in the OS temp dir — negligible, self‑cleaning on reboot. |
| D2 extra table in fixture | Makes the harness match production/`conftest.py` (audit table present); does not alter any assertion's intent. |
| Unused import | `from sqlalchemy.pool import StaticPool` is now unused in the D2 file (harmless; no runtime/lint failure in the suite). Cosmetic — optional cleanup, not required. |
| Other suites | Full suite green; no collection changes beyond the two added tests; no cross‑test state (temp DB is per‑fixture, cache reset fixtures intact). |

---

## Summary & remaining risks
- **Both corrections are test‑only and verified.** Production `decode_token` (expiry) and `require_scope` (explicit/super‑admin) are provably unchanged; B2B/B2C isolation holds; Gaming stays disabled. The full suite is **green (1827 passed, 4 skipped, 0 failed/0 errors)** and all 44 previously‑failing tests pass.
- **Remaining risks (unchanged by this task, carried from the audit):**
  1. The B2C audit layer is still **BLOCKED BY DEPLOYMENT** — migration **0095** is unapplied, so audited B2C endpoints 503 at runtime until it (and the DBA grants) are applied. The D2 fix only adds the table in the test harness; **production DB is untouched.**
  2. The DB **role‑separation / least‑privilege runtime account** (D4 in the audit) is still not implemented — the app connects as owner/superuser.
  3. These are **unit/HTTP tests on SQLite**, not live‑DB/browser E2E; the `tests/verify_*.py` live‑server scripts were **not** run here.
  4. One cosmetic item: the now‑unused `StaticPool` import in the D2 test (no functional impact).
- **No production code, database, migration, configuration, or deployment was changed, and nothing in the working tree was discarded or reset.**

*Read‑only review. All pass/fail numbers and git states are quoted from actual command output produced during this review.*
