"""customer_identities — federated sign-in (Google), linked to existing customers.

Purely additive. ONE new table; ``customers`` and ``customer_auth`` are
untouched, so every existing sign-in path keeps working exactly as before and
an OTP-only customer simply has no row here.

The table records "this provider subject IS this customer": ``customer_id`` +
``provider`` + ``provider_user_id`` (Google's ``sub``). The UNIQUE index on
``(provider, provider_user_id)`` is the whole point — it is what makes the same
Google account resolve to the same customer on every sign-in instead of ever
creating a duplicate. No token of any kind is stored.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0087_customer_identities"
down_revision: Union[str, None] = "0086_supplier_references"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer_identities",
        sa.Column("customer_identity_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "customer_id",
            sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.String(length=40), nullable=False),
        sa.Column("provider_user_id", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    # The identity is unique per provider: one Google subject maps to exactly
    # one customer, so a repeat login can never mint a second account.
    op.create_unique_constraint(
        "uq_customer_identities_provider_sub",
        "customer_identities",
        ["provider", "provider_user_id"],
    )
    # Every lookup is "which identities does this customer have"; index it.
    op.create_index(
        "ix_customer_identities_customer_id", "customer_identities", ["customer_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_customer_identities_customer_id", table_name="customer_identities")
    op.drop_constraint(
        "uq_customer_identities_provider_sub", "customer_identities", type_="unique",
    )
    op.drop_table("customer_identities")
