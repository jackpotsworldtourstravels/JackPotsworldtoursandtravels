"""Customer flight bookings — ``/api/customer/bookings/*`` and the catalogue.

The booking flow's server side, in the order the customer meets it:

    GET  /api/customer/flights/seatmap   the aircraft (step 2)
    GET  /api/customer/addons            baggage, meals, services (step 3)
    POST /api/customer/bookings/quote    the fare, recomputed (every step)
    POST /api/customer/coupons/validate  a coupon, checked (step 4)
    POST /api/customer/bookings          the booking (step 5)
    POST /api/customer/bookings/{ref}/pay a payment attempt (step 5)
    GET  /api/customer/bookings          My Bookings (step 6 and after)

The catalogue routes are deliberately open to signed-out visitors — a seat map
is not private and browsing one before signing in is normal. Everything that
touches a booking requires a session.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.models_customer import Customer
from app.schemas.customer_booking import (
    BookingCreate,
    CouponOffer,
    BookingResponse,
    CouponValidateRequest,
    CouponValidateResponse,
    PaymentRequest,
    QuoteRequest,
    QuoteResponse,
)
from app.services import activity_service, customer_audit_service
from app.services import customer_booking_service as bookings
from app.services import customer_catalog_service as catalog
from app.services import customer_pricing_service as pricing

router = APIRouter(prefix="/api/customer", tags=["customer-bookings"])


# ---------------------------------------------------------------------------
# Catalogue — what can be added to a flight, and what it costs.
# ---------------------------------------------------------------------------
@router.get(
    "/flights/seatmap",
    summary="Seat map for a flight",
    description=(
        "Public. The cabin layout, which seats are taken and what each one costs.\n\n"
        "Prices come from here, not from the browser: the booking path re-reads this map when "
        "it prices a booking, so a seat cannot be bought for a number the client made up."
    ),
)
def get_seat_map(
    flight_key: str = Query(..., description="The itinerary's id — seeds the cabin, so the same flight always shows the same seats."),
    rows: int = Query(catalog.DEFAULT_ROWS, ge=10, le=60),
):
    return catalog.seat_map(flight_key, rows)


@router.get(
    "/addons",
    summary="Add-on catalogue",
    description=(
        "Public. Baggage, meals and services available on a product, with the allowance already "
        "included in the fare listed separately so a traveller can see what they have before "
        "being sold more of it."
    ),
)
def get_addons(product_type: str = Query("flight")):
    return catalog.addons(product_type)


@router.get(
    "/reference",
    summary="Reference lists for the traveller form",
    description="Public. Titles, genders, nationalities, cabin classes and frequent-flyer airlines.",
)
def get_reference():
    return catalog.reference_lists()


@router.get(
    "/payment-methods",
    summary="Supported payment methods",
    description=(
        "Public. **No payment gateway is integrated with this portal yet.** This lists the "
        "methods the payment step offers; a booking made through it is recorded as `pending` "
        "and no money moves. See `POST /bookings/{ref}/pay`."
    ),
)
def get_payment_methods():
    return {"gateway_configured": False, "methods": bookings.PAYMENT_METHODS}


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------
@router.post(
    "/bookings/quote",
    response_model=QuoteResponse,
    summary="Price a booking in progress",
    description=(
        "Public — a fare is quotable before signing in. Recomputes the whole fare from the "
        "choices sent: flight, cabin, party, seats, add-ons, coupon.\n\n"
        "**The request carries no prices.** This is what the Fare Summary re-reads whenever a "
        "seat or an add-on changes, and it is the same code path that prices the real booking, "
        "so the reviewed total and the charged total cannot drift apart.\n\n"
        "A coupon that does not apply comes back in `coupon_error` with the fare still priced — "
        "the customer needs to see the fare while they fix the code."
    ),
)
def quote_booking(payload: QuoteRequest, db: Session = Depends(get_db)):
    try:
        result = pricing.quote(
            db,
            flight_key=payload.flight.flight_key,
            flight_number=payload.flight.flight_number,
            duration_minutes=payload.flight.duration_minutes,
            cabin=payload.flight.cabin_class,
            passenger_types=payload.passenger_types,
            seat_selections=[s.model_dump() for s in payload.seats],
            addon_selections=[a.model_dump() for a in payload.addons],
            coupon_code=payload.coupon_code,
            is_international=payload.flight.is_international,
        )
    except pricing.PricingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return result


@router.get(
    "/coupons",
    response_model=list[CouponOffer],
    summary="Coupons available for a product",
    description=(
        "Public. The active coupons that could apply to this product — what the booking form's "
        "**View available coupons** panel lists.\n\n"
        "Listing is not the same as applying: what a code is actually worth depends on the fare, "
        "the party and whether the route is international, so the panel offers a code to try and "
        "`POST /coupons/validate` is what prices it."
    ),
)
def list_coupons(product_type: str = Query("flight"), db: Session = Depends(get_db)):
    return pricing.available_coupons(db, product_type=product_type)


@router.post(
    "/coupons/validate",
    response_model=CouponValidateResponse,
    summary="Check a coupon against a fare",
    description=(
        "Public. Resolves a code against the coupon table and returns what it is actually worth "
        "on this fare — discounts are looked up, never invented. An unknown and an inactive code "
        "give the same answer, so the table cannot be enumerated."
    ),
)
def validate_coupon(payload: CouponValidateRequest, db: Session = Depends(get_db)):
    base_fare, _ = pricing.flight_fare(
        payload.flight.flight_number, payload.flight.duration_minutes
    )
    mult = pricing.cabin_multiplier(payload.flight.cabin_class)
    paying = max(1, len([t for t in payload.passenger_types if t != "infant"]))
    amount = pricing._money(base_fare * mult * paying)

    try:
        discount, coupon = pricing.validate_coupon(
            db, payload.code, product_type="flight",
            is_international=payload.flight.is_international, amount=amount,
        )
    except pricing.PricingError as exc:
        return CouponValidateResponse(
            code=payload.code.strip().upper(), title="", discount=0,
            applies=False, message=str(exc),
        )
    return CouponValidateResponse(
        code=coupon.code, title=coupon.title, description=coupon.description,
        discount=discount, applies=True,
        message=f"{coupon.code} applied — you save ₹{discount:,.0f}.",
    )


# ---------------------------------------------------------------------------
# Bookings
# ---------------------------------------------------------------------------
@router.post(
    "/bookings",
    response_model=BookingResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a booking",
    description=(
        "Requires a customer session. Re-prices everything server-side and writes the booking, "
        "its passengers and its add-ons.\n\n"
        "**What comes back is real and what does not is null.** `booking_ref` (`JPB000123`) is "
        "this platform's own reference, from a sequence, unique by index. `pnr` is `null`: a PNR "
        "is issued by an airline through a GDS and there is no airline integration here, so "
        "returning a made-up one would give the traveller a code that fails at a check-in desk. "
        "`status` is `pending` for the same reason — nothing has been ticketed and no money has "
        "moved.\n\n"
        "Passport rules are enforced here, not just in the form: required for international "
        "travel, and valid for six months **from the travel date**."
    ),
    responses={400: {"description": "A validation, pricing or availability problem, named."}},
)
def create_booking(
    request: Request,
    payload: BookingCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    try:
        booking = bookings.create_booking(db, customer, payload.model_dump())
    except bookings.BookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Booking created", module="Bookings",
        description=f"{booking.booking_ref} — {booking.airline} {booking.flight_number}",
        meta=activity_service.request_context(request),
    )
    db.commit()
    db.refresh(booking)
    return booking


@router.get(
    "/bookings",
    response_model=list[BookingResponse],
    summary="My bookings",
    description=(
        "Requires a customer session. This customer's bookings, newest first, each with its "
        "passengers, add-ons and payment attempts — everything the My Bookings list and its "
        "detail view show."
    ),
)
def list_bookings(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return bookings.list_for_customer(db, customer)


@router.get(
    "/bookings/{booking_ref}",
    response_model=BookingResponse,
    summary="One booking",
    description=(
        "Requires a customer session. Scoped to the owner — booking references are sequential "
        "and therefore guessable, so another customer's reference returns 404 rather than a "
        "booking."
    ),
    responses={404: {"description": "No such booking for this customer."}},
)
def get_booking(
    booking_ref: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")
    return booking


@router.post(
    "/bookings/{booking_ref}/pay",
    response_model=BookingResponse,
    summary="Record a payment attempt",
    description=(
        "Requires a customer session.\n\n"
        "**This does not take money.** No payment gateway is integrated with this portal, so "
        "the attempt is recorded as `pending`, the booking stays `pending`, and nothing is "
        "charged. Reporting success here would tell a customer they had paid when they had not.\n\n"
        "A real integration replaces the body of `record_payment`: create the provider's order, "
        "return what the client needs to complete it, and let the provider's webhook move the "
        "payment to `captured` and the booking to `confirmed`."
    ),
    responses={400: {"description": "Unsupported method, or the booking is cancelled."}},
)
def pay_booking(
    request: Request,
    booking_ref: str,
    payload: PaymentRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")
    try:
        bookings.record_payment(db, booking, payload.method)
    except bookings.BookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Payment attempted", module="Bookings",
        description=f"{booking.booking_ref} via {payload.method}",
        meta=activity_service.request_context(request),
    )
    db.commit()
    db.refresh(booking)
    return booking


@router.post(
    "/bookings/{booking_ref}/cancel",
    response_model=BookingResponse,
    summary="Cancel a booking",
    description=(
        "Requires a customer session. Marks the booking cancelled and stamps `cancelled_at`. "
        "No refund is computed — there is no payment to refund until a gateway is integrated."
    ),
    responses={400: {"description": "Already cancelled, or completed."}},
)
def cancel_booking(
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
    except bookings.BookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Booking cancelled", module="Bookings",
        description=booking.booking_ref,
        meta=activity_service.request_context(request),
    )
    db.commit()
    db.refresh(booking)
    return booking
