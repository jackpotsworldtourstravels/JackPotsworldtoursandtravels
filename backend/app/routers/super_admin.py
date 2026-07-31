"""Super Admin portal — administrator management.

Per the spec, the Super Admin's entire remit is Admins plus oversight:
create, edit, suspend, delete, reset password, view all admins, and view
system activity. Notably absent, and enforced by the permission codes rather
than by convention: a Super Admin cannot raise tickets or manage payments.
"""
import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.rbac import ALL_PERMISSION_CODES, P, require, require_role, role_permission_matrix
from app.database.session import get_db
from app.models_v2 import AuditOperation, User, UserRole, UserStatus
from app.schemas.accounts import (
    AccountResponse,
    AdminPermissionsResponse,
    CreateAdminRequest,
    CredentialsResponse,
    PermissionMatrixResponse,
    StatusChangeRequest,
    UpdateAdminPermissionsRequest,
    UpdateAdminRequest,
)
from app.schemas.auth import MessageResponse
from app.schemas.audit import AuditLogEntry
from app.schemas.dashboard import SuperAdminDashboardResponse
from app.schemas.pagination import Page
from app.schemas.reports_summary import GlobalSummaryResponse, MerchantSummaryRow
from app.schemas.system_info import SystemInfoResponse
from app.services import (
    account_service,
    activity_service,
    audit_service,
    dashboard_service,
    merchant_service,
    system_info_service,
)

router = APIRouter(prefix="/api/super-admin", tags=["super admin"])


@router.get(
    "/dashboard",
    response_model=SuperAdminDashboardResponse,
    summary="Super Admin Dashboard KPIs",
    description=(
        "Requires `system.activity.view`. System-overview KPIs: Admin counts, merchant counts, "
        "total merchant users, open chat threads (visibility only), schema version, and the 5 "
        "most recent system activity entries. Deliberately excludes ticket/payment operational "
        "queues — those are Admin's domain."
    ),
)
def super_admin_dashboard(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.SYSTEM_ACTIVITY_VIEW)),
):
    data = dashboard_service.super_admin_dashboard(db)
    return SuperAdminDashboardResponse(**data)


@router.get(
    "/admins",
    response_model=Page[AccountResponse],
    summary="List all administrators",
    description=(
        "Requires `admin.view`. Paginated, with an optional name/email search. "
        "Returns **Admins and Managers** — both are staff accounts this screen owns "
        "(CR-2). Pass `role=admin` or `role=manager` to narrow it."
    ),
)
def list_admins(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = None,
    role: Literal["admin", "manager"] | None = Query(None),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.ADMIN_VIEW)),
):
    admins, total = account_service.list_admins(
        db, page, page_size, search, role=UserRole(role) if role else None
    )
    return Page.build([AccountResponse.of(a) for a in admins], total, page, page_size)


@router.post(
    "/admins",
    response_model=CredentialsResponse,
    status_code=201,
    summary="Create an administrator",
    description=(
        "Requires `admin.create` — held only by the Super Admin. Returns the generated password "
        "**once**; it is hashed on write and cannot be retrieved again. "
        "`role` may be `admin` (default) or `manager`; a Manager signs into the manager portal "
        "and approves submitted Booking Requests."
    ),
)
def create_admin(
    payload: CreateAdminRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.ADMIN_CREATE)),
):
    admin, temp_password = account_service.create_admin(
        db, current_user, payload.full_name, payload.email, payload.phone, payload.password,
        role=UserRole(payload.role),
    )
    return CredentialsResponse(
        account=AccountResponse.of(admin), temporary_password=temp_password
    )


@router.get(
    "/admins/{user_id}",
    response_model=AccountResponse,
    summary="Get one administrator",
    description="Requires `admin.view`.",
)
def get_admin(
    user_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.ADMIN_VIEW)),
):
    return AccountResponse.of(account_service.get_admin(db, user_id))


