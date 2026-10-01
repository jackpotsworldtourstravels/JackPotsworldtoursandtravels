"""Tour Package Enquiries — the Contact Us page's "Enquire About Dates" form.

Public, reachable with no session — the same pattern as the Gaming Tour
enquiry endpoint (`app.routers.gaming_tour_enquiries`) and the landing page's
own forms in `app.routers.public`. Stores the enquiry and emails the desk a
courtesy notification in the background; the stored row is the reliable
record either way (see `email_service.send_tour_package_enquiry_email`).
"""
from fastapi import APIRouter, BackgroundTasks, Depends, Request, status
from sqlalchemy.orm import Session

from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.schemas.tour_package_enquiry import TourPackageEnquiryCreate, TourPackageEnquiryResponse
from app.services import email_service, tour_package_enquiry_service as service

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
