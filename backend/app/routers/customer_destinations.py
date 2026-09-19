"""Destination discovery — ``/api/customer/destinations/*``.

    GET /api/customer/destinations                    the homepage's Destinations shelf
    GET /api/customer/destinations/{id}/locations     the locations inside one of them
    GET /api/customer/locations/{id}/hotels           hotels in one location
    GET /api/customer/destinations/{id}/attractions   famous places to visit (0075)
    GET /api/customer/attractions/{id}/hotels         hotels near one of them

Public, like the hotel and package catalogue routes beside it: browsing where a
company flies before signing in is normal, and nothing here touches a booking.

THE SHAPE OF THESE TWO ROUTES DID NOT CHANGE when 0070 gave geography its own
tables — only where the service reads from. The frontend was written against
`id`, `name` and `destination_id` and needed no edit.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database.session import get_db
from app.schemas.customer_destination import (
    DestinationHotelsPage,
    DestinationLocation,
    DestinationSummary,
    LocationHotelsPage,
    AttractionHotelsPage,
    DestinationAttraction,
)
from app.services import customer_destination_service as destinations

router = APIRouter(prefix="/api/customer", tags=["customer-destinations"])


@router.get(
    "/destinations",
    response_model=list[DestinationSummary],
    summary="Destinations",
    description=(
        "Public. Every active destination, from `customer_destinations` (migration 0070). "
        "Independent of inventory: a destination is listed whether or not a hotel or tour "
        "package currently exists there."
    ),
)
def list_destinations(db: Session = Depends(get_db)):
    return destinations.list_destinations(db)


@router.get(
    "/destinations/{destination_id}/locations",
    response_model=list[DestinationLocation],
    summary="Locations in a destination",
    description=(
        "Public. The locations inside one destination, addressed by the slug the destinations "
        "list gave out. An unknown slug is a 404; a real destination with nothing mapped under "
        "it yet is an empty list — those are different answers and the caller needs to tell "
        "them apart."
    ),
    responses={404: {"description": "No destination with that id."}},
)
def list_locations(destination_id: str, db: Session = Depends(get_db)):
    rows = destinations.list_locations(db, destination_id)
    if rows is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No destination with that id.",
        )
    return rows


@router.get(
    "/destinations/{destination_id}/hotels",
    response_model=DestinationHotelsPage,
    summary="Hotels in a destination",
    description=(
        "Public. Every hotel mapped to this destination, newest catalogue first by price, "
        "with the destination's locations alongside for filtering.\n\n"
        "**The filter is a foreign key.** `customer_hotels.destination_id` (migration 0072) "
        "is what selects these rows; a hotel's free-text location is never matched. Pass "
        "`location_id` (the `goa__panaji` form the locations route hands out) to narrow to "
        "one location.\n\n"
        "**This is catalogue, not availability.** A hotel listed here is a property we hold "
        "content for. It says nothing about whether a room is free on any date, and "
        "`price_per_night` is indicative rather than a quote — dated rates come from the "
        "booking flow.\n\n"
        "An unknown destination is a 404; a real destination with no hotels mapped yet is an "
        "empty `hotels` list with `total: 0`."
    ),
    responses={404: {"description": "No destination with that id."}},
)
def list_destination_hotels(
    destination_id: str,
    location_id: str | None = Query(
        default=None,
        description="Optional location filter, e.g. `goa__panaji`. Resolved within this destination only.",
    ),
    page: int = Query(default=1, ge=1, description="1-based page number."),
    page_size: int = Query(
        default=destinations.DEFAULT_PAGE_SIZE,
        ge=1, le=destinations.MAX_PAGE_SIZE,
        description="Rows per page.",
    ),
    db: Session = Depends(get_db),
):
    result = destinations.list_destination_hotels(
        db, destination_id, location_id=location_id, page=page, page_size=page_size,
    )
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No destination with that id.",
        )
    return result


@router.get(
    "/locations/{location_id}/hotels",
    response_model=LocationHotelsPage,
    summary="Hotels in a location",
    description=(
        "Public. The last step of the destination flow — Destination -> location -> hotels. "
        "`location_id` is the namespaced id the locations route hands out, e.g. "
        "`hyderabad__tank-bund`; its destination half fixes the destination and its location "
        "half is resolved within it.\n\n"
        "**The filter is a foreign key** (`customer_hotels.location_id`, migration 0072), the "
        "same one the destination hotels route uses — a hotel's free-text address is never "
        "matched. **Catalogue, not availability**: `price_per_night` is indicative.\n\n"
        "An unknown location is a 404; a real location with no hotels mapped yet is an empty "
        "`hotels` list with `total: 0`."
    ),
    responses={404: {"description": "No location with that id."}},
)
def list_location_hotels(
    location_id: str,
    page: int = Query(default=1, ge=1, description="1-based page number."),
    page_size: int = Query(
        default=destinations.DEFAULT_PAGE_SIZE,
        ge=1, le=destinations.MAX_PAGE_SIZE,
        description="Rows per page.",
    ),
    db: Session = Depends(get_db),
):
    result = destinations.list_location_hotels(
        db, location_id, page=page, page_size=page_size,
    )
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No location with that id.",
        )
    return result


@router.get(
    "/destinations/{destination_id}/attractions",
    response_model=list[DestinationAttraction],
    summary="Famous places in a destination",
    description=(
        "Public. The landmarks a traveller visits and photographs — Charminar, Birla Mandir — "
        "from `customer_attractions` (migration 0075). Not the AREAS of the locations route, "
        "which are how hotels are filed. Each carries its nearest listed area and that area's "
        "hotel count. Unknown destination: 404; none recorded yet: empty list."
    ),
    responses={404: {"description": "No destination with that id."}},
)
def list_attractions(destination_id: str, db: Session = Depends(get_db)):
    rows = destinations.list_attractions(db, destination_id)
    if rows is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No destination with that id.")
    return rows


@router.get(
    "/attractions/{attraction_id}/hotels",
    response_model=AttractionHotelsPage,
    summary="Hotels near a famous place",
    description=(
        "Public. `attraction_id` is the namespaced id from the attractions route, e.g. "
        "`hyderabad__charminar`. Returns the hotels of the attraction's NEAREST LISTED AREA "
        "(hotels are filed by area, by foreign key — never matched by text), with the "
        "attraction and its `area_name` so the page can say which area it is showing. An "
        "attraction with no nearby area is an empty page, not a 404."
    ),
    responses={404: {"description": "No attraction with that id."}},
)
def list_attraction_hotels(
    attraction_id: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=destinations.DEFAULT_PAGE_SIZE, ge=1, le=destinations.MAX_PAGE_SIZE),
    db: Session = Depends(get_db),
):
    result = destinations.list_attraction_hotels(db, attraction_id, page=page, page_size=page_size)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No attraction with that id.")
    return result
