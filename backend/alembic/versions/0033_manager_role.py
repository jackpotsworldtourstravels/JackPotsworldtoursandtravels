"""add the platform Manager role — the approval step between the enquiry desk and booking ops

Revision ID: 0033_manager_role
Revises: 0032_request_notes
Create Date: 2026-07-31

WHY A ROLE AND NOT A PERMISSION GRANT
CR-2 puts a Manager between the merchant's submitted Booking Request and the
Admin Booking Operations queue. That Manager is deliberately *not* an Admin with
one extra code: an Admin already reviews the Ticket Enquiry that precedes the
booking, and letting the same account also sign off the booking it made
available collapses the two-person control the change request exists to create.
A separate ``user_role_enum`` value is what makes "the enquiry desk cannot
approve its own bookings" enforceable rather than a convention.

WHY NO DATA MIGRATION
Nothing is reclassified. Existing admins stay admins; a Manager account is
created through the ordinary user-creation path. ``users.merchant_role`` stays
NULL for a Manager, which the existing ``ck_users_merchant_role_scope``
constraint already requires of every non-merchant role.

WHY THE VALUE IS ADDED IN ITS OWN MIGRATION STEP, IN AN AUTOCOMMIT BLOCK
``ALTER TYPE ... ADD VALUE`` is transactional on PostgreSQL 12+, but the new
label cannot be *used* by the same transaction that adds it. Nothing here writes
a 'manager' row for exactly that reason — see migration 0025, which added
request-status values the same way.

Splitting the label and its first use across two migrations is **not** enough on
its own. ``alembic/env.py`` wraps the whole upgrade run in one transaction
(``with context.begin_transaction(): context.run_migrations()``), so a run that
applies 0033 and 0034 together leaves the label uncommitted when 0034 names it,
and PostgreSQL rejects it::

    (psycopg2.errors.UnsafeNewEnumValueUsage) unsafe use of new value "manager"
    of enum type user_role_enum
    HINT:  New enum values must be committed before they can be used.

0025 never hit this only because its label and its first use happened to be
applied in different deploys. ``autocommit_block()`` makes the guarantee real
instead of incidental: it commits the pending transaction and runs the
``ALTER TYPE`` outside it, so the label is durable before any later migration
refers to it — regardless of how many migrations one run applies.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0033_manager_role"
down_revision: Union[str, None] = "0032_request_notes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role_enum ADD VALUE IF NOT EXISTS 'manager'")


def downgrade() -> None:
    # PostgreSQL cannot drop a value from an enum type. Removing it would mean
    # recreating user_role_enum and rewriting every column that uses it, which
    # is a far more destructive operation than the one being undone — and any
    # surviving 'manager' row would block it anyway. Left as a no-op on purpose:
    # an unused enum label costs nothing.
    pass
