"""let a Manager exist — widen ck_users_merchant_scope to the new role

Revision ID: 0034_manager_scope_constraint
Revises: 0033_manager_role
Create Date: 2026-07-31

WHY THIS IS NOT PART OF 0033
``ck_users_merchant_scope`` enumerates the roles by literal:

    (role IN ('merchant_admin','merchant_user') AND merchant_id IS NOT NULL)
    OR (role IN ('super_admin','admin','customer') AND merchant_id IS NULL)

so adding 'manager' to ``user_role_enum`` was not enough — every Manager insert
failed the constraint, because a Manager has no merchant and 'manager' was in
neither list. Rewriting the constraint has to compare against the literal
'manager', which PostgreSQL must cast to ``user_role_enum``, and **a new enum
label cannot be used by the transaction that added it**. 0033 adds the label
inside an ``autocommit_block()`` so it is committed before this migration runs —
being a separate revision is not by itself enough, because ``env.py`` runs the
whole upgrade in a single transaction. See 0033 for the failure this caused.

The rule itself is unchanged in spirit: a merchant's staff must have a merchant,
and platform staff must not. Manager joins the second group.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0034_manager_scope_constraint"
down_revision: Union[str, None] = "0033_manager_role"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_WITH_MANAGER = (
    "(role IN ('merchant_admin', 'merchant_user') AND merchant_id IS NOT NULL) "
    "OR (role IN ('super_admin', 'admin', 'manager', 'customer') "
    "AND merchant_id IS NULL)"
)

_WITHOUT_MANAGER = (
    "(role IN ('merchant_admin', 'merchant_user') AND merchant_id IS NOT NULL) "
    "OR (role IN ('super_admin', 'admin', 'customer') AND merchant_id IS NULL)"
)


def upgrade() -> None:
    op.drop_constraint("ck_users_merchant_scope", "users", type_="check")
    op.create_check_constraint("ck_users_merchant_scope", "users", _WITH_MANAGER)


def downgrade() -> None:
    # Any Manager row would fail the narrower constraint, so they are demoted to
    # Admin first rather than letting the migration die half-applied. Losing the
    # separation is the *point* of the downgrade; losing the account is not.
    op.execute("UPDATE users SET role = 'admin' WHERE role = 'manager'")
    op.drop_constraint("ck_users_merchant_scope", "users", type_="check")
    op.create_check_constraint("ck_users_merchant_scope", "users", _WITHOUT_MANAGER)