@router.put(
    "/admins/{user_id}",
    response_model=AccountResponse,
    summary="Edit an administrator",
    description=(
        "Requires `admin.edit`. `role` is optional: omit it to leave the account's role "
        "alone, or pass `admin`/`manager` to move it between the two. Changing a role "
        "revokes that account's sessions (its permissions change underneath it) and is "
        "refused with a 409 while a Manager still holds a booking under review."
    ),
)
def update_admin(
    user_id: int,
    payload: UpdateAdminRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.ADMIN_EDIT)),
):
    admin = account_service.update_admin(
        db, current_user, user_id, payload.full_name, payload.email, payload.phone,
        role=UserRole(payload.role) if payload.role else None,
    )
    return AccountResponse.of(admin)


@router.patch(
    "/admins/{user_id}/status",
    response_model=AccountResponse,
    summary="Suspend or reactivate an administrator",
    description=(
        "Requires `admin.suspend`. Suspending ends every active session and revokes outstanding "
        "tokens immediately, rather than waiting for the next login attempt."
    ),
)
def set_admin_status(
    user_id: int,
    payload: StatusChangeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.ADMIN_SUSPEND)),
):
    admin = account_service.set_admin_status(db, current_user, user_id, payload.status)
    return AccountResponse.of(admin)


@router.post(
    "/admins/{user_id}/reset-password",
    response_model=CredentialsResponse,
    summary="Reset an administrator's password",
    description=(
        "Requires `admin.reset_password`. Issues a new password, returns it once, and revokes "
        "the administrator's existing sessions."
    ),
)
def reset_admin_password(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.ADMIN_RESET_PASSWORD)),
):
    admin, temp_password = account_service.reset_admin_password(db, current_user, user_id)
    return CredentialsResponse(
        account=AccountResponse.of(admin), temporary_password=temp_password
    )


@router.delete(
    "/admins/{user_id}",
    response_model=MessageResponse,
    summary="Delete an administrator",
    description=(
        "Requires `admin.delete`. Refused when the administrator has handled requests — deleting "
        "would orphan that history, so suspend instead."
    ),
)
def delete_admin(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.ADMIN_DELETE)),
):
    account_service.delete_admin(db, current_user, user_id)
    return MessageResponse(message="Administrator deleted")


# ---------------------------------------------------------------------------
# Role & Permission Management
# ---------------------------------------------------------------------------
# Role assignments (who can create merchants, who can raise tickets, ...)
# are fixed by design — see app/auth/rbac.py's module docstring. What's
# exposed here is visibility into that fixed matrix, plus the ability to
# grant an individual admin an *extra* capability on top of their role —
# not a way to reassign the roles themselves.
@router.get(
    "/permissions/matrix",
    response_model=PermissionMatrixResponse,
    summary="The fixed role -> permission matrix",
    description=(
        "Requires `system.activity.view`. Read-only — role responsibilities are fixed by "
        "design (e.g. Super Admin cannot hold ticket permissions), not reassignable here."
    ),
)
def permissions_matrix(_: User = Depends(require(P.SYSTEM_ACTIVITY_VIEW))):
    matrix = role_permission_matrix()
    return PermissionMatrixResponse(all_codes=list(ALL_PERMISSION_CODES), **matrix)


@router.get(
    "/admins/{user_id}/permissions",
    response_model=AdminPermissionsResponse,
    summary="One admin's permissions — role defaults, extra grants, effective",
    description="Requires `admin.view`.",
)
def get_admin_permissions(
    user_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.ADMIN_VIEW)),
):
    return AdminPermissionsResponse(**account_service.get_admin_permissions(db, user_id))


@router.put(
    "/admins/{user_id}/permissions",
    response_model=AdminPermissionsResponse,
    summary="Grant an admin extra permissions beyond their role default",
    description=(
        "Requires `admin.edit`. Additive only — this can give an admin a capability their "
        "role doesn't have by default, but cannot revoke a role-default one (change the role "
        "for that). Unknown codes are rejected outright rather than silently ignored."
    ),
)
def update_admin_permissions(
    user_id: int,
    payload: UpdateAdminPermissionsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.ADMIN_EDIT)),
):
    return AdminPermissionsResponse(
        **account_service.set_admin_extra_permissions(
            db, current_user, user_id, payload.extra_grants
        )
    )


