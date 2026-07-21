import datetime

from pydantic import BaseModel, EmailStr


class OnlineUserOut(BaseModel):
    user_id: int
    full_name: str
    email: EmailStr
    profile_photo: str | None
    current_page: str | None
    login_at: datetime.datetime
    last_seen_at: datetime.datetime
    ip_address: str | None
    browser: str | None
    device: str | None


class SessionOut(BaseModel):
    id: int
    user_id: int
    user_name: str
    user_email: EmailStr
    login_at: datetime.datetime
    logout_at: datetime.datetime | None
    last_seen_at: datetime.datetime
    ip_address: str | None
    browser: str | None
    os: str | None
    device: str | None
    is_active: bool

    model_config = {"from_attributes": True}
