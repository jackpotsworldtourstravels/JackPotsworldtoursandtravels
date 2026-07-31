import datetime
import uuid

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.target_schema.payments import Payment


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _normalize_code(code: str) -> str:
    return code.strip().upper()


def _discount_amount(discount_type: str, value: float, amount: float) -> float:
    raw = amount * value / 100 if discount_type == "percent" else value
    return round(min(raw, amount), 2)


def get_by_id(db: Session, payment_id: int) -> Payment:
    payment = db.get(Payment, payment_id)
    if not payment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found")
    return payment


def record_transaction(
    db: Session, *, service_request_id: int | None, user_id: int | None, merchant_id: int | None,
    amount, method: str, status_: str = "success",
) -> Payment:
    now = _now()
    payment = Payment(
        record_type="transaction", service_request_id=service_request_id, user_id=user_id,
        merchant_id=merchant_id, amount=amount, method=method, status=status_,
        transaction_ref=f"TXN-{uuid.uuid4().hex[:12].upper()}", created_at=now, updated_at=now,
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)
    return payment


def refund(db: Session, payment_id: int) -> Payment:
    payment = get_by_id(db, payment_id)
    if payment.record_type != "transaction" or payment.status != "success":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only a successful transaction can be refunded")
    payment.status = "refunded"
    payment.refunded_at = _now()
    payment.refund_reference = f"RFD-{uuid.uuid4().hex[:12].upper()}"
    db.commit()
    db.refresh(payment)
    return payment


def get_active_code(db: Session, code: str) -> Payment | None:
    """Looks up an active coupon or discount campaign by code, applying the
    same validity checks (is_active, date window, usage_limit) the legacy
    coupons/discount_campaigns tables enforced independently.
    """
    payment = db.scalar(
        select(Payment).where(
            Payment.code == _normalize_code(code), Payment.record_type.in_(("coupon", "discount_campaign"))
        )
    )
    if not payment or not payment.is_active:
        return None
    now = _now()
    if payment.valid_from and payment.valid_from > now:
        return None
    if payment.valid_until and payment.valid_until < now:
        return None
    if payment.usage_limit is not None and payment.used_count >= payment.usage_limit:
        return None
    return payment


def validate_coupon(db: Session, code: str, item_type: str, amount_after_campaign: float) -> Payment:
    """Raises HTTPException with a customer-facing message if the code can't
    be used right now — same checks as the legacy pricing_service.validate_coupon,
    plus applicable_item_type/min_order_amount now living on the same row."""
    payment = db.scalar(
        select(Payment).where(Payment.code == _normalize_code(code), Payment.record_type == "coupon")
    )
    if not payment or not payment.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid coupon code.")
    now = _now()
    if (payment.valid_from and payment.valid_from > now) or (payment.valid_until and payment.valid_until < now):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This coupon has expired or isn't active yet.")
    if payment.applicable_item_type and payment.applicable_item_type != item_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"This coupon only applies to {payment.applicable_item_type} bookings.",
        )
    if payment.usage_limit is not None and payment.used_count >= payment.usage_limit:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This coupon has reached its usage limit.")
    if payment.min_order_amount is not None and amount_after_campaign < float(payment.min_order_amount):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"This coupon requires a minimum order amount of ₹{float(payment.min_order_amount):,.2f}.",
        )
    return payment


def apply_discount(payment: Payment, amount: float) -> float:
    return _discount_amount(payment.discount_type, float(payment.discount_value), amount)


def redeem_code(db: Session, payment: Payment) -> None:
    payment.used_count += 1
    db.commit()


def get_active_campaign_discount(db: Session, item_type: str, base_amount: float) -> tuple[float, Payment | None]:
    """Best auto-applied discount_campaign for this item type today, mirroring
    the legacy pricing_service.get_active_campaign_discount (picks whichever
    active campaign yields the largest discount, not just the first match)."""
    now = _now()
    stmt = select(Payment).where(
        Payment.record_type == "discount_campaign",
        Payment.is_active.is_(True),
        or_(Payment.valid_from.is_(None), Payment.valid_from <= now),
        or_(Payment.valid_until.is_(None), Payment.valid_until >= now),
        or_(Payment.applicable_item_type.is_(None), Payment.applicable_item_type == item_type),
    )
    campaigns = db.scalars(stmt).all()
    if not campaigns:
        return 0.0, None
    best = max(campaigns, key=lambda c: _discount_amount(c.discount_type, float(c.discount_value), base_amount))
    return _discount_amount(best.discount_type, float(best.discount_value), base_amount), best


def get_effective_unit_price(item, on_date: datetime.date | None, base_price: float) -> float:
    """Reads the catalog item's own seasonal_pricing JSONB column (a list of
    {start_date, end_date, override_price, label} objects) — replaces a
    separate seasonal_prices table lookup with a plain Python scan over data
    already loaded on the item, since it's now scoped to that one row.
    """
    on_date = on_date or datetime.date.today()
    for entry in getattr(item, "seasonal_pricing", None) or []:
        start = datetime.date.fromisoformat(entry["start_date"])
        end = datetime.date.fromisoformat(entry["end_date"])
        if start <= on_date <= end:
            return float(entry["override_price"])
    return base_price


def list_by_service_request(db: Session, service_request_id: int) -> list[Payment]:
    return db.scalars(
        select(Payment)
        .where(Payment.service_request_id == service_request_id, Payment.record_type == "transaction")
        .order_by(Payment.created_at.desc())
    ).all()
