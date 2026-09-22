"""A merchant is active when it is saved — no approval step, and none pending.

WHY THE WORKFLOW WENT. An Admin created a merchant and then an Admin approved
it. Those are the same person here: there is no separate approver, no vetting
desk and no second pair of eyes the step was protecting. What it actually did
was leave a company at "Pending Approval", unable to sign in, until somebody
clicked a button that never said no.

WHAT THIS MIGRATION HAS TO FIX. Removing the button is not enough on its own.
Any company sitting at ``pending_approval`` right now would be stranded — the
only route out of that state was the Approve action, and that action no longer
exists. So every one of them is moved to ``active``, which is what approving
them would have done and what creating them today does.

  * A suspended, inactive or deleted merchant is NOT touched. Those are states
    somebody chose, and this migration must not quietly un-suspend anyone.

THE ENUM VALUE STAYS. ``pending_approval`` remains a member of
``merchant_status_enum`` and of ``MerchantStatus``, deliberately: dropping a
value from a PostgreSQL enum means rebuilding the type and rewriting every
column that uses it, and the only thing that buys is tidiness. Nothing writes
it any more, and a restored backup that still contains one loads rather than
raising. There are no ``approved_by``/``approved_at``/``approval_status``
columns on ``merchants`` to drop — the workflow was a status value and a
button, never a table of its own.

THE PERMISSION GOES FROM THE PEOPLE WHO HOLD IT. ``merchant.approve`` is not a
row in a table; it is a string inside each user's ``permissions`` JSONB array.
It is stripped here so the admin screens do not list a code that no endpoint
accepts. Every other permission in the array is left exactly as it is.

Reversing this restores the permission to the admins who would be granted it
today and leaves the merchants active — which is correct, because it cannot
know which of them were pending before, and inventing that would put working
companies back behind a door with no handle.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0078_merchant_no_approval"
down_revision: Union[str, None] = "0077_customer_assistant"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: The role grant in app/auth/rbac.py that used to include this code.
_ADMIN_ROLES = ("admin",)


def upgrade() -> None:
    conn = op.get_bind()

    moved = conn.execute(sa.text(
        "UPDATE merchants SET status = 'active', updated_at = now() "
        "WHERE status = 'pending_approval'"
    )).rowcount
    print(f"  0078: {moved} merchant(s) released from pending_approval")

    # jsonb_agg over the array minus the retired code. FILTER, not a rebuild
    # of the whole permission set: two admins with different grants must stay
    # different afterwards.
    stripped = conn.execute(sa.text("""
        UPDATE users
           SET permissions = COALESCE((
                   SELECT jsonb_agg(p)
                     FROM jsonb_array_elements(permissions) AS p
                    WHERE p <> '"merchant.approve"'::jsonb
               ), '[]'::jsonb)
         WHERE permissions @> '["merchant.approve"]'::jsonb
    """)).rowcount
    print(f"  0078: merchant.approve removed from {stripped} user(s)")


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("""
        UPDATE users
           SET permissions = permissions || '["merchant.approve"]'::jsonb
         WHERE role::text = ANY(:roles)
           AND NOT permissions @> '["merchant.approve"]'::jsonb
    """).bindparams(sa.bindparam("roles", value=list(_ADMIN_ROLES))))
