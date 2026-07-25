import datetime
from typing import Literal

from pydantic import BaseModel

ExportFormat = Literal["pdf", "excel"]


class ReportRowOut(BaseModel):
    booking_id: int
    reference_number: str
    passenger_id: int
    passenger_name: str
    service_request_number: str | None = None
    sector_departure: str
    sector_arrival: str
    request_date: datetime.date
    travel_date: datetime.date | None = None
    total_amount: float | None = None
    amount_reimbursement: float | None = None
    status: str
