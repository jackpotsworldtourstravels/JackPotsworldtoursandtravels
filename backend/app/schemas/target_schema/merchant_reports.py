import datetime

from pydantic import BaseModel


class ReportRowOut(BaseModel):
    request_number: str
    request_type: str
    status: str
    departure: str | None
    arrival: str | None
    departure_date: datetime.date | None
    return_date: datetime.date | None
    total_amount: float | None
    created_at: datetime.datetime
