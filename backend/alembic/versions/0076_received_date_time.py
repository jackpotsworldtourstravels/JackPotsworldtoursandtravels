"""When the client's request was received — the Manual Enquiry form's new field.

The desk types enquiries in after the fact: a WhatsApp message at 3:45 PM keyed
in at 4:10. ``created_at`` records the second moment; this records the first.
Captured on the Admin portal's Manual Enquiry form (required there, never in the
future), copied onto the booking raised from that enquiry, and null on anything
a merchant raised through its own portal, which never asks for it.

A timestamp WITH time zone, like every other instant on this table, so a value
entered as 03:45 PM IST reads back as 03:45 PM IST. Nullable, and nothing is
backfilled: for a row saved before this column existed, when the client asked
was never recorded, and inventing it from ``created_at`` would state a guess as
a fact.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0076_received_date_time"
down_revision: Union[str, None] = "0075_customer_attractions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "service_requests",
        sa.Column("received_date_time", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("service_requests", "received_date_time")
