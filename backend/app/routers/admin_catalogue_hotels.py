"""Admin hotel catalogue — ``/api/admin/catalogue/hotels/*``. Phase 5 of the B2C
Admin Portal build-out. See ``catalogue_hotel_admin_service`` for what this
reuses (the customer site's own hotel/room tables) and what it refuses
(deleting, and editing the columns a supplier sync overwrites).

Gated on ``catalog.manage`` (Admin only). Every write leaves one line in the
portal activity log, like Phases 1-4.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.catalogue_admin import (
    HotelDetail, HotelListItem, HotelUpdate, RoomCreate, RoomOut, RoomUpdate,
)
from app.schemas.pagination import Page
from app.services import catalogue_hotel_admin_service as service
from app.services.catalogue_common import log_change

router = APIRouter(prefix="/api/admin/catalogue/hotels", tags=["admin-catalogue"])

_NO_HOTEL = "No such hotel."


@router.get("", response_model=Page[HotelListItem], summary="List hotels, including disabled ones",
            description="Requires `catalog.manage` (admin only).")
def list_hotels(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CATALOG_MANAGE)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    search: str | None = Query(None, max_length=120),
    is_active: bool | None = Query(None),
    destination_id: int | None = Query(None),
):
    items, total = service.list_hotels(
        db, page=page, page_size=page_size, search=search, is_active=is_active,
        destination_id=destination_id,
    )
    return Page.build(items, total, page, page_size)


@router.get("/{hotel_id}", response_model=HotelDetail, summary="One hotel with all its rooms",
            description="Requires `catalog.manage` (admin only).",
            responses={404: {"description": _NO_HOTEL}})
def get_hotel(hotel_id: int, db: Session = Depends(get_db), _: User = Depends(require(P.CATALOG_MANAGE))):
    hotel = service.get_hotel(db, hotel_id)
    if hotel is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_HOTEL)
    return hotel


@router.patch(
    "/{hotel_id}", response_model=HotelDetail, summary="Edit hotel information, amenities, images or visibility",
    description=(
        "Requires `catalog.manage` (admin only). Only the fields sent are written. "
        "A supplier-synced hotel refuses the fields its sync overwrites (409). "
        "Hotel price is not editable — it follows the cheapest active room."
    ),
    responses={404: {"description": _NO_HOTEL}, 409: {"description": "Field owned by the supplier sync."}},
)
def update_hotel(
    hotel_id: int, payload: HotelUpdate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    result = service.update_hotel(db, hotel_id, payload.model_dump(exclude_unset=True))
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_HOTEL)
    detail, changed = result
    log_change(db, request, user, action="Hotel updated", reference_id=hotel_id,
               description=f"{user.full_name} updated hotel {detail['name']!r} ({hotel_id}): {', '.join(changed) or 'no change'}")
    db.commit()
    return detail


@router.post("/{hotel_id}/rooms", response_model=RoomOut, status_code=status.HTTP_201_CREATED,
             summary="Add a room type to a hotel", description="Requires `catalog.manage` (admin only).",
             responses={404: {"description": _NO_HOTEL}, 409: {"description": "Room code already used at this hotel."}})
def create_room(
    hotel_id: int, payload: RoomCreate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    result = service.create_room(db, hotel_id, payload.model_dump())
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_HOTEL)
    room, _ = result
    log_change(db, request, user, action="Hotel room added", reference_id=hotel_id,
               description=f"{user.full_name} added room {room['name']!r} ({room['code']}) to hotel {hotel_id}")
    db.commit()
    return room


@router.patch("/{hotel_id}/rooms/{room_id}", response_model=RoomOut, summary="Edit or disable a room",
              description="Requires `catalog.manage` (admin only). Rooms are disabled, never deleted.",
              responses={404: {"description": "No such hotel or room."}})
def update_room(
    hotel_id: int, room_id: int, payload: RoomUpdate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    result = service.update_room(db, hotel_id, room_id, payload.model_dump(exclude_unset=True))
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such hotel or room.")
    room, _, changed = result
    log_change(db, request, user, action="Hotel room updated", reference_id=hotel_id,
               description=f"{user.full_name} updated room {room['name']!r} ({room['code']}) of hotel {hotel_id}: {', '.join(changed) or 'no change'}")
    db.commit()
    return room
