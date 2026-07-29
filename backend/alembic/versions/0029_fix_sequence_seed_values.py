"""correct the document-number sequence start values

Revision ID: 0029_fix_sequences
Revises: 0028_doc_sequences
Create Date: 2026-07-29

Migration 0028 introduced the sequences but seeded them wrongly:

* It stripped **every** non-digit from the document number, so
  ``REQ-2026-000001`` became ``2026000001`` and the sequence jumped to two
  billion — the next allocation came out as ``REQ-2026-2026000006``.
* It only reset ``seq_request_number``. The other three still started at 1
  and collided with numbers already issued by the previous counting logic.

The number format is ``PREFIX-YYYY-NNNNNN``, so the counter is the digits
after the **last** hyphen — not every digit in the string. Older rows written
before 0028 used ``TKT2026-000001`` (no hyphen after the prefix), and the
same "digits after the last hyphen" rule reads those correctly too.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0029_fix_sequences"
down_revision: Union[str, None] = "0028_doc_sequences"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: sequence -> (column, LIKE pattern identifying that document type)
TARGETS = (
    ("seq_request_number", "request_number", "REQ-%"),
    ("seq_service_request_number", "request_number", "SRQ-%"),
    ("seq_ticket_number", "ticket_number", "%"),
    ("seq_invoice_number", "invoice_number", "%"),
)


def upgrade() -> None:
    for sequence, column, pattern in TARGETS:
        op.execute(
            f"""
            SELECT setval(
                '{sequence}',
                GREATEST(
                    COALESCE((
                        SELECT MAX(
                            NULLIF(regexp_replace({column}, '^.*-', ''), '')::bigint
                        )
                        FROM service_requests
                        WHERE {column} IS NOT NULL
                          AND {column} LIKE '{pattern}'
                          AND {column} ~ '-[0-9]+$'
                    ), 0),
                    1
                ),
                true
            )
            """
        )


def downgrade() -> None:
    # Nothing to undo — sequence positions are not meaningful history.
    pass
