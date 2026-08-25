"""Customer Account Center — wishlist, notifications, reviews, support tickets.

The Account Center modal (index.html's "ACCOUNT CENTER") has had a tab for each
of these since before the Customer Portal existed server-side: My Bookings,
Wishlist, Payment History, Notifications, Support Tickets, My Reviews. Only
Profile and Settings ever had a real backend behind them — the rest called
``/api/wishlist``, ``/api/notifications``, ``/api/reviews/mine`` and
``/api/support-tickets``, none of which exist, and ``/api/bookings``, which is
a different (merchant-side analytics) route entirely. Every one of those tabs
has shown "Failed to load..." since the day it shipped.

This migration gives four of those tabs somewhere real to land (My Bookings
already has one — ``customer_bookings`` from 0053 — and Payment History reads
the ``customer_booking_payments`` rows that migration already writes, so
neither needs a new table):

* ``customer_wishlist``       a saved flight/hotel/cruise/package, by the
                              catalogue id the frontend already sends.
* ``customer_notifications``  system-generated messages (booking created,
                              cancelled, ...) — not a marketing inbox.
* ``customer_reviews``        one review per customer per item, matching the
                              existing (currently orphaned) reviews modal.
* ``customer_support_tickets`` + ``customer_support_messages`` — the
                              customer's own ticket thread. Deliberately not
                              the merchant/admin chat system in
                              ``support_tickets.py``: that one is rooted at
                              ``models_v2.User`` and reaching a `Customer`
                              across that boundary is exactly what 0044's
                              docstring says takes an explicit primaryjoin
                              this schema does not create. A fresh, small
                              table on this Base is the same choice 0053 made
                              for bookings.

Kept off ``customer_bookings`` and off the merchant tables on purpose: a
wishlist entry or a review is about a *catalogue item* (still sample data —
see ``travel-data.js``), not a booking, so there is nothing to foreign-key to
yet. ``item_type``/``item_id`` mirrors exactly what the frontend has sent
since it was written.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0054_customer_account_center"
down_revision: Union[str, None] = "0053_customer_flight_booking"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ITEM_TYPE = postgresql.ENUM(
    "flight", "hotel", "cruise", "package",
    name="customer_item_type_enum", create_type=False,
)
_NOTIF_TYPE = postgresql.ENUM(
    "booking_created", "booking_cancelled", "booking_payment", "general",
    name="customer_notification_type_enum", create_type=False,
)
_TICKET_STATUS = postgresql.ENUM(
    "open", "in_progress", "resolved", "closed",
    name="customer_ticket_status_enum", create_type=False,
)
_TICKET_PRIORITY = postgresql.ENUM(
    "low", "normal", "high", "urgent",
    name="customer_ticket_priority_enum", create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()

    _ITEM_TYPE.create(bind, checkfirst=True)
    _NOTIF_TYPE.create(bind, checkfirst=True)
    _TICKET_STATUS.create(bind, checkfirst=True)
    _TICKET_PRIORITY.create(bind, checkfirst=True)

    # ------------------------------------------------------------------ 1/5 --
    op.create_table(
        "customer_wishlist",
        sa.Column("customer_wishlist_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("item_type", _ITEM_TYPE, nullable=False),
        sa.Column("item_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_customer_wishlist_customer", "customer_wishlist", ["customer_id"])
    # One heart per item per customer — the frontend toggles on this pair.
    op.create_unique_constraint(
        "uq_customer_wishlist_item", "customer_wishlist", ["customer_id", "item_type", "item_id"],
    )

    # ------------------------------------------------------------------ 2/5 --
    op.create_table(
        "customer_notifications",
        sa.Column("customer_notification_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("notification_type", _NOTIF_TYPE, nullable=False,
                  server_default=sa.text("'general'")),
        sa.Column("title", sa.String(length=150), nullable=False),
        sa.Column("message", sa.String(length=500), nullable=False),
        #: What the notification is about, so a click can route to it —
        #: e.g. a booking_ref. Optional: not every notification names one.
        sa.Column("related_ref", sa.String(length=40), nullable=True),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_customer_notifications_customer", "customer_notifications", ["customer_id"])

    # ------------------------------------------------------------------ 3/5 --
    op.create_table(
        "customer_reviews",
        sa.Column("customer_review_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("item_type", _ITEM_TYPE, nullable=False),
        sa.Column("item_id", sa.Integer(), nullable=False),
        sa.Column("rating", sa.SmallInteger(), nullable=False),
        sa.Column("comment", sa.String(length=1000), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint("rating >= 1 AND rating <= 5", name="ck_customer_review_rating"),
    )
    op.create_index("ix_customer_reviews_item", "customer_reviews", ["item_type", "item_id"])
    # One review per customer per item — the existing frontend already assumes
    # this (it edits "my" review rather than ever letting a second one exist).
    op.create_unique_constraint(
        "uq_customer_review_item", "customer_reviews", ["customer_id", "item_type", "item_id"],
    )

    # ------------------------------------------------------------------ 4/5 --
    op.create_table(
        "customer_support_tickets",
        sa.Column("customer_support_ticket_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("subject", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("priority", _TICKET_PRIORITY, nullable=False, server_default=sa.text("'normal'")),
        sa.Column("status", _TICKET_STATUS, nullable=False, server_default=sa.text("'open'")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_customer_support_tickets_customer", "customer_support_tickets", ["customer_id"])

    # ------------------------------------------------------------------ 5/5 --
    op.create_table(
        "customer_support_messages",
        sa.Column("customer_support_message_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_support_ticket_id", sa.BigInteger(),
            sa.ForeignKey("customer_support_tickets.customer_support_ticket_id", ondelete="CASCADE"),
            nullable=False,
        ),
        #: Who wrote it. NULL author = the customer (there is no staff-user
        #: table on this Base to point at — see the module docstring); a
        #: non-NULL value is a plain display name for a staff reply, written
        #: by whatever future admin surface answers these tickets.
        sa.Column("author_name", sa.String(length=150), nullable=True),
        sa.Column("is_staff", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_customer_support_messages_ticket", "customer_support_messages",
        ["customer_support_ticket_id"],
    )


def downgrade() -> None:
    bind = op.get_bind()

    op.drop_table("customer_support_messages")
    op.drop_table("customer_support_tickets")
    op.drop_table("customer_reviews")
    op.drop_table("customer_notifications")
    op.drop_table("customer_wishlist")

    _TICKET_PRIORITY.drop(bind, checkfirst=True)
    _TICKET_STATUS.drop(bind, checkfirst=True)
    _NOTIF_TYPE.drop(bind, checkfirst=True)
    _ITEM_TYPE.drop(bind, checkfirst=True)
