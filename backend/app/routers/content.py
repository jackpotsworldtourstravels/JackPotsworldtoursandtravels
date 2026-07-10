import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models.travel import Cruise, Flight, Hotel, TourPackage
from app.schemas.travel import (
    CruiseCreate,
    CruiseOut,
    FlightCreate,
    FlightOut,
    HotelCreate,
    HotelOut,
    TourPackageCreate,
    TourPackageOut,
)

flights_router = APIRouter(prefix="/api/flights", tags=["flights"])
hotels_router = APIRouter(prefix="/api/hotels", tags=["hotels"])
cruises_router = APIRouter(prefix="/api/cruises", tags=["cruises"])
packages_router = APIRouter(prefix="/api/packages", tags=["packages"])


def _get_or_404(db: Session, model, item_id: int):
    obj = db.get(model, item_id)
    if not obj:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return obj


# ---------- Flights ----------
@flights_router.get("", response_model=list[FlightOut])
def list_flights(
    from_airport: str | None = None,
    to_airport: str | None = None,
    departure_date: datetime.date | None = None,
    db: Session = Depends(get_db),
):
    stmt = select(Flight)
    if from_airport:
        stmt = stmt.where(Flight.from_airport.ilike(f"%{from_airport}%"))
    if to_airport:
        stmt = stmt.where(Flight.to_airport.ilike(f"%{to_airport}%"))
    if departure_date:
        stmt = stmt.where(
            Flight.departure_time >= datetime.datetime.combine(departure_date, datetime.time.min),
            Flight.departure_time <= datetime.datetime.combine(departure_date, datetime.time.max),
        )
    return db.scalars(stmt.order_by(Flight.price)).all()


@flights_router.post("", response_model=FlightOut, status_code=status.HTTP_201_CREATED)
def create_flight(payload: FlightCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    flight = Flight(**payload.model_dump())
    db.add(flight)
    db.commit()
    db.refresh(flight)
    return flight


@flights_router.put("/{flight_id}", response_model=FlightOut)
def update_flight(
    flight_id: int, payload: FlightCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)
):
    flight = _get_or_404(db, Flight, flight_id)
    for key, value in payload.model_dump().items():
        setattr(flight, key, value)
    db.commit()
    db.refresh(flight)
    return flight


@flights_router.delete("/{flight_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_flight(flight_id: int, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    flight = _get_or_404(db, Flight, flight_id)
    db.delete(flight)
    db.commit()


# ---------- Hotels ----------
@hotels_router.get("", response_model=list[HotelOut])
def list_hotels(location: str | None = None, db: Session = Depends(get_db)):
    stmt = select(Hotel)
    if location:
        stmt = stmt.where(Hotel.location.ilike(f"%{location}%"))
    return db.scalars(stmt.order_by(Hotel.price_per_night)).all()


@hotels_router.post("", response_model=HotelOut, status_code=status.HTTP_201_CREATED)
def create_hotel(payload: HotelCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    hotel = Hotel(**payload.model_dump())
    db.add(hotel)
    db.commit()
    db.refresh(hotel)
    return hotel


@hotels_router.put("/{hotel_id}", response_model=HotelOut)
def update_hotel(
    hotel_id: int, payload: HotelCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)
):
    hotel = _get_or_404(db, Hotel, hotel_id)
    for key, value in payload.model_dump().items():
        setattr(hotel, key, value)
    db.commit()
    db.refresh(hotel)
    return hotel


@hotels_router.delete("/{hotel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_hotel(hotel_id: int, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    hotel = _get_or_404(db, Hotel, hotel_id)
    db.delete(hotel)
    db.commit()


# ---------- Cruises ----------
@cruises_router.get("", response_model=list[CruiseOut])
def list_cruises(cruise_type: str | None = None, departure_month: str | None = None, db: Session = Depends(get_db)):
    stmt = select(Cruise)
    if cruise_type:
        stmt = stmt.where(Cruise.cruise_type.ilike(f"%{cruise_type}%"))
    if departure_month:
        stmt = stmt.where(Cruise.departure_month == departure_month)
    return db.scalars(stmt.order_by(Cruise.price)).all()


@cruises_router.post("", response_model=CruiseOut, status_code=status.HTTP_201_CREATED)
def create_cruise(payload: CruiseCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    cruise = Cruise(**payload.model_dump())
    db.add(cruise)
    db.commit()
    db.refresh(cruise)
    return cruise


@cruises_router.put("/{cruise_id}", response_model=CruiseOut)
def update_cruise(
    cruise_id: int, payload: CruiseCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)
):
    cruise = _get_or_404(db, Cruise, cruise_id)
    for key, value in payload.model_dump().items():
        setattr(cruise, key, value)
    db.commit()
    db.refresh(cruise)
    return cruise


@cruises_router.delete("/{cruise_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cruise(cruise_id: int, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    cruise = _get_or_404(db, Cruise, cruise_id)
    db.delete(cruise)
    db.commit()


# ---------- Tour Packages ----------
@packages_router.get("", response_model=list[TourPackageOut])
def list_packages(
    package_type: str | None = None,
    limit: int | None = Query(default=None, gt=0, le=100),
    db: Session = Depends(get_db),
):
    stmt = select(TourPackage)
    if package_type:
        stmt = stmt.where(TourPackage.package_type.ilike(f"%{package_type}%"))
    stmt = stmt.order_by(TourPackage.id)
    if limit:
        stmt = stmt.limit(limit)
    return db.scalars(stmt).all()


@packages_router.post("", response_model=TourPackageOut, status_code=status.HTTP_201_CREATED)
def create_package(payload: TourPackageCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    package = TourPackage(**payload.model_dump())
    db.add(package)
    db.commit()
    db.refresh(package)
    return package


@packages_router.put("/{package_id}", response_model=TourPackageOut)
def update_package(
    package_id: int, payload: TourPackageCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)
):
    package = _get_or_404(db, TourPackage, package_id)
    for key, value in payload.model_dump().items():
        setattr(package, key, value)
    db.commit()
    db.refresh(package)
    return package


@packages_router.delete("/{package_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_package(package_id: int, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    package = _get_or_404(db, TourPackage, package_id)
    db.delete(package)
    db.commit()
