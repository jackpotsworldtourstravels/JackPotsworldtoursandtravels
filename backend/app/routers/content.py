import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin, get_current_user_optional
from app.database.session import get_db
from app.models.travel import Cruise, Flight, Hotel, TourPackage
from app.models.user import User
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
from app.services import activity_service

flights_router = APIRouter(prefix="/api/flights", tags=["flights"])
hotels_router = APIRouter(prefix="/api/hotels", tags=["hotels"])
cruises_router = APIRouter(prefix="/api/cruises", tags=["cruises"])
packages_router = APIRouter(prefix="/api/packages", tags=["packages"])


def _get_or_404(db: Session, model, item_id: int):
    obj = db.get(model, item_id)
    if not obj:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return obj


def _log_search(db: Session, current_user: User | None, category: str, detail: str) -> None:
    who = current_user.full_name if current_user else "A visitor"
    activity_service.log_activity(
        db, current_user.id if current_user else None, f"Search ({category}: {detail})",
        activity_type="Search", module="Search", description=f"{who} searched {category}s ({detail})",
    )


# ---------- Flights ----------
@flights_router.get(
    "",
    response_model=list[FlightOut],
    summary="Search/list flights",
    description="Public endpoint. Returns flights matching the given filters (route, date, cabin class, seats needed), ordered by price ascending. Filters are optional and combine with AND.",
)
def list_flights(
    from_airport: str | None = None,
    to_airport: str | None = None,
    departure_date: datetime.date | None = None,
    cabin_class: str | None = None,
    passengers: int | None = None,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user_optional),
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
    if cabin_class:
        stmt = stmt.where(Flight.cabin_class.ilike(f"%{cabin_class}%"))
    if passengers:
        stmt = stmt.where(Flight.seats_available >= passengers)
    if from_airport or to_airport or departure_date or cabin_class or passengers:
        _log_search(db, current_user, "flight", f"{from_airport or '*'} to {to_airport or '*'}")
    return db.scalars(stmt.order_by(Flight.price)).all()


@flights_router.post(
    "",
    response_model=FlightOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a flight",
    description="Requires admin role. Adds a new flight to the catalog.",
)
def create_flight(payload: FlightCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    flight = Flight(**payload.model_dump())
    db.add(flight)
    db.commit()
    db.refresh(flight)
    activity_service.log_activity(db, _admin.id, f"Admin created flight #{flight.id}", module="Admin", activity_type="Admin Action")
    return flight


@flights_router.put(
    "/{flight_id}",
    response_model=FlightOut,
    summary="Update a flight",
    description="Requires admin role. Replaces all fields of an existing flight. Returns 404 if the flight doesn't exist.",
)
def update_flight(
    flight_id: int, payload: FlightCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)
):
    flight = _get_or_404(db, Flight, flight_id)
    for key, value in payload.model_dump().items():
        setattr(flight, key, value)
    db.commit()
    db.refresh(flight)
    activity_service.log_activity(db, _admin.id, f"Admin updated flight #{flight_id}", module="Admin", activity_type="Admin Action")
    return flight


@flights_router.delete(
    "/{flight_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a flight",
    description="Requires admin role. Permanently removes a flight from the catalog. Returns 404 if it doesn't exist.",
)
def delete_flight(flight_id: int, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    flight = _get_or_404(db, Flight, flight_id)
    db.delete(flight)
    db.commit()
    activity_service.log_activity(db, _admin.id, f"Admin deleted flight #{flight_id}", module="Admin", activity_type="Admin Action")


# ---------- Hotels ----------
@hotels_router.get(
    "",
    response_model=list[HotelOut],
    summary="Search/list hotels",
    description="Public endpoint. Returns hotels matching the given filters (location, minimum rooms needed), ordered by price per night ascending.",
)
def list_hotels(
    location: str | None = None,
    rooms: int | None = None,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user_optional),
):
    stmt = select(Hotel)
    if location:
        stmt = stmt.where(Hotel.location.ilike(f"%{location}%"))
    if rooms:
        stmt = stmt.where(Hotel.rooms_available >= rooms)
    if location or rooms:
        _log_search(db, current_user, "hotel", location or "any location")
    return db.scalars(stmt.order_by(Hotel.price_per_night)).all()


@hotels_router.post(
    "",
    response_model=HotelOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a hotel",
    description="Requires admin role. Adds a new hotel to the catalog.",
)
def create_hotel(payload: HotelCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    hotel = Hotel(**payload.model_dump())
    db.add(hotel)
    db.commit()
    db.refresh(hotel)
    activity_service.log_activity(db, _admin.id, f"Admin created hotel #{hotel.id}", module="Admin", activity_type="Admin Action")
    return hotel


@hotels_router.put(
    "/{hotel_id}",
    response_model=HotelOut,
    summary="Update a hotel",
    description="Requires admin role. Replaces all fields of an existing hotel. Returns 404 if the hotel doesn't exist.",
)
def update_hotel(
    hotel_id: int, payload: HotelCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)
):
    hotel = _get_or_404(db, Hotel, hotel_id)
    for key, value in payload.model_dump().items():
        setattr(hotel, key, value)
    db.commit()
    db.refresh(hotel)
    activity_service.log_activity(db, _admin.id, f"Admin updated hotel #{hotel_id}", module="Admin", activity_type="Admin Action")
    return hotel


