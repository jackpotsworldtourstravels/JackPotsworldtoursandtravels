"""add the sequence backing hotel enquiry reference numbers

Revision ID: 0046_hotel_enquiry_sequence
Revises: 0045_merchant_service_access
Create Date: 2026-08-13

Hotel Enquiry reuses the exact shape 0030 built for Flight: a
``service_requests`` row with ``request_type = 'ticket_enquiry'``, this time
with ``travel_type = 'hotel'`` — a value the enum has carried, unused, since
migration 0023 — and hotel-shaped fields in ``travel_details`` JSONB. No table
is added or altered here either.

Hotel enquiries get their own reference series, ``HTL-20260813-000001``,
rather than sharing ``seq_enquiry_number``. Same reasoning 0030 gave for not
sharing ``seq_service_request_number``: a merged counter would leave gaps in
whichever series didn't get the next value, and the two products should be
countable independently (an Admin asking "how many hotel enquiries this
month" should not have to subtract flights out of one shared number).
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0046_hotel_enquiry_sequence"
down_revision: Union[str, None] = "0045_merchant_service_access"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEQUENCE = "seq_hotel_enquiry_number"


def upgrade() -> None:
    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {SEQUENCE} START WITH 1 INCREMENT BY 1")

    # Same collision guard 0030 applies to seq_enquiry_number: start above
    # anything already numbered HTL-, so a re-run cannot collide with
    # uq_service_requests_number.
    op.execute(
        """
        SELECT setval(
            'seq_hotel_enquiry_number',
            GREATEST(COALESCE((
                SELECT MAX(NULLIF(split_part(request_number, '-', 3), '')::bigint)
                FROM service_requests WHERE request_number LIKE 'HTL-%'
            ), 0), 1)
        )
        """
    )


def downgrade() -> None:
    op.execute(f"DROP SEQUENCE IF EXISTS {SEQUENCE}")
