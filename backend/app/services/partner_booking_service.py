from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.schemas.partner_booking import PassengerCreate, TicketRequestCreate


def get_dashboard_stats(db: Session, partner_id: int) -> dict:
    row = db.execute(
        text("SELECT * FROM sp_get_dashboard_statistics(:pid)"), {"pid": partner_id}
    ).mappings().first()
    if not row:
        return {
            "total_requests": 0, "pending_requests": 0, "approved_requests": 0, "rejected_requests": 0,
            "completed_requests": 0, "cancelled_requests": 0, "today_requests": 0, "today_revenue": 0,
        }
    return dict(row)


def search_ticket_enquiry(
    db: Session, departure: str | None, arrival: str | None, date: str | None, cabin_class: str | None
) -> list[dict]:
    rows = db.execute(
        text("SELECT * FROM sp_get_ticket_enquiry(:departure, :arrival, :date, :cabin_class)"),
        {"departure": departure, "arrival": arrival, "date": date, "cabin_class": cabin_class},
    ).mappings().all()
    return [dict(r) for r in rows]


def create_ticket_request(db: Session, partner_id: int, partner_user_id: int, payload: TicketRequestCreate) -> dict:
    row = db.execute(
        text("""
            SELECT * FROM sp_create_ticket_request(
                :partner_id, :partner_user_id, :travel_type, :flight_id, :hotel_id, :cruise_id,
                :airline_name, :flight_number, :trip_type, :departure, :arrival,
                :departure_date, :return_date, :cabin_class
            )
        """),
        {
            "partner_id": partner_id, "partner_user_id": partner_user_id, "travel_type": payload.travel_type,
            "flight_id": payload.flight_id, "hotel_id": payload.hotel_id, "cruise_id": payload.cruise_id,
            "airline_name": payload.airline_name, "flight_number": payload.flight_number,
            "trip_type": payload.trip_type, "departure": payload.departure, "arrival": payload.arrival,
            "departure_date": payload.departure_date, "return_date": payload.return_date,
            "cabin_class": payload.cabin_class,
        },
    ).mappings().first()
    db.commit()
    return dict(row)


def add_passenger(db: Session, partner_id: int, booking_id: int, payload: PassengerCreate) -> int:
    _get_own_booking_or_404(db, partner_id, booking_id)
    passenger_id = db.execute(
        text("""
            SELECT sp_add_passenger(
                :booking_id, :full_name, :gender, :passenger_type, :passport_issuing_country_id,
                :passport_number, :passport_issue_date, :passport_expiry_date, :date_of_birth,
                :nationality_country_id, :meal_preference, :special_assistance
            )
        """),
        {
            "booking_id": booking_id, "full_name": payload.full_name, "gender": payload.gender,
            "passenger_type": payload.passenger_type,
            "passport_issuing_country_id": payload.passport_issuing_country_id,
            "passport_number": payload.passport_number, "passport_issue_date": payload.passport_issue_date,
            "passport_expiry_date": payload.passport_expiry_date, "date_of_birth": payload.date_of_birth,
            "nationality_country_id": payload.nationality_country_id,
            "meal_preference": payload.meal_preference, "special_assistance": payload.special_assistance,
        },
    ).scalar()
    db.commit()
    return passenger_id


def submit_for_approval(db: Session, partner_id: int, booking_id: int) -> None:
    _get_own_booking_or_404(db, partner_id, booking_id)
    try:
        db.execute(text("SELECT sp_submit_request_for_approval(:booking_id)"), {"booking_id": booking_id})
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc.orig).split("CONTEXT")[0].strip()) from exc


def get_booking_detail(db: Session, partner_id: int, booking_id: int) -> dict:
    booking = _get_own_booking_or_404(db, partner_id, booking_id)
    passengers = db.execute(
        text("SELECT * FROM partner_booking_passengers WHERE booking_id = :bid ORDER BY passenger_id"),
        {"bid": booking_id},
    ).mappings().all()
    booking = dict(booking)
    booking["passengers"] = [dict(p) for p in passengers]
    return booking


def get_request_history(
    db: Session, partner_id: int, status_filter: str | None, from_date: str | None, to_date: str | None
) -> list[dict]:
    rows = db.execute(
        text("SELECT * FROM sp_get_request_history(:partner_id, :status, :from_date, :to_date)"),
        {"partner_id": partner_id, "status": status_filter, "from_date": from_date, "to_date": to_date},
    ).mappings().all()
    return [dict(r) for r in rows]


def _get_own_booking_or_404(db: Session, partner_id: int, booking_id: int) -> dict:
    """Every booking-scoped operation goes through here — partners can only
    ever act on their own bookings, enforced here rather than trusting the
    caller, regardless of what booking_id a client sends."""
    row = db.execute(
        text("SELECT * FROM partner_bookings WHERE booking_id = :bid AND partner_id = :pid"),
        {"bid": booking_id, "pid": partner_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    return dict(row)
