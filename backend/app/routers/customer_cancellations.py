"""Customer-facing cancellation/refund requests — ``/api/customer/
cancellation-requests``. Phase 3 of the B2C Admin Portal build-out.

ADDITIVE, NOT A REPLACEMENT. The existing instant self-cancel endpoints
(``.../bookings/{ref}/cancel`` and its hotel/package siblings) are untouched
and still work exactly as before: a customer who wants to cancel outright
still can, with no admin step. This is a second, distinct path — "ask the
desk to review a cancellation" — for whatever a future screen gates it behind
(past the free-cancellation window, a partial refund, a special fare). No
existing customer-facing behaviour changed to add it.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.models_customer import Customer
from app.schemas.customer_cancellation_admin import CancellationCreate, CancellationDetail
from app.services import customer_cancellation_admin_service as service

router = APIRouter(prefix="/api/customer", tags=["customer-cancellations"])

_ERROR_DETAIL = {
    "not_found": "No such booking on your account.",
    "terminal": "This booking is already cancelled or completed.",
    "duplicate": "A cancellation request is already open for this booking.",
}


@router.post(
    "/cancellation-requests",
    response_model=CancellationDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Ask the desk to review cancelling a booking",
    description="Requires a customer session. Does not cancel the booking itself — an admin reviews it first.",
    responses={404: {"description": "No such booking on this account."},
               400: {"description": "The booking is already cancelled/completed, or a request is already open."}},
)
def create_cancellation_request(
    payload: CancellationCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    result = service.create_request(db, customer, payload.booking_ref, payload.reason)
    if result == "not_found":
        raise HTTPException(status.HTTP_404_NOT_FOUND, _ERROR_DETAIL["not_found"])
    if result in ("terminal", "duplicate"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _ERROR_DETAIL[result])
    return result
