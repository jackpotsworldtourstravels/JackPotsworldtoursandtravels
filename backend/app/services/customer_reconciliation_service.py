"""B2C payment reconciliation — Phase 4 of the B2C Admin Portal build-out.
Completes the plan's own diagram: Customer -> Booking -> Payment ->
Cancellation -> Refund needed one more link, verifying that the money the
gateway says moved is the money we recorded.

NO NEW TABLE, NO NEW PAYMENT SYSTEM. This module reads the same three
``customer_*_booking_payments`` tables Customer Payments already reads — it
calls straight into ``customer_payment_admin_service.list_payments`` /
``get_payment`` for the row data rather than a second query shape — and its
one live action calls the SAME provider adapters (Razorpay/HDFC/TrustBrick)
every other payment path already uses, through the same
``get_provider_named()`` factory. Nothing here creates a payment, a refund,
or a row; it only asks a question and reports the answer.

WHY VERIFICATION IS ON DEMAND, NOT PRECOMPUTED FOR THE WHOLE LIST. Comparing
against the gateway means calling it — Razorpay's or HDFC's own API, over the
network, per payment. Doing that for every row on every page load would be
slow, would hit rate limits on a real account, and would be reconciling
against a number that is already stale by the time an admin reads it. Every
row starts "not_checked"; the desk verifies the ones it actually needs an
answer for, right now, and gets a live one.

``fetch_payment()`` is literally documented as "the reconciliation path" on
the provider Protocol itself (see payments/base.py) — this module is that
path's first caller from the admin side.
"""
from __future__ import annotations

import math
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.services import customer_payment_admin_service as payments_admin
from app.services.payments import get_provider_named
from app.services.payments.base import PaymentProviderError, PaymentNotConfigured, from_minor


def list_for_reconciliation(
    db: Session, *, page: int = 1, page_size: int = 25, product: str | None = None,
    status: str | None = None, provider: str | None = None, search: str | None = None,
) -> dict[str, Any]:
    """The same rows Customer Payments lists, with `reconciliation_status`
    added at "not_checked" — see the module docstring for why that is never
    precomputed here."""
    data = payments_admin.list_payments(
        db, page=page, page_size=page_size, product=product,
        status=status, provider=provider, search=search,
    )
    for row in data["items"]:
        row["reconciliation_status"] = "not_checked"
    # list_payments()'s own return shape (CustomerPaymentList) carries no
    # total_pages — Customer Payments' own list screen paginates without one.
    # This screen's table does need it, so it's computed here rather than by
    # changing that shape for the screen that already works with it as-is.
    data["total_pages"] = max(1, math.ceil(data["total"] / data["page_size"])) if data["page_size"] else 1
    return data


def verify_payment(db: Session, product: str, payment_id: int) -> dict[str, Any] | None:
    """Ask the payment's own gateway, right now, what it says the amount and
    status are, and compare against what we recorded. Returns ``None`` if no
    such payment exists — the router turns that into a 404."""
    row = payments_admin.get_payment(db, product, payment_id)
    if row is None:
        return None

    expected_amount = Decimal(str(row["amount"]))
    base = {
        "payment_id": payment_id,
        "product": product,
        "booking_ref": row["booking_ref"],
        "expected_amount": expected_amount,
        "currency": row["currency"],
        "our_status": row["status"],
    }

    if not row.get("provider") or not row.get("provider_payment_id"):
        return {
            **base, "gateway_amount": None, "gateway_status": None,
            "reconciliation_status": "no_reference",
            "detail": "This payment has no provider payment id to check against — "
                      "it never reached the gateway (or the gateway never confirmed it).",
        }

    try:
        provider = get_provider_named(row["provider"])
        live = provider.fetch_payment(row["provider_payment_id"])
    except PaymentNotConfigured as exc:
        return {
            **base, "gateway_amount": None, "gateway_status": None,
            "reconciliation_status": "not_configured",
            "detail": str(exc),
        }
    except PaymentProviderError as exc:
        return {
            **base, "gateway_amount": None, "gateway_status": None,
            "reconciliation_status": "gateway_unavailable",
            "detail": f"Could not reach {row['provider']}: {exc}",
        }

    gateway_amount = (
        from_minor(live.amount_minor, live.currency or row["currency"])
        if live.amount_minor is not None else None
    )
    matched = gateway_amount is not None and gateway_amount == expected_amount
    return {
        **base,
        "gateway_amount": gateway_amount,
        "gateway_status": live.provider_status,
        "reconciliation_status": "matched" if matched else "mismatch",
        "detail": None,
    }
