"""merchant and merchant-user delete — a fifth status, not a fifth table

Revision ID: 0051_merchant_user_delete
Revises: 0050_hotel_enquiry_client_fare
Create Date: 2026-08-18

WHAT THIS IS FOR
Admin Portal is gaining a Delete action for both Merchants and Merchant
Users. A merchant has too much CASCADE-linked history (bookings, documents,
enquiries — 13 of 14 FKs against ``merchants.merchant_id`` cascade) for a
hard delete to ever be safe, so deletion is modelled as one more status,
exactly like ``suspended`` already is: ``DELETED`` on both
``merchant_status_enum`` and ``user_status_enum``. Login is already refused
for any non-``active`` status (``auth_service``), so this one enum value is
the entire mechanism — no new login-blocking code is needed anywhere.

A Merchant User with no booking/enquiry history is hard-deleted instead
(``account_service.delete_merchant_user``, mirroring the existing Admin
delete path) — ``users.user_id`` is referenced only by ``SET NULL`` FKs, so
that is schema-safe and needs no new enum value on its own. The
``DELETED`` status only fires for a user who does have history, or for
every user swept up by a merchant-level delete.

WHY ADD VALUE HERE RATHER THAN WAIT FOR THE REAL FEATURE
``ALTER TYPE ... ADD VALUE`` cannot run in the same transaction that later
uses the value (see 0033, 0038, 0048, 0049) — growing the enum ahead of the
code that uses it is the established pattern here, not a shortcut specific
to this migration.

BACKWARD COMPATIBILITY
Purely additive: two new enum values, no existing column, constraint, or
index touched. ``downgrade()`` is a no-op — Postgres cannot drop a value
from an enum type without rebuilding it, same standing rule as every other
enum-growth migration in this codebase.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0051_merchant_user_delete"
down_revision: Union[str, None] = "0050_hotel_enquiry_client_fare"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE merchant_status_enum ADD VALUE IF NOT EXISTS 'deleted'")
        op.execute("ALTER TYPE user_status_enum ADD VALUE IF NOT EXISTS 'deleted'")


def downgrade() -> None:
    # The enum values are left in place — PostgreSQL cannot drop a value from
    # an enum type without rebuilding it. Same standing rule as every other
    # enum-growth migration in this codebase (see 0033, 0038, 0048, 0049).
    pass
