import datetime

from fastapi import HTTPException, status
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.models.booking import Booking, Payment
from app.models.misc import ActivityLog
from app.models.travel import Cruise, Flight, Hotel, TourPackage
from app.models.user import User
from app.services import activity_service, booking_service, catalog_items, inventory_service, notification_service

ITEM_JOINS = [
    (Flight, "flight"),
    (Hotel, "hotel"),
    (Cruise, "cruise"),
    (TourPackage, "package"),
]


def destination_expr():
    return case(
        (Booking.booking_type == "flight", Flight.from_airport.concat(" → ").concat(Flight.to_airport)),
        (Booking.booking_type == "hotel", Hotel.name),
        (Booking.booking_type == "cruise", Cruise.name),
        (Booking.booking_type == "package", TourPackage.title),
        else_=None,
    )


def _base_query():
    q = (
        select(
            Booking,
            User.full_name.label("customer_name"),
            User.email.label("customer_email"),
            User.id.label("customer_id"),
            destination_expr().label("destination"),
            Payment.status.label("payment_status"),
        )
        .join(User, Booking.user_id == User.id)
        .outerjoin(Payment, Payment.booking_id == Booking.id)
    )
    for model, item_type in ITEM_JOINS:
        q = q.outerjoin(model, and_(Booking.booking_type == item_type, Booking.item_id == model.id))
    return q


_SORT_MAP = {
    "newest": Booking.created_at.desc(),
    "oldest": Booking.created_at.asc(),
    "travel_date": Booking.travel_date.asc(),
    "amount": Booking.total_price.desc(),
    "status": Booking.status.asc(),
    "customer_name": User.full_name.asc(),
}


def list_bookings_rich(
    db: Session,
    page: int,
    page_size: int,
    search: str | None = None,
    booking_type: str | None = None,
    booking_status: str | None = None,
    payment_status: str | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    customer_id: int | None = None,
    sort: str = "newest",
):
    q = _base_query()

    if search:
        pattern = f"%{search}%"
        conditions = [User.full_name.ilike(pattern), User.email.ilike(pattern), destination_expr().ilike(pattern)]
        if search.isdigit():
            conditions.append(Booking.id == int(search))
        q = q.where(or_(*conditions))

    if booking_type:
        q = q.where(Booking.booking_type == booking_type)
    if booking_status:
        q = q.where(Booking.status == booking_status)
    if payment_status:
        q = q.where(Payment.status == payment_status)
    if date_from:
        q = q.where(Booking.created_at >= datetime.datetime.combine(date_from, datetime.time.min))
    if date_to:
        q = q.where(Booking.created_at <= datetime.datetime.combine(date_to, datetime.time.max))
    if customer_id:
        q = q.where(Booking.user_id == customer_id)

    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    order_by = _SORT_MAP.get(sort, _SORT_MAP["newest"])
    rows = db.execute(q.order_by(order_by).limit(page_size).offset((page - 1) * page_size)).all()

    items = []
    for booking, customer_name, customer_email, customer_id_, destination, payment_status_ in rows:
        items.append(
            {
                "id": booking.id,
                "customer_id": customer_id_,
                "customer_name": customer_name,
                "customer_email": customer_email,
                "booking_type": booking.booking_type,
                "destination": destination or f"{booking.booking_type} #{booking.item_id}",
                "booking_date": booking.created_at,
                "travel_date": booking.travel_date,
                "passengers": booking.quantity,
                "total_amount": float(booking.total_price),
                "payment_status": payment_status_,
                "booking_status": booking.status,
                "created_by": "Customer",
                "updated_at": booking.updated_at,
            }
        )
    return items, total


def _get_booking_or_404(db: Session, booking_id: int) -> Booking:
    booking = db.get(Booking, booking_id)
    if not booking:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    return booking


def get_booking_timeline(db: Session, booking_id: int, payment_ids: list[int]) -> list[ActivityLog]:
    conditions = [and_(ActivityLog.module == "Booking", ActivityLog.reference_id == booking_id)]
    if payment_ids:
        conditions.append(and_(ActivityLog.module == "Payment", ActivityLog.reference_id.in_(payment_ids)))
    conditions.append(and_(ActivityLog.module == "Admin", ActivityLog.reference_id == booking_id))
    stmt = select(ActivityLog).where(or_(*conditions)).order_by(ActivityLog.created_at.asc())
    return db.scalars(stmt).all()


