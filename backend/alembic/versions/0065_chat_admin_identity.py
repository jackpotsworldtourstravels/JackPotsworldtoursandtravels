"""Widen ck_customer_chat_messages_admin_identified (CR-9 follow-up).

WHAT WAS WRONG
0064 wrote the constraint as::

    (sender_type = 'admin') = (sender_admin_id IS NOT NULL)

and then, ninety lines further down, its own data migration inserts every
migrated staff reply with ``sender_admin_id = NULL`` — with a comment saying
why: ``customer_support_messages`` recorded ``author_name`` and never which
user row wrote the reply, and inventing an id would be worse than admitting
there isn't one.

So 0064 contained a constraint that forbids exactly what 0064 inserts. It only
got as far as production because this deployment had no staff replies on any
open ticket to migrate; on any database that did, ``alembic upgrade head``
would have aborted mid-migration.

WHAT THE RULE ACTUALLY IS
An admin message must SAY WHO WROTE IT. An id is the better answer and is what
every live reply carries; a name alone is the honest answer for history. Either
satisfies the intent. A customer message must still carry no admin id — that
half was never in question and is unchanged.

WHY NOT JUST FIX 0064 IN PLACE
It is applied here. Editing it alone would leave this database with the old
constraint and no migration to move it, so the schema and the model would
disagree for good. 0064 *is* also corrected, so a database built from scratch
gets the right constraint the first time and this migration is then a no-op
that re-states it — which is why the DROP is IF EXISTS and the ADD names the
same constraint.
"""
from alembic import op

revision = "0065_chat_admin_identity"
down_revision = "0064_customer_live_chat"
branch_labels = None
depends_on = None

_NAME = "ck_customer_chat_messages_admin_identified"
_WIDE = (
    "(sender_type <> 'admin' AND sender_admin_id IS NULL) OR "
    "(sender_type = 'admin' AND "
    "(sender_admin_id IS NOT NULL OR sender_name IS NOT NULL))"
)
_NARROW = "(sender_type = 'admin') = (sender_admin_id IS NOT NULL)"


def upgrade() -> None:
    op.execute(f"ALTER TABLE customer_chat_messages DROP CONSTRAINT IF EXISTS {_NAME}")
    op.execute(f"ALTER TABLE customer_chat_messages ADD CONSTRAINT {_NAME} CHECK ({_WIDE})")


def downgrade() -> None:
    """Narrowing again will fail if any named-only admin row exists.

    Deliberately not forced. Those rows are migrated support history; a
    downgrade that deleted them to satisfy a constraint would destroy the very
    thing 0064 existed to preserve. If this fails, the correct response is to
    stay on 0065.
    """
    op.execute(f"ALTER TABLE customer_chat_messages DROP CONSTRAINT IF EXISTS {_NAME}")
    op.execute(f"ALTER TABLE customer_chat_messages ADD CONSTRAINT {_NAME} CHECK ({_NARROW})")
