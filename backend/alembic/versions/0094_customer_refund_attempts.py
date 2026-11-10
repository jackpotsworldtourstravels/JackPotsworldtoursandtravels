"""customer_refund_attempts -- the actual refund lifecycle (B2C refunds).

WHY A NEW TABLE. Until now ``customer_cancellation_requests`` could say a
request was ``refunded`` because an admin clicked a button; nothing recorded a
provider refund id, an idempotency key, the payment the money came off, or what
the provider replied. docs/D1_REFUND_INVESTIGATION.md established that no
equivalent table exists on any branch; docs/REFUND_ARCHITECTURE_CORRECTIONS.md
fixed the shape below.

ONE ROW PER ATTEMPT. A failed attempt is kept and a retry is a new row with a
new ``attempt_number`` (and therefore a new idempotency key): the original key is
burned at the provider. The amount still refundable on a payment is its captured
amount minus the ``succeeded`` + ``processing`` rows, never a stored balance.

THE CONSTRAINTS ARE THE LAST LINE OF DEFENCE; the service's ``SELECT ... FOR
UPDATE`` on the payment row is the first.
  * UNIQUE(provider, idempotency_key)         -- one provider request per key
  * UNIQUE(cancellation_ref, attempt_number)  -- attempts are numbered once
  * UNIQUE(provider, provider_refund_id) WHERE NOT NULL -- one row per refund
  * UNIQUE(cancellation_ref) WHERE status IN ('pending','processing')
        -- at most ONE in-flight attempt per cancellation, so a double-click or
        a replayed request cannot open a second while the first is unresolved
  * CHECK amount_minor > 0, status vocabulary, payment_table vocabulary

``initiated_by_user_id`` and friends are plain integers, not foreign keys: the
customer schema does not reach into ``users`` (see 0089 for the reasoning).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0094_customer_refund_attempts"
down_revision: Union[str, None] = "0093_traveller_middle_name"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "customer_refund_attempts"
STATUSES = ("pending", "processing", "succeeded", "failed", "manual_required")
PAYMENT_TABLES = (
    "customer_booking_payments",
    "customer_hotel_booking_payments",
    "customer_package_booking_payments",
)


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("refund_attempt_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "cancellation_ref", sa.String(length=40),
            sa.ForeignKey("customer_cancellation_requests.cancellation_ref", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("payment_table", sa.String(length=40), nullable=False),
        sa.Column("payment_row_id", sa.BigInteger(), nullable=False),
        sa.Column("provider", sa.String(length=40), nullable=False),
        sa.Column("provider_refund_id", sa.String(length=120), nullable=True),
        sa.Column("idempotency_key", sa.String(length=80), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default="INR"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("provider_status", sa.String(length=60), nullable=True),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.Column("raw_response", postgresql.JSONB(), nullable=True),
        sa.Column("is_manual", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("admin_override", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("manual_reference", sa.String(length=120), nullable=True),
        sa.Column("manual_reason", sa.Text(), nullable=True),
        sa.Column("approval_required", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("initiated_by_user_id", sa.BigInteger(), nullable=True),
        sa.Column("approved_by_user_id", sa.BigInteger(), nullable=True),
        sa.Column("completed_by_user_id", sa.BigInteger(), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(), onupdate=sa.func.now(),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("provider", "idempotency_key", name="uq_refund_attempt_idempotency"),
        sa.UniqueConstraint("cancellation_ref", "attempt_number", name="uq_refund_attempt_number"),
        sa.CheckConstraint("amount_minor > 0", name="ck_refund_attempt_amount_positive"),
        sa.CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in STATUSES) + ")",
            name="ck_refund_attempt_status",
        ),
        sa.CheckConstraint(
            "payment_table IN (" + ", ".join(f"'{t}'" for t in PAYMENT_TABLES) + ")",
            name="ck_refund_attempt_payment_table",
        ),
    )
    op.create_index(
        "uq_refund_attempt_provider_refund", TABLE, ["provider", "provider_refund_id"],
        unique=True, postgresql_where=sa.text("provider_refund_id IS NOT NULL"),
    )
    op.create_index(
        "uq_refund_attempt_one_in_flight", TABLE, ["cancellation_ref"],
        unique=True, postgresql_where=sa.text("status IN ('pending', 'processing')"),
    )
    op.create_index("ix_refund_attempt_payment", TABLE, ["payment_table", "payment_row_id", "status"])
    op.create_index("ix_refund_attempt_status", TABLE, ["status"])


def downgrade() -> None:
    op.drop_index("ix_refund_attempt_status", table_name=TABLE)
    op.drop_index("ix_refund_attempt_payment", table_name=TABLE)
    op.drop_index("uq_refund_attempt_one_in_flight", table_name=TABLE)
    op.drop_index("uq_refund_attempt_provider_refund", table_name=TABLE)
    op.drop_table(TABLE)
