import datetime

from pydantic import BaseModel

from app.schemas.booking import BookingType


class WishlistCreate(BaseModel):
    item_type: BookingType
    item_id: int


class WishlistOut(BaseModel):
    id: int
    item_type: str
    item_id: int
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class AdminWishlistOut(WishlistOut):
    user_email: str
