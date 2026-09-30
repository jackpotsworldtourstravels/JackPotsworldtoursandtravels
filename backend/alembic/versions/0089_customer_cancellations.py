"""customer_cancellation_requests — Phase 3 of the B2C Admin Portal build-out.

WHY THIS IS A NEW TABLE, NOT A REUSE OF SOMETHING THAT ALREADY EXISTS.
Before writing this migration the existing schema was checked for a table
that already carried a cancellation/refund workflow, per the brief's own
"analyze existing tables first" instruction. There isn't one:
``CustomerBooking``/``CustomerHotelBooking``/``CustomerPackageBooking``.status
already has a bare ``cancelled`` value, and the existing customer-facing
"Cancel" button flips straight to it (see ``.../cancel`` in
customer_bookings.py and friends) — there has never been an intermediate
state, an admin decision, or a refund amount tracked anywhere. The B2B side
has exactly this shape on ``service_requests`` (``request_type='cancellation'``
/ ``'refund'``), but that table is hard-keyed to ``merchant_id``/``user_id``
or holds no ``customer_id`` column at all, so a B2C row is not a request that
table's shape or its permission model was ever built to hold.

ONE TABLE, POLYMORPHIC BY ``product`` + ``booking_ref`` — the same choice
``customer_booking_admin_service.py`` (Phase 2) already made for reading
across the three booking tables, rather than three near-identical
cancellation tables that would drift the moment one of them changes. There is
no database-level foreign key from ``booking_ref`` to any one booking table
for that reason; the service layer resolves it the same way Phase 2 already
does, against whichever of the three tables actually has that reference.

WHO DECIDED IS NOT A COLUMN HERE, DELIBERATELY. Recording it would need
either a cross-Base foreign key from ``models_customer`` into
``users.user_id`` (``models_v2``'s table) — the separation the codebase's own
existing comments call structural rather than remembered — or a duplicate
admin-identity table. Every other admin action in this build-out (Phase 1's
customer reads, Phase 2's status changes) already has its actor recorded in
the existing, portal-wide ``activity_service`` audit log instead; this does
the same rather than inventing a second place to look.

STATUS IS A PLAIN STRING WITH A CHECK, the same call 0088 made for
``gaming_tour_enquiries`` and 0047 made for ``hotel_enquiries``: the workflow
(``requested`` -> ``approved`` -> ``refund_processing`` -> ``refunded``, or
``rejected`` from ``requested``/``approved``) is specific to this desk.

Reference numbers are date-stamped and sequence-backed, the same pattern
0030/0046/0088 established: ``CXL-20260930-000001``.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0089_customer_cancellations"
down_revision: Union[str, None] = "0088_gaming_tour_enquiries"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEQUENCE = "seq_customer_cancellation_number"

PRODUCTS = ("flight", "hotel", "package")

STATUSES = ("requested", "approved", "rejected", "refund_processing", "refunded")


def upgrade() -> None:
    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {SEQUENCE} START WITH 1 INCREMENT BY 1")

    op.create_table(
        "customer_cancellation_requests",
        sa.Column("cancellation_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("cancellation_ref", sa.String(length=40), nullable=False),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        # Which of the three booking tables `booking_ref` belongs to — see the
        # module docstring for why this is a plain string, not an FK.
        sa.Column("product", sa.String(length=20), nullable=False),
        sa.Column("booking_ref", sa.String(length=20), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="requested"),
        # NULL until an admin sets it on approval; the amount actually
        # refunded may differ from the booking's own total (a partial
        # refund), so this is its own field rather than a lookup of the
        # booking's total_amount at read time.
        sa.Column("refund_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("admin_notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(), onupdate=sa.func.now(),
        ),
        sa.UniqueConstraint("cancellation_ref", name="uq_customer_cancellation_ref"),
        sa.CheckConstraint(
            "product IN (" + ", ".join(f"'{p}'" for p in PRODUCTS) + ")",
            name="ck_customer_cancellation_product",
        ),
        sa.CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in STATUSES) + ")",
            name="ck_customer_cancellation_status",
        ),
    )
    op.create_index(
        "ix_customer_cancellation_customer", "customer_cancellation_requests", ["customer_id"],
    )
    op.create_index(
        "ix_customer_cancellation_booking_ref", "customer_cancellation_requests", ["booking_ref"],
    )
    op.create_index(
        "ix_customer_cancellation_status", "customer_cancellation_requests", ["status"],
    )
    op.create_index(
        "ix_customer_cancellation_created_at",
        "customer_cancellation_requests", [sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_customer_cancellation_created_at", table_name="customer_cancellation_requests")
    op.drop_index("ix_customer_cancellation_status", table_name="customer_cancellation_requests")
    op.drop_index("ix_customer_cancellation_booking_ref", table_name="customer_cancellation_requests")
    op.drop_index("ix_customer_cancellation_customer", table_name="customer_cancellation_requests")
    op.drop_table("customer_cancellation_requests")
    op.execute(f"DROP SEQUENCE IF EXISTS {SEQUENCE}")
