import datetime
from typing import Literal

from pydantic import BaseModel, Field

TicketPriority = Literal["low", "medium", "high", "urgent"]


class SupportTicketCreate(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=4000)
    priority: TicketPriority = "medium"


class SupportTicketOut(BaseModel):
    id: int
    user_id: int | None
    subject: str | None
    description: str | None
    status: str
    priority: str | None
    created_at: datetime.datetime
    resolved_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
