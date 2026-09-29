"""Gaming Tour Enquiries — the public submission and the Admin queue.

Both halves live in one router for the reason `enquiries.py` gives for
merging Merchant and Admin: they operate on the same rows, and splitting them
would only duplicate the model imports. The public route needs no session at
all — see `app.models_v2.GamingTourEnquiry` for why there is no merchant or
customer to authenticate against.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.gaming_tour_enquiry import (
    GamingTourEnquiryAdminDetail,
    GamingTourEnquiryAdminItem,
    GamingTourEnquiryCreate,
    GamingTourEnquiryResponse,
    GamingTourEnquiryUpdate,
)
from app.schemas.pagination import Page
from app.services import email_service, gaming_tour_enquiry_service as service

router = APIRouter(tags=["gaming-tour-enquiries"])


# ---------------------------------------------------------------------------
# Public — reachable with no session, the same as contact/newsletter/the
# hotel group enquiry in app.routers.public. Lives under /api/customer/ at
# the brief's request even though it needs no customer session, so the URL
# matches what the frontend form posts to.
# ---------------------------------------------------------------------------
@router.post(
    "/api/customer/gaming-tour-enquiries",
    response_model=GamingTourEnquiryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Submit a Gaming Tour enquiry",
    description=(
        "Public. No session required. Gaming Tour Packages are quoted by hand rather than "
        "booked live, so this stores the enquiry (not a booking) and returns a reference the "
        "desk will call back about."
    ),
)
@limiter.limit("5/minute")
def submit_gaming_tour_enquiry(
    request: Request,
    payload: GamingTourEnquiryCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    row = service.create(db, payload)
    # AFTER THE RESPONSE, NOT BEFORE IT. email_service's SMTP call is a
    # synchronous smtplib connection with a 10s timeout (the same one
    # send_contact_form_email/send_hotel_group_enquiry_email already carry) —
    # calling it inline here held a mobile-network customer's "please wait"
    # screen hostage to a mail server's connect time before they even saw the
    # reference. BackgroundTasks runs it once the response has gone out, so
    # the enquiry (already committed above) confirms immediately and the mail
    # is still sent, just not on the customer's clock. A failure inside it is
    # logged there and never becomes this request's problem either way.
    background_tasks.add_task(_notify_gaming_tour_enquiry, row.enquiry_reference, payload)
    return GamingTourEnquiryResponse(enquiry_reference=row.enquiry_reference)


def _notify_gaming_tour_enquiry(reference: str, payload: GamingTourEnquiryCreate) -> None:
    try:
        email_service.send_gaming_tour_enquiry_email(reference, payload)
    except Exception:  # noqa: BLE001 — a background task's exception has no caller to see it
        pass


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
@router.get(
    "/api/admin/gaming-tour-enquiries",
    response_model=Page[GamingTourEnquiryAdminItem],
    summary="List Gaming Tour enquiries",
    description="Requires an admin session. Every enquiry, newest first — there is no merchant to scope by.",
)
def list_gaming_tour_enquiries(
    status_filter: str | None = Query(None, alias="status"),
    search: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    rows, total = service.list_enquiries(
        db, status=status_filter, search=search, page=page, page_size=page_size,
    )
    names = service.admin_names_for(db, rows)
    items = [GamingTourEnquiryAdminItem(**service.admin_item_dict(r, names)) for r in rows]
    return Page.build(items, total, page, page_size)


@router.get(
    "/api/admin/gaming-tour-enquiries/{enquiry_id}",
    response_model=GamingTourEnquiryAdminDetail,
    summary="Gaming Tour enquiry detail",
)
def get_gaming_tour_enquiry(
    enquiry_id: int, db: Session = Depends(get_db), admin: User = Depends(get_current_admin),
):
    row = service.get(db, enquiry_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such enquiry.")
    names = service.admin_names_for(db, [row])
    data = service.admin_item_dict(row, names)
    data["admin_notes"] = row.admin_notes
    data["updated_at"] = row.updated_at
    return GamingTourEnquiryAdminDetail(**data)


@router.patch(
    "/api/admin/gaming-tour-enquiries/{enquiry_id}",
    response_model=GamingTourEnquiryAdminDetail,
    summary="Update status, assignment or notes",
    description=(
        "Requires an admin session. Every field is optional; only what is sent is written. "
        "Assigning an admin to a NEW enquiry with no status in the same request moves it to "
        "ASSIGNED automatically."
    ),
)
def update_gaming_tour_enquiry(
    enquiry_id: int,
    payload: GamingTourEnquiryUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    row = service.get(db, enquiry_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such enquiry.")
    row = service.update(db, row, payload)
    names = service.admin_names_for(db, [row])
    data = service.admin_item_dict(row, names)
    data["admin_notes"] = row.admin_notes
    data["updated_at"] = row.updated_at
    return GamingTourEnquiryAdminDetail(**data)
