import datetime

from pydantic import BaseModel, Field


class NotificationOut(BaseModel):
    id: int
    title: str
    message: str
    is_read: bool
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class AdminNotificationCreate(BaseModel):
    user_id: int | None = Field(default=None, description="Target user id. Omit or set to null to broadcast to all users.")
    title: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=2000)


class AdminNotificationOut(NotificationOut):
    user_email: str
