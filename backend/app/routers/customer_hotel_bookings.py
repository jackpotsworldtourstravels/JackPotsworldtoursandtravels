"""Customer hotel bookings — ``/api/customer/hotels/*`` and ``/hotel-bookings/*``.

The hotel flow's server side, in the order the customer meets it:

    GET  /api/customer/hotels                 Hotel Results (replaces SAMPLE_HOTELS)
    GET  /api/customer/hotels/{id}             Hotel Details, with its rooms
    GET  /api/customer/hotels/addons           breakfast, transfers, late checkout
    POST /api/customer/hotel-bookings/quote    the fare, recomputed (every step)
    POST /api/customer/hotel-bookings          the booking
    POST /api/customer/hotel-bookings/{ref}/pay a payment attempt
    GET  /api/customer/hotel-bookings          My Trips (step 6 and after)

Deliberately a separate path from ``customer_bookings.py`` and a separate
table underneath it — see migration 0055. The catalogue routes are public for
the same reason a flight's seat map is: browsing a room before signing in is
normal. Everything that touches a booking requires a session.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

import logging

from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.models_customer import Customer
from app.schemas.customer_hotel_booking import (
    HotelCheckoutRequest,
    HotelCheckoutResponse,
    HotelReconcileRequest,
    HotelReconcileResponse,
    HotelBookingCreate,
    HotelBookingResponse,
    HotelDetail,
    HotelPaymentRequest,
    HotelQuoteRequest,
    HotelQuoteResponse,
    HotelSearchResult,
)
from app.services import activity_service, customer_audit_service
from app.services import customer_account_service as acct
from app.services import customer_hotel_booking_service as bookings
from app.services import payment_verification_hotel_service as verify_hotel
from app.services import payments as payment_providers
from app.services import customer_hotel_catalog_service as catalog
from app.services import customer_hotel_pricing_service as pricing

router = APIRouter(prefix="/api/customer", tags=["customer-hotel-bookings"])

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------
@router.get(
    "/hotels",
    response_model=list[HotelSearchResult],
    summary="Hotel Results",
    description=(
        "Public. Every active property, with its lowest nightly rate. Destination and price-band "
        "filtering stay client-side — the same arrangement flights use for their own sample-sized "
        "catalogue — so this returns the whole list and the browser narrows it."
    ),
)
def list_hotels(db: Session = Depends(get_db)):
    return catalog.list_hotels(db)


@router.get(
    "/hotels/addons",
    summary="Hotel add-on catalogue",
    description="Public. Breakfast, airport pickup, late checkout and travel insurance.",
)
def get_hotel_addons():
    return catalog.addons()


@router.get(
    "/hotels/rooms",
    summary="Room options for a property",
    description=(
        "Public. The room tiers ``booking-data.js``'s local generator used to invent from a "
        "hotel's nightly rate — this is the seam it already named "
        "(``BookingData.config.endpoints.rooms``), now answered for real. Shaped to match that "
        "generator's own fields exactly, so the Room Selection step needed no changes to read it."
    ),
    responses={404: {"description": "No such hotel."}},
)
def get_hotel_rooms(hotel: int = Query(..., description="The hotel's id."), db: Session = Depends(get_db)):
    property_ = catalog.get_hotel(db, hotel)
    if property_ is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Hotel not found.")
    return [
        {
            "id": str(r.customer_hotel_room_id),
            "name": r.name,
            "beds": r.bed_type,
            "size": r.size_label,
            "price": float(r.base_price_per_night),
            "maxGuests": r.max_guests,
            "perks": list(r.perks or []),
            "left": r.total_inventory,
            "mealPlan": r.meal_plan,
            "cancellationPolicy": r.cancellation_policy,
            "description": r.description,
        }
        for r in property_.rooms
    ]


@router.get(
    "/hotels/{hotel_id}",
    response_model=HotelDetail,
    summary="Hotel Details",
    description="Public. Images, description, amenities, policies and every room option.",
    responses={404: {"description": "No such hotel."}},
)
def get_hotel(hotel_id: int, db: Session = Depends(get_db)):
    hotel = catalog.get_hotel(db, hotel_id)
    if hotel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Hotel not found.")
    return hotel


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------
@router.post(
    "/hotel-bookings/quote",
    response_model=HotelQuoteResponse,
    summary="Price a stay in progress",
    description=(
        "Public. Recomputes the whole fare from the choices sent: the room, the dates, the party, "
        "add-ons, a coupon. The request carries no prices — this is what the Fare Summary re-reads "
        "on every change, and the same code path prices the real booking."
    ),
)
def quote_hotel_booking(payload: HotelQuoteRequest, db: Session = Depends(get_db)):
    # Priced through the booking service, NOT by resolving a room here: this
    # route used to do its own lookup and its own checks, which is how it came
    # to ignore `room_ids` and quote two of the first room for a stay that
    # mixes types. One function now answers both the quote and the booking.
    try:
        return bookings.quote_stay(
            db,
            payload.stay.model_dump(),
            [a.model_dump() for a in payload.addons],
            payload.coupon_code,
        )
    except bookings.HotelBookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Bookings
# ---------------------------------------------------------------------------
@router.post(
    "/hotel-bookings",
    response_model=HotelBookingResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a hotel booking",
    description=(
        "Requires a customer session. Re-prices everything server-side and writes the booking, "
        "its guests and its add-ons.\n\n"
        "`booking_ref` (`JPH000123`) is this platform's own reference, from its own sequence — "
        "distinct from a flight's `JPB` series. `status` is `pending`: no payment gateway is "
        "integrated, so nothing has been charged yet."
    ),
    responses={400: {"description": "A validation, pricing or availability problem, named."}},
)
def create_hotel_booking(
    request: Request,
    payload: HotelBookingCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    try:
        booking = bookings.create_booking(db, customer, payload.model_dump())
    except bookings.HotelBookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Hotel booking created", module="Bookings",
        description=f"{booking.booking_ref} — {booking.hotel_name}",
        meta=activity_service.request_context(request),
    )
    acct.notify(
        db, customer.customer_id, "booking_created",
        title="Booking confirmed",
        message=f"Your stay at {booking.hotel_name} ({booking.booking_ref}) has been recorded.",
        related_ref=booking.booking_ref,
    )
    db.commit()
    db.refresh(booking)
    return booking


@router.get(
    "/hotel-bookings",
    response_model=list[HotelBookingResponse],
    summary="My hotel bookings",
    description="Requires a customer session. This customer's hotel bookings, newest first.",
)
def list_hotel_bookings(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return bookings.list_for_customer(db, customer)


@router.get(
    "/hotel-bookings/{booking_ref}",
    response_model=HotelBookingResponse,
    summary="One hotel booking",
    description="Requires a customer session. Scoped to the owner.",
    responses={404: {"description": "No such booking for this customer."}},
)
def get_hotel_booking(
    booking_ref: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")
    return booking


@router.post(
    "/hotel-bookings/{booking_ref}/pay",
    response_model=HotelBookingResponse,
    summary="Record a payment attempt",
    description=(
        "Requires a customer session. No payment gateway is integrated for hotels, so "
        "the attempt is recorded as `pending` and nothing is charged — the same "
        "honesty as the flight path.\n\n"
        "Tour packages have an online gateway at "
        "`POST /customer/package-bookings/{ref}/checkout`. This endpoint is not it, "
        "and never captures a payment or confirms a booking."
    ),
)
def pay_hotel_booking(
    request: Request,
    booking_ref: str,
    payload: HotelPaymentRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")
    try:
        bookings.record_payment(db, booking, payload.method)
    except bookings.HotelBookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Hotel payment attempted", module="Bookings",
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
    "/hotel-bookings/{booking_ref}/cancel",
    response_model=HotelBookingResponse,
    summary="Cancel a hotel booking",
    description="Requires a customer session. Marks the booking cancelled and stamps `cancelled_at`.",
    responses={400: {"description": "Already cancelled, or completed."}},
)
def cancel_hotel_booking(
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
    except bookings.HotelBookingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    customer_audit_service.log(
        db, customer, "Hotel booking cancelled", module="Bookings",
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
# Taking a real payment for a hotel booking.
#
# These mirror the package endpoints in customer_package_bookings.py. The
# CustomerPaymentStatus import is local to keep this block self-contained.
# ---------------------------------------------------------------------------
@router.post(
    "/hotel-bookings/{booking_ref}/checkout",
    response_model=HotelCheckoutResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Open a payment checkout for a hotel booking",
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
def start_hotel_checkout(
    request: Request,
    booking_ref: str,
    payload: HotelCheckoutRequest,
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
            "Hotel checkout could not be opened for %s: %s", booking.booking_ref, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=exc.customer_message,
        ) from exc
    except bookings.HotelBookingError as exc:
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

    return HotelCheckoutResponse(
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
    "/hotel-bookings/{booking_ref}/reconcile",
    response_model=HotelReconcileResponse,
    summary="Ask the provider where this hotel booking's payment actually stands",
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
def reconcile_hotel_payment(
    request: Request,
    booking_ref: str,
    payload: HotelReconcileRequest,
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
        return HotelReconcileResponse(
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
    result = verify_hotel.verify_and_capture(
        db, payment.customer_hotel_booking_payment_id,
    )

    if result.captured_now or result.booking_confirmed_now:
        # Audited only when something actually MOVED. A poller calling this
        # every two seconds must not write an audit row every two seconds.
        customer_audit_service.log(
            db, customer, "Payment reconciled", module="Bookings",
            description=(
                f"{booking.booking_ref}: {result.code} "
                f"(payment {payment.customer_hotel_booking_payment_id}, "
                f"captured={result.captured_now}, "
                f"confirmed={result.booking_confirmed_now})"
            ),
            meta=activity_service.request_context(request),
        )

    db.commit()
    db.refresh(booking)
    db.refresh(payment)

    return HotelReconcileResponse(
        booking_ref=booking.booking_ref,
        booking_status=booking.status,
        payment_status=payment.status,
        captured=result.captured_now,
        code=result.code,
        retryable=result.disposition == verify_hotel.RETRYABLE,
    )
