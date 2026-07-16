import datetime

from pydantic import BaseModel


class ActivityLogOut(BaseModel):
    id: int
    user_id: int | None
    user_email: str | None
    action: str
    ip_address: str | None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}
