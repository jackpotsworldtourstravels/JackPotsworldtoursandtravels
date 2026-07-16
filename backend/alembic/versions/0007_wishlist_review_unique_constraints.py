"""prevent duplicate wishlist/review rows at the database level

Adds UNIQUE(user_id, item_type, item_id) to both tables so a race between two
concurrent requests can no longer both pass the app-level "does this already
exist" check and insert duplicates. The service layer catches the resulting
IntegrityError and converts it to the same clean 400 it already returns for
the non-concurrent case.

Revision ID: 0007_wishlist_review_unique
Revises: 0006_add_performance_indexes
Create Date: 2026-07-13

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0007_wishlist_review_unique"
down_revision: Union[str, None] = "0006_add_performance_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_wishlist_user_item", "wishlist", ["user_id", "item_type", "item_id"]
    )
    op.create_unique_constraint(
        "uq_reviews_user_item", "reviews", ["user_id", "item_type", "item_id"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_reviews_user_item", "reviews", type_="unique")
    op.drop_constraint("uq_wishlist_user_item", "wishlist", type_="unique")
