"""A customer can be told their booking is confirmed.

THE REVISION ID IS SHORT ON PURPOSE. ``alembic_version.version_num`` is
VARCHAR(32) in this database, and the first draft of this file was called
``0063_booking_confirmed_notification`` — 34 characters. Alembic applied the
DDL and then failed writing the version row, which rolls the whole migration
back and leaves a confusing "it ran but it did not" state. Keep revision ids
under 32 characters; the longest existing one is 30.

``customer_notification_type_enum`` had four members — booking_created,
booking_cancelled, booking_payment, general — because until now nothing ever
confirmed a B2C booking. Phase 7 does, and a confirmation is its own event: it
is not the creation of a booking, and it is not a payment attempt.

WHY NOT REUSE ``general``
Because the customer's notification list groups and filters by this column, and
the one notification a traveller most wants to find again — "my trip is paid
for and confirmed" — would be indistinguishable from anything else the platform
ever says. A type that means "something happened" is not a type.

WHY NOT ``booking_payment``
That one already exists and means "a payment attempt was recorded", which is
written when the customer chooses a method and nothing has been charged. Using
it for a confirmed, paid booking would make the same label mean two opposite
things on the same screen.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0063_booking_confirmed_notif"
down_revision: Union[str, None] = "0062_customer_payment_provider"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Autocommit block, matching 0033/0038/0062: ``ALTER TYPE ... ADD VALUE`` is
    # transactional on PostgreSQL 12+, but the new label cannot be USED by the
    # transaction that adds it. Nothing here writes one.
    with op.get_context().autocommit_block():
        op.execute(
            "ALTER TYPE customer_notification_type_enum "
            "ADD VALUE IF NOT EXISTS 'booking_confirmed'"
        )


def downgrade() -> None:
    # PostgreSQL cannot drop an enum value. Removing it would mean recreating
    # the type and rewriting every notification row, and failing anyway if any
    # customer has been sent one. An unused label is harmless; rewriting live
    # notification history to remove it is not. Same reasoning as 0062.
    pass
