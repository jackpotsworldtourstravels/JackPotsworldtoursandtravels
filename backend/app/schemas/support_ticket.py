"""Schemas for Support Management / Live Chat.

See app/services/chat_service.py for why this implements chat threads
rather than a separate ticket model — the approved spec has no distinct
"raise a ticket" step, only Live Chat, and "Support Management" is Admin's
queue view over the same threads.
"""
import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models_v2 import Priority, RequestStatus

#: Chat-specific wording — SPEC_LABELS' "Submitted"/"Under Review" reads
#: right for a booking approval queue, not for a conversation thread.
_CHAT_LABELS = {
    RequestStatus.SUBMITTED: "Open",
    RequestStatus.IN_REVIEW: "In Progress",
    RequestStatus.COMPLETED: "Resolved",
}

#: Kept as a Literal rather than an enum import so the OpenAPI schema lists the
#: eight categories inline — the merchant portal builds its dropdown from the
#: generated contract, and a bare string would have made that a hand-copied list
#: that drifts the first time the desk adds a category.
Category = Literal[
    "booking", "payment", "wallet", "refund",
    "ticket_issue", "account", "technical", "other",
]


class OpenChatRequest(BaseModel):
    #: OPTIONAL, deliberately. Requiring a subject put a form in front of a
    #: merchant who only wanted to say what had gone wrong — the wrong thing to
    #: ask for on the one screen where someone is already having a bad day.
    #: When it is blank the service derives a title from the first message, so
    #: the desk's queue stays scannable; see chat_service.derive_thread_title.
    subject: str | None = Field(default=None, max_length=200)
    message: str = Field(min_length=1, max_length=4000)
    category: Category | None = None
    #: A merchant's opening assessment. The desk can overrule it through
    #: /triage — see chat_service.set_triage for why triage is not the
    #: raiser's call.
    priority: Priority = Priority.NORMAL
    #: The booking this ticket is about, so support does not have to ask for a
    #: reference the merchant already has on screen.
    related_request_id: int | None = None


class SendMessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class TriageRequest(BaseModel):
    """Admin re-files a thread. Both fields optional — sending one leaves the
    other alone, so changing priority cannot silently clear a category."""

    priority: Priority | None = None
    category: Category | None = None


class AddNoteRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class ChatNoteResponse(BaseModel):
    """An internal note. Staff-only — no merchant-facing response embeds this."""

    id: int
    body: str
    author: str | None = None
    created_at: datetime.datetime
    edited_at: datetime.datetime | None = None

    @classmethod
    def of(cls, n, author: str | None = None) -> "ChatNoteResponse":
        return cls(
            id=n.note_id, body=n.body, author=author,
            created_at=n.created_at, edited_at=n.edited_at,
        )


class ChatDocumentResponse(BaseModel):
    """A file shared in the conversation.

    ``stored_path`` is deliberately absent: bytes come from
    ``GET /api/documents/{id}/download``, which re-checks merchant scope on
    every read. Exposing the key would make the file addressable without it.
    """

    id: int
    filename: str
    content_type: str
    size_bytes: int
    uploaded_by: str | None = None
    #: Which side shared it, so the UI can put it with the right bubble.
    is_staff: bool = False
    created_at: datetime.datetime

    @classmethod
    def of(cls, d, uploader: str | None = None, is_staff: bool = False) -> "ChatDocumentResponse":
        return cls(
            id=d.document_id, filename=d.original_filename, content_type=d.content_type,
            size_bytes=d.size_bytes, uploaded_by=uploader, is_staff=is_staff,
            created_at=d.created_at,
        )


class ChatMessageResponse(BaseModel):
    id: int
    sender_name: str | None = None
    direction: str
    message: str | None = None
    #: A real receipt off msg_logs.is_read, set when the other side opens the
    #: thread — not the "has it been claimed?" inference the portal used to draw
    #: the second tick from.
    is_read: bool = False
    created_at: datetime.datetime

    @classmethod
    def of(cls, m) -> "ChatMessageResponse":
        return cls(
            id=m.message_id, sender_name=m.sender_name, direction=m.direction,
            message=m.message, is_read=bool(m.is_read), created_at=m.created_at,
        )


class ChatThreadResponse(BaseModel):
    id: int
    request_number: str
    status: RequestStatus
    status_label: str
    title: str | None = None
    merchant_id: int | None = None
    merchant_name: str | None = None
    opened_by: str | None = None
    assigned_admin: int | None = None
    assigned_admin_name: str | None = None
    priority: Priority = Priority.NORMAL
    category: str | None = None
    category_label: str | None = None
    #: The booking this ticket is about, resolved to something quotable so the
    #: client can render a jump-to link without a second round trip.
    related_request_id: int | None = None
    related_request_number: str | None = None
    message_count: int = 0
    attachment_count: int = 0
    #: Whether a resolved thread is still inside the reopening window. Computed
    #: server-side because the window is a server rule; a client deriving it
    #: from created_at would be a second copy of that rule, free to disagree.
    can_reopen: bool = False
    last_message_at: datetime.datetime | None = None
    created_at: datetime.datetime

    @classmethod
    def of(
        cls,
        t,
        message_count: int = 0,
        last_message_at=None,
        *,
        attachment_count: int = 0,
        assigned_admin_name: str | None = None,
        can_reopen: bool = False,
    ) -> "ChatThreadResponse":
        from app.services.chat_service import CATEGORY_LABELS, category_of

        category = category_of(t)
        return cls(
            id=t.request_id,
            request_number=t.request_number,
            status=t.status,
            status_label=_CHAT_LABELS.get(t.status, t.status.value),
            title=t.title,
            merchant_id=t.merchant_id,
            merchant_name=t.merchant.company_name if t.merchant else None,
            opened_by=t.user.full_name if t.user else None,
            assigned_admin=t.assigned_admin,
            assigned_admin_name=assigned_admin_name,
            priority=t.priority,
            category=category,
            category_label=CATEGORY_LABELS.get(category) if category else None,
            related_request_id=t.parent_request_id,
            related_request_number=t.parent.request_number if t.parent else None,
            message_count=message_count,
            attachment_count=attachment_count,
            can_reopen=can_reopen,
            last_message_at=last_message_at,
            created_at=t.created_at,
        )


class ChatThreadDetailResponse(BaseModel):
    thread: ChatThreadResponse
    messages: list[ChatMessageResponse]
    documents: list[ChatDocumentResponse] = []
