import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.target_schema.passenger_data import PassengerData
from app.models.target_schema.service_requests import ServiceRequest
from app.services.target_schema import system_log_service


def generate_report(
    db: Session, merchant_id: int, user_id: int, *,
    request_date_from: datetime.date | None = None, request_date_to: datetime.date | None = None,
    travel_date_from: datetime.date | None = None, travel_date_to: datetime.date | None = None,
    passenger_name: str | None = None, service_request_number: str | None = None,
    sector_departure: str | None = None, sector_arrival: str | None = None, export_format: str = "excel",
) -> list[dict]:
    stmt = select(ServiceRequest).where(ServiceRequest.merchant_id == merchant_id)
    if request_date_from:
        stmt = stmt.where(ServiceRequest.created_at >= request_date_from)
    if request_date_to:
        stmt = stmt.where(ServiceRequest.created_at < request_date_to + datetime.timedelta(days=1))
    if travel_date_from:
        stmt = stmt.where(ServiceRequest.departure_date >= travel_date_from)
    if travel_date_to:
        stmt = stmt.where(ServiceRequest.departure_date <= travel_date_to)
    if service_request_number:
        stmt = stmt.where(ServiceRequest.request_number.ilike(f"%{service_request_number}%"))
    if sector_departure:
        stmt = stmt.where(ServiceRequest.departure.ilike(f"%{sector_departure}%"))
    if sector_arrival:
        stmt = stmt.where(ServiceRequest.arrival.ilike(f"%{sector_arrival}%"))
    if passenger_name:
        matching_ids = db.scalars(
            select(ServiceRequest.id).join(PassengerData, PassengerData.service_request_id == ServiceRequest.id)
            .where(ServiceRequest.merchant_id == merchant_id, PassengerData.full_name.ilike(f"%{passenger_name}%"))
        ).all()
        stmt = stmt.where(ServiceRequest.id.in_(matching_ids))

    rows = db.scalars(stmt.order_by(ServiceRequest.created_at.desc())).all()
    system_log_service.log_report_generation(
        db, user_id=user_id,
        filters={
            "request_date_from": str(request_date_from) if request_date_from else None,
            "request_date_to": str(request_date_to) if request_date_to else None,
            "travel_date_from": str(travel_date_from) if travel_date_from else None,
            "travel_date_to": str(travel_date_to) if travel_date_to else None,
            "passenger_name": passenger_name, "service_request_number": service_request_number,
            "sector_departure": sector_departure, "sector_arrival": sector_arrival,
        },
        export_format=export_format,
    )
    return [
        {
            "request_number": r.request_number, "request_type": r.request_type, "status": r.status,
            "departure": r.departure, "arrival": r.arrival, "departure_date": r.departure_date,
            "return_date": r.return_date, "total_amount": float(r.total_amount) if r.total_amount else None,
            "created_at": r.created_at,
        }
        for r in rows
    ]
