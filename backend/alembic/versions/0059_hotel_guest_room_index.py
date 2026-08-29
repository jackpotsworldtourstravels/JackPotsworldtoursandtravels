"""Which room each hotel guest is staying in.

Migration 0058 let a booking hold several rooms, possibly of different types.
This finishes that job on the other side of the stay: it records WHICH of
those rooms each guest occupies.

Without it, a four-guest two-room booking arrives at the property as four
names and two rooms with nothing to say who is in which — the Guest Details
screen groups guests under "Room 1" and "Room 2", and that grouping was being
discarded the moment the booking was written. The property would have to guess,
which is exactly the kind of quiet data loss the room table was added to stop.

NULLABLE, AND ADDITIVE.
``room_index`` is nullable because every booking made before this migration
genuinely has no answer, and inventing one — "they were probably in room 0" —
would be a guess written into a record. A NULL means "not recorded", which is
true. New bookings from the Guest Details screen always set it.

It is a plain integer matching ``customer_hotel_booking_rooms.room_index``
rather than a foreign key to that table's primary key: the two are written in
the same transaction from the same in-memory list, and indexing by position
keeps a guest tied to "the second room on this booking" even if the room rows
were ever rewritten.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0059_hotel_guest_room_index"
down_revision: Union[str, None] = "0058_hotel_multi_room"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "customer_hotel_booking_guests",
        sa.Column("room_index", sa.SmallInteger(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("customer_hotel_booking_guests", "room_index")
