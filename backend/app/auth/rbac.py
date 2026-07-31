"""Role-based access control for the three-role B2B platform.

Single source of truth for "who may do what". Every protected endpoint
declares a permission code and this module decides, rather than each router
re-deriving rules from ``user.role`` — which is how the two surfaces drift
apart and a merchant ends up seeing another merchant's data.

Three portal roles, plus a merchant's own internal staff roles:

* ``super_admin`` — manages Admins. Explicitly cannot raise tickets.
* ``admin``       — manages Merchants, approves tickets, handles payments.
* ``merchant_admin`` / ``merchant_user`` — raise and track their own requests.

A user's effective permissions are the union of:

1. the defaults for their :class:`UserRole`,
2. the defaults for their :class:`MerchantRole`, when they have one, and
3. any explicit codes in ``users.permissions`` (the JSONB array that
   replaced the ``permissions``/``role_permissions`` tables).

``super_admin`` short-circuits to "everything in its own role set" — note
that this is *not* a wildcard: the spec deliberately denies super admins
ticket creation, and :func:`has_permission` honours that.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, status

from app.models_v2 import MerchantRole, User, UserRole


# ---------------------------------------------------------------------------
# Permission codes
# ---------------------------------------------------------------------------
class P:
    """Permission codes, grouped by module."""

    # Super Admin — administrator lifecycle
    ADMIN_CREATE = "admin.create"
    ADMIN_EDIT = "admin.edit"
    ADMIN_SUSPEND = "admin.suspend"
    ADMIN_DELETE = "admin.delete"
    ADMIN_RESET_PASSWORD = "admin.reset_password"
    ADMIN_VIEW = "admin.view"

    # Merchant lifecycle (Admin)
    MERCHANT_CREATE = "merchant.create"
    MERCHANT_APPROVE = "merchant.approve"
    MERCHANT_EDIT = "merchant.edit"
    MERCHANT_SUSPEND = "merchant.suspend"
    MERCHANT_VIEW = "merchant.view"

    # Merchant's own staff (Merchant)
    MERCHANT_USER_CREATE = "merchant_user.create"
    MERCHANT_USER_MANAGE = "merchant_user.manage"

    # Tickets / bookings
    TICKET_ENQUIRY = "ticket.enquiry"
    TICKET_REQUEST = "ticket.request"
    TICKET_VIEW = "ticket.view"
    TICKET_APPROVE = "ticket.approve"
    TICKET_REJECT = "ticket.reject"
    TICKET_ISSUE = "ticket.issue"

    # Manager sign-off on a submitted Booking Request (CR-2).
    #
    # WHY THESE ARE NOT ``TICKET_APPROVE`` / ``TICKET_REJECT``
    # Those two are the Admin's codes for the catalog-led approval queue, and
    # the whole point of the Manager step is that the desk which answered the
    # enquiry cannot also sign off the booking. Reusing the Admin's codes would
    # have handed every Admin the Manager's job on day one; giving the Manager
    # the Admin's codes would have handed it the catalog queue as well.
    BOOKING_MANAGER_APPROVE = "booking.manager_approve"
    BOOKING_MANAGER_RETURN = "booking.manager_return"

    # Service requests (date change, cancellation, refund, ancillaries)
    SERVICE_REQUEST_CREATE = "servicerequest.create"
    SERVICE_REQUEST_MANAGE = "servicerequest.manage"

    # Payments
    PAYMENT_PAY = "payment.pay"
    PAYMENT_VERIFY = "payment.verify"
    PAYMENT_MANAGE = "payment.manage"
    PAYMENT_VIEW = "payment.view"

    # Reports
    REPORT_VIEW = "report.view"
    REPORT_EXPORT = "report.export"

    # Support / chat
    CHAT_CREATE = "chat.create"
    CHAT_VIEW = "chat.view"
    CHAT_MANAGE = "chat.manage"
    SUPPORT_MANAGE = "support.manage"

    # Documents
    DOCUMENT_UPLOAD = "document.upload"
    DOCUMENT_VERIFY = "document.verify"

    # Cross-cutting
    PROFILE_MANAGE = "profile.manage"
    NOTIFICATION_VIEW = "notification.view"
    NOTIFICATION_SEND = "notification.send"
    SYSTEM_ACTIVITY_VIEW = "system.activity.view"
    AUDIT_VIEW = "audit.view"


# ---------------------------------------------------------------------------
# The matrix
# ---------------------------------------------------------------------------
# Mirrors the permission table in the spec. Where the spec says a role must
# NOT have something (Super Admin raising tickets, Admin creating admins),
# the code is simply absent — there is no override that grants it.
_SUPER_ADMIN: frozenset[str] = frozenset({
    P.ADMIN_CREATE, P.ADMIN_EDIT, P.ADMIN_SUSPEND, P.ADMIN_DELETE,
    P.ADMIN_RESET_PASSWORD, P.ADMIN_VIEW,
    P.MERCHANT_VIEW,               # visibility only — creation belongs to Admin
    P.REPORT_VIEW, P.REPORT_EXPORT,
    P.CHAT_VIEW,                   # "View" in the spec's Chat Support row
    P.PROFILE_MANAGE,
    P.NOTIFICATION_VIEW,
    P.SYSTEM_ACTIVITY_VIEW, P.AUDIT_VIEW,
})

_ADMIN: frozenset[str] = frozenset({
    P.MERCHANT_CREATE, P.MERCHANT_APPROVE, P.MERCHANT_EDIT,
    P.MERCHANT_SUSPEND, P.MERCHANT_VIEW,
    # Full lifecycle of a merchant's staff logins from the Admin portal: list,
    # create (POST /api/admin/merchants/{id}/users), and reset password. The
    # separate MERCHANT_USER_CREATE below stays a merchant-only code — it is
    # what lets a merchant add staff to its OWN company via /api/merchant/team,
    # and admins reach the same service through the merchant-scoped path above
    # rather than by holding it.
    P.MERCHANT_USER_MANAGE,
    P.TICKET_VIEW, P.TICKET_APPROVE, P.TICKET_REJECT, P.TICKET_ISSUE,
    P.SERVICE_REQUEST_MANAGE,
    P.PAYMENT_MANAGE, P.PAYMENT_VERIFY, P.PAYMENT_VIEW,
    P.REPORT_VIEW, P.REPORT_EXPORT,
    P.CHAT_MANAGE, P.CHAT_VIEW, P.SUPPORT_MANAGE,
    P.DOCUMENT_VERIFY,
    P.PROFILE_MANAGE,
    P.NOTIFICATION_VIEW, P.NOTIFICATION_SEND,
    P.SYSTEM_ACTIVITY_VIEW, P.AUDIT_VIEW,
})

# The Manager (CR-2) exists to do exactly one thing: read a submitted Booking
# Request in full and either send it to the operations desk or send it back to
# the merchant. Everything it needs to *see* comes through its own endpoints,
# which scope by ``is_platform_staff``, so it holds no ``ticket.view`` — that
# code is what opens the Admin's booking screens, the operations queue and the
# internal-notes API, none of which are the Manager's business.
#
# Notably absent, and deliberately: ticket.approve / ticket.reject (the Admin's
# catalog queue), ticket.issue (the operations desk), every payment code (this
# workflow has no payment step), and merchant/admin lifecycle codes.
_MANAGER: frozenset[str] = frozenset({
    P.BOOKING_MANAGER_APPROVE, P.BOOKING_MANAGER_RETURN,
    P.PROFILE_MANAGE,
    P.NOTIFICATION_VIEW,
})

_MERCHANT_ADMIN: frozenset[str] = frozenset({
    P.MERCHANT_USER_CREATE, P.MERCHANT_USER_MANAGE,
    P.TICKET_ENQUIRY, P.TICKET_REQUEST, P.TICKET_VIEW,
    P.SERVICE_REQUEST_CREATE,
    P.PAYMENT_PAY, P.PAYMENT_VIEW,
    P.REPORT_VIEW, P.REPORT_EXPORT,
    P.CHAT_CREATE, P.CHAT_VIEW,
    P.DOCUMENT_UPLOAD,
    P.PROFILE_MANAGE,
    P.NOTIFICATION_VIEW,
})

# A plain merchant user gets nothing beyond profile/notifications until a
# merchant sub-role grants more — least privilege by default.
_MERCHANT_USER: frozenset[str] = frozenset({
    P.PROFILE_MANAGE,
    P.NOTIFICATION_VIEW,
    P.TICKET_VIEW,
})

ROLE_PERMISSIONS: dict[UserRole, frozenset[str]] = {
    UserRole.SUPER_ADMIN: _SUPER_ADMIN,
    UserRole.ADMIN: _ADMIN,
    UserRole.MANAGER: _MANAGER,
    UserRole.MERCHANT_ADMIN: _MERCHANT_ADMIN,
    UserRole.MERCHANT_USER: _MERCHANT_USER,
    UserRole.CUSTOMER: frozenset(),   # retail customers are out of scope
}


# Merchant sub-roles refine what a merchant_user may do inside their company.
#
# Operator and Data Operator are the SAME ROLE, by the business's decision
# (2026-07-31). They used to differ by ``ticket.request``: a Data Operator could
# ask the desk about a sector but not turn the answer into a booking. In
# practice the two names described one job, and the split only surfaced as a
# 403 at the end of a filled-in booking form.
#
# Bound to one frozenset rather than copied, so the two cannot drift apart
# again — that drift is the whole bug. Both enum members are kept: they are
# stored in ``users.merchant_role`` on live rows and named in migration 0025,
# so removing either means a data migration, not an edit here.
_MERCHANT_OPERATOR: frozenset[str] = frozenset({
    P.TICKET_ENQUIRY, P.TICKET_REQUEST, P.TICKET_VIEW,
    P.SERVICE_REQUEST_CREATE,
    P.CHAT_CREATE, P.DOCUMENT_UPLOAD,
})

MERCHANT_ROLE_PERMISSIONS: dict[MerchantRole, frozenset[str]] = {
    MerchantRole.MANAGER: frozenset({
        P.MERCHANT_USER_CREATE, P.MERCHANT_USER_MANAGE,
        P.TICKET_ENQUIRY, P.TICKET_REQUEST, P.TICKET_VIEW,
        P.SERVICE_REQUEST_CREATE,
        P.PAYMENT_PAY, P.PAYMENT_VIEW,
        P.REPORT_VIEW, P.REPORT_EXPORT,
        P.CHAT_CREATE, P.DOCUMENT_UPLOAD,
    }),
    MerchantRole.SUPERVISOR: frozenset({
        P.TICKET_ENQUIRY, P.TICKET_REQUEST, P.TICKET_VIEW,
        P.SERVICE_REQUEST_CREATE,
        P.PAYMENT_VIEW,
        P.REPORT_VIEW, P.REPORT_EXPORT,
        P.CHAT_CREATE, P.DOCUMENT_UPLOAD,
    }),
    MerchantRole.OPERATOR: _MERCHANT_OPERATOR,
    MerchantRole.FINANCE: frozenset({
        P.TICKET_VIEW,
        P.PAYMENT_PAY, P.PAYMENT_VIEW,
        P.REPORT_VIEW, P.REPORT_EXPORT,
    }),
    MerchantRole.DATA_OPERATOR: _MERCHANT_OPERATOR,
}


#: Every permission code that exists, derived from the ``P`` class rather
#: than hand-maintained — adding a new ``P.X = "..."`` picks it up for free.
ALL_PERMISSION_CODES: tuple[str, ...] = tuple(
    sorted(v for k, v in vars(P).items() if not k.startswith("_"))
)


def role_permission_matrix() -> dict[str, list[str]]:
    """The full role -> permission table, for Super Admin's read-only view.

    Role assignments in this system are fixed by design — the spec
    deliberately denies Super Admin ticket creation and Admin merchant-user
    creation, and that separation is the point, not a gap to fill with a
    role editor. This is visibility into the fixed matrix, not a way to
    rewrite it.
    """
    return {
        "roles": {role.value: sorted(codes) for role, codes in ROLE_PERMISSIONS.items()},
        "merchant_roles": {
            role.value: sorted(codes) for role, codes in MERCHANT_ROLE_PERMISSIONS.items()
        },
    }


def effective_permissions(user: User) -> frozenset[str]:
    """Every permission code this user holds."""
    codes = set(ROLE_PERMISSIONS.get(user.role, frozenset()))
    if user.merchant_role is not None:
        codes |= MERCHANT_ROLE_PERMISSIONS.get(user.merchant_role, frozenset())
    # Explicit per-user grants stored on the row.
    codes |= {c for c in (user.permissions or []) if isinstance(c, str)}
    return frozenset(codes)


def has_permission(user: User, code: str) -> bool:
    return code in effective_permissions(user)


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------
def require(*codes: str, require_all: bool = False):
    """Dependency factory enforcing one or more permission codes.

    ``require(P.TICKET_APPROVE)`` — caller must hold that code.
    ``require(P.A, P.B)`` — caller must hold *either* (default).
    ``require(P.A, P.B, require_all=True)`` — caller must hold both.
    """
    # Imported here to avoid a circular import: deps imports models, rbac is
    # imported by deps' consumers.
    from app.auth.deps import get_current_user

    def _dependency(current_user: User = Depends(get_current_user)) -> User:
        held = effective_permissions(current_user)
        ok = held.issuperset(codes) if require_all else bool(held.intersection(codes))
        if not ok:
            joiner = " + " if require_all else " or "
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Missing required permission: " + joiner.join(sorted(codes)),
            )
        return current_user

    return _dependency


def require_role(*roles: UserRole):
    """Dependency factory enforcing a portal-level role.

    Prefer :func:`require` — permissions survive a role rename, role checks
    do not. Use this only where the spec talks about the role itself, such as
    "the Super Admin portal".
    """
    from app.auth.deps import get_current_user

    def _dependency(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This portal is not available for your account",
            )
        return current_user

    return _dependency


def assert_same_merchant(user: User, merchant_id: int | None) -> None:
    """Guard cross-merchant data access.

    Platform staff see everything. A merchant user may only ever touch rows
    belonging to their own company — enforced server-side here, not merely
    hidden in the UI.
    """
    if user.is_platform_staff:
        return
    if merchant_id is None or user.merchant_id != merchant_id:
        # 404 rather than 403: don't confirm that another merchant's record exists.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
