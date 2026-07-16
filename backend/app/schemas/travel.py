import datetime

from pydantic import BaseModel, Field


class FlightBase(BaseModel):
    airline: str = Field(max_length=100)
    from_airport: str = Field(max_length=100)
    to_airport: str = Field(max_length=100)
    departure_time: datetime.datetime
    arrival_time: datetime.datetime
    cabin_class: str = Field(default="Economy", max_length=30)
    price: float = Field(gt=0)
    seats_available: int = Field(default=0, ge=0)


class FlightCreate(FlightBase):
    pass


class FlightOut(FlightBase):
    id: int

    model_config = {"from_attributes": True}


class HotelBase(BaseModel):
    name: str = Field(max_length=150)
    location: str = Field(max_length=150)
    price_per_night: float = Field(gt=0)
    rating: float = Field(default=0, ge=0, le=5)
    amenities: str | None = Field(default=None, max_length=500)
    image_url: str | None = Field(default=None, max_length=500)
    rooms_available: int = Field(default=0, ge=0)


class HotelCreate(HotelBase):
    pass


class HotelOut(HotelBase):
    id: int

    model_config = {"from_attributes": True}


class CruiseBase(BaseModel):
    name: str = Field(max_length=150)
    cruise_type: str = Field(max_length=100)
    departure_port: str = Field(max_length=150)
    duration_days: int = Field(gt=0)
    price: float = Field(gt=0)
    departure_month: str = Field(max_length=20)


class CruiseCreate(CruiseBase):
    pass


class CruiseOut(CruiseBase):
    id: int

    model_config = {"from_attributes": True}


class TourPackageBase(BaseModel):
    title: str = Field(max_length=150)
    package_type: str = Field(max_length=100)
    duration_days: int = Field(gt=0)
    price: float = Field(gt=0)
    rating: float = Field(default=0, ge=0, le=5)
    description: str | None = Field(default=None, max_length=1000)
    image_url: str | None = Field(default=None, max_length=500)
    available_month: str | None = Field(default=None, max_length=20)


class TourPackageCreate(TourPackageBase):
    pass


class TourPackageOut(TourPackageBase):
    id: int

    model_config = {"from_attributes": True}
