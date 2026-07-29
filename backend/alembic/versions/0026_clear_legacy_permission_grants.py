"""clear stale explicit permission grants from seeded accounts

Revision ID: 0026_clear_legacy_permissions
Revises: 0025_b2b_three_role_spec
Create Date: 2026-07-29

Migration 0023 seeded hand-written permission codes into
``users.permissions``. Those codes predate ``app/auth/rbac.py`` and no longer
match anything it defines (``catalog.manage``, ``booking.approve``,
``reports.export`` — note the last is a near-duplicate of the real
``report.export``).

Worse, they are *additive*. Effective permissions are the union of the role
matrix and the explicit grants, so a stale grant can only ever widen access:
the seeded super admin held ``payment.manage``, which the spec denies to that
role. A caught-in-testing example of why one authority beats two.

This clears the explicit grants on every existing row. The role matrix in
rbac.py then governs by itself, and ``users.permissions`` goes back to
meaning only "extras deliberately granted to this individual".
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0026_clear_legacy_permissions"
down_revision: Union[str, None] = "0025_b2b_three_role_spec"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: Codes written by the 0023 seed. Only these are removed — a grant added
#: later through the admin API is left alone.
LEGACY_CODES = (
    "catalog.manage",
    "booking.view",
    "booking.approve",
    "booking.reject",
    "booking.create",
    "payment.manage",
    "merchant.manage",
    "user.manage",
    "reports.export",
    "support.manage",
    "audit.view",
    "request.create",
    "request.view",
    "profile.manage",
)


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE users
            SET permissions = COALESCE(
                (
                    SELECT jsonb_agg(code)
                    FROM jsonb_array_elements_text(permissions) AS code
                    WHERE code <> ALL(:legacy)
                ),
                '[]'::jsonb
            )
            WHERE permissions <> '[]'::jsonb
            """
        ).bindparams(sa.bindparam("legacy", value=list(LEGACY_CODES), type_=sa.ARRAY(sa.Text)))
    )


def downgrade() -> None:
    # The original grants were wrong; deliberately not restored.
    pass
