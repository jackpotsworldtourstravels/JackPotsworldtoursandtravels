"""Dashboard KPI response shapes (API_CONTRACT.md §6.1)."""
from decimal import Decimal

from pydantic import BaseModel

from app.schemas.ticket import RequestResponse


class RequestsByStatus(BaseModel):
    draft: int = 0
    pending_approval: int = 0
    in_review: int = 0
    approved: int = 0
    payment_pending: int = 0
    paid: int = 0
    ticket_issued: int = 0
    completed: int = 0
    rejected: int = 0
    cancelled: int = 0


class MerchantDashboardResponse(BaseModel):
    wallet_balance: Decimal
    credit_limit: Decimal
    requests_by_status: RequestsByStatus
    pending_payments_count: int
    unread_notifications_count: int
    open_chat_threads_count: int
    recent_requests: list[RequestResponse] = []


class MerchantCounts(BaseModel):
    total: int = 0
    pending_approval: int = 0
    active: int = 0
    suspended: int = 0


class RecentActivityEntry(BaseModel):
    id: int
    user_name: str | None = None
    module: str
    action: str
    description: str | None = None
    created_at: str


class EnquiryCounts(BaseModel):
    """Ticket Enquiry queue, counted apart from booking approvals.

    ``requests_by_status`` deliberately excludes enquiries, so these are the
    only place they are counted — an enquiry awaiting an answer is a different
    job from a booking awaiting approval, on a different screen.
    """

    pending: int = 0
    in_review: int = 0
    #: pending + in_review — what the Ticket Enquiries queue still owes an answer.
    awaiting_response: int = 0
    available: int = 0
    not_available: int = 0
    answered_today: int = 0


class AdminDashboardResponse(BaseModel):
    merchants: MerchantCounts
    requests_by_status: RequestsByStatus
    enquiries: EnquiryCounts = EnquiryCounts()
    payments_pending_count: int
    payments_verified_today: int
    open_support_tickets: int
    open_chat_threads: int
    recent_activity: list[RecentActivityEntry] = []


class AdminCounts(BaseModel):
    total: int = 0
    active: int = 0
    suspended: int = 0


class SuperAdminDashboardResponse(BaseModel):
    """System-overview KPIs, deliberately not the operational ticket/payment
    queues — those are Admin's domain per the permission matrix. A Super
    Admin's dashboard is about the system and the Admins running it.
    """

    admins: AdminCounts
    merchants: MerchantCounts
    total_merchant_users: int
    open_chat_threads: int
    schema_version: str
    recent_activity: list[RecentActivityEntry] = []
