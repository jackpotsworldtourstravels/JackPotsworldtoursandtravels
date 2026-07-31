import secrets

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

# Catalog tables (flights/hotels/cruises/tour_packages) are deliberately NOT
# part of the target schema — they stay the existing live tables, so this
# module reuses the existing legacy ORM classes to query/update them rather
# than duplicating a catalog layer. See docs/DATABASE_REDESIGN_9TABLE.md §1.
from app.models.travel import Cruise, Flight, Hotel, TourPackage
from app.models.target_schema.service_requests import ServiceRequest
from app.models.target_schema.users import User
from app.services.target_schema import msg_log_service, payment_service, system_log_service

ITEM_MODELS = {"flight": Flight, "hotel": Hotel, "cruise": Cruise, "tour_package": TourPackage}
ITEM_NAME_FN = {
    "flight": lambda item: f"{item.from_airport} → {item.to_airport}",
    "hotel": lambda item: item.name,
    "cruise": lambda item: item.name,
    "tour_package": lambda item: item.title,
}
AVAILABILITY_FIELD = {
    "flight": "seats_available", "hotel": "rooms_available", "cruise": "cabins_available", "tour_package": "capacity",
}
_AVAILABILITY_LABEL = {"flight": "seat(s)", "hotel": "room(s)", "cruise": "cabin(s)", "tour_package": "slot(s)"}


def get_item(db: Session, item_type: str, item_id: int):
    model = ITEM_MODELS[item_type]
    item = db.get(model, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{item_type} {item_id} not found")
    return item


def item_display_name(db: Session, item_type: str, item_id: int) -> str:
    model = ITEM_MODELS.get(item_type)
    item = db.get(model, item_id) if model else None
    if not item:
        return f"{item_type} #{item_id} (removed)"
    return ITEM_NAME_FN[item_type](item)


def base_unit_price(item_type: str, item) -> float:
    return float(item.price_per_night) if item_type == "hotel" else float(item.price)


def check_availability(item_type: str, item, quantity: int) -> None:
    available = getattr(item, AVAILABILITY_FIELD[item_type])
    if available < quantity:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Only {available} {_AVAILABILITY_LABEL[item_type]} available for this {item_type}.",
        )


def decrement_inventory(db: Session, item_type: str, item_id: int, quantity: int) -> int:
    """Atomic, race-safe against concurrent bookings — a losing request
    affects zero rows instead of driving availability negative."""
    model = ITEM_MODELS[item_type]
    field_name = AVAILABILITY_FIELD[item_type]
    field = getattr(model, field_name)
    stmt = (
        update(model).where(model.id == item_id, field >= quantity)
        .values(**{field_name: field - quantity}).returning(field)
    )
    row = db.execute(stmt).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"This {item_type} no longer has enough {_AVAILABILITY_LABEL[item_type]} available.",
        )
    return row[0]


def restore_inventory(db: Session, item_type: str, item_id: int, quantity: int) -> None:
    model = ITEM_MODELS[item_type]
    field_name = AVAILABILITY_FIELD[item_type]
    field = getattr(model, field_name)
    db.execute(update(model).where(model.id == item_id).values(**{field_name: field + quantity}))


