"""Request/response schemas for live chat (CR-9, migration 0064).

THESE SHAPES ARE THE WEBSOCKET'S TOO. Slice 3 publishes `ChatMessageResponse`
over the socket verbatim rather than inventing a second serialisation, so a
message rendered from a REST page and one arriving live cannot disagree about
its own fields. That is the whole reason the transport-independent service layer
exists, and it only pays off if the schemas are shared as well.
"""
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, Field

#: Mirrors `customer_chat_service.MAX_BODY_CHARS`. Validated in both places on
#: purpose: Pydantic rejects it at the edge with a clean 422, and the service
#: rejects it again for callers that are not HTTP — the socket, and any future
#: WhatsApp or email bridge.
MAX_BODY_CHARS = 4000

CONVERSATION_STATUSES = ("waiting", "active", "resolved", "closed")


class ChatAttachmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    attachment_id: int
    file_name: str
    mime_type: str
    file_size: int


class ChatMessageResponse(BaseModel):
    """One message as the client renders it.

    `sender_admin_id` is deliberately NOT exposed. The customer has no use for
    a merchant-side user id, and shipping internal identifiers to a browser
    invites them to be used as an oracle for how many staff exist. The display
    name is the only part of an agent's identity that leaves the server.

    `body` is None on a deleted message and the client renders a tombstone —
    the row still exists so the thread does not silently rewrite itself.
    """

    model_config = ConfigDict(from_attributes=True)

    message_id: int
    conversation_id: int
    sender_type: str
    sender_name: str | None = None
    body: str | None = None
    message_type: str
    is_internal: bool = False
    client_msg_id: str | None = None
    delivered_at: dt.datetime | None = None
    read_at: dt.datetime | None = None
    deleted_at: dt.datetime | None = None
    created_at: dt.datetime
    attachments: list[ChatAttachmentResponse] = Field(default_factory=list)

    @classmethod
    def for_customer(cls, message) -> "ChatMessageResponse":
        """Serialise with a deleted body blanked.

        The tombstone is produced HERE rather than by leaving `body` populated
        and trusting the client to hide it. A client-side hide ships the text to
        the browser, where it is one devtools panel away from being read.
        """
        model = cls.model_validate(message)
        if model.deleted_at is not None:
            model.body = None
            model.attachments = []
        return model


class ConversationResponse(BaseModel):
    """The conversation header the widget opens with."""

    model_config = ConfigDict(from_attributes=True)

    conversation_id: int
    status: str
    #: The agent's display name, or None while the chat is waiting. No id.
    assigned_admin_name: str | None = None
    last_message: str | None = None
    last_message_at: dt.datetime | None = None
    unread_count: int = 0
    created_at: dt.datetime

    @classmethod
    def for_customer(cls, conversation) -> "ConversationResponse":
        return cls(
            conversation_id=conversation.conversation_id,
            status=conversation.status,
            assigned_admin_name=conversation.assigned_admin_name,
            last_message=conversation.last_message,
            last_message_at=conversation.last_message_at,
            unread_count=conversation.customer_unread_count,
            created_at=conversation.created_at,
        )


class ConversationOpenResponse(BaseModel):
    """What `GET /conversation` returns: the header plus the newest page.

    ONE ROUND TRIP, not two. The widget opens on a click and a second request
    for the first page would show an empty panel for the length of a mobile
    round trip — which reads as "the chat is broken", not "the chat is loading".
    """

    conversation: ConversationResponse
    messages: list[ChatMessageResponse]


class MessageCreate(BaseModel):
    body: str | None = Field(default=None, max_length=MAX_BODY_CHARS)
    #: The idempotency key. Client-generated, so a retry after a dropped
    #: connection resolves to the same message — see 0064's docstring.
    client_msg_id: str | None = Field(default=None, max_length=64)
    attachment_ids: list[int] = Field(default_factory=list, max_length=10)


class MessageSendResponse(BaseModel):
    """The stored message, and whether this call created it.

    `created=False` means the server already had this `client_msg_id`. The
    client still renders the returned message — it asked precisely because it
    did not know whether the first attempt landed.
    """

    message: ChatMessageResponse
    created: bool


class MarkReadRequest(BaseModel):
    #: Bounded by an id rather than "mark all read", so a message that arrives
    #: while the client is rendering is not marked read before it is shown.
    up_to_message_id: int


class MarkReadResponse(BaseModel):
    marked: int
    unread_count: int
