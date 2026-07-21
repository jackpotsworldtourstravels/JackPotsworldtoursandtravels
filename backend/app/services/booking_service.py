import datetime
import secrets

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models.booking import Booking, Payment
from app.models.user import User
from app.schemas.booking import BookingCreate
from app.services import activity_service, catalog_items, notification_service, pricing_service
from app.services.catalog_items import AVAILABILITY_FIELD, ITEM_MODELS

_AVAILABILITY_LABEL = {"flight": "seat(s)", "hotel": "room(s)", "cruise": "cabin(s)", "package": "slot(s)"}


def get_item(db: Session, booking_type: str, item_id: int):
    model = ITEM_MODELS[booking_type]
    item = db.get(model, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{booking_type} {item_id} not found")
    return item


def unit_price(booking_type: str, item) -> float:
    return catalog_items.base_unit_price(booking_type, item)


def check_availability(booking_type: str, item, quantity: int) -> None:
    """Friendly pre-check before the real atomic guard in decrement_inventory."""
    available = getattr(item, AVAILABILITY_FIELD[booking_type])
    if available < quantity:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Only {available} {_AVAILABILITY_LABEL[booking_type]} available for this {booking_type}.",
        )


def decrement_inventory(db: Session, booking_type: str, item_id: int, quantity: int) -> int:
    """Atomically consumes inventory, race-safe against concurrent bookings for the
    same item — the WHERE clause means a losing request affects zero rows instead
    of driving availability negative, so it can raise instead of overselling.
    """
    model = ITEM_MODELS[booking_type]
    field_name = AVAILABILITY_FIELD[booking_type]
    field = getattr(model, field_name)
    stmt = (
        update(model)
        .where(model.id == item_id, field >= quantity)
        .values(**{field_name: field - quantity})
        .returning(field)
    )
    row = db.execute(stmt).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"This {booking_type} no longer has enough {_AVAILABILITY_LABEL[booking_type]} available.",
        )
    return row[0]


def restore_inventory(db: Session, booking_type: str, item_id: int, quantity: int) -> None:
    model = ITEM_MODELS[booking_type]
    field_name = AVAILABILITY_FIELD[booking_type]
    field = getattr(model, field_name)
    db.execute(update(model).where(model.id == item_id).values(**{field_name: field + quantity}))


def restore_inventory_for_booking(db: Session, booking: "Booking") -> None:
    """Puts a cancelled booking's seats/rooms/cabins/slots back into the pool.
    Safe to call from any cancellation path (user-initiated or admin-initiated).
    """
    restore_inventory(db, booking.booking_type, booking.item_id, booking.quantity)
    db.commit()


