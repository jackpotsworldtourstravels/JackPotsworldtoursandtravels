import datetime

from pydantic import BaseModel, EmailStr


class PaymentListItemOut(BaseModel):
    id: int
    transaction_ref: str
    booking_id: int
    booking_type: str
    booking_status: str
    destination: str
    customer_id: int
    customer_name: str
    customer_email: EmailStr
    amount: float
    gateway: str
    method: str
    status: str
    refund_status: str
    refund_reference: str | None
    refunded_at: datetime.datetime | None
    created_at: datetime.datetime


class PaymentAnalyticsOut(BaseModel):
    total_transactions: int
    total_revenue: float
    today_revenue: float
    total_refunded: float
    success_count: int
    failed_count: int
    refunded_count: int


class PaymentDashboardCardOut(BaseModel):
    today_revenue: float
    total_transactions_today: int
    failed_payments: int
    pending_refunds: int
