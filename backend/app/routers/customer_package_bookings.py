"""Customer tour-package bookings — ``/api/customer/packages/*`` and
``/package-bookings/*``.

The package flow's server side, in the order the customer meets it:

    GET  /api/customer/packages                Tour Packages grid (replaces SAMPLE_PACKAGES)
    GET  /api/customer/packages/{id}            the package's own detail view
    GET  /api/customer/packages/departures      Departure step (replaces buildDepartures())
    GET  /api/customer/packages/addons          hotel upgrade, guide, transfer, insurance
    POST /api/customer/package-bookings/quote   the fare, recomputed
    POST /api/customer/package-bookings         the booking
    POST /api/customer/package-bookings/{ref}/pay      an intent, when no gateway
    GET  /api/customer/payments/config                is a gateway configured?
    POST /api/customer/package-bookings/{ref}/checkout open a provider order
    GET  /api/customer/package-bookings         My Trips

Deliberately a separate path and a separate table from both
``customer_bookings.py`` (flights) and ``customer_hotel_bookings.py`` — see
migration 0056. Catalogue routes are public, same reasoning as the other two.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.models_customer import Customer, CustomerPaymentStatus
from app.schemas.customer_package_booking import (
    PackageBookingCreate,
    PackageBookingResponse,
    PackageCheckoutRequest,
    PackageCheckoutResponse,
    PackageDetail,
    PackagePaymentRequest,
    PackageReconcileRequest,
    PackageReconcileResponse,
    PackageQuoteRequest,
    PackageQuoteResponse,
    PackageSearchResult,
)
from app.services import activity_service, customer_audit_service
from app.services import customer_account_service as acct
from app.services import customer_package_booking_service as bookings
from app.services import customer_package_catalog_service as catalog
from app.services import customer_package_pricing_service as pricing
from app.services import payment_verification_service
from app.services import payments as payment_providers

import logging

logger = logging.getLogger(__name__)

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
        "Requires a customer session. **This is not the gateway and it takes no "
        "money.** The attempt is recorded as `pending`, the booking is untouched, and "
        "nothing is charged. It remains for deployments with no provider configured "
        "and for clients written before the gateway existed.\n\n"
        "To actually take payment for a package, open a checkout with "
        "`POST /customer/package-bookings/{ref}/checkout` and let the provider's "
        "signed webhook capture it. Only that verified path may set a payment "
        "`captured` or a booking `confirmed` — this endpoint never does."
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


# ---------------------------------------------------------------------------
# Real payments (Phase 3). Opening a checkout only.
#
# WHY THIS IS A NEW ROUTE AND NOT A CHANGE TO /pay
# ``/pay`` records which method a traveller intends to use and charges nothing,
# and the live checkout still calls it. Rewriting it here would change a
# contract the frontend depends on before the frontend is ready for the new
# one, which is a broken deployment for the length of two phases. ``/pay``
# stays exactly as it is; Phase 8 moves the frontend across, and only then does
# ``/pay`` become the fallback for deployments with no provider configured.
# ---------------------------------------------------------------------------
@router.get(
    "/payments/config",
    summary="Is online payment available, and with what",
    description=(
        "Public. Reports whether a payment provider is configured on this "
        "deployment and, if so, its **publishable** key.\n\n"
        "No payment method list is returned. The provider decides what to offer "
        "from the customer's device — UPI Intent on mobile, UPI QR on desktop — "
        "and a list published here would go stale the moment an account setting "
        "changed. UPI Collect is not offered by anyone: NPCI withdrew it for "
        "merchant payments on 28 February 2026.\n\n"
        "**The key secret and the webhook secret are never returned by this or "
        "any other endpoint.**"
    ),
)
def payment_config():
    return {
        "configured": payment_providers.is_available(),
        "provider": payment_providers.provider_name(),
        # Publishable by design — the provider's browser script needs it.
        "key_id": payment_providers.publishable_key(),
        "currency": payment_providers.INR,
    }


@router.post(
    "/package-bookings/{booking_ref}/checkout",
    response_model=PackageCheckoutResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Open a payment checkout for a package booking",
    description=(
        "Requires a customer session, and the booking must belong to it.\n\n"
        "**This takes no money.** It asks the provider to open an order for the "
        "amount held on the booking row, records the order id against a "
        "`pending` payment, and returns what the browser needs to display the "
        "provider's own checkout. The booking is not touched.\n\n"
        "**The amount is never read from the request.** There is no field for "
        "one — see `PackageCheckoutRequest`. Every rupee comes from the booking "
        "the server priced at creation.\n\n"
        "**Pressing Pay Now twice opens one order.** Send the same "
        "`idempotency_key` on a retry and the order already opened is returned.\n\n"
        "A payment becomes `captured`, and the booking `confirmed`, only when "
        "the provider's webhook is verified server-side. Nothing the browser "
        "reports can produce either."
    ),
    responses={
        400: {"description": "Cancelled, completed, already paid, or a bad key."},
        404: {"description": "No such booking for this customer."},
        503: {"description": "No payment provider is configured, or it is unreachable."},
    },
)
def start_package_checkout(
    request: Request,
    booking_ref: str,
    payload: PackageCheckoutRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        # 404 rather than 403: another customer's reference must not be
        # distinguishable from one that does not exist, or the endpoint becomes
        # a way to test whether a booking reference is real.
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
        # The provider's own words are logged by the adapter and never sent on:
        # they are written for developers and can name internal fields.
        logger.warning(
            "Checkout could not be opened for %s: %s", booking.booking_ref, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=exc.customer_message,
        ) from exc
    except bookings.PackageBookingError as exc:
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

    return PackageCheckoutResponse(
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


# ---------------------------------------------------------------------------
# Reconciliation — asking the provider, on demand
# ---------------------------------------------------------------------------
@router.post(
    "/package-bookings/{booking_ref}/reconcile",
    response_model=PackageReconcileResponse,
    summary="Ask the provider where this booking's payment actually stands",
    description=(
        "Requires a customer session, and the booking must belong to it.\n\n"
        "**This is the same verification the webhook performs, on demand.** It "
        "re-reads the payment from the provider over an authenticated channel "
        "and compares the amount, currency and order against the booking row "
        "before deciding anything — it does not read a status from the request, "
        "and there is no field in `PackageReconcileRequest` that could carry "
        "one.\n\n"
        "**Why it exists.** The webhook is the authority, but it is not always "
        "available: a provider cannot deliver to a developer's laptop, a "
        "delivery can be late, and a customer can close the tab before one "
        "arrives. Without this the booking stays `pending` even though the "
        "money moved. This endpoint does not weaken that model — it calls the "
        "identical verifier, so a payment the webhook would refuse is refused "
        "here for the same reason.\n\n"
        "**Safe to call repeatedly.** The verifier takes a row lock and answers "
        "`already_captured` for a settled payment without calling the provider, "
        "so polling it costs one query rather than one provider round trip."
    ),
    responses={
        404: {"description": "No such booking for this customer."},
        503: {"description": "No payment provider is configured."},
    },
)
@limiter.limit("60/minute")
def reconcile_package_payment(
    request: Request,
    booking_ref: str,
    payload: PackageReconcileRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    booking = bookings.get_owned(db, customer, booking_ref)
    if booking is None:
        # 404 not 403, for the reason given on the checkout endpoint above.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found.")

    payment = bookings.reconcilable_payment(db, booking)
    if payment is None:
        # No checkout was ever opened. Not an error: it is what a booking looks
        # like before anyone has pressed Pay Now, and the honest answer is the
        # booking's own status rather than a 4xx.
        return PackageReconcileResponse(
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
    # below is what settles the payment either way. This is logged because a
    # signature that does NOT match is worth an operator's attention even when
    # the payment turns out to be genuine.
    #
    # The order id compared is OURS, off the payment row. Razorpay's own
    # guidance is explicit that verifying against the order id returned by the
    # checkout proves nothing, because an attacker supplies both halves.
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

    # ---- the authoritative path, unchanged --------------------------------
    result = payment_verification_service.verify_and_capture(
        db, payment.customer_package_booking_payment_id,
    )

    if result.captured_now or result.booking_confirmed_now:
        # Audited only when something actually MOVED. A poller calling this
        # every two seconds must not write an audit row every two seconds.
        customer_audit_service.log(
            db, customer, "Payment reconciled", module="Bookings",
            description=(
                f"{booking.booking_ref}: {result.code} "
                f"(payment {payment.customer_package_booking_payment_id}, "
                f"captured={result.captured_now}, "
                f"confirmed={result.booking_confirmed_now})"
            ),
            meta=activity_service.request_context(request),
        )

    db.commit()
    db.refresh(booking)
    db.refresh(payment)

    return PackageReconcileResponse(
        booking_ref=booking.booking_ref,
        booking_status=booking.status,
        payment_status=payment.status,
        captured=result.captured_now,
        code=result.code,
        retryable=result.disposition == payment_verification_service.RETRYABLE,
    )
