"""Where a payment provider tells us what happened — ``/api/webhooks/payments/*``.

THE ONLY UNAUTHENTICATED WRITE SURFACE IN THIS APPLICATION

Every other write here is behind a session. This one cannot be: the caller is
Razorpay's server, which has no account and no token. What stands in for a
session is the signature over the raw bytes, and that is why the order of
operations below is fixed and not a matter of taste:

    read the bytes  ->  verify the signature  ->  ONLY THEN parse

Parsing first would mean acting on an unverified body, and a body that has not
been verified is just a string somebody posted at us.

DELIBERATELY SEPARATE FROM THE B2B SIDE

``payments``, ``service_requests`` and the merchant wallet are not reachable
from this module and are not imported by it. A merchant tops up by bank
transfer and an admin verifies it by hand; nothing about that flow involves a
webhook, and this endpoint must never become a way to touch it.

WHAT THIS ENDPOINT DOES NOT DO (PHASE 5)
It does not capture a payment and it does not confirm a booking. A
``payment.captured`` delivery is verified, recorded and marked ``deferred``,
because deciding that money arrived needs the amount, currency and ownership
checked against our own rows — Phase 6. A signature proves who sent a message,
not that the message is about the right booking for the right amount.

ANSWERING 2xx IS USUALLY THE CORRECT ANSWER, EVEN FOR NOTHING
Razorpay retries any non-2xx with exponential backoff for 24 hours, and allows
5 seconds for a response. So an event about a payment we do not have, an event
type we do not subscribe to, and a duplicate are all 200 with a short body: they
would fail identically on every retry, and retrying them costs both sides. Only
a bad signature and a malformed request are refused, because those must not be
recorded as ordinary traffic.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.orm import Session

from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.services import payment_event_service as events
from app.services import payments as payment_providers

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/webhooks", tags=["payment-webhooks"])

#: A provider event body is small. Anything larger is not one, and reading it
#: into memory to find that out is what a naive endpoint does. Razorpay's
#: payloads are a few kilobytes; this is generous by two orders of magnitude.
MAX_BODY_BYTES = 256 * 1024


@router.post(
    "/payments/{provider}",
    status_code=status.HTTP_200_OK,
    summary="Payment provider webhook",
    description=(
        "**Called by the payment provider, never by a browser.** No session; "
        "the signature over the raw request body is the authentication.\n\n"
        "The signature is verified *before* the body is parsed. "
        "`X-Razorpay-Event-Id` is required and stored: Razorpay delivers at "
        "least once, and an event with no stable id cannot be de-duplicated.\n\n"
        "Duplicate deliveries are answered `200` and change nothing — the "
        "unique index on `(provider, provider_event_id)` decides, not a "
        "check-then-act in Python.\n\n"
        "**This endpoint does not capture payments or confirm bookings.** A "
        "`payment.captured` event is recorded as `deferred` pending the "
        "server-side amount, currency and ownership verification."
    ),
    responses={
        200: {"description": "Recorded. Includes duplicates and ignored events."},
        400: {"description": "Unparseable, oversized, or no such provider."},
        401: {"description": "Missing or invalid signature. Nothing is recorded."},
    },
)
@limiter.limit("120/minute")
async def receive_payment_webhook(
    request: Request,
    provider: str,
    db: Session = Depends(get_db),
):
    # ---- 1. the raw bytes, before anything looks inside them --------------
    raw = await request.body()
    if not raw:
        return Response(
            content='{"status":"ignored","detail":"empty body"}',
            media_type="application/json",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if len(raw) > MAX_BODY_BYTES:
        logger.warning(
            "Oversized webhook refused: provider=%s bytes=%d", provider, len(raw),
        )
        return Response(
            content='{"status":"ignored","detail":"body too large"}',
            media_type="application/json",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # ---- 2. which adapter, and is it the one addressed? -------------------
    try:
        adapter = payment_providers.get_provider_named(provider)
    except payment_providers.PaymentProviderError:
        # Says nothing about what IS configured. An unauthenticated endpoint
        # that enumerates a deployment's providers is a small gift to somebody
        # mapping it.
        logger.warning("Webhook for unconfigured provider %r refused.", provider)
        return Response(
            content='{"status":"ignored","detail":"unknown provider"}',
            media_type="application/json",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # ---- 3. the signature, over the bytes, before any parsing -------------
    # NOTE the headers passed through untouched. The adapter picks the ones it
    # needs; this layer does not know or care which they are, which is what
    # lets a different provider use a different header without touching this
    # file. Authorization headers and cookies are never read, logged, or
    # forwarded anywhere.
    try:
        event = adapter.verify_webhook(raw, dict(request.headers))
    except payment_providers.WebhookVerificationError as exc:
        # 401, and NOTHING is written. An unverified delivery is not evidence
        # of anything, so recording it would fill the event log with whatever
        # anyone chose to post. The reason is logged for an operator; the
        # response says only that verification failed, so this cannot be used
        # as an oracle for which half of the check failed.
        logger.warning(
            "Webhook signature rejected: provider=%s reason=%s", provider, exc,
        )
        return Response(
            content='{"status":"rejected"}',
            media_type="application/json",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    except Exception:                                   # noqa: BLE001
        # A correctly signed body that the adapter still could not read. Logged
        # without the body, which may be anything at all.
        logger.exception("Webhook could not be parsed: provider=%s", provider)
        return Response(
            content='{"status":"ignored","detail":"unreadable payload"}',
            media_type="application/json",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # ---- 4. record once, then act ----------------------------------------
    outcome, note = events.handle(db, adapter.name, event)

    # Always 200 from here. Every outcome below is a final answer that would be
    # identical on a retry, and Razorpay's 5-second budget is best spent on the
    # work above rather than on a redelivery that changes nothing.
    return {"status": outcome, "event_id": event.event_id, "detail": note}
