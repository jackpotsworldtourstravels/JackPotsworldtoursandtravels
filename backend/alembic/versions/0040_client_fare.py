"""client fare — what the merchant quoted its own customer, and what that saved

Revision ID: 0040_client_fare
Revises: 0039_provider_management
Create Date: 2026-08-02

WHAT ``client_fare`` IS
The price the merchant's Data Operator has quoted to *their* end customer, typed
on the Booking Enquiry form before we have answered it. It is **not** a price
this platform charges, does not participate in settlement, and never moves a
wallet. It exists so the merchant — and the Admin looking at the same enquiry —
can see the margin between what they sold at and what we billed them.

    saved_amount = client_fare - total_amount     (floored at zero)

WHY A COLUMN AND NOT ``travel_details`` JSON
Every other free-form field on an enquiry lives in the ``travel_details`` JSONB
blob, and this deliberately does not. The figure has to be SUM()ed — the
merchant Dashboard shows "Total Savings" across every booking, and Reports
aggregates it by month. Summing a JSON key means casting text to numeric on
every row with no index to help, and one bad write ("20,000" with a comma)
poisons the whole aggregate at read time instead of failing at write time.
``Numeric(14, 2)`` matches ``total_amount`` exactly, so the subtraction above is
decimal-exact and cannot drift the way a float would.

WHY IT IS NULLABLE, AND WHY THERE IS NO DEFAULT
Nullable because it is genuinely optional: a merchant that does not resell at a
markup has no client fare to record, and 61,000 existing rows never had one.
**NULL means "not recorded", 0 would mean "quoted at zero"** — those are
different facts, and backfilling either would be inventing data. Every consumer
therefore treats NULL as "no savings figure", not as a zero saving.

WHY THE CHECK CONSTRAINT
``ck_sr_client_fare_non_negative`` mirrors ``ck_sr_amount_non_negative`` on
``total_amount``. A negative quoted fare is not a discount, it is a typo, and
the savings arithmetic above would turn it into a *negative* saving that then
subtracts from the merchant's dashboard total.

WHY THE PARTIAL INDEX
Only enquiries and the bookings made from them ever carry the value, and the
aggregates always filter ``client_fare IS NOT NULL``. A partial index covers
exactly those rows and stays small — on the demo data that is a few hundred rows
out of ~61,000 rather than an index over the whole table.

BACKWARD COMPATIBILITY
Additive only. Nothing reads the column unless it is set, no existing query
changes, and ``downgrade()`` is a clean drop — no data other than the new column
is touched in either direction.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# THE TYPE ANNOTATIONS ARE LOAD-BEARING, NOT DECORATION.
# tests/verify_m9.py discovers the migration chain by regex, and its pattern
# requires `revision: str = ...` / `down_revision: Union[str, None] = ...`.
# Written as bare assignments this file is invisible to that scan: the suite
# counted 39 migrations instead of 40, computed the head as 0039, and then
# failed "the database is at the migration head" against a database that was
# correctly at 0040. Match the annotated style every other migration uses.
revision: str = "0040_client_fare"
down_revision: Union[str, None] = "0039_provider_management"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "service_requests",
        sa.Column("client_fare", sa.Numeric(14, 2), nullable=True),
    )
    op.create_check_constraint(
        "ck_sr_client_fare_non_negative",
        "service_requests",
        "client_fare IS NULL OR client_fare >= 0",
    )
    op.create_index(
        "ix_sr_client_fare",
        "service_requests",
        ["merchant_id", "client_fare"],
        postgresql_where=sa.text("client_fare IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_sr_client_fare", table_name="service_requests")
    op.drop_constraint(
        "ck_sr_client_fare_non_negative", "service_requests", type_="check"
    )
    op.drop_column("service_requests", "client_fare")
