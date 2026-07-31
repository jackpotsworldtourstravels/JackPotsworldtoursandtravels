import datetime

from pydantic import BaseModel, Field


class NotificationOut(BaseModel):
    id: int
    title: str | None = Field(validation_alias="subject")
    message: str | None
    is_read: bool
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}
