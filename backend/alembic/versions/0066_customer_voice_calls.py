"""Voice calls on a conversation (CR-10).

ONE TABLE. A call is an event that happens *inside* an existing conversation,
not a parallel universe with its own participants — so it hangs off
``customer_conversations`` and inherits its scoping, its customer, and the
assignment rules the chat already enforces. There is no separate "call session"
concept and no second place that knows who may talk to whom.

WHY A ROW IS WRITTEN THE MOMENT THE CALLER PRESSES CALL
The interesting outcomes are the ones where nothing happens: nobody answered,
the agent declined, the browser had no microphone. If the row were written when
a call *connects*, every one of those would leave no trace, and "Missed" could
not appear in the customer's call log at all — which the brief asks for by name.
So the row is created at ``calling`` and moves through the state machine; a call
that never connects is a row whose ``status`` says why and whose ``duration`` is
NULL rather than 0. NULL and 0 are different facts: NULL is "never connected",
0 is "connected and lasted under a second", and a support desk arguing about a
dropped call needs to be able to tell them apart.

``duration_seconds`` IS STORED, NOT DERIVED
It is computable from ``connected_at`` and ``ended_at``, and storing it anyway
is deliberate: those two columns are NULL for most rows, the call log sorts and
sums on duration, and a generated expression that is NULL in six of ten states
is harder to reason about than a column written once at hangup.

NO FOREIGN KEY ON ``admin_id`` — the same rule ``customer_conversations``
follows and for the same reason: ``users`` lives in the other SQLAlchemy
registry (models_v2), the two are deliberately not joined at the database level,
and a call's history must survive the agent's account being deleted. The
display name is denormalised alongside it, exactly as ``assigned_admin_name`` is.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0066_customer_voice_calls"
down_revision: Union[str, None] = "0065_chat_admin_identity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


#: The full lifecycle, including the transient states, because a row exists
#: from the first ring and the queue is read while calls are in progress.
#:
#:   calling    the caller pressed call; the callee has not been reached yet
#:   ringing    the callee's browser has the invitation on screen
#:   accepted   answered; SDP is being exchanged but media has not flowed
#:   connected  ICE succeeded and audio is live      <- the only billable state
#:   ended      hung up normally by either party     |
#:   rejected   the callee declined                  |
#:   missed     rang out with no answer              |- terminal
#:   cancelled  the CALLER hung up before an answer  |
#:   busy       the callee was already on a call     |
#:   failed     ICE never connected, or the media path died
#:
#: `cancelled` is not in the brief's status list, which has `missed` for both.
#: They are kept apart because they are different facts about different people:
#: missed is the agent not answering, cancelled is the customer changing their
#: mind. Collapsing them would make the agent's own miss-rate unmeasurable.
_CALL_STATUS = postgresql.ENUM(
    "calling", "ringing", "accepted", "connected",
    "ended", "rejected", "missed", "cancelled", "busy", "failed",
    name="customer_call_status_enum", create_type=False,
)

#: Who hung up. NULL while the call is live, and for a call that failed on its
#: own — "nobody ended this, it broke" is a distinct and useful answer.
_ENDED_BY = postgresql.ENUM(
    "customer", "admin", "system",
    name="customer_call_ended_by_enum", create_type=False,
)

_DIRECTION = postgresql.ENUM(
    "customer_to_admin", "admin_to_customer",
    name="customer_call_direction_enum", create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    _CALL_STATUS.create(bind, checkfirst=True)
    _ENDED_BY.create(bind, checkfirst=True)
    _DIRECTION.create(bind, checkfirst=True)

    op.create_table(
        "customer_calls",
        sa.Column("call_id", sa.BigInteger(), primary_key=True),
        #: The public identifier. Every signalling frame carries it, so it is
        #: the one call field a browser ever sees. A uuid rather than `call_id`
        #: because the integer is guessable and a signalling frame naming
        #: somebody else's call must not be a matter of arithmetic.
        sa.Column("public_id", sa.String(length=36), nullable=False),
        sa.Column(
            "conversation_id", sa.BigInteger(),
            sa.ForeignKey("customer_conversations.conversation_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        #: users.user_id, deliberately without a FK — see the module docstring.
        #: NULL until somebody answers: an unanswered call has no agent.
        sa.Column("admin_id", sa.BigInteger(), nullable=True),
        sa.Column("admin_name", sa.String(length=150), nullable=True),
        sa.Column("direction", _DIRECTION, nullable=False),
        sa.Column("status", _CALL_STATUS, nullable=False, server_default=sa.text("'calling'")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
        #: When the callee's device actually showed the invitation. NULL means
        #: it never did — the ring reached nobody, which is a different failure
        #: from ringing out, and the only way to tell them apart later.
        sa.Column("ringing_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
        #: ICE succeeded. Duration is measured from HERE, not from answered_at:
        #: the seconds spent negotiating are not seconds anyone could talk.
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_by", _ENDED_BY, nullable=True),
        #: NULL for a call that never connected. See the module docstring on
        #: why that is not zero.
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        #: A short machine reason on a failure — "ice_failed", "no_microphone",
        #: "callee_offline". Shown to nobody; read when someone asks why the
        #: call quality complaints all came from one week.
        sa.Column("failure_reason", sa.String(length=60), nullable=True),
        sa.CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds >= 0",
            name="ck_customer_calls_duration_sane",
        ),
        sa.CheckConstraint(
            "connected_at IS NULL OR answered_at IS NOT NULL",
            name="ck_customer_calls_connected_implies_answered",
        ),
    )

    op.create_index(
        "uq_customer_calls_public_id", "customer_calls", ["public_id"], unique=True,
    )
    #: The customer's "Recent Calls" list: one conversation, newest first.
    op.create_index(
        "ix_customer_calls_conversation",
        "customer_calls", ["conversation_id", sa.text("call_id DESC")],
    )
    #: The agent's own call history, and the miss-rate query.
    op.create_index(
        "ix_customer_calls_admin", "customer_calls", ["admin_id", sa.text("call_id DESC")],
    )
    #: ONE LIVE CALL PER CONVERSATION, enforced by the database rather than by
    #: a check in Python. Two tabs, or a double-tapped call button under two
    #: workers, both pass a `SELECT ... if none: INSERT` — this is the same
    #: partial-unique trick `uq_customer_conversation_live` uses, and it is why
    #: `call_busy` can be produced by catching an IntegrityError instead of by
    #: a race everybody loses differently.
    op.create_index(
        "uq_customer_calls_live", "customer_calls", ["conversation_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('calling', 'ringing', 'accepted', 'connected')"),
    )


def downgrade() -> None:
    op.drop_index("uq_customer_calls_live", table_name="customer_calls")
    op.drop_index("ix_customer_calls_admin", table_name="customer_calls")
    op.drop_index("ix_customer_calls_conversation", table_name="customer_calls")
    op.drop_index("uq_customer_calls_public_id", table_name="customer_calls")
    op.drop_table("customer_calls")
    bind = op.get_bind()
    _DIRECTION.drop(bind, checkfirst=True)
    _ENDED_BY.drop(bind, checkfirst=True)
    _CALL_STATUS.drop(bind, checkfirst=True)
