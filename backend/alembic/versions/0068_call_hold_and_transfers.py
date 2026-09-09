"""What a call did while it was live: how long it sat on hold, and every pair
of hands it passed through.

WHY HOLD IS SUDDENLY PERSISTED
``call_handlers.hold()`` says, correctly, that hold is "a property of a live
session, not of the call's history" — a hold flag surviving in the database
after the socket died would leave the next reader thinking a finished call is
still paused. That reasoning is about the FLAG. It is not about the DURATION.

"Six minutes, four of them on hold" is a different call from "six minutes of
conversation", and only one of those is worth a supervisor's attention. So the
flag stays out of the row and the accumulated seconds go in. ``held_since`` is
the exception that makes the sum possible: it is the open bracket of the
current hold and is closed — into ``hold_seconds`` — on resume, on transfer and
on hangup. A call that ends while still held has its final stretch closed by
``finish()``, so no hold is ever lost because nobody pressed Resume.

WHY THE CHAIN IS A COLUMN AND NOT A TABLE
``transferred_from_admin_id`` remembers one hop. A call that goes A -> B -> C
overwrites A with B and the first agent vanishes from its own call's history,
which is precisely the question anyone asks afterwards: who had this customer,
and for how long. A second hop is not an edge case — it is what happens when B
transfers to a specialist.

A ``customer_call_transfers`` table would model it properly and is the wrong
trade here, for the reason 0067 already gives about ``transfer_to_admin_id``:
the rest of this feature's state is in this row, the chain is read only with
the call it belongs to, it is never queried across calls, and it is bounded by
how many times a human will hand one conversation over. A JSONB array keeps a
finished call readable in a single SELECT.

``transferred_from_admin_id`` is deliberately KEPT. It is what every existing
reader looks at, the chain is additive, and removing a column to replace it
with a superset is how a migration turns into an outage.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0068_call_hold_and_transfers"
down_revision: Union[str, None] = "0067_call_transfer"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "customer_calls",
        #: Total seconds this call spent on hold, summed across every hold it
        #: had. NOT NULL with a default of 0: "never held" is a real answer and
        #: a nullable integer would make every reader handle None to say it.
        sa.Column(
            "hold_seconds", sa.Integer(), nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "customer_calls",
        #: The open bracket of the hold currently in progress, NULL the rest of
        #: the time. The only piece of live hold state that is persisted, and
        #: only because the sum above cannot be computed without it.
        sa.Column("held_since", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "customer_calls",
        #: Every completed handover, oldest first:
        #: ``[{"from_admin_id", "from_admin_name", "to_admin_id",
        #:     "to_admin_name", "at"}]``
        #: An empty array means the agent who answered is the agent who hung up.
        sa.Column(
            "transfer_chain", JSONB(), nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("customer_calls", "transfer_chain")
    op.drop_column("customer_calls", "held_since")
    op.drop_column("customer_calls", "hold_seconds")
