"""Per-room selections on a hotel booking.

WHY THIS TABLE EXISTS. ``customer_hotel_bookings`` records a stay as one
``room_id`` multiplied by ``rooms_count``: two rooms means two of the SAME
room type. That is fine when a party books two Deluxe Rooms, and wrong the
moment they want a Deluxe and a Premium — a normal thing to want, and what
the Room Selection screen is required to offer. The shape simply cannot hold
it: there is one room_id column.

So the selections move into a child table, one row per room actually booked,
in the order the traveller configured them. Room 1 and Room 2 are then
genuinely independent, and a booking can mix room types.

DELIBERATELY ADDITIVE — NOTHING IS DROPPED OR REWRITTEN.
``customer_hotel_bookings.room_id``/``room_name``/``meal_plan``/``rooms_count``
all stay exactly as they are and keep being written, holding the FIRST room and
the count. Three reasons:

* existing rows stay valid and readable with no backfill and no data loss;
* every existing reader — My Trips, the booking detail response, anything that
  says "your room" — keeps working untouched;
* a single-room booking, which is the overwhelming majority, is still fully
  described by the parent row alone.

The child rows are the authority when a booking mixes types; the parent
columns remain the summary. Price is snapshotted per room for the same reason
the parent snapshots ``room_name``: a property re-pricing next week must not
silently rewrite what somebody already booked.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0058_hotel_multi_room"
down_revision: Union[str, None] = "0057_merge_ocr_customer_heads"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer_hotel_booking_rooms",
        sa.Column("customer_hotel_booking_room_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "hotel_booking_id",
            sa.BigInteger(),
            sa.ForeignKey("customer_hotel_bookings.customer_hotel_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
        # 0-based, and which of the searched rooms this is. Ordering matters:
        # "Room 2" on the voucher must be the room the traveller configured
        # second, not whichever row the database happened to return first.
        sa.Column("room_index", sa.SmallInteger(), nullable=False),
        # RESTRICT, not CASCADE: retiring a room type must never delete a line
        # out of a booking somebody already holds.
        sa.Column(
            "room_id",
            sa.BigInteger(),
            sa.ForeignKey("customer_hotel_rooms.customer_hotel_room_id", ondelete="RESTRICT"),
            nullable=False,
        ),
        # Snapshots, for the same reason the parent row snapshots its own.
        sa.Column("room_name", sa.String(120), nullable=False),
        sa.Column("meal_plan", sa.String(60), nullable=True),
        sa.Column("price_per_night", sa.Numeric(12, 2), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("hotel_booking_id", "room_index", name="uq_hotel_booking_room_index"),
    )
    op.create_index(
        "ix_customer_hotel_booking_rooms_booking",
        "customer_hotel_booking_rooms",
        ["hotel_booking_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_customer_hotel_booking_rooms_booking", table_name="customer_hotel_booking_rooms")
    op.drop_table("customer_hotel_booking_rooms")
