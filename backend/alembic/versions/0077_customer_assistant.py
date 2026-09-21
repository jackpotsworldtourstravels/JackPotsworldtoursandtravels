"""The Travel Assistant's own conversations — guest or signed in.

The floating menu's Travel Assistant and Voice Assistant were a panel of four
canned replies. Making them answer for real needs somewhere to keep what was
said, and it cannot be ``customer_conversations`` (CR-9): that is a person
talking to our support staff and requires an account, while this answers a
visitor who has never signed in.

So two tables of its own:

* ``customer_assistant_sessions`` — one conversation. ``customer_id`` is
  NULLABLE, which is the guest case; the browser holds the random
  ``session_key`` instead. Signing in later stamps the account onto the row
  (``/api/customer/assistant/claim``), which is how a guest conversation
  becomes part of an account without copying a single message.
* ``customer_assistant_messages`` — the turns, with who said each one and the
  intent the assistant understood.

Both are ON DELETE CASCADE from their parent, so deleting a customer takes
their assistant history with it, exactly as the chat tables behave.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0077_customer_assistant"
down_revision: Union[str, None] = "0076_received_date_time"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer_assistant_sessions",
        sa.Column("customer_assistant_session_id", sa.BigInteger(), primary_key=True),
        sa.Column("session_key", sa.String(64), nullable=False),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=True,
        ),
        sa.Column("kind", sa.String(20), nullable=False, server_default="assistant"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_active_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("session_key", name="uq_customer_assistant_session_key"),
    )
    op.create_index(
        "ix_customer_assistant_sessions_customer_id",
        "customer_assistant_sessions", ["customer_id"],
    )

    op.create_table(
        "customer_assistant_messages",
        sa.Column("customer_assistant_message_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "session_id", sa.BigInteger(),
            sa.ForeignKey(
                "customer_assistant_sessions.customer_assistant_session_id", ondelete="CASCADE",
            ),
            nullable=False,
        ),
        sa.Column("sender", sa.String(16), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("intent", sa.String(40), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_customer_assistant_messages_session_id",
        "customer_assistant_messages", ["session_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_customer_assistant_messages_session_id", table_name="customer_assistant_messages")
    op.drop_table("customer_assistant_messages")
    op.drop_index("ix_customer_assistant_sessions_customer_id", table_name="customer_assistant_sessions")
    op.drop_table("customer_assistant_sessions")
