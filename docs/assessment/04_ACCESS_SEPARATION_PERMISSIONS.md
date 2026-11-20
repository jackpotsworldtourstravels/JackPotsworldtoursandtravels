# Admin Portal Assessment — 4. Access Separation & Permissions Review

**Date:** 2026-11-13 · Read-only. Sources: `backend/app/auth/rbac.py`, `auth/deps.py`, `auth/customer_deps.py`, the B2C admin routers, `admin.js`.

## Identity & token model
- One admin identity store: **B2B `users`** (role enum + a JSONB `permissions` array). `auth/deps.get_current_user` accepts only a `scope=None` (core admin/staff) token; partner/super-admin/customer tokens carry a distinct `scope` and are refused here.
- Retail customers authenticate on a separate `scope='customer'` token (`auth/customer_deps`), structurally unable to reach admin endpoints.
- The Admin Portal's B2B/B2C **mode toggle is UI only** (`admin.js:208-227`) — it is NOT an authorization boundary; every gate is server-side.

## B2B authorization (RBAC)
- `rbac.py` defines permission codes (`P.*`), role defaults (`ROLE_PERMISSIONS`: super_admin/admin/manager/merchant_admin/merchant_user/customer) and merchant sub-role defaults. Effective permissions = role defaults ∪ merchant-role defaults ∪ explicit `users.permissions`.
- Enforced by `rbac.require(*codes)` (role-aware) and `deps.require_permission(code)` (explicit/`has_permission`). `assert_same_merchant` confines merchant users to their own rows.
- **Unchanged by Stage 1/2.** B2B functionality and its permission codes are preserved.

## B2C authorization (the `b2c.*` namespace — Stage 1)
- New namespace in `P`: `b2c.customers.view`, `b2c.catalogue.manage`, `b2c.payments.verify`, `b2c.refunds.{view,execute,authorize,reconcile}`, `b2c.reports.{view,export}`, `b2c.chat.manage`, `b2c.audit.view` — all collected in `B2C_SCOPES`, and **deliberately in NO role default**.
- Three enforcement mechanisms, all consulting **explicit grants** (`users.permissions`) or the super-admin short-circuit, never the role-default matrix:
  - `require_scope(*codes)` — most B2C admin endpoints (customers, bookings, reviews, catalogue, reconciliation, payment, reports).
  - `require_b2c_access()` — a router-level **domain gate** on `admin_cancellations` (paired with the unchanged `require(P.REFUND_*)` capability checks, so maker-checker + super-admin-view-only are preserved while a role-default B2B admin is refused).
  - `get_current_b2c_admin` — `admin_chat` HTTP routes (admin role + B2C domain); the WebSocket admits only a ticket minted by the now-gated `/ws-ticket`.
- **Isolation result (tested):** a B2B-only admin (role default, no `b2c.*`) → **403** on B2C admin endpoints; a B2C-only operator → 403 on B2B; super-admin and dual-grant → both. Evidence: `test_b2c_permission_isolation`, `test_admin_chat_b2c_isolation`, the refund B2B-only 403 test, `test_catalogue_update_is_denied_without_the_b2c_scope`.

## Audit separation
- **B2B:** `audit_logs` (DB trigger, whole-row, redacted on read) + `system_logs` (activity, actor-attributed).
- **B2C customer self-service:** `customer_audit_logs` (the customer's own trail — no admin actor).
- **B2C admin actions:** `customer_admin_audit_logs` (Stage 2) — actor snapshot (no cross-Base FK), 4 outcomes, redacted, append-only, read behind `b2c.audit.view`. Writes dual-write to `system_logs` for backward-compat. **Not deployed** (migration 0095 pending).
- The three trails are distinct by design; no B2C-admin action writes the customer's own trail or the B2B trigger table.

## Frontend vs backend gating
- The sidebar shows/hides B2B vs B2C groups by mode, but this is **not** a security control. Backend `require_scope`/`require_b2c_access`/role checks are the real boundary.
- **Observation (not a defect, but a hardening opportunity):** the portal nav is **not yet scope-gated** — it shows the B2C groups regardless of whether the logged-in admin holds `b2c.*`. A B2B-only admin would see B2C nav items and receive 403s on use. True enforcement holds (server-side); only the UI is unfiltered. (This is "Track B" in the earlier roadmap.)

## Findings
| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | B2B/B2C server-side isolation enforced via explicit `b2c.*` scopes | — | **Verified sound** (tested) |
| 2 | Admin nav not scope-filtered (UI shows items the user can't use) | Low (UX) | Open — Track B |
| 3 | B2C admin audit trail not deployed (0095) | Medium | Open — needs DB execution |
| 4 | Provisioning: existing non-super admins need explicit `b2c.*` grants to use B2C after Stage 1 | Medium (operational) | Documented; data step, no migration |
| 5 | No separate "B2C-admin" role — B2C access is grant-based on the single identity store | By design | Acceptable under one-DB logical-separation model |
| 6 | Super-admin short-circuit grants all `b2c.*` (incl. audit view) | By design | Expected |

**Net:** the access-separation design is coherent and server-enforced; the gaps are a UI nav filter (low), the undeployed audit table (medium), and operational grant provisioning (medium). No missing authorization check was found on the B2C admin endpoints reviewed.
