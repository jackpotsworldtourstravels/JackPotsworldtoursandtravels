"""customer_booking_notifications — the booking-confirmation outbox (Phase 2 Bug 1).

A confirmed flight/hotel/package booking enqueues one row here per channel
(email, and SMS when a mobile is on file) in the SAME transaction that confirms
the booking; a background sweep sends them best-effort and records the outcome.
See ``app.models_customer.CustomerBookingNotification`` and
``app.services.booking_confirmation_service``.

PURELY ADDITIVE. A new table with no change to any existing one, so the upgrade
is safe on a live database and the downgrade simply drops it. ``booking_ref`` is
a plain column, NOT a foreign key: the three booking tables each own their own
references, so no single FK could point at all three — the ``product`` column
records which table a reference belongs to. The table carries the ``customer_*``
prefix and its only FK (``customer_id``) points at ``customers``, so it satisfies
the B2C/B2B isolation check (verify_customer_portal.py).

The ``(booking_ref, channel)`` unique index is the idempotency key: a
redelivered gateway callback that re-enters ``confirm_booking`` cannot create a
second confirmation for the same channel.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0096_customer_booking_notifications"
down_revision: Union[str, None] = "0095_customer_admin_audit_logs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer_booking_notifications",
        sa.Column("customer_booking_notification_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("booking_ref", sa.String(length=20), nullable=False),
        sa.Column("product", sa.String(length=10), nullable=False),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("channel", sa.String(length=10), nullable=False),
        sa.Column("recipient", sa.String(length=255), nullable=False),
        sa.Column("subject", sa.String(length=200), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_message", sa.String(length=1000), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("booking_ref", "channel", name="uq_customer_booking_notification_ref_channel"),
        sa.CheckConstraint("channel IN ('email', 'sms')", name="ck_customer_booking_notification_channel"),
        sa.CheckConstraint(
            "product IN ('flight', 'hotel', 'package')", name="ck_customer_booking_notification_product",
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'sent', 'failed', 'suppressed')",
            name="ck_customer_booking_notification_status",
        ),
    )
    # The sweep reads QUEUED/FAILED rows oldest-first; a (status, created_at)
    # index serves that scan without touching the whole table as it grows.
    op.create_index(
        "ix_customer_booking_notification_pending",
        "customer_booking_notifications",
        ["status", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_customer_booking_notification_pending", table_name="customer_booking_notifications",
    )
    op.drop_table("customer_booking_notifications")
