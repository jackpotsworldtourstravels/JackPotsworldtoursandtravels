import datetime

from pydantic import BaseModel, Field

from app.schemas.booking import BookingType


class ReviewCreate(BaseModel):
    item_type: BookingType
    item_id: int
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=2000)


class ReviewUpdate(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=2000)


class ReviewOut(BaseModel):
    id: int
    user_id: int
    user_name: str
    item_type: str
    item_id: int
    rating: int
    comment: str | None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class AdminReviewOut(ReviewOut):
    user_email: str
