"""hotel booking — a hotel enquiry converges onto service_requests once quoted

Revision ID: 0048_hotel_booking
Revises: 0047_hotel_enquiry_tables
Create Date: 2026-08-14

WHAT THIS IS FOR
Hotel Enquiry (0047) stops at quotation on purpose — "no booking table, no
conversion step" was the deliberate boundary at the time. This migration
lifts that boundary: once a hotel enquiry is quoted and the merchant clicks
Raise Booking, the booking itself becomes a `service_requests` row
(`request_type='booking'`, `travel_type='hotel'`) — NOT a new standalone
`hotel_bookings` table. That is the whole point of this design: Manager
Approval, Admin ticket/voucher issuance, wallet billing, invoice/confirmation
PDF generation, Booking History and Reports are all already generic over
`service_requests`/`travel_type` (verified by reading every one of them
before writing this migration) — converging onto that table gets a hotel
booking all of that machinery for free, instead of a second, parallel
implementation of all six systems that would then need to be kept in step
with the first forever.

`hotel_enquiries`, `hotel_enquiry_rooms` and `hotel_room_children` are
UNTOUCHED by this migration except for one new nullable column — the enquiry
stage's own tables and lifecycle are not being replaced, only extended with a
pointer to what it became.

WHY GUESTS GET A NEW TABLE (`hotel_booking_guests`) INSTEAD OF REUSING
`passenger_data`
`passenger_data` is genuinely generic ("a traveller on a request," FK'd to
any `service_requests` row) but its non-generic columns are flight-shaped:
`seat_preference` (window/aisle/exit row), the four passport columns, and
`meal_preference` as an airline-catering concept (veg/non-veg/jain/kosher...).
None of that describes a hotel guest, and stretching its free-text
`special_services` JSONB array to carry structural data like which room a
guest is in would be exactly the kind of "unstructured where it should be
structured" shape the hotel enquiry tables themselves were built to avoid.
A dedicated table costs nothing extra here and zero risk to `passenger_data`
or anything that reads it.

WHY hotel_enquiries.booking_request_id RATHER THAN A NEW `hotel_bookings`
JOIN TABLE
The relationship is one enquiry -> at most one booking. A single nullable FK
column says that directly; a join table would only be right if an enquiry
could produce several bookings, which the application layer explicitly
refuses (`hotel_booking_service.to_booking_request` 409s a second attempt).
The partial unique index below is the database's own copy of that same rule.

WHY THE NEW RequestType VALUES ARE ADDED NOW, NOT WHEN THEY'RE WIRED UP
The 7 informational hotel service-request types (room upgrade/downgrade,
early check-in, late check-out, extra bed, airport transfer, guest name
correction) aren't wired into any endpoint by this change — that's later,
scoped, follow-on work. They're added here anyway because `ALTER TYPE ... ADD
VALUE` cannot run in the same transaction that later uses the value (see
migration 0033's note on 'manager', and 0038's on 'reschedule_fee'), so
growing the enum ahead of the code that uses it is the established pattern
in this codebase, not a shortcut specific to this migration. Cancellation,
Refund and Date Change need no new values — a hotel service request of those
three kinds reuses the existing `cancellation`/`refund`/`date_change`
members verbatim, the same way it already means "change my travel date"
generically enough to mean "change my check-in/check-out" for a hotel row.

WHY DocumentType GAINS NO NEW VALUE
A hotel voucher upload reuses `DocumentType.TICKET` — deliberately. See
`hotel_booking_service.py` and the frontend Admin Ops changes in this same
change for the reasoning: the uploaded file IS the voucher, the distinction
is a label the desk sees, not a data model concern, and adding a new value
would mean touching `document_service.STAFF_LATE_TYPES` and every frontend
`doc_type === 'ticket'` filter for a distinction that never needs to be
queried on.

BACKWARD COMPATIBILITY
Purely additive: one new table, one new nullable column with a partial
unique index, and enum-value growth on a type Postgres can only grow, never
shrink. No existing column, constraint, index or row is touched.
`downgrade()` reverses the two structural additions; the enum values are left
in place (the standing rule for every enum-growth migration here — see 0033).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0048_hotel_booking"
down_revision: Union[str, None] = "0047_hotel_enquiry_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Bind to the EXISTING passenger_type_enum (adult/child/infant) — not a new
# type. A hotel guest is either kind exactly the way a flight passenger is;
# minting a second enum with the same two words would only forge a
# translation nobody needs. `create_type=False` is load-bearing: without it
# SQLAlchemy emits its own `CREATE TYPE` on table creation and collides with
# the type migration 0023 already created (same pattern as 0047's
# `_REQUEST_STATUS`).
_PASSENGER_TYPE = postgresql.ENUM(
    "adult", "child", "infant",
    name="passenger_type_enum",
    create_type=False,
)

_NEW_REQUEST_TYPES = (
    "room_upgrade",
    "room_downgrade",
    "early_check_in",
    "late_check_out",
    "extra_bed",
    "airport_transfer",
    "guest_name_correction",
)


def upgrade() -> None:
    op.create_table(
        "hotel_booking_guests",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column(
            "booking_request_id", sa.BigInteger,
            sa.ForeignKey("service_requests.request_id", ondelete="CASCADE"), nullable=False,
        ),
        # Which room (within the booking) this guest belongs to — mirrors
        # hotel_enquiry_rooms.room_number, the enquiry-side equivalent.
        sa.Column("room_number", sa.Integer, nullable=False),
        sa.Column("is_lead_guest", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("title", sa.String(10), nullable=True),
        sa.Column("first_name", sa.String(100), nullable=False),
        sa.Column("last_name", sa.String(100), nullable=False),
        sa.Column("guest_type", _PASSENGER_TYPE, nullable=False, server_default=sa.text("'adult'")),
        # Child guests only — mirrors hotel_room_children.child_age.
        sa.Column("age", sa.SmallInteger, nullable=True),
        sa.Column("id_proof_type", sa.String(40), nullable=True),
        sa.Column("id_proof_number", sa.String(60), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_check_constraint(
        "ck_hotel_guest_age_range", "hotel_booking_guests", "age IS NULL OR age BETWEEN 0 AND 17"
    )
    op.create_check_constraint(
        "ck_hotel_guest_room_number_positive", "hotel_booking_guests", "room_number > 0"
    )
    op.create_index("ix_hotel_booking_guests_request", "hotel_booking_guests", ["booking_request_id"])
    # Deliberately NOT a "exactly one lead guest per booking" constraint — a
    # partial unique index on (booking_request_id) WHERE is_lead_guest would
    # do it, but this is an app-enforced invariant (the guest-capture screen
    # only ever offers one lead-guest choice), same posture as several other
    # soft invariants already in this schema (e.g. star_category being a
    # CHECK set rather than a lookup table).

    op.add_column(
        "hotel_enquiries",
        sa.Column(
            "booking_request_id", sa.BigInteger,
            sa.ForeignKey("service_requests.request_id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.create_index(
        "ix_hotel_enquiries_booking_request", "hotel_enquiries", ["booking_request_id"]
    )
    # Two bookings can never claim the same enquiry — the database's own copy
    # of the 409 hotel_booking_service.to_booking_request already enforces in
    # application code (belt-and-braces, same relationship 0036's wallet
    # ledger constraints have to their service-layer checks).
    op.create_index(
        "uq_hotel_enquiries_booking_request_id", "hotel_enquiries", ["booking_request_id"],
        unique=True, postgresql_where=sa.text("booking_request_id IS NOT NULL"),
    )

    with op.get_context().autocommit_block():
        for value in _NEW_REQUEST_TYPES:
            op.execute(f"ALTER TYPE request_type_enum ADD VALUE IF NOT EXISTS '{value}'")


def downgrade() -> None:
    op.drop_index("uq_hotel_enquiries_booking_request_id", table_name="hotel_enquiries")
    op.drop_index("ix_hotel_enquiries_booking_request", table_name="hotel_enquiries")
    op.drop_column("hotel_enquiries", "booking_request_id")
    op.drop_index("ix_hotel_booking_guests_request", table_name="hotel_booking_guests")
    op.drop_table("hotel_booking_guests")
    # request_type_enum's new values are left in place — PostgreSQL cannot
    # drop a value from an enum type without rebuilding it and rewriting
    # every row that uses it. Same standing rule as migration 0033/0038.
