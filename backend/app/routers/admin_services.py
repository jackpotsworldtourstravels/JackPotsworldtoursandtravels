"""Admin B2C Service Management — ``/api/admin/services``.

The central desk for the customer-facing service registry: enable/disable each
service, set navigation and homepage visibility and order, switch a service into
maintenance mode, and record provider / integration-readiness status.

Reads require ``b2c.services.view`` (or the manage scope); every write requires
``b2c.services.manage``. A super admin holds both implicitly; a B2B-only admin
holds neither. Every write records a B2C admin-audit row
(``customer_admin_audit_logs``) atomically with the registry change — the
``record_in_session`` readiness gate makes the change fail closed if the audit
store is unwritable, so no registry change lands unaudited (requirement 10).

This governs the PUBLIC storefront globally. It is deliberately separate from
``/api/merchant`` service access, which is the per-merchant B2B entitlement
(requirement 8) and is untouched here.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require_scope
from app.database.session import get_db
from app.models_customer import AdminAuditOutcome
from app.models_v2 import User
from app.schemas.admin_services import ServiceReorder, ServiceRow, ServiceUpdate
from app.services import customer_admin_audit_service as b2c_audit
from app.services import service_registry_service as registry

router = APIRouter(prefix="/api/admin", tags=["admin-services"])

_NO_SERVICE = "No such service."


@router.get(
    "/services", response_model=list[ServiceRow], summary="List travel services",
    description="Requires `b2c.services.view` (or manage). Every service, in nav order.",
)
def list_services(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_SERVICES_VIEW, P.B2C_SERVICES_MANAGE)),
):
    return registry.list_all(db)


@router.patch(
    "/services/{code}", response_model=ServiceRow, summary="Update a travel service",
    description=(
        "Requires `b2c.services.manage`. Only the fields sent are written; `code` is "
        "immutable. Disabling a service removes it from customer navigation and makes its "
        "search / new-booking endpoints reject requests; existing bookings stay accessible."
    ),
    responses={404: {"description": _NO_SERVICE}},
)
def update_service(
    code: str, payload: ServiceUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_scope(P.B2C_SERVICES_MANAGE)),
):
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No fields to update.")
    row = registry.update_service(db, code, data)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_SERVICE)
    b2c_audit.record_in_session(
        db, admin=user, action="service.update", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="service_registry", entity_id=row.code, new={"changed": sorted(data)},
    )
    db.commit()
    db.refresh(row)
    return row


@router.post(
    "/services/reorder", response_model=list[ServiceRow], summary="Reorder services",
    description="Requires `b2c.services.manage`. Sets nav order from the given code sequence.",
)
def reorder_services(
    payload: ServiceReorder,
    db: Session = Depends(get_db),
    user: User = Depends(require_scope(P.B2C_SERVICES_MANAGE)),
):
    rows = registry.set_order(db, payload.codes)
    b2c_audit.record_in_session(
        db, admin=user, action="service.reorder", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="service_registry", entity_id=None, new={"order": payload.codes},
    )
    db.commit()
    return rows
