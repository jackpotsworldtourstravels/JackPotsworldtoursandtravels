"""Somewhere to remember a transfer in flight (CR-10 follow-up).

WHY A COLUMN AND NOT A VARIABLE
Agent A presses Transfer; agent B accepts a few seconds later. Under
``WEB_CONCURRENCY=2`` those two sockets are usually on different workers, which
share no memory — so "this call is being transferred to B" cannot live in a
dict. Without somewhere durable, B's accept arrives at a worker that has never
heard of the transfer, and the only way to let it through would be to allow ANY
admin to take over ANY connected call. That is not a trade worth making to avoid
one column.

Redis would also work. A column is chosen because the rest of this feature's
state is already in this row, a transfer that half-happened is then visible to
anyone reading the table, and it survives a Redis restart mid-transfer.

``transfer_to_admin_id`` is NULL except during the seconds between the request
and its answer. It is cleared on accept, on decline, on timeout, and when the
call ends — so a stale value cannot leave a finished call looking transferable.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0067_call_transfer"
down_revision: Union[str, None] = "0066_customer_voice_calls"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "customer_calls",
        #: users.user_id of the agent being offered the call. No foreign key —
        #: the same B2C/B2B rule the rest of this table follows.
        sa.Column("transfer_to_admin_id", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "customer_calls",
        #: Who handed it over. Kept after the transfer completes, because "this
        #: call changed hands" is the interesting fact when someone later asks
        #: why a call has two agents in its history.
        sa.Column("transferred_from_admin_id", sa.BigInteger(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("customer_calls", "transferred_from_admin_id")
    op.drop_column("customer_calls", "transfer_to_admin_id")
