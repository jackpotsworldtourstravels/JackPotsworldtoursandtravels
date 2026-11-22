"""Tour Package Enquiries — the Contact Us page's "Enquire About Dates" form.

Public, reachable with no session — the same pattern as the Gaming Tour
enquiry endpoint (`app.routers.gaming_tour_enquiries`) and the landing page's
own forms in `app.routers.public`. Stores the enquiry and emails the desk a
courtesy notification in the background; the stored row is the reliable
record either way (see `email_service.send_tour_package_enquiry_email`).
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rate_limit import limiter
from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.pagination import Page
from app.schemas.tour_package_enquiry import (
    TourPackageEnquiryAdminDetail,
    TourPackageEnquiryAdminItem,
    TourPackageEnquiryAuditEntry,
    TourPackageEnquiryCounts,
    TourPackageEnquiryCreate,
    TourPackageEnquiryResponse,
    TourPackageEnquiryUpdate,
)
from app.services import activity_service, email_service, tour_package_enquiry_service as service

router = APIRouter(tags=["tour-package-enquiries"])


@router.post(
    "/api/customer/tour-package-enquiries",
    response_model=TourPackageEnquiryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Submit a Tour Package enquiry",
    description=(
        "Public. No session required. Raised from the Contact Us page's \"Enquire About This "
        "Tour Package\" form — reached from a package's \"Enquire about dates\" button, or opened "
        "directly with no package context. Stores the enquiry (not a booking) and returns a "
        "reference; the desk is notified by email as a courtesy on top of the stored row."
    ),
)
@limiter.limit("5/minute")
def submit_tour_package_enquiry(
    request: Request,
    payload: TourPackageEnquiryCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    row = service.create(db, payload)
    # AFTER THE RESPONSE, NOT BEFORE IT — same reasoning as the Gaming Tour
    # enquiry endpoint: the enquiry is already committed, so a slow or failing
    # SMTP call must not hold the customer's "please wait" screen hostage.
    background_tasks.add_task(_notify_tour_package_enquiry, row.enquiry_reference, payload)
    return TourPackageEnquiryResponse(enquiry_reference=row.enquiry_reference)


def _notify_tour_package_enquiry(reference: str, payload: TourPackageEnquiryCreate) -> None:
    try:
        email_service.send_tour_package_enquiry_email(reference, payload)
    except Exception:  # noqa: BLE001 — a background task's exception has no caller to see it
        pass


# ---------------------------------------------------------------------------
# Admin (Phase 2 Bug 3). Same router as the public submission, the same reason
# gaming_tour_enquiries/enquiries merge the two: one set of rows, scoped by
# permission code, not URL prefix. Every admin route requires
# ``tour_package.enquiry.manage``.
# ---------------------------------------------------------------------------
@router.get(
    "/api/admin/tour-package-enquiries",
    response_model=Page[TourPackageEnquiryAdminItem],
    summary="List Tour Package enquiries",
    description="Requires `tour_package.enquiry.manage`. Every enquiry, newest first — there is no merchant to scope by.",
)
def list_tour_package_enquiries(
    status_filter: str | None = Query(None, alias="status"),
    search: str | None = Query(None, max_length=120),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    admin: User = Depends(require(P.TOUR_PACKAGE_ENQUIRY_MANAGE)),
):
    rows, total = service.list_enquiries(
        db, status=status_filter, search=search, page=page, page_size=page_size,
    )
    names = service.admin_names_for(db, rows)
    items = [TourPackageEnquiryAdminItem(**service.admin_item_dict(r, names)) for r in rows]
    return Page.build(items, total, page, page_size)


@router.get(
    "/api/admin/tour-package-enquiries/counts",
    response_model=TourPackageEnquiryCounts,
    summary="Tour Package enquiry counts",
    description="Requires `tour_package.enquiry.manage`. Live figures for the dashboard card and sidebar badge.",
)
def tour_package_enquiry_counts(
    db: Session = Depends(get_db),
    admin: User = Depends(require(P.TOUR_PACKAGE_ENQUIRY_MANAGE)),
):
    return TourPackageEnquiryCounts(**service.counts(db))


def _detail(row, db: Session) -> TourPackageEnquiryAdminDetail:
    names = service.admin_names_for(db, [row])
    data = service.admin_item_dict(row, names)
    data["message"] = row.message
    data["admin_notes"] = row.admin_notes
    data["updated_at"] = row.updated_at
    return TourPackageEnquiryAdminDetail(**data)


@router.get(
    "/api/admin/tour-package-enquiries/{enquiry_id}",
    response_model=TourPackageEnquiryAdminDetail,
    summary="Tour Package enquiry detail",
)
def get_tour_package_enquiry(
    enquiry_id: int, db: Session = Depends(get_db),
    admin: User = Depends(require(P.TOUR_PACKAGE_ENQUIRY_MANAGE)),
):
    row = service.get(db, enquiry_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such enquiry.")
    return _detail(row, db)


@router.get(
    "/api/admin/tour-package-enquiries/{enquiry_id}/history",
    response_model=list[TourPackageEnquiryAuditEntry],
    summary="Tour Package enquiry audit history",
    description="Requires `tour_package.enquiry.manage`. The actor-attributed trail of admin changes, newest first.",
)
def tour_package_enquiry_history(
    enquiry_id: int, db: Session = Depends(get_db),
    admin: User = Depends(require(P.TOUR_PACKAGE_ENQUIRY_MANAGE)),
):
    row = service.get(db, enquiry_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such enquiry.")
    return [TourPackageEnquiryAuditEntry(**e) for e in service.audit_trail(db, enquiry_id)]


@router.patch(
    "/api/admin/tour-package-enquiries/{enquiry_id}",
    response_model=TourPackageEnquiryAdminDetail,
    summary="Update status, assignment or notes",
    description=(
        "Requires `tour_package.enquiry.manage`. Every field is optional; only what is sent is written. "
        "Assigning an admin to a NEW enquiry with no status in the same request moves it to ASSIGNED "
        "automatically."
    ),
)
def update_tour_package_enquiry(
    enquiry_id: int,
    payload: TourPackageEnquiryUpdate,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require(P.TOUR_PACKAGE_ENQUIRY_MANAGE)),
):
    row = service.get(db, enquiry_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such enquiry.")
    previous_status = row.status
    row = service.update(db, row, payload)

    # Actor-attributed audit (System Logs): who, which enquiry, which fields,
    # and the status transition when it changed — the trail the history
    # endpoint reads back. Content-light: never the free-text note body.
    meta = activity_service.request_context(request)
    changed = sorted(payload.model_dump(exclude_unset=True))
    details = {"fields": changed}
    if row.status != previous_status:
        details["from_status"] = previous_status
        details["to_status"] = row.status
    activity_service.log_activity(
        db, admin.user_id, "Tour package enquiry updated", meta["ip_address"],
        activity_type="Update", module=service.AUDIT_MODULE,
        description=(
            f"{admin.full_name} updated tour package enquiry {enquiry_id} "
            f"(fields: {', '.join(changed) or 'none'})"
        ),
        reference_id=enquiry_id, browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(admin, "merchant_id", None), details=details,
    )
    return _detail(row, db)
