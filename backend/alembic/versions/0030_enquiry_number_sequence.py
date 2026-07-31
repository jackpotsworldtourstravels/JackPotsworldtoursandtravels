"""add the sequence backing ticket enquiry reference numbers

Revision ID: 0030_enquiry_sequence
Revises: 0029_fix_sequences
Create Date: 2026-07-30

Ticket Enquiry is the merchant's new entry point: instead of searching live
inventory, the merchant describes the sector they want and an Admin answers.

**No table is added or altered.** An enquiry is a ``service_requests`` row with
``request_type = 'ticket_enquiry'`` — a value the enum has carried since
migration 0023 — and its form fields live in ``travel_details`` JSONB, the same
way catalog items and service requests already store their type-specific
payload. The nine-table design is untouched.

The one thing that genuinely did not exist is the reference series. Enquiries
are numbered ``ENQ-20260730-000123``, which needs its own counter: sharing
``seq_service_request_number`` would leave permanent gaps in the SRQ series
every time somebody enquired. Sequences are not tables, so this follows
migration 0028's precedent exactly.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0030_enquiry_sequence"
down_revision: Union[str, None] = "0029_fix_sequences"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEQUENCE = "seq_enquiry_number"


def upgrade() -> None:
    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {SEQUENCE} START WITH 1 INCREMENT BY 1")

    # Start above anything already numbered ENQ-, so re-running against a
    # database that somehow carries enquiries cannot collide with
    # uq_service_requests_number. Same guard 0028 applies to seq_request_number.
    op.execute(
        """
        SELECT setval(
            'seq_enquiry_number',
            GREATEST(COALESCE((
                SELECT MAX(NULLIF(split_part(request_number, '-', 3), '')::bigint)
                FROM service_requests WHERE request_number LIKE 'ENQ-%'
            ), 0), 1)
        )
        """
    )


def downgrade() -> None:
    op.execute(f"DROP SEQUENCE IF EXISTS {SEQUENCE}")
