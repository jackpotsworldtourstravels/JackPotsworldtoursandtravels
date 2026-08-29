"""Hotel Enquiry — the merchant's entry point, and the Admin's answer.

Separate router, separate tables (migration 0047) — see
``services/hotel_enquiry_service.py`` for why this doesn't share
``routers/enquiries.py``'s ``service_requests`` plumbing. Reuses the same
``ticket.*`` permission codes as Flight: same lifecycle (raise, view,
approve/reject, claim before answering), just a different table underneath —
minting a parallel RBAC surface for an identical capability would be the
duplication the platform's own permission matrix is trying to avoid.

Merchant and Admin endpoints live in one router for the same reason
``routers/enquiries.py`` does: they operate on the same rows under the same
visibility rules.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, has_permission, require
from app.database.session import get_db
from app.models_v2 import RequestStatus, User
from app.schemas.hotel_booking import DirectHotelBookingCreate, HotelEnquiryToBooking
from app.schemas.hotel_enquiry import HotelEnquiryCreate, HotelEnquiryRespond, HotelEnquiryResponse
from app.schemas.pagination import Page
from app.schemas.ticket import RequestResponse
# `enquiry_service`/`ticket_service` here are a deliberate cross-module
# reuse, not a layering slip: `discard_unsubmitted` and `submit_request` are
# already generic over `request_id`/`ServiceRequest`, with nothing
# flight-specific in either — see the Book Directly endpoint below.
from app.services import enquiry_service, hotel_booking_service, hotel_enquiry_service, ticket_service

router = APIRouter(prefix="/api/hotel", tags=["hotel-enquiries"])
admin_router = APIRouter(prefix="/api/admin/hotel-enquiries", tags=["admin · hotel-enquiries"])


# ---------------------------------------------------------------------------
# Merchant
# ---------------------------------------------------------------------------
@router.post(
    "/enquiries",
    response_model=HotelEnquiryResponse,
    status_code=201,
    tags=["merchant · hotel enquiry"],
    summary="Hotel Enquiry — ask the desk about a stay",
    description=(
        "Requires `ticket.enquiry` and the merchant's company must have Hotels service access "
        "enabled. Creates the enquiry at **Pending** and notifies the Admin team. Returns the "
        "`HTL-YYYYMMDD-NNNNNN` reference. Check-out must be after check-in, check-in cannot be "
        "in the past, and every room needs at least one adult."
    ),
)
def create_hotel_enquiry(
    payload: HotelEnquiryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_ENQUIRY)),
):
    enquiry = hotel_enquiry_service.create(db, current_user, payload)
    return HotelEnquiryResponse.of(enquiry)


@router.get(
    "/enquiries",
    response_model=Page[HotelEnquiryResponse],
    tags=["merchant · hotel enquiry"],
    summary="Hotel Enquiry listing",
    description=(
        "Requires `ticket.view`, and the merchant's company must have Hotels service access "
        "enabled — reading hotel data is using Hotels, so a company whose entitlement is off "
        "gets 403 here too, not just on create. Platform staff are exempt and see every "
        "merchant's, entitled or not. A merchant sees only its own. Search matches the "
        "reference, destination and hotel name."
    ),
)
def list_hotel_enquiries(
    status: RequestStatus | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    items, total = hotel_enquiry_service.list_enquiries(
        db, current_user,
        page=page, page_size=page_size, request_status=status,
        merchant_id=merchant_id, search=search,
    )
    return Page.build([HotelEnquiryResponse.of(i) for i in items], total, page, page_size)


@router.get(
    "/enquiries/{enquiry_id}",
    response_model=HotelEnquiryResponse,
    tags=["merchant · hotel enquiry"],
    summary="Hotel enquiry detail",
    description=(
        "Requires `ticket.view`, and the merchant's company must have Hotels service access "
        "enabled (same rule as the listing — checked before the row is looked up, so an "
        "unentitled merchant gets the same 403 for every id rather than a 403/404 split that "
        "would say which ids exist). Everything the View Details card shows."
    ),
)
def get_hotel_enquiry(
    enquiry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    return HotelEnquiryResponse.of(hotel_enquiry_service.get(db, current_user, enquiry_id))


@router.post(
    "/enquiries/{enquiry_id}/booking-request",
    response_model=RequestResponse,
    status_code=201,
    tags=["merchant · requests"],
    summary="Raise Booking — turn a quoted hotel enquiry into a draft booking",
    description=(
        "Requires `ticket.request`. Valid only once the Admin has sent a quotation "
        "(**Approved**), and only once per enquiry (409 otherwise). The stay itself is copied "
        "from the enquiry server-side — only the guests come from the body, and their room/child "
        "counts must match what was quoted. The draft still needs "
        "`POST /api/requests/{id}/submit`."
    ),
)
def hotel_enquiry_to_booking_request(
    enquiry_id: int,
    payload: HotelEnquiryToBooking,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    booking = hotel_booking_service.to_booking_request(
        db, current_user, enquiry_id,
        guests=payload.guests,
        remarks=payload.remarks,
        contact=payload.contact.model_dump() if payload.contact else None,
        special_requests=payload.special_requests,
        client_fare=payload.client_fare,
    )
    return RequestResponse.of(
        hotel_booking_service.load_with_guests(db, current_user, booking.request_id)
    )


@router.post(
    "/bookings/direct",
    response_model=RequestResponse,
    status_code=201,
    tags=["merchant · requests"],
    summary="Book Directly — raise a hotel booking without an enquiry first",
    description=(
        "Requires `ticket.request` and the merchant's company must have Hotels service access "
        "enabled. Creates the booking at **Draft** with the stay and guests taken from the "
        "merchant, since there is no quotation to copy the stay from — it therefore carries "
        "**no amount**: the desk names the fare when it issues the voucher, the same place an "
        "unpriced booking has always been priced. Everything after this call is the existing "
        "workflow — Manager approval, then voucher issuance, then the wallet debit. Send "
        "`submit: true` to put it in front of the Manager in the same call, or leave it false "
        "and use `POST /api/requests/{id}/submit` later."
    ),
)
def create_direct_hotel_booking(
    payload: DirectHotelBookingCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    booking = hotel_booking_service.create_direct_booking(db, current_user, payload)
    if payload.submit:
        try:
            ticket_service.submit_request(db, current_user, booking.request_id)
        except Exception:
            enquiry_service.discard_unsubmitted(db, booking.request_id)
            raise
    return RequestResponse.of(
        hotel_booking_service.load_with_guests(db, current_user, booking.request_id)
    )


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
@admin_router.post(
    "/{enquiry_id}/review",
    response_model=HotelEnquiryResponse,
    summary="Start review — claim a pending hotel enquiry",
    description=(
        "Requires `ticket.approve`. Moves **Pending -> Under Review** and records the claiming "
        "admin, so a second admin gets a 409 instead of answering the same enquiry."
    ),
)
def start_hotel_enquiry_review(
    enquiry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_APPROVE)),
):
    return HotelEnquiryResponse.of(hotel_enquiry_service.start_review(db, current_user, enquiry_id))


@admin_router.post(
    "/{enquiry_id}/respond",
    response_model=HotelEnquiryResponse,
    summary="Answer a hotel enquiry — send a quotation, or decline",
    description=(
        "`available: true` is **Send Quotation**: requires `ticket.approve`, a strictly positive "
        "`total_fare` and remarks explaining it, and moves the enquiry to **Approved**. "
        "`available: false` is a decline: requires `ticket.reject` and a mandatory reason. "
        "The answer is final — a second response returns 409."
    ),
)
def respond_to_hotel_enquiry(
    enquiry_id: int,
    payload: HotelEnquiryRespond,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_APPROVE, P.TICKET_REJECT)),
):
    needed = P.TICKET_APPROVE if payload.available else P.TICKET_REJECT
    if not has_permission(current_user, needed):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Missing required permission: {needed}",
        )

    enquiry = hotel_enquiry_service.respond(
        db, current_user, enquiry_id,
        available=payload.available, reason=payload.reason, response=payload.response,
        total_fare=payload.total_fare,
    )
    return HotelEnquiryResponse.of(enquiry)
