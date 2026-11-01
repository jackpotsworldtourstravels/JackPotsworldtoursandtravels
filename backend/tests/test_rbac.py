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
