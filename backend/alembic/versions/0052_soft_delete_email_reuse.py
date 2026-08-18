"""soft-delete must free the email for reuse

Revision ID: 0052_soft_delete_email_reuse
Revises: 0051_merchant_user_delete
Create Date: 2026-08-19

WHAT THIS IS FOR
0051 gave Merchant and Merchant User a ``deleted`` status, but
``merchants.email`` and ``users.email`` both still carried a plain,
unconditional ``UNIQUE`` constraint — so a soft-deleted row kept occupying
its email forever, and re-registering the same address after a delete
failed with "Email already registered" even once the application-level
checks are fixed to ignore deleted rows (see ``account_service`` and
``merchant_service`` in this same change).

WHY A PARTIAL INDEX RATHER THAN MANGLING THE STORED EMAIL
The constraint becomes ``UNIQUE (email) WHERE status != 'deleted'``: exactly
one non-deleted row may hold an email at a time, unlimited deleted rows may
share one. The original email stays exactly as it was on the deleted row —
no mangling, nothing to unwind — which is what "preserve historical data"
requires here. This is not a new pattern for this codebase:
``uq_hotel_enquiries_booking_request_id`` (migration 0048) already does the
same partial-uniqueness trick for a different column.

BACKWARD COMPATIBILITY
The dropped constraints never permitted two rows to share an email while
both existed, deleted or not — so no existing row can violate the narrower
replacement, and this applies cleanly to a database with live data.
``downgrade()`` restores the plain constraints; it fails only if some
`deleted` row is now sharing an email with a live one, which is the correct
failure (that state cannot arise going forward, but could not be silently
un-done if it somehow did).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0052_soft_delete_email_reuse"
down_revision: Union[str, None] = "0051_merchant_user_delete"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint("uq_merchants_email", "merchants", type_="unique")
    op.create_index(
        "ux_merchants_email_not_deleted", "merchants", ["email"],
        unique=True, postgresql_where=sa.text("status != 'deleted'"),
    )

    op.drop_constraint("uq_users_email", "users", type_="unique")
    op.create_index(
        "ux_users_email_not_deleted", "users", ["email"],
        unique=True, postgresql_where=sa.text("status != 'deleted'"),
    )


def downgrade() -> None:
    op.drop_index("ux_users_email_not_deleted", table_name="users")
    op.create_unique_constraint("uq_users_email", "users", ["email"])

    op.drop_index("ux_merchants_email_not_deleted", table_name="merchants")
    op.create_unique_constraint("uq_merchants_email", "merchants", ["email"])
