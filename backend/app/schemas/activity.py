import datetime

from pydantic import BaseModel


class ActivityLogOut(BaseModel):
    id: int
    user_id: int | None
    user_name: str | None = None
    user_email: str | None
    action: str
    activity_type: str | None = None
    module: str | None = None
    description: str | None = None
    reference_id: int | None = None
    ip_address: str | None
    browser: str | None = None
    device: str | None = None
    status: str = "success"
    created_at: datetime.datetime

    model_config = {"from_attributes": True}
