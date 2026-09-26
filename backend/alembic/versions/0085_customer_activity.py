"""customer_activity — the signal behind personalised recommendations.

Records the destinations, hotels and packages a customer has looked at, saved
or booked, so recommendation_service.py can score what to suggest next. A guest
holds a real anonymous customer row (see the auth/guest flow), so this covers
them too; a fully signed-out visitor has no row here and is served the
client-side shelf instead.

ONE APPEND-ONLY TABLE. Rows are written and read by recency, never edited. It is
keyed on customer_id and CASCADEs with the customer, so deleting an account
takes its activity with it — and a guest's rows die with the guest customer they
belong to. Nothing personal beyond the entity looked at is stored: no IP, no
user agent, no free text except an optional small `meta` the caller controls.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0085_customer_activity"
down_revision: Union[str, None] = "0084_goa_packages"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer_activity",
        sa.Column("activity_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "customer_id",
            sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"),
            nullable=False,
        ),
        # A short vocabulary, validated at the API edge: view / wishlist /
        # booking / search. Kept as text so a new signal needs no migration.
        sa.Column("activity_type", sa.String(length=32), nullable=False),
        # destination / hotel / package. The id is the catalogue's own id for
        # that kind — a destination slug, a package id — stored as text so one
        # column serves all three.
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.String(length=128), nullable=False),
        sa.Column("meta", JSONB(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    # Every read is "this customer's activity, newest first", so that is the
    # index. Nothing queries by entity, so nothing indexes it.
    op.create_index(
        "ix_customer_activity_customer_recent",
        "customer_activity",
        ["customer_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_customer_activity_customer_recent", table_name="customer_activity")
    op.drop_table("customer_activity")