def get_booking_detail(db: Session, booking_id: int) -> dict:
    booking = _get_booking_or_404(db, booking_id)
    customer = db.get(User, booking.user_id)
    payments = db.scalars(
        select(Payment).where(Payment.booking_id == booking_id).order_by(Payment.created_at.desc())
    ).all()
    catalog_item = db.get(catalog_items.ITEM_MODELS[booking.booking_type], booking.item_id)

    timeline = get_booking_timeline(db, booking_id, [p.id for p in payments])

    inventory_row = None
    if catalog_item:
        inventory_row = inventory_service.to_inventory_out(booking.booking_type, catalog_item)

    return {
        "id": booking.id,
        "booking_type": booking.booking_type,
        "destination": catalog_items.item_display_name(db, booking.booking_type, booking.item_id),
        "status": booking.status,
        "quantity": booking.quantity,
        "total_price": float(booking.total_price),
        "travel_date": booking.travel_date,
        "created_at": booking.created_at,
        "updated_at": booking.updated_at,
        "customer": {
            "id": customer.id,
            "full_name": customer.full_name,
            "email": customer.email,
            "mobile": customer.mobile,
        },
        "payments": [
            {
                "id": p.id,
                "transaction_ref": p.transaction_ref,
                "amount": float(p.amount),
                "method": p.method,
                "status": p.status,
                "created_at": p.created_at,
                "refunded_at": p.refunded_at,
                "refund_reference": p.refund_reference,
            }
            for p in payments
        ],
        "timeline": [
            {
                "activity_type": t.activity_type,
                "description": t.description or t.action,
                "status": t.status,
                "created_at": t.created_at,
                "actor": "Admin" if t.module == "Admin" else "Customer",
            }
            for t in timeline
        ],
        "inventory": inventory_row,
    }


def approve_booking(db: Session, booking_id: int, admin_id: int) -> Booking:
    booking = _get_booking_or_404(db, booking_id)
    if booking.status != "pending":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only pending bookings can be approved")
    booking.status = "confirmed"
    db.commit()
    db.refresh(booking)
    _log_and_notify(db, booking, admin_id, "Booking Approved", "Your booking has been approved and confirmed.")
    return booking


def reject_booking(db: Session, booking_id: int, admin_id: int) -> Booking:
    booking = _get_booking_or_404(db, booking_id)
    if booking.status != "pending":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only pending bookings can be rejected")
    booking.status = "cancelled"
    db.commit()
    db.refresh(booking)
    booking_service.restore_inventory_for_booking(db, booking)
    booking_service.refund_payment_for_booking(db, booking)
    _log_and_notify(db, booking, admin_id, "Booking Rejected", "Your booking request was rejected by our team.")
    return booking


def cancel_booking_admin(db: Session, booking_id: int, admin_id: int) -> Booking:
    booking = _get_booking_or_404(db, booking_id)
    if booking.status == "cancelled":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Booking is already cancelled")
    booking.status = "cancelled"
    db.commit()
    db.refresh(booking)
    booking_service.restore_inventory_for_booking(db, booking)
    booking_service.refund_payment_for_booking(db, booking)
    _log_and_notify(db, booking, admin_id, "Booking Cancelled", "Your booking has been cancelled by our team.")
    return booking


def complete_booking(db: Session, booking_id: int, admin_id: int) -> Booking:
    booking = _get_booking_or_404(db, booking_id)
    if booking.status != "confirmed":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only confirmed bookings can be marked completed")
    booking.status = "completed"
    db.commit()
    db.refresh(booking)
    _log_and_notify(db, booking, admin_id, "Booking Completed", "Your trip has been marked as completed. We hope you enjoyed it!")
    return booking


def _log_and_notify(db: Session, booking: Booking, admin_id: int, activity_type: str, customer_message: str) -> None:
    activity_service.log_activity(
        db, admin_id, f"{activity_type} (#{booking.id})",
        module="Booking", activity_type=activity_type, reference_id=booking.id,
        description=f"Admin: {activity_type.lower()} for booking #{booking.id}",
    )
    notification_service.create_notification(db, booking.user_id, activity_type, customer_message)
    notification_service.notify_admins(db, activity_type, f"Booking #{booking.id}: {activity_type.lower()}.")


def reschedule_booking(db: Session, booking_id: int, admin_id: int, new_travel_date: datetime.date) -> Booking:
    booking = _get_booking_or_404(db, booking_id)
    if booking.status == "cancelled":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot reschedule a cancelled booking")
    old_date = booking.travel_date
    booking.travel_date = new_travel_date
    db.commit()
    db.refresh(booking)
    activity_service.log_activity(
        db, admin_id, f"Booking Rescheduled (#{booking.id})",
        module="Booking", activity_type="Booking Rescheduled", reference_id=booking.id,
        description=f"Admin moved booking #{booking.id} travel date from {old_date} to {new_travel_date}",
    )
    notification_service.create_notification(
        db, booking.user_id, "Booking rescheduled",
        f"Your booking #{booking.id}'s travel date was changed to {new_travel_date}.",
    )
    return booking


