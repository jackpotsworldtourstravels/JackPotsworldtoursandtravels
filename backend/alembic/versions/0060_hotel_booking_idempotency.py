"""One hotel booking per submission, enforced by the database.

THE BUG THIS CLOSES. A traveller who reached Confirmation, pressed Back and
pressed the primary action again got a SECOND real booking for the same stay —
two references, two rooms held, two amounts owed. A double-click did the same
thing. The client can be taught not to ask twice, and it now is, but a client
guard is a race with itself: two clicks 20ms apart both pass a Python
check-then-act, and a retried request after a dropped connection passes it too.

So the rule lives where rules belong. Following 0037's own words —
"The database owns correctness. A uniqueness rule that must hold is a
constraint or a unique index, never a check-then-act in Python" — this adds an
idempotency key and a unique index over it.

WHY THE INDEX IS ON (customer_id, idempotency_key) AND NOT THE KEY ALONE.
Scoping to the customer means one person's key can never collide with another
person's, and the lookup that returns the already-created booking can filter by
owner. A unique index on the bare key would let a guessed or replayed key from
one account collide with another's insert, which turns an idempotency feature
into a way to probe for other people's bookings.

NULLABLE, so every caller that predates this — and every booking already in the
table — stays valid. Postgres treats NULLs as distinct in a unique index, so
any number of rows may carry no key at all; only real keys are constrained.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0060_hotel_booking_idempotency"
down_revision: Union[str, None] = "0059_hotel_guest_room_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "customer_hotel_bookings",
        sa.Column("idempotency_key", sa.String(64), nullable=True),
    )
    # Partial: only rows that actually carry a key participate. Equivalent to
    # relying on NULL-distinctness, but says the intent out loud and keeps the
    # index small.
    op.create_index(
        "uq_customer_hotel_bookings_idempotency",
        "customer_hotel_bookings",
        ["customer_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_customer_hotel_bookings_idempotency",
        table_name="customer_hotel_bookings",
    )
    op.drop_column("customer_hotel_bookings", "idempotency_key")
