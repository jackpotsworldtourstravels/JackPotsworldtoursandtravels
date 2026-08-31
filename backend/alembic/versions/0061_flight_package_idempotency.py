"""One booking per submission, for flights and packages too.

Migration 0060 closed this for hotels: a traveller who pressed Back from
Confirmation and pressed the button again, or double-clicked it, or whose
request was retried after a dropped connection, got a SECOND real booking —
two references, two amounts owed. Flights and packages create their bookings
through the same shape of code and had the same hole; only hotels were
protected, which is worse than neither being protected because it looks done.

Identical treatment, and deliberately so — one pattern to understand rather
than three:

* a nullable ``idempotency_key`` on each bookings table;
* a unique index on ``(customer_id, idempotency_key)``, partial so only rows
  that actually carry a key participate;
* scoped to the customer rather than the key alone, so one account's key can
  never collide with another's, and the lookup that returns the
  already-created booking can filter by owner.

Following 0037's rule that the database owns correctness: the client can be
taught not to ask twice, and now is, but a client guard races itself. Two
clicks 20ms apart both pass a Python check-then-act. The index does not.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0061_flight_package_idempotency"
down_revision: Union[str, None] = "0060_hotel_booking_idempotency"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("customer_bookings", "customer_package_bookings")


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(table, sa.Column("idempotency_key", sa.String(64), nullable=True))
        op.create_index(
            f"uq_{table}_idempotency",
            table,
            ["customer_id", "idempotency_key"],
            unique=True,
            postgresql_where=sa.text("idempotency_key IS NOT NULL"),
        )


def downgrade() -> None:
    for table in _TABLES:
        op.drop_index(f"uq_{table}_idempotency", table_name=table)
        op.drop_column(table, "idempotency_key")
