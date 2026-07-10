import datetime

from pydantic import BaseModel, Field


class FlightBase(BaseModel):
    airline: str
    from_airport: str
    to_airport: str
    departure_time: datetime.datetime
    arrival_time: datetime.datetime
    cabin_class: str = "Economy"
    price: float = Field(gt=0)
    seats_available: int = 0


class FlightCreate(FlightBase):
    pass


class FlightOut(FlightBase):
    id: int

    model_config = {"from_attributes": True}


class HotelBase(BaseModel):
    name: str
    location: str
    price_per_night: float = Field(gt=0)
    rating: float = 0
    amenities: str | None = None
    image_url: str | None = None
    rooms_available: int = 0


class HotelCreate(HotelBase):
    pass


class HotelOut(HotelBase):
    id: int

    model_config = {"from_attributes": True}


class CruiseBase(BaseModel):
    name: str
    cruise_type: str
    departure_port: str
    duration_days: int = Field(gt=0)
    price: float = Field(gt=0)
    departure_month: str


class CruiseCreate(CruiseBase):
    pass


class CruiseOut(CruiseBase):
    id: int

    model_config = {"from_attributes": True}


class TourPackageBase(BaseModel):
    title: str
    package_type: str
    duration_days: int = Field(gt=0)
    price: float = Field(gt=0)
    rating: float = 0
    description: str | None = None
    image_url: str | None = None


class TourPackageCreate(TourPackageBase):
    pass


class TourPackageOut(TourPackageBase):
    id: int

    model_config = {"from_attributes": True}
