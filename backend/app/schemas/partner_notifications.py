from datetime import datetime

from pydantic import BaseModel


class NotificationOut(BaseModel):
    notification_id: int
    title: str
    message: str
    is_read: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class NotificationListOut(BaseModel):
    unread_count: int
    notifications: list[NotificationOut]


class MessageResponse(BaseModel):
    message: str
