import datetime

from sqlalchemy import Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.session import Base


class Flight(Base):
    __tablename__ = "flights"

    id: Mapped[int] = mapped_column(primary_key=True)
    airline: Mapped[str] = mapped_column(String(100), nullable=False)
    from_airport: Mapped[str] = mapped_column(String(100), nullable=False)
    to_airport: Mapped[str] = mapped_column(String(100), nullable=False)
    departure_time: Mapped[datetime.datetime] = mapped_column(nullable=False)
    arrival_time: Mapped[datetime.datetime] = mapped_column(nullable=False)
    cabin_class: Mapped[str] = mapped_column(String(30), default="Economy")
    price: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    seats_available: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)


class Hotel(Base):
    __tablename__ = "hotels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    location: Mapped[str] = mapped_column(String(150), nullable=False)
    price_per_night: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    rating: Mapped[float] = mapped_column(default=0)
    amenities: Mapped[str | None] = mapped_column(String(500), nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    rooms_available: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)


class Cruise(Base):
    __tablename__ = "cruises"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    cruise_type: Mapped[str] = mapped_column(String(100), nullable=False)
    departure_port: Mapped[str] = mapped_column(String(150), nullable=False)
    duration_days: Mapped[int] = mapped_column(nullable=False)
    price: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    departure_month: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)


class TourPackage(Base):
    __tablename__ = "tour_packages"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(150), nullable=False)
    package_type: Mapped[str] = mapped_column(String(100), nullable=False)
    duration_days: Mapped[int] = mapped_column(nullable=False)
    price: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    rating: Mapped[float] = mapped_column(default=0)
    description: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)
