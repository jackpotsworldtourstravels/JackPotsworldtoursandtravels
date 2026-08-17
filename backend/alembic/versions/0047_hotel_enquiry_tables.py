"""hotel enquiry — genuinely separate tables, not a service_requests row

Revision ID: 0047_hotel_enquiry_tables
Revises: 0046_hotel_enquiry_sequence
Create Date: 2026-08-13

WHY THIS REPLACES THE service_requests DESIGN
Hotel enquiries were first built as `service_requests` rows with
`travel_type='hotel'` (see 0045/0046), matching how Flight enquiries already
work and the codebase's own documented "everything is a row in one table"
intent. That is architecturally consistent, but it is not what the product
spec asked for: separate, queryable, hotel-specific tables — normalized rooms
and children, not a JSONB array a report can't easily join against. This
migration builds that instead. The single test row created under the old
design (`service_requests.request_number LIKE 'HTL-%'`) is left in place —
it's dev data, not something worth a data migration for.

THREE TABLES, MATCHING THE SHAPE OF THE DATA
`hotel_enquiries` is one row per enquiry. `hotel_enquiry_rooms` is one row per
room (a merchant can ask about several), and `hotel_room_children` is one row
per child *within* a room (ages, not just a count) — three tables because a
child's age genuinely belongs to a room, not to the enquiry as a whole, and
flattening it into a JSON column is exactly the "unstructured" shape the spec
asked NOT to use here.

WHY status REUSES request_status_enum RATHER THAN A NEW TYPE
A hotel enquiry's lifecycle (pending_approval -> in_review -> approved /
rejected) is a subset of the same states Flight enquiries already use, and
every label/tone mapping the two portals render from (`ENQUIRY_LABELS`,
`CL_STATUS_TONE`, `SPEC_LABELS`) is keyed on this enum's values. Minting a
second `hotel_enquiry_status_enum` with the same four words would only forge
two disagreements: one type could gain a state the other never sees, and every
UI status map would need a hotel-specific branch to translate between them.
Binding to the existing type is a plain `_pg_enum()`, same as everywhere else.

WHY THE REFERENCE SEQUENCE ALREADY EXISTS
`seq_hotel_enquiry_number` (migration 0046) was cut for this exact purpose and
never used for anything else — `hotel_enquiry_service._next_reference` starts
drawing from it in this same change. No new sequence needed here.

BACKWARD COMPATIBILITY
Purely additive: three new tables, no existing column, constraint, or index
touched. `downgrade()` drops what `upgrade()` created, in dependency order.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0047_hotel_enquiry_tables"
down_revision: Union[str, None] = "0046_hotel_enquiry_sequence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_REQUEST_STATUS = postgresql.ENUM(
    "draft", "submitted", "pending_approval", "in_review", "approved", "rejected",
    "payment_pending", "paid", "ticket_issued", "verified", "completed", "cancelled",
    name="request_status_enum",
    create_type=False,
)


def upgrade() -> None:
    op.create_table(
        "hotel_enquiries",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column(
            "merchant_id", sa.BigInteger,
            sa.ForeignKey("merchants.merchant_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "user_id", sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("enquiry_reference", sa.String(40), nullable=False),
        sa.Column("destination_city", sa.String(120), nullable=False),
        sa.Column("check_in_date", sa.Date, nullable=False),
        sa.Column("check_out_date", sa.Date, nullable=False),
        # Denormalised at create time, same convention Flight's own
        # `passenger_count` follows on service_requests — every reader wants
        # the count and none of them should recompute it from the two dates.
        sa.Column("number_of_nights", sa.Integer, nullable=False),
        sa.Column("hotel_name", sa.String(200), nullable=True),
        # Free text, not a foreign key to a star-rating table that does not
        # exist — a closed set of three values is exactly what a CHECK
        # constraint states without standing up a lookup table for it.
        sa.Column("star_category", sa.String(1), nullable=False),
        sa.Column("room_type", sa.String(120), nullable=True),
        sa.Column("pan", sa.String(10), nullable=True),
        sa.Column("meal_plan", sa.String(20), nullable=False),
        sa.Column("special_requirements", sa.Text, nullable=True),
        sa.Column("preferred_location", sa.String(200), nullable=True),
        sa.Column("status", _REQUEST_STATUS, nullable=False, server_default=sa.text("'pending_approval'")),
        # The quotation (CR-5's binding-fare pattern, carried over unchanged).
        sa.Column("quoted_fare", sa.Numeric(14, 2), nullable=True),
        sa.Column("quotation_remarks", sa.Text, nullable=True),
        sa.Column("admin_response", sa.Text, nullable=True),
        sa.Column("rejection_reason", sa.Text, nullable=True),
        sa.Column(
            "review_claimed_by", sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("review_claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_unique_constraint("uq_hotel_enquiries_reference", "hotel_enquiries", ["enquiry_reference"])
    op.create_check_constraint(
        "ck_hotel_enq_date_order", "hotel_enquiries", "check_out_date > check_in_date"
    )
    op.create_check_constraint(
        "ck_hotel_enq_nights_positive", "hotel_enquiries", "number_of_nights > 0"
    )
    op.create_check_constraint(
        "ck_hotel_enq_star_category", "hotel_enquiries", "star_category IN ('3','4','5')"
    )
    op.create_check_constraint(
        "ck_hotel_enq_meal_plan", "hotel_enquiries",
        "meal_plan IN ('breakfast','half_board','full_board')",
    )
    op.create_index("ix_hotel_enquiries_merchant", "hotel_enquiries", ["merchant_id"])
    op.create_index("ix_hotel_enquiries_status", "hotel_enquiries", ["status"])
    op.create_index("ix_hotel_enquiries_created_at", "hotel_enquiries", [sa.text("created_at DESC")])

    op.create_table(
        "hotel_enquiry_rooms",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column(
            "hotel_enquiry_id", sa.BigInteger,
            sa.ForeignKey("hotel_enquiries.id", ondelete="CASCADE"), nullable=False,
        ),
        # 1-based, per enquiry — "Room 1", "Room 2" on both portals reads
        # directly off this rather than an array index computed at render time.
        sa.Column("room_number", sa.Integer, nullable=False),
        sa.Column("adults", sa.Integer, nullable=False),
        sa.Column("children", sa.Integer, nullable=False, server_default=sa.text("0")),
    )
    op.create_unique_constraint(
        "uq_hotel_room_number", "hotel_enquiry_rooms", ["hotel_enquiry_id", "room_number"]
    )
    op.create_check_constraint("ck_hotel_room_adults_positive", "hotel_enquiry_rooms", "adults >= 1")
    op.create_check_constraint("ck_hotel_room_children_non_negative", "hotel_enquiry_rooms", "children >= 0")
    op.create_index("ix_hotel_enquiry_rooms_enquiry", "hotel_enquiry_rooms", ["hotel_enquiry_id"])

    op.create_table(
        "hotel_room_children",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column(
            "room_id", sa.BigInteger,
            sa.ForeignKey("hotel_enquiry_rooms.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("child_age", sa.SmallInteger, nullable=False),
    )
    op.create_check_constraint(
        "ck_hotel_room_child_age_range", "hotel_room_children", "child_age BETWEEN 0 AND 17"
    )
    op.create_index("ix_hotel_room_children_room", "hotel_room_children", ["room_id"])


def downgrade() -> None:
    op.drop_table("hotel_room_children")
    op.drop_table("hotel_enquiry_rooms")
    op.drop_table("hotel_enquiries")
