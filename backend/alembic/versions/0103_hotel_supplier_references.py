"""supplier references on hotel bookings — for a live hotel supplier (TBO).

The hotel analogue of migration 0086 (which gave flight bookings their
``supplier_*`` columns). Hotels were never supplier-driven — they run off the
``customer_hotel_*`` DATABASE catalogue — so ``customer_hotel_bookings`` had no
supplier linkage, no external confirmation number and no voucher state. Making
TBO a live hotel supplier needs them.

Purely additive, and every column is NULLABLE. A catalogue booking — which is
every hotel booking today — leaves them all NULL and is unaffected, so this is
safe to apply ahead of any hotel supplier going live. When the hotel supplier is
TBO these carry ITS own identifiers, price and voucher state:

  * ``supplier``                 which supplier owns the row ("tbo")
  * ``supplier_booking_id``      TBO Book.BookingId — the primary handle
  * ``supplier_confirmation_no`` TBO Book.ConfirmationNo — voucher/confirmation ref
  * ``supplier_booking_code``    TBO Search/PreBook.BookingCode — the bookable unit
  * ``supplier_status``          Book.Status / HotelBookingStatus
  * ``voucher_status``           TBO VoucherStatus — hold vs vouchered
  * ``supplier_net_amount``      PreBook/Book NetAmount, stored VERBATIM
  * ``supplier_currency``        the supplier's own currency, NOT converted
  * ``last_cancellation_date``   deadline to voucher a hold / free-cancel
  * ``change_request_id``        SendChangeRequest.ChangeRequestId — cancel tracking
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0103_hotel_supplier_references"
down_revision: Union[str, None] = "0102_service_registry"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("customer_hotel_bookings", sa.Column("supplier", sa.String(length=20), nullable=True))
    op.add_column("customer_hotel_bookings", sa.Column("supplier_booking_id", sa.String(length=40), nullable=True))
    op.add_column("customer_hotel_bookings", sa.Column("supplier_confirmation_no", sa.String(length=80), nullable=True))
    op.add_column("customer_hotel_bookings", sa.Column("supplier_booking_code", sa.String(length=160), nullable=True))
    op.add_column("customer_hotel_bookings", sa.Column("supplier_status", sa.String(length=40), nullable=True))
    op.add_column("customer_hotel_bookings", sa.Column("voucher_status", sa.String(length=20), nullable=True))
    op.add_column("customer_hotel_bookings", sa.Column("supplier_net_amount", sa.Numeric(12, 2), nullable=True))
    op.add_column("customer_hotel_bookings", sa.Column("supplier_currency", sa.String(length=3), nullable=True))
    op.add_column(
        "customer_hotel_bookings",
        sa.Column("last_cancellation_date", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("customer_hotel_bookings", sa.Column("change_request_id", sa.String(length=40), nullable=True))
    # A supplier booking id is unique when present; two rows must never claim one
    # TBO booking. A partial index lets the many NULLs (catalogue bookings) coexist.
    op.create_index(
        "uq_customer_hotel_bookings_supplier_booking_id",
        "customer_hotel_bookings",
        ["supplier_booking_id"],
        unique=True,
        postgresql_where=sa.text("supplier_booking_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_customer_hotel_bookings_supplier_booking_id",
        table_name="customer_hotel_bookings",
    )
    for col in (
        "change_request_id",
        "last_cancellation_date",
        "supplier_currency",
        "supplier_net_amount",
        "voucher_status",
        "supplier_status",
        "supplier_booking_code",
        "supplier_confirmation_no",
        "supplier_booking_id",
        "supplier",
    ):
        op.drop_column("customer_hotel_bookings", col)