def update_passenger_count(db: Session, booking_id: int, admin_id: int, new_quantity: int) -> Booking:
    booking = _get_booking_or_404(db, booking_id)
    if booking.status == "cancelled":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot change a cancelled booking")
    delta = new_quantity - booking.quantity
    if delta == 0:
        return booking

    item = booking_service.get_item(db, booking.booking_type, booking.item_id)
    if delta > 0:
        booking_service.decrement_inventory(db, booking.booking_type, booking.item_id, delta)
    else:
        booking_service.restore_inventory(db, booking.booking_type, booking.item_id, -delta)

    old_quantity = booking.quantity
    booking.quantity = new_quantity
    booking.total_price = round(booking_service.unit_price(booking.booking_type, item) * new_quantity, 2)
    db.commit()
    db.refresh(booking)

    activity_service.log_activity(
        db, admin_id, f"Passenger Count Updated (#{booking.id})",
        module="Booking", activity_type="Passenger Count Updated", reference_id=booking.id,
        description=f"Admin changed booking #{booking.id} passengers from {old_quantity} to {new_quantity}",
    )
    notification_service.create_notification(
        db, booking.user_id, "Booking updated",
        f"Your booking #{booking.id} passenger count changed to {new_quantity}; new total is ₹{booking.total_price:,.2f}.",
    )
    return booking


def get_analytics(db: Session) -> dict:
    today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    total = db.scalar(select(func.count()).select_from(Booking)) or 0
    today = db.scalar(select(func.count()).select_from(Booking).where(Booking.created_at >= today_start)) or 0

    def _count(status_value: str) -> int:
        return db.scalar(select(func.count()).select_from(Booking).where(Booking.status == status_value)) or 0

    revenue = (
        db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.status == "success")) or 0
    )
    avg_value = db.scalar(select(func.coalesce(func.avg(Booking.total_price), 0))) or 0

    return {
        "total_bookings": total,
        "today_bookings": today,
        "confirmed": _count("confirmed"),
        "cancelled": _count("cancelled"),
        "completed": _count("completed"),
        "pending": _count("pending"),
        "revenue": float(revenue),
        "average_booking_value": round(float(avg_value), 2),
    }


def get_dashboard_card(db: Session) -> dict:
    today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_bookings = db.scalar(select(func.count()).select_from(Booking).where(Booking.created_at >= today_start)) or 0
    pending_approvals = db.scalar(select(func.count()).select_from(Booking).where(Booking.status == "pending")) or 0
    upcoming_trips = (
        db.scalar(
            select(func.count())
            .select_from(Booking)
            .where(Booking.status == "confirmed", Booking.travel_date >= datetime.date.today())
        )
        or 0
    )
    cancelled_today = (
        db.scalar(
            select(func.count())
            .select_from(Booking)
            .where(Booking.status == "cancelled", Booking.updated_at >= today_start)
        )
        or 0
    )
    return {
        "today_bookings": today_bookings,
        "pending_approvals": pending_approvals,
        "upcoming_trips": upcoming_trips,
        "cancelled_today": cancelled_today,
    }


def export_invoice_csv(db: Session, booking_id: int) -> str:
    import csv
    import io

    booking = _get_booking_or_404(db, booking_id)
    customer = db.get(User, booking.user_id)
    payment = db.scalar(select(Payment).where(Payment.booking_id == booking_id).order_by(Payment.created_at.desc()))
    destination = catalog_items.item_display_name(db, booking.booking_type, booking.item_id)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Invoice for Booking", f"#{booking.id}"])
    writer.writerow(["Customer", customer.full_name])
    writer.writerow(["Email", customer.email])
    writer.writerow(["Booking Type", booking.booking_type])
    writer.writerow(["Destination", destination])
    writer.writerow(["Travel Date", booking.travel_date])
    writer.writerow(["Passengers", booking.quantity])
    writer.writerow(["Total Amount", float(booking.total_price)])
    writer.writerow(["Booking Status", booking.status])
    if payment:
        writer.writerow(["Transaction Ref", payment.transaction_ref])
        writer.writerow(["Payment Status", payment.status])
        writer.writerow(["Payment Date", payment.created_at])
        if payment.refunded_at:
            writer.writerow(["Refund Reference", payment.refund_reference])
            writer.writerow(["Refund Date", payment.refunded_at])
    writer.writerow(["Booked On", booking.created_at])
    return buf.getvalue()
