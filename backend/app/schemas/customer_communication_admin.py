"""What the admin desk sees on the B2C Communication screen — Phase 7 of the
B2C Admin Portal build-out. All read-only: an allow-list of what each row
exposes, the same discipline every other admin/* schema in this package uses.
"""
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


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
