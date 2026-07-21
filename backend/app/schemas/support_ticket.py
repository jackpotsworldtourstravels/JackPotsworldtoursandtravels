import datetime
from typing import Literal

from pydantic import BaseModel, Field

TicketStatus = Literal["open", "in_progress", "resolved", "closed"]
TicketPriority = Literal["low", "normal", "high", "urgent"]


class SupportTicketCreate(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=4000)
    priority: TicketPriority = "normal"


class SupportTicketOut(BaseModel):
    id: int
    user_id: int
    subject: str
    description: str
    status: str
    priority: str
    created_at: datetime.datetime
    resolved_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


class AdminSupportTicketOut(SupportTicketOut):
    user_email: str


class SupportTicketStatusUpdate(BaseModel):
    status: TicketStatus