@router.get(
    "/system-info",
    response_model=SystemInfoResponse,
    summary="System Configuration / Global Settings (read-only)",
    description=(
        "Requires `system.activity.view`. Non-secret operational settings — token lifetimes, "
        "OTP policy, CORS origins, schema version, SMTP delivery mode. No write endpoint exists: "
        "configuration lives in backend/.env by design, and secrets (SMTP credentials, the JWT "
        "signing key, the database URL) are never returned."
    ),
)
def system_info(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.SYSTEM_ACTIVITY_VIEW)),
):
    return SystemInfoResponse(**system_info_service.get_system_info(db))


# ---------------------------------------------------------------------------
# Audit Logs — row-level change history, written by fn_write_audit_log
# ---------------------------------------------------------------------------
@router.get(
    "/audit-logs",
    response_model=Page[AuditLogEntry],
    summary="Row-level audit trail",
    description=(
        "Requires `audit.view`. Every INSERT/UPDATE/DELETE on users, merchants, "
        "service_requests, and payments, captured by a database trigger — this is a reader over "
        "already-existing data, not something the API writes to."
    ),
)
def list_audit_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    table_name: str | None = None,
    operation: AuditOperation | None = None,
    changed_by: int | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.AUDIT_VIEW)),
):
    rows, total = audit_service.list_audit_logs(
        db, page, page_size,
        table_name=table_name, operation=operation, changed_by=changed_by,
        date_from=date_from, date_to=date_to,
    )
    items = [
        AuditLogEntry(
            id=log.audit_id, table_name=log.table_name, record_id=log.record_id,
            operation=log.operation, old_value=log.old_value, new_value=log.new_value,
            changed_by=log.changed_by, changed_by_name=name, changed_by_email=email,
            changed_at=log.changed_at,
        )
        for log, name, email in rows
    ]
    return Page.build(items, total, page, page_size)


@router.get(
    "/audit-logs/tables",
    summary="Distinct table names for the audit log filter",
    description="Requires `audit.view`.",
)
def audit_log_tables(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.AUDIT_VIEW)),
):
    return {"tables": audit_service.list_audited_tables(db)}


# ---------------------------------------------------------------------------
# Global Reports & Analytics
# ---------------------------------------------------------------------------
@router.get(
    "/reports/summary",
    response_model=GlobalSummaryResponse,
    summary="Global Reports & Analytics — per-merchant summary",
    description=(
        "Requires the Super Admin or Admin role — deliberately role-gated rather than "
        "permission-gated: `report.view` is also held by merchants, but for their own scoped "
        "data, not this cross-merchant rollup, so the permission code alone can't be trusted "
        "here. Request volume, completion, revenue, and headcount per merchant, platform-wide. "
        "For row-level export (CSV/Excel/PDF), use `GET /api/reports/export` — Super Admin "
        "already holds `report.export`."
    ),
)
def global_reports_summary(
    db: Session = Depends(get_db),
    _: User = Depends(require_role(UserRole.SUPER_ADMIN, UserRole.ADMIN)),
):
    rows = merchant_service.global_reports_summary(db)
    return GlobalSummaryResponse(merchants=[MerchantSummaryRow(**r) for r in rows])


@router.get(
    "/activity",
    summary="System activity log",
    description="Requires `system.activity.view`. Every recorded user action, newest first.",
)
def system_activity(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    search: str | None = None,
    action: str | None = None,
    module: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.SYSTEM_ACTIVITY_VIEW)),
):
    rows, total = activity_service.list_activity_logs_paginated(
        db, page, page_size, search, action, module
    )
    items = [
        {
            "id": log.log_id,
            "user_id": log.user_id,
            "user_email": email,
            "user_name": full_name,
            "module": log.module,
            "action": log.action,
            "description": log.description,
            "ip_address": str(log.ip_address) if log.ip_address else None,
            "browser": log.browser,
            "device": log.device,
            "status": log.status,
            "created_at": log.created_at,
        }
        for log, email, full_name in rows
    ]
    return Page.build(items, total, page, page_size)


@router.get(
    "/activity/filters",
    summary="Distinct actions and modules for the activity filters",
    description="Requires `system.activity.view`.",
)
def activity_filters(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.SYSTEM_ACTIVITY_VIEW)),
):
    return {
        "actions": activity_service.list_distinct_actions(db),
        "modules": activity_service.list_distinct_modules(db),
    }
