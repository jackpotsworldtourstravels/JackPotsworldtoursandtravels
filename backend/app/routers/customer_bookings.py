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

import logging

from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.models_customer import Customer
from app.schemas.customer_booking import (
    FlightCheckoutRequest,
    FlightCheckoutResponse,
    FlightReconcileRequest,
    FlightReconcileResponse,
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
from app.services import customer_account_service as acct
from app.services import customer_booking_service as bookings
from app.services import payment_verification_flight_service as verify_flight
from app.services import payments as payment_providers
from app.services import customer_catalog_service as catalog
from app.services import customer_pricing_service as pricing

router = APIRouter(prefix="/api/customer", tags=["customer-bookings"])

logger = logging.getLogger(__name__)


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
        "Public. Lists the methods the **legacy** payment step offers, and always "
        "reports `gateway_configured: false` — that flow records an attempt and "
        "moves no money, for every product including tour packages.\n\n"
        "**This is not the online gateway.** Tour packages take real payments "
        "through `GET /customer/payments/config` and "
        "`POST /customer/package-bookings/{ref}/checkout`, which report their own "
        "configuration separately. Flights and hotels have no gateway, so for "
        "those two this is the whole story. See `POST /bookings/{ref}/pay`."
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
    acct.notify(
        db, customer.customer_id, "booking_created",
        title="Booking confirmed",
        message=f"Your {booking.airline} {booking.flight_number} booking "
                f"({booking.booking_ref}) has been recorded.",
        related_ref=booking.booking_ref,
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
        "**This does not take money.** No payment gateway is integrated for flights, "
        "so the attempt is recorded as `pending`, the booking stays `pending`, and "
        "nothing is charged. Reporting success here would tell a customer they had "
        "paid when they had not.\n\n"
        "Tour packages DO have an online gateway, and it was added **alongside** "
        "this endpoint rather than inside it — see "
        "`POST /customer/package-bookings/{ref}/checkout`. Only the provider's "
        "verified webhook path may move a payment to `captured` or a booking to "
        "`confirmed`; this endpoint never does, for any product."
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
    acct.notify(
        db, customer.customer_id, "booking_cancelled",
        title="Booking cancelled",
        message=f"{booking.booking_ref} has been cancelled.",
        related_ref=booking.booking_ref,
    )
    db.commit()
    db.refresh(booking)
    return booking


# ---------------------------------------------------------------------------
# Taking a real payment for a flight booking.
#
# These mirror the package endpoints in customer_package_bookings.py. The
# CustomerPaymentStatus import is local to keep this block self-contained.
# ---------------------------------------------------------------------------
@router.post(
    "/bookings/{booking_ref}/checkout",
    response_model=FlightCheckoutResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Open a payment checkout for a flight booking",
    description=(
        "Requires a customer session, and the booking must belong to it.\n\n"
        "**This takes no money.** It asks the provider to open an order for the "
        "amount held on the booking row, records the order id against a "
        "`pending` payment, and returns what the browser needs to display the "
        "provider's own checkout. The booking is not touched.\n\n"
        "**The amount is never read from the request.** There is no field for "
        "one. Every rupee comes from the booking the server priced at creation."
    ),
    responses={
        400: {"description": "Cancelled, already paid, or a bad idempotency key."},
        404: {"description": "No such booking for this customer."},
        503: {"description": "No payment provider is configured, or it is unreachable."},
    },
)
def start_flight_checkout(
    request: Request,
    booking_ref: str,
    payload: FlightCheckoutRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    from app.models_customer import CustomerPaymentStatus

    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        # 404 not 403: booking references are sequential and therefore
        # guessable, and a 403 would confirm that one exists.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")

    try:
        payment, session = bookings.start_checkout(
            db, customer, booking, idempotency_key=payload.idempotency_key,
        )
    except payment_providers.PaymentNotConfigured as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=exc.customer_message,
        ) from exc
    except payment_providers.PaymentProviderError as exc:
        logger.warning(
            "Flight checkout could not be opened for %s: %s", booking.booking_ref, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=exc.customer_message,
        ) from exc
    except bookings.BookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Payment checkout opened", module="Bookings",
        description=(
            f"{booking.booking_ref} via {session.provider} order {session.order_id} "
            f"for {payment.currency} {payment.amount}"
        ),
        meta=activity_service.request_context(request),
    )
    db.commit()

    return FlightCheckoutResponse(
        provider=session.provider,
        order_id=session.order_id,
        amount=session.amount_minor,
        currency=session.currency,
        key_id=session.publishable_key,
        booking_ref=booking.booking_ref,
        options=dict(session.options),
        # Always pending here. Said explicitly rather than read off the row so
        # that a future change to the row cannot make this endpoint start
        # reporting a success it has no business reporting.
        payment_status=CustomerPaymentStatus.PENDING.value,
    )


@router.post(
    "/bookings/{booking_ref}/reconcile",
    response_model=FlightReconcileResponse,
    summary="Ask the provider where this flight booking's payment actually stands",
    description=(
        "Requires a customer session. **Asks the provider**, over an "
        "authenticated server-side channel, and applies the answer through the "
        "same verifier the webhook uses. Nothing the browser sends decides "
        "anything.\n\n"
        "This is what lets a payment finish where no webhook can arrive."
    ),
    responses={
        404: {"description": "No such booking for this customer."},
        503: {"description": "No payment provider is configured."},
    },
)
def reconcile_flight_payment(
    request: Request,
    booking_ref: str,
    payload: FlightReconcileRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")

    payment = bookings.reconcilable_payment(db, booking)
    if payment is None:
        # No checkout was ever opened. Not an error: it is what a booking looks
        # like before anyone has pressed Pay Now, and the honest answer is the
        # booking's own status rather than a 4xx.
        return FlightReconcileResponse(
            booking_ref=booking.booking_ref,
            booking_status=booking.status,
            payment_status=None,
            captured=False,
            code="no_payment",
            retryable=False,
        )

    # ---- the handler's signature, when the browser still has it -----------
    # CORROBORATION, NOT AUTHORISATION. A valid signature does not capture
    # anything and an absent one does not block anything; the provider read
    # below is what settles the payment either way.
    #
    # The order id compared is OURS, off the payment row. Verifying against the
    # order id returned by the checkout proves nothing, because an attacker
    # supplies both halves.
    if payload.signature and payload.provider_payment_id:
        try:
            adapter = payment_providers.get_provider_named(payment.provider or "")
            verify_sig = getattr(adapter, "verify_checkout_signature", None)
            if callable(verify_sig) and payment.provider_order_id:
                if not verify_sig(
                    order_id=payment.provider_order_id,
                    payment_id=payload.provider_payment_id,
                    signature=payload.signature,
                ):
                    logger.warning(
                        "Checkout signature did not match for %s (order %s). "
                        "Verifying against the provider anyway; the provider "
                        "read is what decides.",
                        booking.booking_ref, payment.provider_order_id,
                    )
        except payment_providers.PaymentProviderError:
            # Not configured, or a different provider. The verifier below
            # reports that properly; nothing to add here.
            pass

    # ---- the authoritative path -------------------------------------------
    result = verify_flight.verify_and_capture(
        db, payment.customer_booking_payment_id,
    )

    if result.captured_now or result.booking_confirmed_now:
        # Audited only when something actually MOVED. A poller calling this
        # every two seconds must not write an audit row every two seconds.
        customer_audit_service.log(
            db, customer, "Payment reconciled", module="Bookings",
            description=(
                f"{booking.booking_ref}: {result.code} "
                f"(payment {payment.customer_booking_payment_id}, "
                f"captured={result.captured_now}, "
                f"confirmed={result.booking_confirmed_now})"
            ),
            meta=activity_service.request_context(request),
        )

    db.commit()
    db.refresh(booking)
    db.refresh(payment)

    return FlightReconcileResponse(
        booking_ref=booking.booking_ref,
        booking_status=booking.status,
        payment_status=payment.status,
        captured=result.captured_now,
        code=result.code,
        retryable=result.disposition == verify_flight.RETRYABLE,
    )
