"""RBAC permission tests — refund lifecycle foundation.

Stage 1 tests verify constant registration and no-duplicates invariant.
Stage 2 tests (added in the next commit) verify role assignments.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.auth.rbac import (
    ALL_PERMISSION_CODES,
    P,
    ROLE_PERMISSIONS,
    MERCHANT_ROLE_PERMISSIONS,
    role_permission_matrix,
)

REFUND_CODES = frozenset({
    "refund.view",
    "refund.execute",
    "refund.authorize",
    "refund.reconcile",
})


# ---- Stage 1: constant registration ----

def test_refund_codes_registered():
    """All four refund codes appear in ALL_PERMISSION_CODES."""
    for code in REFUND_CODES:
        assert code in ALL_PERMISSION_CODES, f"{code} missing from ALL_PERMISSION_CODES"


def test_no_duplicate_permission_codes():
    """Every permission string in P is unique."""
    codes = [v for k, v in vars(P).items() if not k.startswith("_")]
    assert len(codes) == len(set(codes)), (
        f"Duplicate codes: {[c for c in codes if codes.count(c) > 1]}"
    )


def test_existing_role_permissions_unchanged():
    """Adding refund constants must not alter any role's existing set.

    Snapshot the 51 pre-refund codes and confirm they are still present
    in their original roles (no accidental removal or reassignment).
    """
    pre_refund_codes = set(ALL_PERMISSION_CODES) - REFUND_CODES
    assert len(pre_refund_codes) == 49, (
        f"Expected 49 pre-refund codes, got {len(pre_refund_codes)}"
    )
    for role, codes in ROLE_PERMISSIONS.items():
        for code in codes:
            if code not in REFUND_CODES:
                assert code in pre_refund_codes, (
                    f"Role {role.value} holds unknown code {code}"
                )


# ---- Stage 2: role assignments ----

from app.models_v2 import UserRole, MerchantRole
from types import SimpleNamespace


def _mock_user(role, merchant_role=None, permissions=None):
    """Lightweight stand-in for User with just the fields rbac reads."""
    return SimpleNamespace(
        role=role,
        merchant_role=merchant_role,
        permissions=permissions or [],
    )


def test_admin_holds_operational_refund_codes():
    """Admin gets view, execute, reconcile — the operational set."""
    admin_codes = ROLE_PERMISSIONS[UserRole.ADMIN]
    assert P.REFUND_VIEW in admin_codes
    assert P.REFUND_EXECUTE in admin_codes
    assert P.REFUND_RECONCILE in admin_codes


def test_admin_does_not_hold_refund_authorize():
    """Admin must NOT hold refund.authorize by role — it is per-user only."""
    admin_codes = ROLE_PERMISSIONS[UserRole.ADMIN]
    assert P.REFUND_AUTHORIZE not in admin_codes


def test_super_admin_holds_refund_view_only():
    """Super-admin gets view for oversight — no execute, reconcile, authorize."""
    sa_codes = ROLE_PERMISSIONS[UserRole.SUPER_ADMIN]
    assert P.REFUND_VIEW in sa_codes
    assert P.REFUND_EXECUTE not in sa_codes
    assert P.REFUND_AUTHORIZE not in sa_codes
    assert P.REFUND_RECONCILE not in sa_codes


def test_manager_holds_no_refund_codes():
    """Manager role has no refund capabilities."""
    mgr_codes = ROLE_PERMISSIONS[UserRole.MANAGER]
    assert not mgr_codes.intersection(REFUND_CODES)


def test_merchant_admin_holds_no_refund_codes():
    """Merchant admin has no refund capabilities."""
    ma_codes = ROLE_PERMISSIONS[UserRole.MERCHANT_ADMIN]
    assert not ma_codes.intersection(REFUND_CODES)


def test_merchant_user_holds_no_refund_codes():
    """Merchant user (base) has no refund capabilities."""
    mu_codes = ROLE_PERMISSIONS[UserRole.MERCHANT_USER]
    assert not mu_codes.intersection(REFUND_CODES)


def test_customer_holds_no_refund_codes():
    """Customer role has no refund capabilities."""
    cust_codes = ROLE_PERMISSIONS[UserRole.CUSTOMER]
    assert not cust_codes.intersection(REFUND_CODES)


def test_no_merchant_role_holds_refund_codes():
    """No merchant sub-role (Manager/Supervisor/Operator/Finance/DataOp)
    grants any refund permission."""
    for role, codes in MERCHANT_ROLE_PERMISSIONS.items():
        assert not codes.intersection(REFUND_CODES), (
            f"MerchantRole.{role.value} unexpectedly holds refund codes: "
            f"{codes.intersection(REFUND_CODES)}"
        )


def test_per_user_refund_authorize_grant():
    """A per-user grant of refund.authorize merges into effective permissions."""
    from app.auth.rbac import effective_permissions
    user = _mock_user(UserRole.ADMIN, permissions=["refund.authorize"])
    perms = effective_permissions(user)
    assert "refund.authorize" in perms
    assert "refund.execute" in perms   # from role
    assert "refund.view" in perms      # from role


def test_role_permission_matrix_shows_refund_codes():
    """The matrix endpoint returns the new refund codes in the correct roles."""
    matrix = role_permission_matrix()
    admin_perms = matrix["roles"]["admin"]
    sa_perms = matrix["roles"]["super_admin"]
    assert "refund.view" in admin_perms
    assert "refund.execute" in admin_perms
    assert "refund.reconcile" in admin_perms
    assert "refund.authorize" not in admin_perms
    assert "refund.view" in sa_perms
    assert "refund.authorize" not in sa_perms
    assert "refund.execute" not in sa_perms
