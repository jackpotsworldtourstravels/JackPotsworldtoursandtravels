"""customer_reviews moderation + admin reply — Phase 6 of the B2C Admin Portal
build-out.

WHY COLUMNS ON THE EXISTING TABLE, NOT A NEW ONE. A review's moderation state
and the desk's reply are facts about that one review (1:1, never more than one
reply), so they live beside it. ``customer_reviews`` has carried the review
itself since migration 0054; nothing here changes what a customer wrote.

``status`` is ``pending`` -> ``approved`` | ``rejected``. A plain string with a
CHECK, the same call 0088/0089 made for their own status columns. New reviews
start ``pending``: the public ``GET /api/customer/reviews`` now serves only
``approved`` ones, so nothing a customer types is shown to other visitors until
the desk has read it. A customer editing their review sends it back to
``pending`` (done in ``customer_account_service``), otherwise an approved
review could be rewritten into something unreviewed.

BACKFILL: every row that exists when this runs was already publicly visible, so
it is marked ``approved`` rather than silently disappearing from the site the
moment this ships. (There are none in the development database today; the rule
is for any environment that has some.)

WHO MODERATED IS NOT A COLUMN, on the same reasoning as 0089: the admin lives
in ``models_v2``'s ``users`` table, a different Base, so the actor is recorded
in the portal-wide activity log like every other admin action in this build-out.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0090_customer_review_moderation"
down_revision: Union[str, None] = "0089_customer_cancellations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

STATUSES = ("pending", "approved", "rejected")


def upgrade() -> None:
    op.add_column(
        "customer_reviews",
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
    )
    # Everything that exists now was already live: keep it live.
    op.execute("UPDATE customer_reviews SET status = 'approved'")
    op.add_column("customer_reviews", sa.Column("admin_reply", sa.Text(), nullable=True))
    op.add_column("customer_reviews", sa.Column("replied_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("customer_reviews", sa.Column("moderated_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        "ck_customer_review_status", "customer_reviews",
        "status IN (" + ", ".join(f"'{s}'" for s in STATUSES) + ")",
    )
    op.create_index("ix_customer_reviews_status", "customer_reviews", ["status"])


def downgrade() -> None:
    op.drop_index("ix_customer_reviews_status", table_name="customer_reviews")
    op.drop_constraint("ck_customer_review_status", "customer_reviews", type_="check")
    op.drop_column("customer_reviews", "moderated_at")
    op.drop_column("customer_reviews", "replied_at")
    op.drop_column("customer_reviews", "admin_reply")
    op.drop_column("customer_reviews", "status")