def create_booking_with_payment(db: Session, user: User, payload: BookingCreate) -> tuple[Booking, Payment]:
    item = get_item(db, payload.booking_type, payload.item_id)
    check_availability(payload.booking_type, item, payload.quantity)

    # Server recomputes the price from the catalog — the client-supplied total_price is ignored.
    # Order: base/seasonal unit price -> auto campaign discount -> optional coupon on top.
    # With no seasonal price, no active campaign, and no coupon (true for all bookings today),
    # this is exactly unit_price * quantity, unchanged from before pricing existed.
    effective_unit_price = pricing_service.get_effective_unit_price(db, payload.booking_type, item, payload.travel_date)
    subtotal = round(effective_unit_price * payload.quantity, 2)
    campaign_discount, _campaign = pricing_service.get_active_campaign_discount(db, payload.booking_type, subtotal)
    amount_after_campaign = subtotal - campaign_discount

    coupon = None
    coupon_discount = 0.0
    if payload.coupon_code:
        coupon = pricing_service.validate_coupon(db, payload.coupon_code, payload.booking_type, amount_after_campaign)
        coupon_discount = pricing_service.apply_coupon_discount(coupon, amount_after_campaign)

    total_discount = round(campaign_discount + coupon_discount, 2)
    total_price = max(round(subtotal - total_discount, 2), 0.01)

    availability_before = getattr(item, AVAILABILITY_FIELD[payload.booking_type])
    new_available = decrement_inventory(db, payload.booking_type, payload.item_id, payload.quantity)

    booking = Booking(
        user_id=user.id,
        booking_type=payload.booking_type,
        item_id=payload.item_id,
        status="confirmed",
        total_price=total_price,
        quantity=payload.quantity,
        travel_date=payload.travel_date,
        coupon_code=coupon.code if coupon else None,
        discount_amount=total_discount or None,
    )
    db.add(booking)
    db.flush()

    payment = Payment(
        booking_id=booking.id,
        user_id=user.id,
        amount=total_price,
        method="mock",
        status="success",
        transaction_ref=f"TXN-{secrets.token_hex(6).upper()}",
    )
    db.add(payment)
    if coupon:
        coupon.times_used += 1
    db.commit()
    db.refresh(booking)
    db.refresh(payment)

    activity_service.log_activity(
        db, user.id, f"Booking Created ({payload.booking_type} #{payload.item_id})",
        activity_type="Booking Created", module="Booking", reference_id=booking.id,
        description=f"{user.full_name} booked {payload.booking_type} #{payload.item_id} (booking #{booking.id})",
    )
    activity_service.log_activity(
        db, user.id, f"Payment Successful (#{payment.id})",
        activity_type="Payment Completed", module="Payment", reference_id=payment.id,
        description=f"Payment of ₹{total_price:,.2f} for booking #{booking.id} succeeded",
    )
    notification_service.create_notification(
        db, user.id, "Booking confirmed",
        f"Your {payload.booking_type} booking (#{booking.id}) is confirmed.",
    )
    notification_service.create_notification(
        db, user.id, "Payment successful",
        f"Payment of ₹{total_price:,.2f} for booking #{booking.id} was successful.",
    )
    notification_service.notify_admins(
        db, "New booking received",
        f"{user.full_name} booked {payload.booking_type} #{payload.item_id} for ₹{total_price:,.2f} (booking #{booking.id}).",
    )
    _maybe_alert_low_stock(db, payload.booking_type, item, availability_before, new_available)
    return booking, payment


def _maybe_alert_low_stock(db: Session, booking_type: str, item, before: int, after: int) -> None:
    """Notifies admins once per threshold-crossing, not on every booking made
    while already low — 'before > threshold >= after' catches the crossing.
    """
    threshold = item.low_stock_threshold
    if before > threshold >= after:
        label = _AVAILABILITY_LABEL[booking_type]
        message = (
            f"Only {after} {label} left for {catalog_items.item_display_name(db, booking_type, item.id)} "
            f"(threshold: {threshold})."
        )
        title = "Sold out" if after <= 0 else "Low availability"
        notification_service.notify_admins(db, title, message)


def list_user_bookings(db: Session, user: User) -> list[Booking]:
    stmt = select(Booking).where(Booking.user_id == user.id).order_by(Booking.created_at.desc())
    return db.scalars(stmt).all()


def refund_payment_for_booking(db: Session, booking: Booking) -> None:
    payment = db.scalar(select(Payment).where(Payment.booking_id == booking.id, Payment.status == "success"))
    if not payment:
        return
    payment.status = "refunded"
    payment.refunded_at = datetime.datetime.utcnow()
    payment.refund_reference = f"RFD-{secrets.token_hex(6).upper()}"
    db.commit()
    activity_service.log_activity(
        db, booking.user_id, f"Payment Refunded (#{booking.id})",
        activity_type="Payment Refunded", module="Payment", reference_id=payment.id,
        description=f"Payment for booking #{booking.id} was refunded",
    )
    notification_service.create_notification(
        db, booking.user_id, "Payment refunded", f"Your payment for booking #{booking.id} has been refunded."
    )


def cancel_booking(db: Session, user: User, booking_id: int) -> Booking:
    booking = db.get(Booking, booking_id)
    if not booking or booking.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    if booking.status == "cancelled":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Booking is already cancelled")
    booking.status = "cancelled"
    db.commit()
    db.refresh(booking)

    activity_service.log_activity(
        db, user.id, f"Booking Cancelled (#{booking.id})",
        activity_type="Booking Cancelled", module="Booking", reference_id=booking.id,
        description=f"{user.full_name} cancelled booking #{booking.id}",
    )
    notification_service.create_notification(
        db, user.id, "Booking cancelled", f"Your booking #{booking.id} has been cancelled."
    )
    restore_inventory_for_booking(db, booking)
    refund_payment_for_booking(db, booking)
    return booking


def list_user_payments(db: Session, user: User) -> list[Payment]:
    stmt = select(Payment).where(Payment.user_id == user.id).order_by(Payment.created_at.desc())
    return db.scalars(stmt).all()
