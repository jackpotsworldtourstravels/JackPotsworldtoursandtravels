"""customer_notification_preferences — per-customer email/SMS channel opt-ins (Issue #21).

One row per customer, keyed by ``customer_id`` (so a customer has at most one).
Two categories x two channels:

  * booking_email / booking_sms  — transactional confirmations. Default ON, so an
    existing customer keeps getting confirmations with no row at all (the service
    reads "no row" as all-defaults and never writes on a mere read).
  * promo_email / promo_sms      — marketing. Default OFF — strictly opt-in.

Purely additive and backward compatible: a brand-new table, no change to any
existing table, no data migration. Every customer that predates it simply has no
row and is served the defaults. In-app notifications are not governed by this
table and are unaffected. Fully reversible (``drop_table``), and it sits well
above the 0023 redesign boundary, so the sprint-era round-trip stays clean.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0101_customer_notif_prefs"
down_revision: Union[str, None] = "0100_supplier_markup_festival"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "customer_notification_preferences"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("booking_email", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("booking_sms", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("promo_email", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("promo_sms", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(), onupdate=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table(TABLE)
