"""hotel enquiry client fare — captured once, at the point the stay is described

Revision ID: 0050_hotel_enquiry_client_fare
Revises: 0049_holidays_service_code
Create Date: 2026-08-16

WHAT THIS IS FOR
Client Fare (what a merchant charges its OWN customer) has always had a home
on the Flight side — collected once, on the Booking Enquiry / Book Directly
form, and carried forward automatically from there (see 0040's
``client_fare`` column and the "stated once" comment in
``enquiry_service.to_booking_request``). Hotel never had anywhere to put it
at the enquiry stage — only ``HotelEnquiryToBooking`` (the booking-request
step) accepted it, which put the same field on two different screens for
Hotel instead of one, an inconsistency with the Flight UX this migration
corrects. This column is the missing "one home" for Hotel's value, matching
Flight's shape exactly.

WHY NULLABLE, NO BACKFILL
Purely additive — every hotel enquiry raised before this column existed
simply has no client fare on file, same as a pre-CR-0040 flight enquiry.
Nothing reads this column as required.

BACKWARD COMPATIBILITY
One nullable column on an existing table. No existing column, constraint or
index touched. ``downgrade()`` drops it.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0050_hotel_enquiry_client_fare"
down_revision: Union[str, None] = "0049_holidays_service_code"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "hotel_enquiries",
        sa.Column("client_fare", sa.Numeric(14, 2), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hotel_enquiries", "client_fare")
