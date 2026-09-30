"""Admin destinations — ``/api/admin/catalogue/destinations/*``. Phase 5 of the
B2C Admin Portal build-out. See ``catalogue_destination_admin_service`` for
what this reuses (the destination/location tables behind the customer site's
shelf and destination pages), what "popular" means (position in the homepage
order), and why there is no delete.

Gated on ``catalog.manage`` (Admin only). Every write leaves one line in the
portal activity log, like Phases 1-4.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.catalogue_admin import (
    DestinationCreate, DestinationDetail, DestinationListItem, DestinationReorder,
    DestinationUpdate, LocationCreate, LocationUpdate,
)
from app.services import catalogue_destination_admin_service as service
from app.services.catalogue_common import log_change

router = APIRouter(prefix="/api/admin/catalogue/destinations", tags=["admin-catalogue"])

_NO_DEST = "No such destination."


@router.get("", response_model=list[DestinationListItem],
            summary="Every destination in homepage order, including disabled ones",
            description="Requires `catalog.manage` (admin only). `popular` marks the ones inside the homepage shelf's first-shown window.")
def list_destinations(db: Session = Depends(get_db), _: User = Depends(require(P.CATALOG_MANAGE))):
    return service.list_destinations(db)


@router.post("", response_model=DestinationDetail, status_code=status.HTTP_201_CREATED,
             summary="Add a destination (appended last in the homepage order)",
             description="Requires `catalog.manage` (admin only). The public address (slug) is derived from the name and cannot change later.",
             responses={409: {"description": "A destination with that address exists."}})
def create_destination(
    payload: DestinationCreate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    detail = service.create_destination(db, payload.model_dump())
    log_change(db, request, user, action="Destination created", reference_id=detail["id"],
               description=f"{user.full_name} created destination {detail['name']!r} ({detail['id']})")
    db.commit()
    return detail


@router.put("/order", response_model=list[DestinationListItem],
            summary="Set the homepage order (which destinations are popular)",
            description=(
                "Requires `catalog.manage` (admin only). The body must list EVERY destination id exactly "
                "once, in the new order; a stale or partial list is refused (409)."
            ),
            responses={409: {"description": "The list does not match the current destinations."}})
def reorder_destinations(
    payload: DestinationReorder, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    result = service.reorder(db, payload.ids)
    log_change(db, request, user, action="Destinations reordered",
               description=f"{user.full_name} changed the homepage destination order")
    db.commit()
    return result


@router.get("/{destination_id}", response_model=DestinationDetail,
            summary="One destination with all its locations",
            description="Requires `catalog.manage` (admin only).",
            responses={404: {"description": _NO_DEST}})
def get_destination(destination_id: int, db: Session = Depends(get_db), _: User = Depends(require(P.CATALOG_MANAGE))):
    detail = service.get_destination(db, destination_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_DEST)
    return detail


@router.patch("/{destination_id}", response_model=DestinationDetail,
              summary="Edit a destination's name, country, image or visibility",
              description="Requires `catalog.manage` (admin only). Only the fields sent are written.",
              responses={404: {"description": _NO_DEST}})
def update_destination(
    destination_id: int, payload: DestinationUpdate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    result = service.update_destination(db, destination_id, payload.model_dump(exclude_unset=True))
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_DEST)
    detail, changed = result
    log_change(db, request, user, action="Destination updated", reference_id=destination_id,
               description=f"{user.full_name} updated destination {detail['name']!r} ({destination_id}): {', '.join(changed) or 'no change'}")
    db.commit()
    return detail


@router.post("/{destination_id}/locations", response_model=DestinationDetail, status_code=status.HTTP_201_CREATED,
             summary="Add a location inside a destination",
             description="Requires `catalog.manage` (admin only).",
             responses={404: {"description": _NO_DEST}, 409: {"description": "Location already exists here."}})
def create_location(
    destination_id: int, payload: LocationCreate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    detail = service.create_location(db, destination_id, payload.model_dump())
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_DEST)
    log_change(db, request, user, action="Location created", reference_id=destination_id,
               description=f"{user.full_name} added location {payload.name!r} to destination {destination_id}")
    db.commit()
    return detail


@router.patch("/{destination_id}/locations/{location_id}", response_model=DestinationDetail,
              summary="Edit a location's name, description, image, order or visibility",
              description="Requires `catalog.manage` (admin only). Only the fields sent are written.",
              responses={404: {"description": "No such destination or location."}})
def update_location(
    destination_id: int, location_id: int, payload: LocationUpdate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    result = service.update_location(db, destination_id, location_id, payload.model_dump(exclude_unset=True))
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such destination or location.")
    detail, changed = result
    log_change(db, request, user, action="Location updated", reference_id=destination_id,
               description=f"{user.full_name} updated location {location_id} of destination {destination_id}: {', '.join(changed) or 'no change'}")
    db.commit()
    return detail
