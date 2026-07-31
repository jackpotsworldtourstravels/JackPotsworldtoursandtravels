import datetime

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

# Catalog stays legacy — same reasoning as booking_service.py.
from app.models.travel import Flight
from app.models.target_schema.service_requests import ServiceRequest
from app.services.target_schema import passenger_service, service_request_service


def get_dashboard_stats(db: Session, merchant_id: int) -> dict:
    base = select(ServiceRequest).where(ServiceRequest.merchant_id == merchant_id, ServiceRequest.request_type == "booking")

    def _count(status_value: str) -> int:
        return db.scalar(select(func.count()).select_from(base.where(ServiceRequest.status == status_value).subquery())) or 0

    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    today_start = datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_requests = db.scalar(
        select(func.count()).select_from(base.where(ServiceRequest.created_at >= today_start).subquery())
    ) or 0
    today_revenue = db.scalar(
        select(func.coalesce(func.sum(ServiceRequest.total_amount), 0)).where(
            ServiceRequest.merchant_id == merchant_id, ServiceRequest.request_type == "booking",
            ServiceRequest.status == "approved", ServiceRequest.created_at >= today_start,
        )
    ) or 0
    return {
        "total_requests": total, "pending_requests": _count("pending"), "approved_requests": _count("approved"),
        "rejected_requests": _count("rejected"), "completed_requests": _count("completed"),
        "cancelled_requests": _count("cancelled"), "today_requests": today_requests,
        "today_revenue": float(today_revenue),
    }


def search_ticket_enquiry(
    db: Session, departure: str | None, arrival: str | None, date: datetime.date | None, cabin_class: str | None
) -> list[Flight]:
    stmt = select(Flight)
    if departure:
        stmt = stmt.where(Flight.from_airport.ilike(f"%{departure}%"))
    if arrival:
        stmt = stmt.where(Flight.to_airport.ilike(f"%{arrival}%"))
    if date:
        stmt = stmt.where(func.date(Flight.departure_time) == date)
    if cabin_class:
        stmt = stmt.where(Flight.cabin_class.ilike(cabin_class))
    return db.scalars(stmt.order_by(Flight.departure_time)).all()


def create_ticket_request(db: Session, merchant_id: int, user_id: int, payload: dict) -> ServiceRequest:
    """Creates a draft booking — legacy's multi-step flow (draft -> add
    passengers -> submit for approval) is preserved via request_status='draft'."""
    item_type = {"flight": "flight", "hotel": "hotel", "cruise": "cruise"}[payload["travel_type"]]
    item_id = payload.get("flight_id") or payload.get("hotel_id") or payload.get("cruise_id")
    details = {k: payload[k] for k in ("airline_name", "flight_number") if payload.get(k)} or None
    return service_request_service.create_booking(
        db, channel="merchant", user_id=user_id, merchant_id=merchant_id, item_type=item_type, item_id=item_id,
        total_amount=None, request_status="draft", trip_type=payload.get("trip_type"),
        cabin_class=payload.get("cabin_class"), departure=payload["departure"], arrival=payload["arrival"],
        departure_date=payload["departure_date"], return_date=payload.get("return_date"), details=details,
    )


def _get_own_booking_or_404(db: Session, merchant_id: int, booking_id: int) -> ServiceRequest:
    booking = db.get(ServiceRequest, booking_id)
    if not booking or booking.merchant_id != merchant_id or booking.request_type != "booking":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    return booking


def add_passenger(db: Session, merchant_id: int, booking_id: int, payload: dict) -> int:
    booking = _get_own_booking_or_404(db, merchant_id, booking_id)
    if booking.status != "draft":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Passengers can only be added to a draft booking")
    passenger = passenger_service.add_passenger(db, service_request_id=booking.id, **payload)
    return passenger.id


def submit_for_approval(db: Session, merchant_id: int, booking_id: int) -> None:
    booking = _get_own_booking_or_404(db, merchant_id, booking_id)
    if booking.status != "draft":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only a draft booking can be submitted")
    if not passenger_service.list_for_request(db, booking.id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Add at least one passenger before submitting")
    service_request_service.update_status(db, booking.id, "pending")


def get_booking_detail(db: Session, merchant_id: int, booking_id: int) -> ServiceRequest:
    return _get_own_booking_or_404(db, merchant_id, booking_id)


def get_request_history(
    db: Session, merchant_id: int, status_filter: str | None, from_date: datetime.date | None, to_date: datetime.date | None
) -> list[ServiceRequest]:
    stmt = select(ServiceRequest).where(ServiceRequest.merchant_id == merchant_id)
    if status_filter:
        stmt = stmt.where(ServiceRequest.status == status_filter)
    if from_date:
        stmt = stmt.where(ServiceRequest.created_at >= from_date)
    if to_date:
        stmt = stmt.where(ServiceRequest.created_at < to_date + datetime.timedelta(days=1))
    return db.scalars(stmt.order_by(ServiceRequest.created_at.desc())).all()


def verify_reference_belongs_to_merchant(db: Session, merchant_id: int, reference_number: str) -> ServiceRequest:
    """Every subtype-request creation goes through here — a merchant can only
    ever act on their own bookings, enforced here rather than trusting the
    caller, regardless of what reference_number a client sends."""
    booking = db.scalar(select(ServiceRequest).where(ServiceRequest.request_number == reference_number))
    if not booking or booking.merchant_id != merchant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking reference not found")
    return booking
