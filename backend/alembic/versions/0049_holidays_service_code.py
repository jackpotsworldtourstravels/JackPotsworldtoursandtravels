"""holidays service code — a fourth, placeholder product on the same gate

Revision ID: 0049_holidays_service_code
Revises: 0048_hotel_booking
Create Date: 2026-08-15

WHAT THIS IS FOR
Adds ``holidays`` as a fourth value on ``service_code_enum``, so an Admin can
grant or withhold a Holidays product per merchant the same way Flights,
Hotels and Visa already work. There is no Holidays *feature* behind this
yet — no enquiry table, no booking flow, nothing — this is purely the access
toggle, following the exact precedent Visa itself set in migration 0045:
the entitlement ships before the product does, and the Merchant Portal gates
a "coming soon" placeholder page on it in the meantime (see
``frontend/merchant-classic/js/classic-holidays.js``).

WHY ADD VALUE HERE RATHER THAN WAIT FOR THE REAL FEATURE
``ALTER TYPE ... ADD VALUE`` cannot run in the same transaction that later
uses the value (see 0033's note on 'manager', 0038's on 'reschedule_fee',
0048's on the seven hotel service-request types) — growing the enum ahead of
the code that uses it is the established pattern here, not a shortcut
specific to this migration.

WHY THE BACKFILL IS NOT OPTIONAL
Same reasoning as 0045: ``service_access_service.get_access_map`` already
defensively fills a missing row from ``DEFAULT_ACCESS``, so nothing would
break without this — but every other service code got an explicit row for
every existing merchant, and leaving Holidays as the one code that only ever
exists implicitly would make it the one row a direct SQL query or report
against this table silently omits. Seeded ``false`` for every existing
merchant, same as Hotels and Visa were.

BACKWARD COMPATIBILITY
Purely additive: one new enum value, one data backfill confined to the
existing table. No existing column, constraint, or index is touched.
``downgrade()`` reverses the backfill; the enum value is left in place
(Postgres cannot drop one — same standing rule as every other enum-growth
migration here).
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0049_holidays_service_code"
down_revision: Union[str, None] = "0048_hotel_booking"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE service_code_enum ADD VALUE IF NOT EXISTS 'holidays'")

    op.execute(
        """
        INSERT INTO merchant_service_access (merchant_id, service_code, enabled)
        SELECT merchant_id, 'holidays', false FROM merchants
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM merchant_service_access WHERE service_code = 'holidays'")
    # The enum value itself is left in place — PostgreSQL cannot drop a value
    # from an enum type without rebuilding it. Same standing rule as every
    # other enum-growth migration in this codebase (see 0033, 0038, 0048).