def create_booking_with_payment(
    db: Session, user: User, *, item_type: str, item_id: int, quantity: int,
    travel_date=None, coupon_code: str | None = None,
) -> tuple[ServiceRequest, "payment_service.Payment"]:
    item = get_item(db, item_type, item_id)
    check_availability(item_type, item, quantity)

    # Order: base/seasonal unit price -> auto campaign discount -> optional
    # coupon on top. NOTE: seasonal pricing reads item.seasonal_pricing, which
    # only exists once app/models/travel.py maps the column added by 0025 —
    # until that cutover step, this safely falls back to the base price.
    base_price = base_unit_price(item_type, item)
    effective_unit_price = payment_service.get_effective_unit_price(item, travel_date, base_price)
    subtotal = round(effective_unit_price * quantity, 2)
    campaign_discount, _campaign = payment_service.get_active_campaign_discount(db, item_type, subtotal)
    amount_after_campaign = subtotal - campaign_discount

    coupon = None
    coupon_discount = 0.0
    if coupon_code:
        coupon = payment_service.validate_coupon(db, coupon_code, item_type, amount_after_campaign)
        coupon_discount = payment_service.apply_discount(coupon, amount_after_campaign)

    total_discount = round(campaign_discount + coupon_discount, 2)
    total_price = max(round(subtotal - total_discount, 2), 0.01)

    availability_before = getattr(item, AVAILABILITY_FIELD[item_type])
    new_available = decrement_inventory(db, item_type, item_id, quantity)

    from app.services.target_schema import service_request_service
    booking = service_request_service.create_booking(
        db, channel="customer", user_id=user.id, merchant_id=None, item_type=item_type, item_id=item_id,
        total_amount=total_price, quantity=quantity, departure_date=travel_date,
        coupon_code=coupon.code if coupon else None,
        details={"discount_amount": total_discount} if total_discount else None,
        request_status="confirmed",
    )

    payment = payment_service.record_transaction(
        db, service_request_id=booking.id, user_id=user.id, merchant_id=None, amount=total_price, method="mock",
    )
    if coupon:
        payment_service.redeem_code(db, coupon)

    system_log_service.log_activity(
        db, user_id=user.id, event=f"{user.full_name} booked {item_type} #{item_id} (booking #{booking.id})",
        entity_type="service_request", entity_id=booking.id, activity_type="Booking Created", module="Booking",
    )
    system_log_service.log_activity(
        db, user_id=user.id, event=f"Payment of ₹{total_price:,.2f} for booking #{booking.id} succeeded",
        entity_type="payment", entity_id=payment.id, activity_type="Payment Completed", module="Payment",
    )
    msg_log_service.send(
        db, channel="notification", user_id=user.id, subject="Booking confirmed",
        message=f"Your {item_type} booking (#{booking.id}) is confirmed.",
        related_entity_type="service_request", related_entity_id=booking.id,
    )
    msg_log_service.send(
        db, channel="notification", user_id=user.id, subject="Payment successful",
        message=f"Payment of ₹{total_price:,.2f} for booking #{booking.id} was successful.",
        related_entity_type="payment", related_entity_id=payment.id,
    )
    msg_log_service.notify_admins(
        db, "New booking received",
        f"{user.full_name} booked {item_type} #{item_id} for ₹{total_price:,.2f} (booking #{booking.id}).",
    )
    _maybe_alert_low_stock(db, item_type, item, availability_before, new_available)
    return booking, payment


def _maybe_alert_low_stock(db: Session, item_type: str, item, before: int, after: int) -> None:
    """Notifies admins once per threshold-crossing, not on every booking made while already low."""
    threshold = getattr(item, "low_stock_threshold", 0)
    if before > threshold >= after:
        label = _AVAILABILITY_LABEL[item_type]
        message = f"Only {after} {label} left for {item_display_name(db, item_type, item.id)} (threshold: {threshold})."
        title = "Sold out" if after <= 0 else "Low availability"
        msg_log_service.notify_admins(db, title, message)


def list_user_bookings(db: Session, user: User) -> list[ServiceRequest]:
    stmt = (
        select(ServiceRequest)
        .where(ServiceRequest.user_id == user.id, ServiceRequest.request_type == "booking")
        .order_by(ServiceRequest.created_at.desc())
    )
    return db.scalars(stmt).all()


def refund_payment_for_booking(db: Session, booking: ServiceRequest) -> None:
    payment = db.scalar(
        select(payment_service.Payment).where(
            payment_service.Payment.service_request_id == booking.id,
            payment_service.Payment.status == "success",
        )
    )
    if not payment:
        return
    payment_service.refund(db, payment.id)
    system_log_service.log_activity(
        db, user_id=booking.user_id, event=f"Payment for booking #{booking.id} was refunded",
        entity_type="payment", entity_id=payment.id, activity_type="Payment Refunded", module="Payment",
    )
    msg_log_service.send(
        db, channel="notification", user_id=booking.user_id, subject="Payment refunded",
        message=f"Your payment for booking #{booking.id} has been refunded.",
    )


def cancel_booking(db: Session, user: User, booking_id: int) -> ServiceRequest:
    booking = db.get(ServiceRequest, booking_id)
    if not booking or booking.user_id != user.id or booking.request_type != "booking":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    if booking.status == "cancelled":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Booking is already cancelled")

    from app.services.target_schema import service_request_service
    booking = service_request_service.update_status(db, booking_id, "cancelled")

    system_log_service.log_activity(
        db, user_id=user.id, event=f"{user.full_name} cancelled booking #{booking.id}",
        entity_type="service_request", entity_id=booking.id, activity_type="Booking Cancelled", module="Booking",
    )
    msg_log_service.send(
        db, channel="notification", user_id=user.id, subject="Booking cancelled",
        message=f"Your booking #{booking.id} has been cancelled.",
    )
    restore_inventory(db, booking.item_type, booking.item_id, booking.quantity)
    db.commit()
    refund_payment_for_booking(db, booking)
    return booking


def list_user_payments(db: Session, user: User) -> list["payment_service.Payment"]:
    stmt = (
        select(payment_service.Payment)
        .where(payment_service.Payment.user_id == user.id, payment_service.Payment.record_type == "transaction")
        .order_by(payment_service.Payment.created_at.desc())
    )
    return db.scalars(stmt).all()
