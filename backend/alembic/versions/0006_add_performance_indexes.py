"""add indexes on frequently-filtered/joined columns

Note: no standalone index on wishlist.user_id or reviews.user_id here — the
UNIQUE(user_id, item_type, item_id) constraint added in the next migration
creates its own composite index starting with user_id, which Postgres can
already use for user_id-only lookups (leftmost-prefix matching), so a separate
single-column index on those two tables would be redundant.

Revision ID: 0006_add_performance_indexes
Revises: 0005_user_delete_fk_behavior
Create Date: 2026-07-13

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0006_add_performance_indexes"
down_revision: Union[str, None] = "0005_user_delete_fk_behavior"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_bookings_user_id", "bookings", ["user_id"])
    op.create_index("ix_bookings_status", "bookings", ["status"])
    op.create_index("ix_payments_booking_id", "payments", ["booking_id"])
    op.create_index("ix_payments_user_id", "payments", ["user_id"])
    op.create_index("ix_reviews_item_type_item_id", "reviews", ["item_type", "item_id"])
    op.create_index("ix_notifications_user_id", "notifications", ["user_id"])
    op.create_index("ix_activity_logs_user_id", "activity_logs", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_activity_logs_user_id", table_name="activity_logs")
    op.drop_index("ix_notifications_user_id", table_name="notifications")
    op.drop_index("ix_reviews_item_type_item_id", table_name="reviews")
    op.drop_index("ix_payments_user_id", table_name="payments")
    op.drop_index("ix_payments_booking_id", table_name="payments")
    op.drop_index("ix_bookings_status", table_name="bookings")
    op.drop_index("ix_bookings_user_id", table_name="bookings")
