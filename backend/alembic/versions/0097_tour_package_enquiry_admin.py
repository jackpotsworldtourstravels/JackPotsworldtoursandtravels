"""tour_package_enquiry_admin — admin-management columns for the Tour Package
enquiry desk (Phase 2 Bug 3).

Migration 0091 created ``tour_package_enquiries`` for the public form only, with
a three-value status (NEW/CONTACTED/CLOSED) and no way to assign, note or track
an enquiry — it said so itself ("this desk has no admin screen yet"). This adds
the screen's backing columns, mirroring what ``gaming_tour_enquiries`` (0088)
already carries:

  * ``assigned_admin_id``  the staff member working it (users.user_id, ON
                           DELETE SET NULL — retiring an account unassigns,
                           never deletes the enquiry).
  * ``admin_notes``        free-text internal notes, never shown to the customer.
  * ``updated_at``         last-touched, so the queue can show staleness.

It also WIDENS the status CHECK to a real workflow
(NEW/ASSIGNED/CONTACTED/QUOTE_SENT/CONVERTED/CLOSED/CANCELLED). The three
original values are a subset, so every existing row stays valid and the change
is backward compatible.

PURELY ADDITIVE AND REVERSIBLE. The public submission path
(``tour_package_enquiry_service.create`` and the Contact Us form) is untouched:
it still writes ``status='NEW'`` and never sets the new columns. The downgrade
restores the original three-value CHECK — safe only while no row has moved to
one of the new statuses, which is the normal precondition for reverting a
feature that has not been used.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0097_tour_package_enquiry_admin"
down_revision: Union[str, None] = "0096_customer_booking_notifications"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "tour_package_enquiries"
_STATUS_CK = "ck_tour_package_enq_status"
_NEW_STATUSES = ("NEW", "ASSIGNED", "CONTACTED", "QUOTE_SENT", "CONVERTED", "CLOSED", "CANCELLED")
_OLD_STATUSES = ("NEW", "CONTACTED", "CLOSED")


def _status_ck(values) -> str:
    return "status IN (" + ", ".join(f"'{s}'" for s in values) + ")"


def upgrade() -> None:
    op.add_column(
        TABLE,
        sa.Column(
            "assigned_admin_id", sa.BigInteger(),
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.add_column(TABLE, sa.Column("admin_notes", sa.Text(), nullable=True))
    op.add_column(
        TABLE,
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(),
        ),
    )

    # Widen the status workflow. Drop then recreate — the original three values
    # are a subset of the new set, so no existing row can violate the new check.
    op.drop_constraint(_STATUS_CK, TABLE, type_="check")
    op.create_check_constraint(_STATUS_CK, TABLE, _status_ck(_NEW_STATUSES))

    op.create_index("ix_tour_package_enquiries_status", TABLE, ["status"])


def downgrade() -> None:
    op.drop_index("ix_tour_package_enquiries_status", table_name=TABLE)

    op.drop_constraint(_STATUS_CK, TABLE, type_="check")
    op.create_check_constraint(_STATUS_CK, TABLE, _status_ck(_OLD_STATUSES))

    op.drop_column(TABLE, "updated_at")
    op.drop_column(TABLE, "admin_notes")
    op.drop_column(TABLE, "assigned_admin_id")