@hotels_router.delete(
    "/{hotel_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a hotel",
    description="Requires admin role. Permanently removes a hotel from the catalog. Returns 404 if it doesn't exist.",
)
def delete_hotel(hotel_id: int, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    hotel = _get_or_404(db, Hotel, hotel_id)
    db.delete(hotel)
    db.commit()
    activity_service.log_activity(db, _admin.id, f"Admin deleted hotel #{hotel_id}", module="Admin", activity_type="Admin Action")


# ---------- Cruises ----------
@cruises_router.get(
    "",
    response_model=list[CruiseOut],
    summary="Search/list cruises",
    description="Public endpoint. Returns cruises matching the given filters (type, departure month, duration), ordered by price ascending.",
)
def list_cruises(
    cruise_type: str | None = None,
    departure_month: str | None = None,
    duration_days: int | None = None,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user_optional),
):
    stmt = select(Cruise)
    if cruise_type:
        stmt = stmt.where(Cruise.cruise_type.ilike(f"%{cruise_type}%"))
    if departure_month:
        stmt = stmt.where(Cruise.departure_month == departure_month)
    if duration_days:
        stmt = stmt.where(Cruise.duration_days == duration_days)
    if cruise_type or departure_month or duration_days:
        _log_search(db, current_user, "cruise", cruise_type or "any type")
    return db.scalars(stmt.order_by(Cruise.price)).all()


@cruises_router.post(
    "",
    response_model=CruiseOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a cruise",
    description="Requires admin role. Adds a new cruise to the catalog.",
)
def create_cruise(payload: CruiseCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    cruise = Cruise(**payload.model_dump())
    db.add(cruise)
    db.commit()
    db.refresh(cruise)
    activity_service.log_activity(db, _admin.id, f"Admin created cruise #{cruise.id}", module="Admin", activity_type="Admin Action")
    return cruise


@cruises_router.put(
    "/{cruise_id}",
    response_model=CruiseOut,
    summary="Update a cruise",
    description="Requires admin role. Replaces all fields of an existing cruise. Returns 404 if the cruise doesn't exist.",
)
def update_cruise(
    cruise_id: int, payload: CruiseCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)
):
    cruise = _get_or_404(db, Cruise, cruise_id)
    for key, value in payload.model_dump().items():
        setattr(cruise, key, value)
    db.commit()
    db.refresh(cruise)
    activity_service.log_activity(db, _admin.id, f"Admin updated cruise #{cruise_id}", module="Admin", activity_type="Admin Action")
    return cruise


@cruises_router.delete(
    "/{cruise_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a cruise",
    description="Requires admin role. Permanently removes a cruise from the catalog. Returns 404 if it doesn't exist.",
)
def delete_cruise(cruise_id: int, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    cruise = _get_or_404(db, Cruise, cruise_id)
    db.delete(cruise)
    db.commit()
    activity_service.log_activity(db, _admin.id, f"Admin deleted cruise #{cruise_id}", module="Admin", activity_type="Admin Action")


# ---------- Tour Packages ----------
@packages_router.get(
    "",
    response_model=list[TourPackageOut],
    summary="Search/list tour packages",
    description="Public endpoint. Returns tour packages matching the given filters (type, available month), ordered by id, optionally capped with a limit.",
)
def list_packages(
    package_type: str | None = None,
    month: str | None = None,
    limit: int | None = Query(default=None, gt=0, le=100),
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user_optional),
):
    stmt = select(TourPackage)
    if package_type:
        stmt = stmt.where(TourPackage.package_type.ilike(f"%{package_type}%"))
    if month:
        stmt = stmt.where(TourPackage.available_month == month)
    stmt = stmt.order_by(TourPackage.id)
    if limit:
        stmt = stmt.limit(limit)
    if package_type or month:
        _log_search(db, current_user, "package", package_type or "any type")
    return db.scalars(stmt).all()


@packages_router.post(
    "",
    response_model=TourPackageOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a tour package",
    description="Requires admin role. Adds a new tour package to the catalog.",
)
def create_package(payload: TourPackageCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    package = TourPackage(**payload.model_dump())
    db.add(package)
    db.commit()
    db.refresh(package)
    activity_service.log_activity(db, _admin.id, f"Admin created package #{package.id}", module="Admin", activity_type="Admin Action")
    return package


@packages_router.put(
    "/{package_id}",
    response_model=TourPackageOut,
    summary="Update a tour package",
    description="Requires admin role. Replaces all fields of an existing tour package. Returns 404 if the package doesn't exist.",
)
def update_package(
    package_id: int, payload: TourPackageCreate, db: Session = Depends(get_db), _admin=Depends(get_current_admin)
):
    package = _get_or_404(db, TourPackage, package_id)
    for key, value in payload.model_dump().items():
        setattr(package, key, value)
    db.commit()
    db.refresh(package)
    activity_service.log_activity(db, _admin.id, f"Admin updated package #{package_id}", module="Admin", activity_type="Admin Action")
    return package


@packages_router.delete(
    "/{package_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a tour package",
    description="Requires admin role. Permanently removes a tour package from the catalog. Returns 404 if it doesn't exist.",
)
def delete_package(package_id: int, db: Session = Depends(get_db), _admin=Depends(get_current_admin)):
    package = _get_or_404(db, TourPackage, package_id)
    db.delete(package)
    db.commit()
    activity_service.log_activity(db, _admin.id, f"Admin deleted package #{package_id}", module="Admin", activity_type="Admin Action")
