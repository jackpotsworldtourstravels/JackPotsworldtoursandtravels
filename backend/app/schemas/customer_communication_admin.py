"""What the admin desk sees on the B2C Communication screen — Phase 7 of the
B2C Admin Portal build-out. All read-only: an allow-list of what each row
exposes, the same discipline every other admin/* schema in this package uses.
"""
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, Field, field_validator


# --- Stage 3 M2.1: admin-composed in-app notification (send side) ------------
class CustomerNotifyRequest(BaseModel):
    """An admin-authored in-app notification for one customer. Lengths match the
    ``customer_notifications`` columns (title 150, message 500). The type is
    fixed to the existing ``general`` value — no new enum value, no migration."""

    title: str = Field(min_length=1, max_length=150)
    message: str = Field(min_length=1, max_length=500)

    @field_validator("title", "message")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


class CustomerNotifyResponse(BaseModel):
    outcome: str
    notification_id: int
    customer_id: int
    notification_type: str


# --- Stage 3 M2.2: admin-composed email to one customer ----------------------
class CustomerEmailRequest(BaseModel):
    """An admin-authored email to one customer. The admin never sets anything
    other than the subject and body; the recipient is resolved from the
    customer's own verified address server-side (not supplied here)."""

    subject: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=5000)

    @field_validator("subject", "message")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


class CustomerEmailResponse(BaseModel):
    outcome: str
    customer_id: int
    delivered: bool


# --- Stage 3 M2.3: admin reply on an existing customer support ticket --------
class CustomerTicketReplyRequest(BaseModel):
    """A staff reply on one existing ticket. Only the body — the ticket (and
    therefore its customer) comes from the path; is_staff/author are set
    server-side from the authenticated admin."""

    message: str = Field(min_length=1, max_length=5000)

    @field_validator("message")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


class CommCustomerRef(BaseModel):
    id: int
    name: str
    email: str


class NotificationRow(BaseModel):
    notification_id: int
    customer: CommCustomerRef
    notification_type: str
    title: str
    message: str
    related_ref: str | None
    is_read: bool
    read_at: dt.datetime | None
    created_at: dt.datetime


class NotificationSummary(BaseModel):
    total: int
    unread: int
    by_type: dict[str, int]


class NotificationList(BaseModel):
    items: list[NotificationRow]
    total: int
    page: int
    page_size: int
    total_pages: int
    summary: NotificationSummary


class TicketRow(BaseModel):
    ticket_id: int
    customer: CommCustomerRef
    subject: str
    priority: str
    status: str
    message_count: int
    created_at: dt.datetime
    updated_at: dt.datetime


class TicketList(BaseModel):
    items: list[TicketRow]
    total: int
    page: int
    page_size: int
    total_pages: int


class TicketMessage(BaseModel):
    author_name: str | None
    is_staff: bool
    message: str
    created_at: dt.datetime


class TicketDetail(TicketRow):
    description: str
    messages: list[TicketMessage]


class ChatOverview(BaseModel):
    conversations_total: int
    by_status: dict[str, int]
    #: Conversations nobody has picked up yet.
    unassigned_open: int
    #: Messages from customers that no agent has read yet, summed.
    admin_unread: int
    messages_total: int
    calls_total: int
    calls_by_status: dict[str, int]
    oldest_waiting_at: dt.datetime | None
