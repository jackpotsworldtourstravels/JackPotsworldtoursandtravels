"""A customer payment can be taken by a real provider, and proved afterwards.

Until now ``record_payment`` wrote an INTENTION: a row saying which method the
traveller said they would use, at ``pending``, with ``provider`` and
``provider_reference`` both NULL because nothing was integrated. This migration
gives that row the columns a real provider needs, and adds the table that makes
a webhook safe to receive twice.

WHY THE COLUMNS GO ON ALL THREE PAYMENT TABLES
Flights, hotels and packages each have their own payments table, and they are
written by three services that mirror each other line for line. Packages are
what gets wired up first, but a column that exists on one of the three and not
the others is how the second integration ends up with a different shape than
the first. The cost of the extra columns is nil — they are nullable and unused
until a service writes them.

WHY ``provider_payment_id`` RATHER THAN REUSING ``provider_reference``
``provider_reference`` already exists, is unindexed, and has no agreed meaning:
it could hold an order id, a payment id, a UTR or a receipt number depending on
who wrote it. A webhook has to find exactly one local row from exactly one
identifier, and that lookup has to be unique or the handler is guessing. So the
provider's payment identifier gets its own column with a unique index, and
``provider_reference`` is left alone as the free-text field it already is.

WHY THE UNIQUE INDEXES ARE PARTIAL
Every one of them is on a nullable column, and NULLs are distinct in Postgres
but the intent is clearer stated than relied upon: rows that carry no provider
identifier do not participate. That is what lets the existing 20-odd historical
payment rows keep existing without a backfill.

THE EVENT TABLE IS THE DUPLICATE-WEBHOOK GUARANTEE
A provider retries a webhook it did not get a 2xx for, and it may deliver the
same event twice for reasons of its own. "Have I seen this event?" answered in
Python is a check-then-act that two simultaneous deliveries both pass. The
unique index on ``(provider, provider_event_id)`` is what actually decides, and
the handler treats the IntegrityError as "already processed" rather than as an
error — the same shape as the booking idempotency in 0060 and 0061.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0062_customer_payment_provider"
down_revision: Union[str, None] = "0061_flight_package_idempotency"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


#: (table, the column that points at the booking) — used for the per-booking
#: idempotency index, which is scoped to the booking rather than global so one
#: booking's key can never collide with another's.
_PAYMENT_TABLES = (
    ("customer_booking_payments", "customer_booking_id"),
    ("customer_hotel_booking_payments", "hotel_booking_id"),
    ("customer_package_booking_payments", "package_booking_id"),
)

#: Added to ``customer_payment_status_enum``. The existing members are
#: pending / authorized / captured / failed / refunded.
#:
#: ``captured`` IS NOT RENAMED TO ``paid``. It is the terminal success state
#: already, it is what every existing row and every existing read uses, and
#: renaming it would rewrite live data and every consumer for a synonym.
_NEW_STATUSES = ("processing", "cancelled", "expired")


def upgrade() -> None:
    # The enum first, in an autocommit block — the same shape as 0033 and 0038.
    # ``ALTER TYPE ... ADD VALUE`` is transactional on PostgreSQL 12+, but the
    # new label cannot be USED by the transaction that adds it. Nothing below
    # writes one of these values; the application does, later, in its own
    # transaction.
    with op.get_context().autocommit_block():
        for value in _NEW_STATUSES:
            op.execute(
                f"ALTER TYPE customer_payment_status_enum "
                f"ADD VALUE IF NOT EXISTS '{value}'"
            )

    for table, booking_col in _PAYMENT_TABLES:
        op.add_column(table, sa.Column("provider_payment_id", sa.String(120), nullable=True))
        op.add_column(table, sa.Column("provider_order_id", sa.String(120), nullable=True))
        op.add_column(table, sa.Column("provider_status", sa.String(60), nullable=True))
        op.add_column(table, sa.Column("idempotency_key", sa.String(64), nullable=True))
        op.add_column(
            table, sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True)
        )

        # One local row per provider payment. This is the lookup a webhook uses.
        op.create_index(
            f"uq_{table}_provider_payment",
            table,
            ["provider", "provider_payment_id"],
            unique=True,
            postgresql_where=sa.text("provider_payment_id IS NOT NULL"),
        )
        # One local row per provider order, so a second Pay Now for the same
        # booking finds the order that already exists instead of opening another.
        op.create_index(
            f"uq_{table}_provider_order",
            table,
            ["provider", "provider_order_id"],
            unique=True,
            postgresql_where=sa.text("provider_order_id IS NOT NULL"),
        )
        # One attempt per submission, scoped to the booking.
        op.create_index(
            f"uq_{table}_idempotency",
            table,
            [booking_col, "idempotency_key"],
            unique=True,
            postgresql_where=sa.text("idempotency_key IS NOT NULL"),
        )

    # ------------------------------------------------------------------
    # Provider events. Deliberately NOT audit_logs: that table's
    # ``changed_by`` is a merchant user id and a webhook has no user, and
    # ``customer_audit_logs`` is keyed to a customer and a webhook has no
    # session. This is a log of what a provider told us, which is a different
    # thing from a log of what a person did.
    # ------------------------------------------------------------------
    op.create_table(
        "payment_provider_events",
        sa.Column("payment_provider_event_id", sa.BigInteger, primary_key=True),
        #: Which adapter received it. Part of the uniqueness, because two
        #: providers' event ids share no namespace.
        sa.Column("provider", sa.String(40), nullable=False),
        #: The provider's own id for this delivery. NOT NULL: an event we
        #: cannot identify is one we cannot de-duplicate, and the handler
        #: rejects it rather than storing an un-keyed row.
        sa.Column("provider_event_id", sa.String(120), nullable=False),
        sa.Column("event_type", sa.String(80), nullable=False),
        sa.Column("provider_payment_id", sa.String(120), nullable=True),
        sa.Column("provider_order_id", sa.String(120), nullable=True),
        #: The verified body, stored after the signature passed. Secrets are
        #: never in a provider's event body; card and UPI credentials never
        #: reach us at all.
        sa.Column(
            "payload",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        #: received -> processed | ignored | failed. A string rather than an
        #: enum: this is operational state on a log table, and a new outcome
        #: should not need a migration.
        sa.Column(
            "processing_status",
            sa.String(20),
            nullable=False,
            server_default=sa.text("'received'"),
        ),
        #: Why it was ignored, or how it failed. Operator-facing.
        sa.Column("processing_note", sa.Text, nullable=True),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    # THE DUPLICATE-EVENT GUARANTEE. Not partial: both columns are NOT NULL,
    # so every row participates and a redelivery collides here rather than
    # being caught by a Python check that races itself.
    op.create_index(
        "uq_payment_provider_events_event",
        "payment_provider_events",
        ["provider", "provider_event_id"],
        unique=True,
    )
    # Reconciliation reads: "what came in about this payment, in order?"
    op.create_index(
        "ix_payment_provider_events_payment",
        "payment_provider_events",
        ["provider", "provider_payment_id"],
    )
    # The operator's queue: anything that did not process cleanly.
    op.create_index(
        "ix_payment_provider_events_status",
        "payment_provider_events",
        ["processing_status", "received_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_payment_provider_events_status", table_name="payment_provider_events")
    op.drop_index("ix_payment_provider_events_payment", table_name="payment_provider_events")
    op.drop_index("uq_payment_provider_events_event", table_name="payment_provider_events")
    op.drop_table("payment_provider_events")

    for table, _booking_col in _PAYMENT_TABLES:
        op.drop_index(f"uq_{table}_idempotency", table_name=table)
        op.drop_index(f"uq_{table}_provider_order", table_name=table)
        op.drop_index(f"uq_{table}_provider_payment", table_name=table)
        op.drop_column(table, "paid_at")
        op.drop_column(table, "idempotency_key")
        op.drop_column(table, "provider_status")
        op.drop_column(table, "provider_order_id")
        op.drop_column(table, "provider_payment_id")

    # THE ENUM VALUES ARE NOT REMOVED, AND THIS IS DELIBERATE.
    # Postgres has no DROP VALUE. Removing them means recreating the type,
    # rewriting every column that uses it across three tables, and failing
    # anyway if any row has reached one of the new states. A downgrade that
    # leaves three unused labels behind is harmless; one that rewrites live
    # payment rows is not. Same reasoning as the 0022 floor documented in
    # docs/RUNBOOK.md.
