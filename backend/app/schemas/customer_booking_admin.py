"""What the admin desk sees about a B2C booking — Phase 2 of the B2C Admin
Portal build-out. An allow-list, the same discipline every other admin/*
schema in this package uses.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from pydantic import BaseModel


class BookingCustomerRef(BaseModel):
    id: int
    name: str
    email: str
    mobile: str | None = None


class BookingListItem(BaseModel):
    booking_id: str
    customer: BookingCustomerRef
    service_type: str
    destination: str
    travel_date: dt.date | None
    amount: Decimal
    payment_status: str
    booking_status: str


class BookingList(BaseModel):
    items: list[BookingListItem]
    total: int
    page: int
    page_size: int
    total_pages: int


class BookingTraveller(BaseModel):
    name: str
    type: str


class BookingPaymentInfo(BaseModel):
    transaction_id: str | None
    method: str | None
    status: str
    amount: Decimal | None


class BookingDetail(BaseModel):
    booking_id: str
    customer: BookingCustomerRef
    service_type: str
    destination: str
    travel_date: dt.date | None
    passengers: list[BookingTraveller]
    amount: Decimal
    currency: str
    booking_status: str
    created_at: dt.datetime
    payment: BookingPaymentInfo


class BookingStatusUpdate(BaseModel):
    status: str


class DashboardBookingCounts(BaseModel):
    total: int
    flight: int
    hotel: int
    package: int
    gaming: int
