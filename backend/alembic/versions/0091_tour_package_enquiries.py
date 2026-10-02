"""tour_package_enquiries — the Contact Us page's "Enquire About Dates" form.

A tour package with no scheduled departures shows "Enquire about dates"
instead of "Book now" (package.js / booking-flows.js), which sends the
customer to Contact Us with the package in the query string. That page has
never had a form behind it — only the three static cards (Call us / Email us
/ Where we are) — so there was nowhere for that click to actually land.

SAME SHAPE AS `gaming_tour_enquiries` (migration 0088), AND FOR THE SAME
REASON: this is raised from a public page by someone who may not be signed
into anything, so there is no merchant or customer row to file it against —
contact details are plain columns, not a foreign key to `customers`/`users`.

LIKE GAMING TOUR IN ONE MORE WAY THAN THE DOCSTRING ABOVE SAYS: `package_id`
is a plain nullable column, NOT a database foreign key, even though it names
a real `customer_packages` row when the customer arrived via a package's
"Enquire about dates" button. verify_customer_portal.py enforces this
project's B2C/B2B isolation structurally — every foreign key touching a
`customer*` table must have BOTH ends named `customer*` — and
`tour_package_enquiries` does not carry that prefix, so a literal FK here
would fail that check regardless of which side of any boundary the target
table is actually on. `tour_package_enquiry_service.create()` validates the
id against `CustomerPackage` in Python instead (see `_existing_package_id`),
which is also what lets a retired package degrade the enquiry's `package_id`
to NULL rather than hitting a database constraint. `package_name` (always
stored, independent of this column) is what keeps the enquiry readable
either way. Nullable because Contact Us is also reachable directly, with no
package in mind, in which case the customer types the package name
themselves and there is no id to store.

Reference numbers are date-stamped and sequence-backed, the same pattern
0030/0046/0088 established: ``TPE-20261001-000001``.

STATUS IS A PLAIN STRING WITH A CHECK, not a new Postgres enum — this desk
has no admin screen yet (out of scope for the form this migration supports),
so a three-value workflow (NEW/CONTACTED/CLOSED) is the lighter commitment,
exactly as 0088 chose for Gaming Tour.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0091_tour_package_enquiries"
down_revision: Union[str, None] = "0090_customer_review_moderation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEQUENCE = "seq_tour_package_enquiry_number"

STATUSES = ("NEW", "CONTACTED", "CLOSED")


def upgrade() -> None:
    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {SEQUENCE} START WITH 1 INCREMENT BY 1")

    op.create_table(
        "tour_package_enquiries",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("enquiry_reference", sa.String(length=40), nullable=False),
        sa.Column("customer_name", sa.String(length=150), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("mobile_number", sa.String(length=30), nullable=False),
        # NOT sa.ForeignKey(...) — see the module docstring: a literal FK from
        # a non-`customer*`-prefixed table into one fails this project's
        # B2C/B2B isolation check regardless of which side of any real
        # boundary `customer_packages` is on. Validated in Python instead
        # (tour_package_enquiry_service._existing_package_id).
        sa.Column("package_id", sa.BigInteger(), nullable=True),
        sa.Column("package_name", sa.String(length=200), nullable=False),
        sa.Column("preferred_travel_date", sa.Date(), nullable=True),
        sa.Column("number_of_travellers", sa.Integer(), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        # Both constant today — this table exists for exactly one source and
        # one enquiry type — but stored as real columns rather than assumed,
        # per the brief, so nothing has to guess either fact if this is ever
        # read alongside another enquiry queue.
        sa.Column("source", sa.String(length=40), nullable=False, server_default="b2c_website"),
        sa.Column("enquiry_type", sa.String(length=40), nullable=False, server_default="tour_package"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="NEW"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("enquiry_reference", name="uq_tour_package_enquiries_reference"),
        sa.CheckConstraint(
            "number_of_travellers IS NULL OR number_of_travellers > 0",
            name="ck_tour_package_enq_travellers_positive",
        ),
        sa.CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in STATUSES) + ")",
            name="ck_tour_package_enq_status",
        ),
    )
    op.create_index(
        "ix_tour_package_enquiries_created_at", "tour_package_enquiries", [sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_tour_package_enquiries_package", "tour_package_enquiries", ["package_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_tour_package_enquiries_package", table_name="tour_package_enquiries")
    op.drop_index("ix_tour_package_enquiries_created_at", table_name="tour_package_enquiries")
    op.drop_table("tour_package_enquiries")
    op.execute(f"DROP SEQUENCE IF EXISTS {SEQUENCE}")
