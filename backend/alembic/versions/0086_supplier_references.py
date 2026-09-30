"""supplier references on flight bookings — for a real supplier (e.g. Duffel).

Purely additive, and every column is NULLABLE. A demo-provider booking — which
is every booking today — leaves them all NULL and is unaffected, so this is
safe to apply ahead of any supplier going live. When the flight supplier is a
real one, these carry ITS own identifiers and price:

  * ``supplier``                     which provider issued the order
  * ``supplier_offer_id``            the offer that was booked
  * ``supplier_order_id``            the order (unique) — the trace-back key
  * ``supplier_total_amount``        the supplier's price, stored VERBATIM
  * ``supplier_currency``            in the supplier's own currency, NOT converted
  * ``supplier_status``              the order's status at the supplier
  * ``supplier_order_type``          instant / hold
  * ``supplier_payment_required_by`` the hold deadline, when a hold

The airline PNR still lands in ``customer_bookings.pnr`` (unchanged). The
supplier's per-passenger id lands on ``customer_booking_passengers``.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0086_supplier_references"
down_revision: Union[str, None] = "0085_customer_activity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("customer_bookings", sa.Column("supplier", sa.String(length=20), nullable=True))
    op.add_column("customer_bookings", sa.Column("supplier_offer_id", sa.String(length=80), nullable=True))
    op.add_column("customer_bookings", sa.Column("supplier_order_id", sa.String(length=80), nullable=True))
    op.add_column("customer_bookings", sa.Column("supplier_total_amount", sa.Numeric(12, 2), nullable=True))
    op.add_column("customer_bookings", sa.Column("supplier_currency", sa.String(length=3), nullable=True))
    op.add_column("customer_bookings", sa.Column("supplier_status", sa.String(length=40), nullable=True))
    op.add_column("customer_bookings", sa.Column("supplier_order_type", sa.String(length=20), nullable=True))
    op.add_column(
        "customer_bookings",
        sa.Column("supplier_payment_required_by", sa.DateTime(timezone=True), nullable=True),
    )
    # An order id is unique when present; two bookings must never claim one
    # supplier order. A partial index lets the many NULLs coexist.
    op.create_index(
        "uq_customer_bookings_supplier_order_id",
        "customer_bookings",
        ["supplier_order_id"],
        unique=True,
        postgresql_where=sa.text("supplier_order_id IS NOT NULL"),
    )
    op.add_column(
        "customer_booking_passengers",
        sa.Column("supplier_passenger_id", sa.String(length=80), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("customer_booking_passengers", "supplier_passenger_id")
    op.drop_index("uq_customer_bookings_supplier_order_id", table_name="customer_bookings")
    for col in (
        "supplier_payment_required_by",
        "supplier_order_type",
        "supplier_status",
        "supplier_currency",
        "supplier_total_amount",
        "supplier_order_id",
        "supplier_offer_id",
        "supplier",
    ):
        op.drop_column("customer_bookings", col)
