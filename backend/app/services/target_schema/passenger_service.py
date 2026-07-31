import datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.target_schema.passenger_data import PassengerData


def add_passenger(db: Session, *, service_request_id: int, full_name: str, **fields) -> PassengerData:
    now = datetime.datetime.now(datetime.timezone.utc)
    passenger = PassengerData(
        service_request_id=service_request_id, full_name=full_name, created_at=now, updated_at=now,
        **{k: v for k, v in fields.items() if v is not None},
    )
    db.add(passenger)
    db.commit()
    db.refresh(passenger)
    return passenger


def get_by_id(db: Session, passenger_id: int) -> PassengerData:
    passenger = db.get(PassengerData, passenger_id)
    if not passenger:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Passenger not found")
    return passenger


def list_for_request(db: Session, service_request_id: int) -> list[PassengerData]:
    return db.scalars(
        select(PassengerData).where(PassengerData.service_request_id == service_request_id)
    ).all()


def update_passenger(db: Session, passenger_id: int, field_changed: str, new_value: str) -> PassengerData:
    passenger = get_by_id(db, passenger_id)
    if not hasattr(passenger, field_changed):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown passenger field: {field_changed}")
    setattr(passenger, field_changed, new_value)
    db.commit()
    db.refresh(passenger)
    return passenger
