"""Customer flight e-ticket endpoints.

``GET /api/customer/bookings/{ref}/ticket`` - the owner's full ticket data plus
its verification link and QR. Ownership is a filter on the lookup, so another
customer's reference is a 404, same as the booking itself.

``GET /api/tickets/verify/{token}`` - public. The QR on a ticket lands on the
page that calls this. It answers from the booking row at that moment and
returns the minimum needed to match a traveller to a flight.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.auth.rate_limit import limiter
from app.config import settings
from app.database.session import get_db
from app.models_customer import Customer
from app.schemas.customer_booking import BookingResponse
from app.services import customer_booking_service as bookings
from app.services import eticket_service as eticket

owner_router = APIRouter(prefix="/api/customer", tags=["customer-etickets"])
public_router = APIRouter(prefix="/api/tickets", tags=["etickets"])

_LOCAL_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "[::1]")


def _is_local(url: str) -> bool:
    return any(h in url.lower() for h in _LOCAL_HOSTS)


def _public_base(request: Request) -> str | None:
    """Where a phone scanning the QR should land.

    ON A DEPLOYED HOST this is ONLY the configured FRONTEND_BASE_URL, and it
    must be a real public https address: a QR that points at localhost, a bare
    IP or an internal container name is printed, scanned and dead. Rather than
    guess from the request (behind the proxy that is not necessarily the public
    name), an unconfigured deployment returns None and the ticket is drawn
    WITHOUT a QR ("verification unavailable") instead of with a wrong one.

    In development there is no public name, so the host the ticket was
    requested from is used - which is why a phone cannot scan a dev QR.
    """
    configured = (settings.frontend_base_url or "").strip()
    if settings.deployed:
        if not configured or _is_local(configured) or not configured.lower().startswith("https://"):
            return None
        return configured
    if configured and not _is_local(configured):
        return configured
    return str(request.base_url)


@owner_router.get("/bookings/{booking_ref}/ticket", summary="E-ticket data for one of my bookings")
def get_ticket(
    booking_ref: str, request: Request,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")
    base = _public_base(request)
    url = eticket.verify_url(base, eticket.make_token(booking)) if base else None
    return {
        "booking": BookingResponse.model_validate(booking).model_dump(mode="json"),
        "verify_url": url,
        "qr_svg": eticket.qr_svg(url) if url else None,
        "company": eticket.company_contact(),
    }


@public_router.get("/verify/{token}", summary="Verify a ticket from its QR code")
@limiter.limit("60/minute")
def verify_ticket(request: Request, token: str, db: Session = Depends(get_db)):
    ref = eticket.read_token(token)
    booking = eticket.get_by_ref(db, ref) if ref else None
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid or expired ticket.")
    return eticket.public_view(booking)
