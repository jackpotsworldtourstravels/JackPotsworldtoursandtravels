"""Live chat between a customer and support — one conversation, not tickets.

WHAT THIS REPLACES. ``customer_support_tickets`` (0054) modelled help as a
series of *issues*: subject, description, priority, status, each its own thread.
CR-9 models it as a *relationship*: one conversation per customer, open forever,
exactly as WhatsApp or Messenger works. There is no subject, no category and no
ticket id anywhere below.

THE TICKET TABLES ARE NOT DROPPED HERE, ON PURPOSE.
Their rows are copied into conversations by this migration, but the tables stay.
Two reasons, and the second is the one that matters:

  * A release needs to prove the migrated history reads correctly before the
    original is destroyed.
  * ``downgrade()`` must be total. This project rolled 0063 -> 0052 on
    production on 2026-09-03 and will roll something back again; a downgrade
    that cannot restore what its upgrade consumed turns a routine rollback into
    data loss. Because the ticket tables are only ever READ here, dropping the
    three new tables restores the previous state exactly.

0065 drops them, once.

NO FOREIGN KEY TO ``users``, AND THAT IS DELIBERATE.
``assigned_admin_id`` and ``sender_admin_id`` hold a merchant-side
``users.user_id`` as a plain integer with no constraint. models_customer.py's
docstring is explicit that the two registries exist so a B2C/B2B relationship
"cannot be written by accident", and this module has never carried a foreign key
across that line. Adding the first one for a chat feature would be a poor place
to spend that decision.

The cost is a dangling id when an admin is deleted, and it is paid the same way
``customer_support_messages.author_name`` already pays it: the display name is
DENORMALISED at the moment the message is written. That is not redundancy — the
name of the person who answered in March is a historical fact, and it should not
change because that person later married or left the company.

WHY ONE CONVERSATION PER CUSTOMER IS AN INDEX AND NOT A CONVENTION.
``uq_customer_conversation_live`` is a UNIQUE index on ``customer_id`` filtered
to ``status <> 'closed'``. "Reopening Support Center loads the same thread" is
then a property of the database rather than a promise the application makes.
Without it, two requests racing — a double-clicked widget, a page open in two
tabs — both pass a Python "does one exist?" check and create two threads, and
the customer's history silently forks. Following 0037: "The database owns
correctness. A uniqueness rule that must hold is a constraint or a unique index,
never a check-then-act in Python."

Filtering the index to non-closed rows is what still allows a customer to
accumulate a history of closed conversations while having at most one live.

WHY ``client_msg_id`` EXISTS.
A reconnecting socket retries sends it is not sure landed. Without a
client-generated id and a unique index over it, every flaky mobile connection
duplicates messages. This is the same mechanism as 0060/0061 for bookings, for
the same reason, and — as there — the column is NULLABLE so that any number of
rows may carry no key at all, because Postgres treats NULLs as distinct in a
unique index.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0064_customer_live_chat"
down_revision: Union[str, None] = "0063_booking_confirmed_notif"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


#: waiting -> active -> resolved -> closed. A closed conversation is archived;
#: the partial unique index lets the next message start a fresh one.
_CONV_STATUS = postgresql.ENUM(
    "waiting", "active", "resolved", "closed",
    name="customer_conversation_status_enum", create_type=False,
)
#: `system` covers "chat assigned", "chat closed" and internal notes — events
#: that belong in the thread's chronology but were not typed by either party.
_SENDER_TYPE = postgresql.ENUM(
    "customer", "admin", "system",
    name="customer_chat_sender_enum", create_type=False,
)
_MESSAGE_TYPE = postgresql.ENUM(
    "text", "image", "file", "system",
    name="customer_chat_message_type_enum", create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()

    _CONV_STATUS.create(bind, checkfirst=True)
    _SENDER_TYPE.create(bind, checkfirst=True)
    _MESSAGE_TYPE.create(bind, checkfirst=True)

    # ------------------------------------------------------------------ 1/3 --
    op.create_table(
        "customer_conversations",
        sa.Column("conversation_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        #: A merchant-side users.user_id. NO FOREIGN KEY — see the module
        #: docstring. NULL means unassigned, which is what "waiting" means.
        sa.Column("assigned_admin_id", sa.BigInteger(), nullable=True),
        #: Denormalised at assignment. Survives the admin being renamed or
        #: deleted, which is the point.
        sa.Column("assigned_admin_name", sa.String(length=150), nullable=True),
        sa.Column("status", _CONV_STATUS, nullable=False, server_default=sa.text("'waiting'")),
        #: Denormalised preview for the admin queue. Without it the queue is an
        #: N+1 over messages on every poll of a screen an agent leaves open.
        sa.Column("last_message", sa.String(length=500), nullable=True),
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True),
        #: Badge counts, kept as counters so a widget badge is one column read
        #: rather than a COUNT over the message table on every page load.
        sa.Column("customer_unread_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("admin_unread_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(), onupdate=sa.func.now(),
        ),
        sa.CheckConstraint(
            "customer_unread_count >= 0 AND admin_unread_count >= 0",
            name="ck_customer_conversations_unread_non_negative",
        ),
    )
    # AT MOST ONE LIVE CONVERSATION PER CUSTOMER — see the module docstring.
    op.create_index(
        "uq_customer_conversation_live", "customer_conversations", ["customer_id"],
        unique=True, postgresql_where=sa.text("status <> 'closed'"),
    )
    #: The admin queue: filter by status, newest activity first.
    op.create_index(
        "ix_customer_conversations_queue", "customer_conversations",
        ["status", sa.text("last_message_at DESC")],
    )
    #: "My chats" for one agent.
    op.create_index(
        "ix_customer_conversations_admin", "customer_conversations",
        ["assigned_admin_id", "status"],
    )

    # ------------------------------------------------------------------ 2/3 --
    op.create_table(
        "customer_chat_messages",
        sa.Column("message_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "conversation_id", sa.BigInteger(),
            sa.ForeignKey("customer_conversations.conversation_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sender_type", _SENDER_TYPE, nullable=False),
        #: users.user_id, no FK. NULL for customer and system messages.
        sa.Column("sender_admin_id", sa.BigInteger(), nullable=True),
        #: Denormalised, exactly as customer_support_messages.author_name is.
        sa.Column("sender_name", sa.String(length=150), nullable=True),
        #: NULL when the message carries only an attachment.
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("message_type", _MESSAGE_TYPE, nullable=False, server_default=sa.text("'text'")),
        #: An internal note is a real message in the thread's chronology, so an
        #: agent reads it in the order it was written — but it is filtered out
        #: of every customer-facing query in the service layer.
        sa.Column("is_internal", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        #: Idempotency. See the module docstring.
        sa.Column("client_msg_id", sa.String(length=64), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        #: Soft delete. "Delete own message" leaves a tombstone so the other
        #: party's history does not silently rewrite itself.
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        #: A message with neither text nor an attachment is not a message. The
        #: attachment case is checked in the service layer, because the row is
        #: written before its attachments are linked.
        sa.CheckConstraint(
            "body IS NOT NULL OR message_type <> 'text'",
            name="ck_customer_chat_messages_text_has_body",
        ),
        #: An admin message must SAY WHO WROTE IT — by id, or by name alone
        #: for the replies migrated out of `customer_support_messages`,
        #: which only ever recorded `author_name`. A customer message must
        #: carry no admin id at all.
        #:
        #: This was `(sender_type = 'admin') = (sender_admin_id IS NOT NULL)`
        #: until 0065, which rejected every row _migrate_tickets() below
        #: writes for a staff reply — the migration's own comment explains
        #: why that id is NULL, three lines from the constraint forbidding it.
        sa.CheckConstraint(
            "(sender_type <> 'admin' AND sender_admin_id IS NULL) OR "
            "(sender_type = 'admin' AND "
            "(sender_admin_id IS NOT NULL OR sender_name IS NOT NULL))",
            name="ck_customer_chat_messages_admin_identified",
        ),
    )
    #: The only read path that matters: one conversation, newest first, paged.
    op.create_index(
        "ix_customer_chat_messages_thread", "customer_chat_messages",
        ["conversation_id", sa.text("message_id DESC")],
    )
    op.create_index(
        "uq_customer_chat_messages_client_id", "customer_chat_messages",
        ["conversation_id", "client_msg_id"], unique=True,
        postgresql_where=sa.text("client_msg_id IS NOT NULL"),
    )

    # ------------------------------------------------------------------ 3/3 --
    op.create_table(
        "customer_chat_attachments",
        sa.Column("attachment_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "message_id", sa.BigInteger(),
            sa.ForeignKey("customer_chat_messages.message_id", ondelete="CASCADE"),
            nullable=False,
        ),
        #: A storage.py key, already validated by validate_key() before it is
        #: written. Never the customer's filename.
        sa.Column("storage_key", sa.String(length=400), nullable=False),
        #: The customer's original name, for display and download only.
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("mime_type", sa.String(length=100), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "file_size > 0 AND file_size <= 10485760",
            name="ck_customer_chat_attachments_size",
        ),
    )
    op.create_index(
        "ix_customer_chat_attachments_message", "customer_chat_attachments", ["message_id"],
    )

    _migrate_tickets(bind)


def _migrate_tickets(bind) -> None:
    """Copy ticket history into conversations. Read-only over the old tables.

    One conversation per customer, holding every ticket that customer ever
    raised, in the order they were raised.

    THE SUBJECT IS PREPENDED TO THE FIRST MESSAGE, NOT EMITTED AS ITS OWN.
    ``customer_account_service.create_ticket`` already writes the description as
    the ticket's first ``customer_support_messages`` row — its comment says so:
    "The description is the ticket's own first message". An earlier draft of
    this function emitted ``subject + description`` as an opening message and
    *then* replayed the messages, which printed the description twice in every
    migrated thread. Prefixing instead keeps the subject (it is the only place
    that text exists) without repeating anything.

    A ticket with no messages at all — none exist today, but nothing stops one —
    falls back to ``subject + description``, so its text cannot be lost either.

    Original timestamps are preserved throughout. A migrated history that all
    claims to have happened at deploy time is not history.
    """
    tickets = bind.execute(sa.text("""
        SELECT customer_support_ticket_id, customer_id, subject, description,
               status, created_at
        FROM customer_support_tickets
        ORDER BY customer_id, created_at, customer_support_ticket_id
    """)).mappings().all()
    if not tickets:
        return

    messages = bind.execute(sa.text("""
        SELECT customer_support_ticket_id, author_name, is_staff, message, created_at
        FROM customer_support_messages
        ORDER BY customer_support_ticket_id, customer_support_message_id
    """)).mappings().all()

    by_ticket: dict[int, list] = {}
    for m in messages:
        by_ticket.setdefault(m["customer_support_ticket_id"], []).append(m)

    by_customer: dict[int, list] = {}
    for t in tickets:
        by_customer.setdefault(t["customer_id"], []).append(t)

    for customer_id, customer_tickets in by_customer.items():
        # Every migrated ticket resolved or closed -> the conversation is
        # settled. Anything still open means the customer is still waiting, and
        # the queue must show them.
        live = any(t["status"] not in ("resolved", "closed") for t in customer_tickets)
        status = "waiting" if live else "resolved"

        conversation_id = bind.execute(sa.text("""
            INSERT INTO customer_conversations
                (customer_id, status, created_at, updated_at)
            VALUES (:customer_id, CAST(:status AS customer_conversation_status_enum),
                    :created_at, :created_at)
            RETURNING conversation_id
        """), {
            "customer_id": customer_id,
            "status": status,
            "created_at": customer_tickets[0]["created_at"],
        }).scalar_one()

        last_body = None
        last_at = None
        for t in customer_tickets:
            subject = (t["subject"] or "").strip()
            ticket_messages = by_ticket.get(t["customer_support_ticket_id"], [])
            rows = []
            if ticket_messages:
                for i, m in enumerate(ticket_messages):
                    body = m["message"]
                    # The subject rides on the first message rather than
                    # becoming one of its own — see the docstring.
                    if i == 0 and subject:
                        body = f"{subject}\n\n{body}"
                    rows.append((
                        "admin" if m["is_staff"] else "customer",
                        None,
                        m["author_name"] if m["is_staff"] else None,
                        body,
                        m["created_at"],
                    ))
            else:
                opening = subject
                description = (t["description"] or "").strip()
                if description:
                    opening = f"{opening}\n\n{description}" if opening else description
                if opening:
                    rows.append(("customer", None, None, opening, t["created_at"]))
            for sender_type, admin_id, sender_name, body, created_at in rows:
                bind.execute(sa.text("""
                    INSERT INTO customer_chat_messages
                        (conversation_id, sender_type, sender_admin_id, sender_name,
                         body, message_type, created_at)
                    VALUES (:conversation_id,
                            CAST(:sender_type AS customer_chat_sender_enum),
                            :admin_id, :sender_name, :body,
                            CAST('text' AS customer_chat_message_type_enum),
                            :created_at)
                """), {
                    "conversation_id": conversation_id,
                    "sender_type": sender_type,
                    # Migrated staff replies have a NAME but no id: the old table
                    # never recorded which user wrote them, and inventing one
                    # would be worse than admitting it.
                    "admin_id": None,
                    "sender_name": sender_name,
                    "body": body,
                    "created_at": created_at,
                })
                last_body, last_at = body, created_at

        bind.execute(sa.text("""
            UPDATE customer_conversations
               SET last_message = :last_message, last_message_at = :last_at
             WHERE conversation_id = :conversation_id
        """), {
            "conversation_id": conversation_id,
            "last_message": (last_body or "")[:500] or None,
            "last_at": last_at,
        })


def downgrade() -> None:
    """Total. The ticket tables were only read, so dropping these restores the
    exact prior state — see the module docstring on why that matters here."""
    bind = op.get_bind()

    op.drop_index("ix_customer_chat_attachments_message", table_name="customer_chat_attachments")
    op.drop_table("customer_chat_attachments")

    op.drop_index("uq_customer_chat_messages_client_id", table_name="customer_chat_messages")
    op.drop_index("ix_customer_chat_messages_thread", table_name="customer_chat_messages")
    op.drop_table("customer_chat_messages")

    op.drop_index("ix_customer_conversations_admin", table_name="customer_conversations")
    op.drop_index("ix_customer_conversations_queue", table_name="customer_conversations")
    op.drop_index("uq_customer_conversation_live", table_name="customer_conversations")
    op.drop_table("customer_conversations")

    _MESSAGE_TYPE.drop(bind, checkfirst=True)
    _SENDER_TYPE.drop(bind, checkfirst=True)
    _CONV_STATUS.drop(bind, checkfirst=True)
