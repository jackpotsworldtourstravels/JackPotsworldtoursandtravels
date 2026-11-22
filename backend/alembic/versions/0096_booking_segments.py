"""customer_bookings — grow a one-flight booking into a 1..N-segment journey.

See docs/MULTI_SEGMENT_BOOKING.md. This is the schema half of Bugs 2 (multi-city)
and 5 (round-trip): the booking becomes an ENVELOPE that owns one or more
segments, and one flight is simply the N=1 case.

PURELY ADDITIVE AND BACKWARD COMPATIBLE:

* one new column on ``customer_bookings`` — ``journey_type`` — defaulted to
  ``one_way`` so every existing row is already a valid one-way booking;
* one new table — ``customer_booking_segments`` — one row per flight, carrying
  the per-leg itinerary and the per-leg fare breakdown whose sum is the
  envelope's ``total_amount``;
* a backfill that gives every existing booking exactly one segment (index 0)
  copying its own flight + fare fields, so one-way history reads through the
  same segment path as a multi-segment journey. The envelope columns are never
  rewritten.

The downgrade drops the table and the column. One-way bookings are fully intact
afterwards (their single segment only mirrored the envelope); a booking with
more than one segment keeps its first-segment summary in the envelope columns
and loses the extra legs, which the single-flight model cannot represent — the
one lossy case, noted in the design doc.
"""
import logging
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0096_booking_segments"
down_revision: Union[str, None] = "0095_customer_admin_audit_logs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JOURNEY_TYPES = ("one_way", "round_trip", "multi_city")
SEGMENT_STATUSES = ("pending", "confirmed", "cancelled", "completed")


def upgrade() -> None:
    # --- the envelope gains a journey type -------------------------------- #
    op.add_column(
        "customer_bookings",
        sa.Column(
            "journey_type", sa.String(length=16), nullable=False,
            server_default="one_way",
        ),
    )
    op.create_check_constraint(
        "ck_customer_bookings_journey_type",
        "customer_bookings",
        "journey_type IN (" + ", ".join(f"'{t}'" for t in JOURNEY_TYPES) + ")",
    )

    # --- one row per flight ------------------------------------------------ #
    op.create_table(
        "customer_booking_segments",
        sa.Column("customer_booking_segment_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "customer_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_bookings.customer_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("segment_index", sa.Integer(), nullable=False),
        # itinerary
        sa.Column("airline", sa.String(length=100), nullable=True),
        sa.Column("flight_number", sa.String(length=20), nullable=True),
        sa.Column("origin_code", sa.String(length=10), nullable=True),
        sa.Column("origin_city", sa.String(length=100), nullable=True),
        sa.Column("destination_code", sa.String(length=10), nullable=True),
        sa.Column("destination_city", sa.String(length=100), nullable=True),
        sa.Column("travel_date", sa.Date(), nullable=True),
        sa.Column("departure_time", sa.String(length=10), nullable=True),
        sa.Column("arrival_time", sa.String(length=10), nullable=True),
        sa.Column("duration_label", sa.String(length=40), nullable=True),
        sa.Column("stops", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cabin_class", sa.String(length=40), nullable=True),
        sa.Column("is_international", sa.Boolean(), nullable=False, server_default=sa.false()),
        # per-leg fare breakdown — the sum is the envelope's total_amount
        sa.Column("base_fare", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("taxes", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("seat_charges", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("baggage_total", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("meal_total", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("service_total", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("discount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("total_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        # per-leg ticketing / extras
        sa.Column("pnr", sa.String(length=10), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("seats_json", JSONB(), nullable=True),
        sa.Column("addons_json", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("customer_booking_id", "segment_index", name="uq_customer_booking_segment_index"),
        sa.CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in SEGMENT_STATUSES) + ")",
            name="ck_customer_booking_segment_status",
        ),
    )
    op.create_index(
        "ix_customer_booking_segments_booking",
        "customer_booking_segments", ["customer_booking_id"],
    )

    # --- backfill: one segment per existing booking ----------------------- #
    # Copy the envelope's own flight + fare fields into a single index-0 segment
    # so one-way history reads through the segment path too. ::jsonb '[]' for the
    # extras; the legacy seat/add-on detail still lives in its own tables and the
    # money is already in the fare columns copied here.
    op.execute(
        """
        INSERT INTO customer_booking_segments (
            customer_booking_id, segment_index,
            airline, flight_number, origin_code, origin_city,
            destination_code, destination_city, travel_date,
            departure_time, arrival_time, duration_label, stops,
            cabin_class, is_international,
            base_fare, taxes, seat_charges, baggage_total, meal_total,
            service_total, discount, total_amount,
            pnr, status, seats_json, addons_json, created_at
        )
        SELECT
            customer_booking_id, 0,
            airline, flight_number, origin_code, origin_city,
            destination_code, destination_city, travel_date,
            departure_time, arrival_time, duration_label, stops,
            cabin_class, is_international,
            base_fare, taxes, seat_charges, baggage_total, meal_total,
            service_total, discount, total_amount,
            pnr, status::text, '[]'::jsonb, '[]'::jsonb, created_at
        FROM customer_bookings
        """
    )


def downgrade() -> None:
    # Downgrade safeguard (the one lossy step -- see the module docstring and
    # docs/MULTI_SEGMENT_BOOKING.md#downgrade). One-way bookings are fully
    # preserved by their envelope columns; a booking with MORE THAN ONE segment
    # keeps only its first-segment summary and loses the extra legs, which the
    # single-flight model cannot hold. Count and surface how many bookings that
    # affects BEFORE dropping anything, so an operator sees the data loss rather
    # than discovering it afterwards. (Non-destructive: it only reads and logs.)
    bind = op.get_bind()
    lossy = bind.execute(sa.text(
        "SELECT count(*) FROM customer_bookings WHERE journey_type <> 'one_way'"
    )).scalar() or 0
    if lossy:
        logging.getLogger("alembic.runtime.migration").warning(
            "0096 downgrade: %s multi-segment booking(s) will lose their "
            "non-first legs; only the first-segment summary on customer_bookings "
            "is retained. See docs/MULTI_SEGMENT_BOOKING.md#downgrade.", lossy,
        )

    op.drop_index("ix_customer_booking_segments_booking", table_name="customer_booking_segments")
    op.drop_table("customer_booking_segments")
    op.drop_constraint("ck_customer_bookings_journey_type", "customer_bookings", type_="check")
    op.drop_column("customer_bookings", "journey_type")
