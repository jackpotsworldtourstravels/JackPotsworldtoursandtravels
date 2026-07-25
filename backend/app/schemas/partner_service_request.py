import datetime

from pydantic import BaseModel, Field


class CancellationRequestCreate(BaseModel):
    reference_number: str = Field(min_length=1, max_length=20)
    passenger_ids: list[int] = Field(min_length=1)
    reason: str = Field(min_length=1)


class DateChangeRequestCreate(BaseModel):
    reference_number: str = Field(min_length=1, max_length=20)
    passenger_id: int
    new_travel_date: datetime.date
    reason: str = Field(min_length=1)


class RefundRequestCreate(BaseModel):
    reference_number: str = Field(min_length=1, max_length=20)
    amount: float = Field(gt=0)
    reason: str = Field(min_length=1)


class PassengerModificationRequestCreate(BaseModel):
    reference_number: str = Field(min_length=1, max_length=20)
    passenger_id: int
    field_changed: str = Field(min_length=1, max_length=60)
    old_value: str | None = Field(default=None, max_length=255)
    new_value: str | None = Field(default=None, max_length=255)
    reason: str = Field(min_length=1)


class ServiceRequestCreatedOut(BaseModel):
    service_request_number: str
