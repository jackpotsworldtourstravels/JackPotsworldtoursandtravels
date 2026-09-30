"""What the admin desk sees on the Payment Reconciliation screen — Phase 4 of
the B2C Admin Portal build-out. An allow-list, the same discipline every
other admin/* schema in this package uses.

Reuses ``CustomerPaymentRow`` (the Customer Payments screen's own row shape)
as the base for the list, rather than a parallel definition of the same
fields — the two screens read the same three payment tables.
"""
from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel

from app.schemas.customer_payment_admin import CustomerPaymentRow


class ReconciliationRow(CustomerPaymentRow):
    #: "not_checked" until an admin clicks Verify for this row (see
    #: VerifyResult below) — this is never computed by guessing from our own
    #: stored status, only by actually asking the gateway.
    reconciliation_status: str = "not_checked"


class ReconciliationList(BaseModel):
    items: list[ReconciliationRow]
    total: int
    page: int
    page_size: int
    total_pages: int


class VerifyResult(BaseModel):
    """The outcome of asking the gateway, live, what it says about one
    payment — see customer_reconciliation_service.verify_payment()."""

    payment_id: int
    product: str
    booking_ref: str
    expected_amount: Decimal
    gateway_amount: Decimal | None
    currency: str
    our_status: str
    gateway_status: str | None
    #: matched | mismatch | gateway_unavailable | not_configured | no_reference
    reconciliation_status: str
    detail: str | None = None
