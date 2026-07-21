import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models.user import User
from app.schemas.pagination import Page
from app.schemas.payment_management import PaymentAnalyticsOut, PaymentDashboardCardOut, PaymentListItemOut
from app.services import activity_service, payment_management_service

router = APIRouter(prefix="/api/admin/payment-management", tags=["admin-payment-management"])

PageParam = Query(default=1, ge=1)
PageSizeParam = Query(default=20, ge=1, le=100)


@router.get(
    "/payments",
    response_model=Page[PaymentListItemOut],
    summary="List payments (Payment Management Center)",
    description="Requires admin role. Searchable, filterable, sortable payment list with resolved customer/booking/destination — a dedicated view separate from the existing /api/admin/payments list.",
)
def list_payments(
    search: str | None = None,
    payment_status: Literal["success", "failed", "refunded"] | None = None,
    method: str | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    sort: Literal["newest", "oldest", "amount"] = "newest",
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    items, total = payment_management_service.list_payments_rich(
        db, page, page_size, search=search, payment_status=payment_status, method=method,
        date_from=date_from, date_to=date_to, sort=sort,
    )
    return Page.build([PaymentListItemOut(**item) for item in items], total, page, page_size)


@router.post(
    "/payments/{payment_id}/refund",
    response_model=PaymentListItemOut,
    summary="Refund a payment (admin)",
    description=(
        "Requires admin role. Refunds the payment and cancels its booking (restoring inventory) in one step — "
        "this system has no concept of a refunded payment on a still-active booking, so 'Refund' here reuses "
        "the exact same flow as Booking Management Center's 'Cancel Booking'."
    ),
)
def refund_payment(payment_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    payment = payment_management_service.refund_payment(db, payment_id, _admin.id)
    activity_service.log_activity(
        db, _admin.id, f"Admin refunded payment #{payment_id}",
        module="Admin", activity_type="Admin Action", reference_id=payment_id,
        description=f"Admin refunded payment #{payment_id} ({payment.transaction_ref})",
    )
    return PaymentListItemOut(**payment_management_service.get_payment_list_item(db, payment_id))


@router.get(
    "/analytics",
    response_model=PaymentAnalyticsOut,
    summary="Payment analytics (Payment Management Center)",
)
def get_analytics(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return payment_management_service.get_analytics(db)


@router.get(
    "/dashboard-card",
    response_model=PaymentDashboardCardOut,
    summary="Payment Management summary card for the main Admin Dashboard",
)
def get_dashboard_card(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return payment_management_service.get_dashboard_card(db)
