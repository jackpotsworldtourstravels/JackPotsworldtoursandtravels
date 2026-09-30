"""gaming_tour_enquiries — the B2C casino-tour enquiry desk.

Gaming Tour Packages stopped being a searchable product with this change: a
casino trip is quoted by hand (visas, table limits, property relationships
vary too much for a price to be shown live), so the page that used to be a
destination/date search is now a form, and this is where what it collects
lands.

NOT THE SAME SHAPE AS `hotel_enquiries` / the Ticket Enquiry queue those
belong to a signed-in MERCHANT (`merchant_id` is required on both) raising a
sector or a stay to be priced against their own wallet and credit limit. A
gaming tour enquiry is raised by a member of the public who is not signed into
anything — there is no merchant, no wallet, no quotation binding a fare to a
booking — so it is its own table rather than a row bent to fit that shape.

Reference numbers are date-stamped and sequence-backed, the same pattern 0030
and 0046 established for Flight and Hotel: ``GT-20260928-000001``, collision-
safe under concurrent submissions via ``seq_gaming_tour_enquiry_number``. No
prior data exists for this table, so — unlike 0046 — the sequence starts
at 1 with no ``setval`` collision guard needed.

STATUS IS A PLAIN STRING WITH A CHECK, not a new Postgres enum type: the
workflow (NEW -> ASSIGNED -> CONTACTED -> QUOTE_PREPARED -> CUSTOMER_CONFIRMED
-> BOOKING_CREATED, with CANCELLED reachable from any open state) is specific
to this desk and unlikely to be shared, so a CHECK constraint is the lighter
commitment — the same call ``star_category``/``meal_plan`` made on
``hotel_enquiries`` (migration 0047).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0088_gaming_tour_enquiries"
down_revision: Union[str, None] = "0087_customer_identities"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEQUENCE = "seq_gaming_tour_enquiry_number"

STATUSES = (
    "NEW", "ASSIGNED", "CONTACTED", "QUOTE_PREPARED",
    "CUSTOMER_CONFIRMED", "BOOKING_CREATED", "COMPLETED", "CANCELLED",
)


def upgrade() -> None:
    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {SEQUENCE} START WITH 1 INCREMENT BY 1")

    op.create_table(
        "gaming_tour_enquiries",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("enquiry_reference", sa.String(length=40), nullable=False),
        sa.Column("customer_name", sa.String(length=150), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("mobile_number", sa.String(length=30), nullable=False),
        sa.Column("from_airport", sa.String(length=120), nullable=False),
        sa.Column("to_airport", sa.String(length=120), nullable=False),
        sa.Column("travel_datetime", sa.DateTime(timezone=True), nullable=False),
        sa.Column("number_of_nights", sa.SmallInteger(), nullable=False),
        # Free text ("VIP Casino, Poker, Blackjack") — see the router schema
        # docstring for why this is not a fixed vocabulary.
        sa.Column("casino_type", sa.String(length=300), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="NEW"),
        sa.Column(
            "assigned_admin_id", sa.BigInteger(),
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("admin_notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(), onupdate=sa.func.now(),
        ),
        sa.UniqueConstraint("enquiry_reference", name="uq_gaming_tour_enquiries_reference"),
        sa.CheckConstraint("number_of_nights > 0", name="ck_gaming_tour_enq_nights_positive"),
        sa.CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in STATUSES) + ")",
            name="ck_gaming_tour_enq_status",
        ),
    )
    op.create_index("ix_gaming_tour_enquiries_status", "gaming_tour_enquiries", ["status"])
    op.create_index(
        "ix_gaming_tour_enquiries_created_at", "gaming_tour_enquiries", [sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_gaming_tour_enquiries_assigned_admin", "gaming_tour_enquiries", ["assigned_admin_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_gaming_tour_enquiries_assigned_admin", table_name="gaming_tour_enquiries")
    op.drop_index("ix_gaming_tour_enquiries_created_at", table_name="gaming_tour_enquiries")
    op.drop_index("ix_gaming_tour_enquiries_status", table_name="gaming_tour_enquiries")
    op.drop_table("gaming_tour_enquiries")
    op.execute(f"DROP SEQUENCE IF EXISTS {SEQUENCE}")
