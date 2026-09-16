"""Where a service request came from.

Every row in ``service_requests`` was raised by a merchant through the Merchant
Portal, because that was the only way to raise one. The Admin portal's Manual
Booking screens change that: the desk can now file an enquiry or a booking FOR
a merchant that telephoned it in, and the two are not the same fact even though
they produce the same shaped row.

WHY IT MATTERS THAT THEY ARE DISTINGUISHABLE. The merchant sees its own
enquiries and cannot tell which it typed and which we typed for it; the desk's
reports count "enquiries raised" and would otherwise be counting its own
telephone calls as merchant demand. Neither is recoverable after the fact —
``user_id`` records the admin, but an admin user id could equally mean a row
touched by staff later — so it is recorded at creation or not at all.

THE VALUES FOLLOW THIS SCHEMA'S OWN CONVENTION, not the one the request was
written in: lowercase snake_case, like ``ticket_enquiry`` and ``one_way`` two
columns over, rather than SHOUTING_CASE. A native PostgreSQL enum, bound with
``create_type=False`` the way every other enum on this table is.

EXISTING ROWS ARE 'merchant_portal', AND THAT IS A FACT RATHER THAN A DEFAULT.
Manual Booking did not exist when they were written, so every one of them was
raised by a merchant through the portal. The server default keeps that true for
any code path that has not been taught about the column.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0073_service_request_source"
down_revision: Union[str, None] = "0072_hotel_destination_links"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ENUM_NAME = "request_source_enum"
VALUES = ("merchant_portal", "b2b_manual_enquiry", "b2b_manual_request")


def upgrade() -> None:
    sa.Enum(*VALUES, name=ENUM_NAME).create(op.get_bind(), checkfirst=True)
    op.add_column(
        "service_requests",
        sa.Column(
            "source",
            sa.Enum(*VALUES, name=ENUM_NAME, create_type=False),
            nullable=False,
            server_default="merchant_portal",
        ),
    )
    # The desk filters "everything we raised ourselves" on this, and reports
    # group by it. Both scan the whole table without it.
    op.create_index("ix_service_requests_source", "service_requests", ["source"])


def downgrade() -> None:
    op.drop_index("ix_service_requests_source", table_name="service_requests")
    op.drop_column("service_requests", "source")
    sa.Enum(name=ENUM_NAME).drop(op.get_bind(), checkfirst=True)
