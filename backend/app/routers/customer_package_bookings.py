"""Customer tour-package bookings — ``/api/customer/packages/*`` and
``/package-bookings/*``.

The package flow's server side, in the order the customer meets it:

    GET  /api/customer/packages                Tour Packages grid (replaces SAMPLE_PACKAGES)
    GET  /api/customer/packages/{id}            the package's own detail view
    GET  /api/customer/packages/departures      Departure step (replaces buildDepartures())
    GET  /api/customer/packages/addons          hotel upgrade, guide, transfer, insurance
    POST /api/customer/package-bookings/quote   the fare, recomputed
    POST /api/customer/package-bookings         the booking
    POST /api/customer/package-bookings/{ref}/pay a payment attempt
    GET  /api/customer/package-bookings         My Trips

Deliberately a separate path and a separate table from both
``customer_bookings.py`` (flights) and ``customer_hotel_bookings.py`` — see
migration 0056. Catalogue routes are public, same reasoning as the other two.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.models_customer import Customer
from app.schemas.customer_package_booking import (
    PackageBookingCreate,
    PackageBookingResponse,
    PackageDetail,
    PackagePaymentRequest,
    PackageQuoteRequest,
    PackageQuoteResponse,
    PackageSearchResult,
)
from app.services import activity_service, customer_audit_service
from app.services import customer_account_service as acct
from app.services import customer_package_booking_service as bookings
from app.services import customer_package_catalog_service as catalog
from app.services import customer_package_pricing_service as pricing

router = APIRouter(prefix="/api/customer", tags=["customer-package-bookings"])


# ---------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------
@router.get(
    "/packages",
    response_model=list[PackageSearchResult],
    summary="Tour Packages grid",
    description=(
        "Public. Every active package. Destination/budget/duration/month filtering stays "
        "client-side — the same arrangement flights and hotels use for their own "
        "sample-sized catalogues."
    ),
)
def list_packages(db: Session = Depends(get_db)):
    return catalog.list_packages(db)


@router.get(
    "/packages/addons",
    summary="Package add-on catalogue",
    description="Public. Hotel upgrade, private guide, airport transfer and travel insurance.",
)
def get_package_addons():
    return catalog.addons()


@router.get(
    "/packages/departures",
    summary="Departure dates for a package",
    description=(
        "Public. The group-departure dates this package actually sells, with a real "
        "(if arbitrary) seats-left count — replaces the local generator "
        "(`BookingData.config.endpoints.departures`, once flipped live) that used to invent "
        "six Saturdays fresh on every page load. Shaped to match that generator's own fields "
        "so the Departure step and the Packages search panel needed no changes to read it."
    ),
    responses={404: {"description": "No such package."}},
)
def get_package_departures(package: int = Query(..., description="The package's id."), db: Session = Depends(get_db)):
    property_ = catalog.get_package(db, package)
    if property_ is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Package not found.")
    return [
        {
            "id": str(d.customer_package_departure_id),
            "date": d.departure_date.isoformat(),
            "seatsLeft": d.seats_left,
            "price": float(d.price_per_person),
        }
        for d in property_.departures
    ]


@router.get(
    "/packages/{package_id}",
    response_model=PackageDetail,
    summary="Package details",
    description="Public. Description, inclusions, cancellation policy and every upcoming departure.",
    responses={404: {"description": "No such package."}},
)
def get_package(package_id: int, db: Session = Depends(get_db)):
    package = catalog.get_package(db, package_id)
    if package is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Package not found.")
    return package


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------
@router.post(
    "/package-bookings/quote",
    response_model=PackageQuoteResponse,
    summary="Price a trip in progress",
    description=(
        "Public. Recomputes the whole fare from the choices sent: the departure, the party, "
        "add-ons, a coupon. The request carries no prices."
    ),
)
def quote_package_booking(payload: PackageQuoteRequest, db: Session = Depends(get_db)):
    package = catalog.get_package(db, payload.trip.package_id)
    if package is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That package is not available.")
    departure = catalog.get_departure(db, payload.trip.package_id, payload.trip.departure_id)
    if departure is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That departure date is not available.")
    try:
        result = pricing.quote(
            db, departure=departure, pax_count=payload.trip.pax_count,
            is_international=package.is_international,
            addon_selections=[a.model_dump() for a in payload.addons],
            coupon_code=payload.coupon_code,
        )
    except pricing.PackagePricingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return result


# ---------------------------------------------------------------------------
# Bookings
# ---------------------------------------------------------------------------
@router.post(
    "/package-bookings",
    response_model=PackageBookingResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a package booking",
    description=(
        "Requires a customer session. Re-prices everything server-side and writes the booking, "
        "its travellers and its add-ons.\n\n"
        "`booking_ref` (`JPP000123`) is this platform's own reference, from its own sequence. "
        "`status` is `pending`: no payment gateway is integrated.\n\n"
        "Passport rules are enforced here: required for an international package, valid for six "
        "months from the departure date."
    ),
    responses={400: {"description": "A validation, pricing or availability problem, named."}},
)
def create_package_booking(
    request: Request,
    payload: PackageBookingCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    try:
        booking = bookings.create_booking(db, customer, payload.model_dump())
    except bookings.PackageBookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Package booking created", module="Bookings",
        description=f"{booking.booking_ref} — {booking.package_name}",
        meta=activity_service.request_context(request),
    )
    acct.notify(
        db, customer.customer_id, "booking_created",
        title="Booking confirmed",
        message=f"Your {booking.package_name} package ({booking.booking_ref}) has been recorded.",
        related_ref=booking.booking_ref,
    )
    db.commit()
    db.refresh(booking)
    return booking


@router.get(
    "/package-bookings",
    response_model=list[PackageBookingResponse],
    summary="My package bookings",
    description="Requires a customer session. This customer's package bookings, newest first.",
)
def list_package_bookings(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return bookings.list_for_customer(db, customer)


@router.get(
    "/package-bookings/{booking_ref}",
    response_model=PackageBookingResponse,
    summary="One package booking",
    description="Requires a customer session. Scoped to the owner.",
    responses={404: {"description": "No such booking for this customer."}},
)
def get_package_booking(
    booking_ref: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")
    return booking


@router.post(
    "/package-bookings/{booking_ref}/pay",
    response_model=PackageBookingResponse,
    summary="Record a payment attempt",
    description=(
        "Requires a customer session. No payment gateway is integrated, so the attempt is "
        "recorded as `pending` and nothing is charged."
    ),
)
def pay_package_booking(
    request: Request,
    booking_ref: str,
    payload: PackagePaymentRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")
    try:
        bookings.record_payment(db, booking, payload.method)
    except bookings.PackageBookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Package payment attempted", module="Bookings",
        description=f"{booking.booking_ref} via {payload.method}",
        meta=activity_service.request_context(request),
    )
    acct.notify(
        db, customer.customer_id, "booking_payment",
        title="Payment recorded",
        message=f"A payment attempt via {payload.method} was recorded on {booking.booking_ref}.",
        related_ref=booking.booking_ref,
    )
    db.commit()
    db.refresh(booking)
    return booking


@router.post(
    "/package-bookings/{booking_ref}/cancel",
    response_model=PackageBookingResponse,
    summary="Cancel a package booking",
    description="Requires a customer session. Marks the booking cancelled and frees its seats.",
    responses={400: {"description": "Already cancelled, or completed."}},
)
def cancel_package_booking(
    request: Request,
    booking_ref: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")
    try:
        bookings.cancel(db, booking)
    except bookings.PackageBookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Package booking cancelled", module="Bookings",
        description=booking.booking_ref,
        meta=activity_service.request_context(request),
    )
    acct.notify(
        db, customer.customer_id, "booking_cancelled",
        title="Booking cancelled",
        message=f"{booking.booking_ref} has been cancelled.",
        related_ref=booking.booking_ref,
    )
    db.commit()
    db.refresh(booking)
    return booking
