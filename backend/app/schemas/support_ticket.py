"""Schemas for Support Management / Live Chat.

See app/services/chat_service.py for why this implements chat threads
rather than a separate ticket model — the approved spec has no distinct
"raise a ticket" step, only Live Chat, and "Support Management" is Admin's
queue view over the same threads.
"""
import datetime

from pydantic import BaseModel, Field

from app.models_v2 import RequestStatus

#: Chat-specific wording — SPEC_LABELS' "Submitted"/"Under Review" reads
#: right for a booking approval queue, not for a conversation thread.
_CHAT_LABELS = {
    RequestStatus.SUBMITTED: "Open",
    RequestStatus.IN_REVIEW: "In Progress",
    RequestStatus.COMPLETED: "Resolved",
}


class OpenChatRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=4000)


class SendMessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class ChatMessageResponse(BaseModel):
    id: int
    sender_name: str | None = None
    direction: str
    message: str | None = None
    created_at: datetime.datetime

    @classmethod
    def of(cls, m) -> "ChatMessageResponse":
        return cls(
            id=m.message_id, sender_name=m.sender_name, direction=m.direction,
            message=m.message, created_at=m.created_at,
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
    message_count: int = 0
    last_message_at: datetime.datetime | None = None
    created_at: datetime.datetime

    @classmethod
    def of(cls, t, message_count: int = 0, last_message_at=None) -> "ChatThreadResponse":
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
            message_count=message_count,
            last_message_at=last_message_at,
            created_at=t.created_at,
        )


class ChatThreadDetailResponse(BaseModel):
    thread: ChatThreadResponse
    messages: list[ChatMessageResponse]
