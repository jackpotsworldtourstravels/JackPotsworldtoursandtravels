import datetime

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.booking import Booking, Payment
from app.models.user import User
from app.services import booking_management_service
from app.services.booking_management_service import destination_expr, ITEM_JOINS

_SORT_MAP = {
    "newest": Payment.created_at.desc(),
    "oldest": Payment.created_at.asc(),
    "amount": Payment.amount.desc(),
}


def _base_query():
    q = (
        select(
            Payment,
            Booking.id.label("booking_id"),
            Booking.booking_type,
            Booking.status.label("booking_status"),
            User.id.label("customer_id"),
            User.full_name.label("customer_name"),
            User.email.label("customer_email"),
            destination_expr().label("destination"),
        )
        .join(Booking, Payment.booking_id == Booking.id)
        .join(User, Payment.user_id == User.id)
    )
    for model, item_type in ITEM_JOINS:
        q = q.outerjoin(model, (Booking.booking_type == item_type) & (Booking.item_id == model.id))
    return q


def _refund_status(payment_status: str) -> str:
    return {"refunded": "Refunded", "success": "Not Refunded", "failed": "Not Applicable"}.get(payment_status, "—")


def list_payments_rich(
    db: Session,
    page: int,
    page_size: int,
    search: str | None = None,
    payment_status: str | None = None,
    method: str | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    sort: str = "newest",
):
    q = _base_query()

    if search:
        pattern = f"%{search}%"
        conditions = [
            Payment.transaction_ref.ilike(pattern),
            User.full_name.ilike(pattern),
            User.email.ilike(pattern),
            destination_expr().ilike(pattern),
        ]
        if search.isdigit():
            conditions.append(Booking.id == int(search))
        q = q.where(or_(*conditions))

    if payment_status:
        q = q.where(Payment.status == payment_status)
    if method:
        q = q.where(Payment.method == method)
    if date_from:
        q = q.where(Payment.created_at >= datetime.datetime.combine(date_from, datetime.time.min))
    if date_to:
        q = q.where(Payment.created_at <= datetime.datetime.combine(date_to, datetime.time.max))

    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    order_by = _SORT_MAP.get(sort, _SORT_MAP["newest"])
    rows = db.execute(q.order_by(order_by).limit(page_size).offset((page - 1) * page_size)).all()

    items = []
    for payment, booking_id, booking_type, booking_status, customer_id, customer_name, customer_email, destination in rows:
        items.append(
            {
                "id": payment.id,
                "transaction_ref": payment.transaction_ref,
                "booking_id": booking_id,
                "booking_type": booking_type,
                "booking_status": booking_status,
                "destination": destination or f"{booking_type} #{booking_id}",
                "customer_id": customer_id,
                "customer_name": customer_name,
                "customer_email": customer_email,
                "amount": float(payment.amount),
                "gateway": "JackPots Mock Gateway",
                "method": payment.method,
                "status": payment.status,
                "refund_status": _refund_status(payment.status),
                "refund_reference": payment.refund_reference,
                "refunded_at": payment.refunded_at,
                "created_at": payment.created_at,
            }
        )
    return items, total


def get_payment_list_item(db: Session, payment_id: int) -> dict:
    row = db.execute(_base_query().where(Payment.id == payment_id)).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found")
    payment, booking_id, booking_type, booking_status, customer_id, customer_name, customer_email, destination = row
    return {
        "id": payment.id,
        "transaction_ref": payment.transaction_ref,
        "booking_id": booking_id,
        "booking_type": booking_type,
        "booking_status": booking_status,
        "destination": destination or f"{booking_type} #{booking_id}",
        "customer_id": customer_id,
        "customer_name": customer_name,
        "customer_email": customer_email,
        "amount": float(payment.amount),
        "gateway": "JackPots Mock Gateway",
        "method": payment.method,
        "status": payment.status,
        "refund_status": _refund_status(payment.status),
        "refund_reference": payment.refund_reference,
        "refunded_at": payment.refunded_at,
        "created_at": payment.created_at,
    }


def refund_payment(db: Session, payment_id: int, admin_id: int) -> Payment:
    payment = db.get(Payment, payment_id)
    if not payment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found")
    if payment.status != "success":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only successful payments can be refunded")
    # Reuses the exact same cancel+restore-inventory+refund flow as Booking Management
    # Center's "Cancel Booking" — this system has no concept of a payment being
    # refunded while its booking stays active, so the two actions share one path.
    booking_management_service.cancel_booking_admin(db, payment.booking_id, admin_id)
    db.refresh(payment)
    return payment


def get_analytics(db: Session) -> dict:
    today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

    def _sum(status_value: str) -> float:
        return float(
            db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.status == status_value)) or 0
        )

    def _count(status_value: str) -> int:
        return db.scalar(select(func.count()).select_from(Payment).where(Payment.status == status_value)) or 0

    total_transactions = db.scalar(select(func.count()).select_from(Payment)) or 0
    today_revenue = float(
        db.scalar(
            select(func.coalesce(func.sum(Payment.amount), 0)).where(
                Payment.status == "success", Payment.created_at >= today_start
            )
        )
        or 0
    )

    return {
        "total_transactions": total_transactions,
        "total_revenue": _sum("success"),
        "today_revenue": today_revenue,
        "total_refunded": _sum("refunded"),
        "success_count": _count("success"),
        "failed_count": _count("failed"),
        "refunded_count": _count("refunded"),
    }


def get_dashboard_card(db: Session) -> dict:
    today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_revenue = float(
        db.scalar(
            select(func.coalesce(func.sum(Payment.amount), 0)).where(
                Payment.status == "success", Payment.created_at >= today_start
            )
        )
        or 0
    )
    total_transactions_today = (
        db.scalar(select(func.count()).select_from(Payment).where(Payment.created_at >= today_start)) or 0
    )
    failed_payments = db.scalar(select(func.count()).select_from(Payment).where(Payment.status == "failed")) or 0
    # Refunds happen atomically with cancellation in this system, so a payment stuck
    # "success" on an already-cancelled booking would be a genuine inconsistency —
    # this stays 0 in normal operation but surfaces the real count if it ever isn't.
    pending_refunds = (
        db.scalar(
            select(func.count())
            .select_from(Payment)
            .join(Booking, Payment.booking_id == Booking.id)
            .where(Payment.status == "success", Booking.status == "cancelled")
        )
        or 0
    )
    return {
        "today_revenue": today_revenue,
        "total_transactions_today": total_transactions_today,
        "failed_payments": failed_payments,
        "pending_refunds": pending_refunds,
    }
