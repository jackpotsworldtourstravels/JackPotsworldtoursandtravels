import datetime

from pydantic import BaseModel, EmailStr


class CustomerListOut(BaseModel):
    id: int
    full_name: str
    email: EmailStr
    mobile: str | None
    profile_photo: str | None
    created_at: datetime.datetime
    last_login_at: datetime.datetime | None
    login_count: int
    total_bookings: int
    total_payments: int
    total_spend: float
    reward_points: int
    is_active: bool
    is_blocked: bool
    is_verified: bool
    is_deleted: bool
    is_online: bool


class CustomerStatsOut(BaseModel):
    total_customers: int
    online_customers: int
    blocked_customers: int
    new_customers_today: int
    most_active_customer: str | None
    highest_spending_customer: str | None


class CustomerEditRequest(BaseModel):
    full_name: str
    email: EmailStr
    mobile: str | None = None
    gender: str | None = None
    dob: datetime.date | None = None
    country: str | None = None
    state: str | None = None
    city: str | None = None
    address: str | None = None
    is_verified: bool | None = None


class CustomerBookingOut(BaseModel):
    id: int
    booking_type: str
    destination: str
    travel_date: datetime.date | None
    total_price: float
    status: str
    payment_status: str | None


class CustomerPaymentOut(BaseModel):
    id: int
    transaction_ref: str
    amount: float
    method: str
    status: str
    created_at: datetime.datetime


class CustomerTimelineEntryOut(BaseModel):
    activity_type: str | None
    description: str | None
    module: str | None
    status: str
    created_at: datetime.datetime


class CustomerSupportTicketOut(BaseModel):
    id: int
    subject: str
    priority: str
    status: str
    created_at: datetime.datetime
    resolved_at: datetime.datetime | None


class CustomerReviewOut(BaseModel):
    id: int
    item_type: str
    item_id: int
    destination: str
    rating: int
    comment: str | None
    created_at: datetime.datetime


class CustomerWishlistOut(BaseModel):
    id: int
    item_type: str
    item_id: int
    destination: str
    created_at: datetime.datetime


class CustomerAnalyticsOut(BaseModel):
    total_bookings: int
    completed_trips: int
    cancelled_trips: int
    total_spending: float
    average_booking_value: float
    favorite_destination: str | None
    favorite_hotel: str | None
    favorite_cruise: str | None
    favorite_package: str | None
    last_activity: datetime.datetime | None


class CustomerSessionInfoOut(BaseModel):
    is_online: bool
    current_page: str | None
    browser: str | None
    os: str | None
    device: str | None
    ip_address: str | None
    login_at: datetime.datetime | None


class CustomerProfileOut(BaseModel):
    id: int
    full_name: str
    email: EmailStr
    mobile: str | None
    gender: str | None
    dob: datetime.date | None
    country: str | None
    state: str | None
    city: str | None
    address: str | None
    profile_photo: str | None
    created_at: datetime.datetime
    last_login_at: datetime.datetime | None
    login_count: int
    is_active: bool
    is_blocked: bool
    is_verified: bool
    is_deleted: bool
    session: CustomerSessionInfoOut
    analytics: CustomerAnalyticsOut
    bookings: list[CustomerBookingOut]
    payments: list[CustomerPaymentOut]
    timeline: list[CustomerTimelineEntryOut]
    support_tickets: list[CustomerSupportTicketOut]
    reviews: list[CustomerReviewOut]
    wishlist: list[CustomerWishlistOut]


class CustomerEmailRequest(BaseModel):
    subject: str
    message: str


class CustomerNotifyRequest(BaseModel):
    title: str
    message: str


class CustomerResetPasswordOut(BaseModel):
    message: str
    reset_link: str | None = None
