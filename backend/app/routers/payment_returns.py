"""Where a hosted payment page sends the customer back — ``/api/payments/*/return``.

WHAT THIS ROUTE IS, AND WHAT IT IS NOT
A drop-in checkout (Razorpay) never leaves our page, so it has no return. A
hosted page (HDFC SmartGateway) does: the customer's BROWSER is redirected here
with the order id and a status. That makes this the least trustworthy input in
the payment flow — it is a URL anyone can type — and so it decides nothing:

    params  ->  adapter.verify_return()   which order? (signature, if configured)
            ->  find our payment row      by (provider, provider_order_id) only
            ->  verify_payment_row()      the SAME verifier a webhook reaches:
                                          Order Status from the provider,
                                          order/amount/currency vs. the booking
            ->  303 to OUR frontend       a fixed page, never a URL from input

The ``status`` HDFC puts in the query string is never read. "After receiving
process response on the return url, it is mandatory to do a Server-to-Server
Order Status API call to determine the final payment status" — HDFC's own
words, and what the verifier does.

A REPEATED OR REPLAYED RETURN IS HARMLESS. The verifier takes a row lock and
answers ``already_captured`` for a settled payment without calling out, so
reloading this URL — or replaying a captured one — confirms nothing twice.

THE REDIRECT TARGET IS FIXED. It is built from ``FRONTEND_BASE_URL`` plus our
own booking reference; no parameter can choose where the customer lands.
"""
from __future__ import annotations

import logging
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

import app.config
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.models_customer import (
    CustomerBooking,
    CustomerBookingPayment,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
)
from app.services import payment_event_service as events
from app.services import payments as payment_providers
from app.services.payments.base import ProviderPayment

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/payments", tags=["payment-returns"])

#: A return carries a handful of short parameters. Anything bigger is not one.
MAX_PARAMS = 40
MAX_VALUE_LEN = 512

#: The page the customer lands on. It polls OUR reconcile endpoint, which runs
#: the verifier again — so a return that arrives before the bank has settled
#: still ends on the right answer.
LANDING_PAGE = "/my-bookings.html"


def _landing(**params: str) -> RedirectResponse:
    base = (app.config.settings.frontend_base_url or "").rstrip("/")
    query = urlencode({k: v for k, v in params.items() if v})
    # 303: the browser follows with GET whatever method reached us, so a POSTed
    # return is never re-submitted by a reload.
    return RedirectResponse(f"{base}{LANDING_PAGE}?{query}", status_code=303)


def _booking_for(db: Session, row) -> tuple[str | None, str | None]:
    """(booking_ref, kind) for a payment row — our reference, not the provider's."""
    if isinstance(row, CustomerPackageBookingPayment):
        booking = db.get(CustomerPackageBooking, row.package_booking_id)
        return (booking.booking_ref if booking else None), "package"
    if isinstance(row, CustomerBookingPayment):
        booking = db.get(CustomerBooking, row.customer_booking_id)
        return (booking.booking_ref if booking else None), "flight"
    if isinstance(row, CustomerHotelBookingPayment):
        booking = db.get(CustomerHotelBooking, row.hotel_booking_id)
        return (booking.booking_ref if booking else None), "hotel"
    return None, None


async def _params(request: Request) -> dict[str, str] | None:
    """Query string and, for a POSTed return, the form body. Bounded.

    NOT VERIFIED — requires HDFC confirmation: the docs describe the return as
    "parameters (key=value pairs) from the return_url" and do not say whether
    the redirect is a GET or a form POST. Both are accepted.
    """
    items = list(request.query_params.multi_items())
    if request.method == "POST":
        try:
            form = await request.form()
            items.extend((k, v) for k, v in form.multi_items() if isinstance(v, str))
        except Exception:                               # noqa: BLE001
            return None
    if len(items) > MAX_PARAMS:
        return None
    out: dict[str, str] = {}
    for key, value in items:
        if len(key) > 64 or len(value) > MAX_VALUE_LEN or key in out:
            # A repeated key is ambiguous; which copy was signed is unknowable.
            return None
        out[key] = value
    return out


@router.api_route(
    "/{provider}/return",
    methods=["GET", "POST"],
    include_in_schema=True,
    summary="Customer returning from a hosted payment page",
    description=(
        "**Called by the customer's browser, redirected by the payment "
        "provider.** Nothing on this request is trusted: the order id selects "
        "which payment to re-verify with the provider server-side, and the "
        "status in the query string is ignored. Always answers with a 303 to "
        "the booking page, which polls the reconcile endpoint for the result."
    ),
)
@limiter.limit("60/minute")
async def payment_return(request: Request, provider: str, db: Session = Depends(get_db)):
    try:
        adapter = payment_providers.get_provider_named(provider)
    except payment_providers.PaymentProviderError:
        logger.warning("Payment return for unconfigured provider %r.", provider)
        return _landing(payment_return="unknown")

    verify_return = getattr(adapter, "verify_return", None)
    if not callable(verify_return):
        # A drop-in provider has no return; nothing to do but land somewhere.
        return _landing(payment_return="unknown")

    params = await _params(request)
    if params is None:
        logger.warning("Payment return refused: malformed parameters (provider=%s).",
                       adapter.name)
        return _landing(payment_return="unverified")

    try:
        order_id = verify_return(params)
    except payment_providers.WebhookVerificationError as exc:
        # Nothing is looked up and nothing is verified on the strength of an
        # order id we cannot authenticate. The customer still lands on My
        # Trips, where the booking's own status — settled by the webhook or by
        # reconcile — is what they see.
        logger.warning("Payment return not verified: provider=%s reason=%s",
                       adapter.name, exc)
        return _landing(payment_return="unverified")

    row = events.find_payment(db, adapter.name, ProviderPayment(
        status=payment_providers.PENDING, provider_status="",
        provider_order_id=order_id,
    ))
    if row is None:
        logger.warning("Payment return for an order we have no row for: provider=%s "
                       "order=%s", adapter.name, order_id)
        return _landing(payment_return="unknown")

    booking_ref, kind = _booking_for(db, row)

    try:
        result = events.verify_payment_row(db, row, adapter.name)
        db.commit()
    except Exception:                                   # noqa: BLE001
        # The customer must still get somewhere. The landing page reconciles
        # again, and the webhook and the sweep are still coming.
        db.rollback()
        logger.exception("Verification on return failed: provider=%s order=%s",
                         adapter.name, order_id)
        result = None

    logger.info(
        "Payment return: provider=%s order=%s booking=%s outcome=%s",
        adapter.name, order_id, booking_ref,
        f"{result.disposition}/{result.code}" if result is not None else "error",
    )
    return _landing(payment_return=adapter.name, kind=kind or "", ref=booking_ref or "")
