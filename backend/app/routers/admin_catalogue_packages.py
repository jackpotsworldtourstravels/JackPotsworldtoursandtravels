"""Admin tour-package catalogue — ``/api/admin/catalogue/packages/*``. Phase 5
of the B2C Admin Portal build-out. See ``catalogue_package_admin_service`` for
what this reuses (the customer site's own package, itinerary and departure
tables) and what it deliberately does not do (delete, touch gaming packages,
or edit recorded ratings).

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
    DepartureCreate, DepartureUpdate, ItineraryReplace, PackageCreate, PackageDetail,
    PackageListItem, PackageUpdate, TripType,
)
from app.schemas.pagination import Page
from app.services import catalogue_package_admin_service as service
from app.services.catalogue_common import log_change

router = APIRouter(prefix="/api/admin/catalogue/packages", tags=["admin-catalogue"])

_NO_PACKAGE = "No such package."


@router.get("", response_model=Page[PackageListItem], summary="List tour packages, including disabled ones",
            description="Requires `catalog.manage` (admin only).")
def list_packages(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CATALOG_MANAGE)),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    search: str | None = Query(None, max_length=120),
    is_active: bool | None = Query(None),
    trip_type: TripType | None = Query(None),
):
    items, total = service.list_packages(
        db, page=page, page_size=page_size, search=search, is_active=is_active, trip_type=trip_type,
    )
    return Page.build(items, total, page, page_size)


@router.post("", response_model=PackageDetail, status_code=status.HTTP_201_CREATED,
             summary="Create a tour package (starts disabled unless told otherwise)",
             description="Requires `catalog.manage` (admin only). Always a `holiday` package — gaming trips are enquiry-based.")
def create_package(
    payload: PackageCreate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    detail = service.create_package(db, payload.model_dump())
    log_change(db, request, user, action="Package created", reference_id=detail["id"],
               description=f"{user.full_name} created package {detail['name']!r} ({detail['id']})")
    db.commit()
    return detail


@router.get("/{package_id}", response_model=PackageDetail,
            summary="One package: details, itinerary and every departure",
            description="Requires `catalog.manage` (admin only).",
            responses={404: {"description": _NO_PACKAGE}})
def get_package(package_id: int, db: Session = Depends(get_db), _: User = Depends(require(P.CATALOG_MANAGE))):
    detail = service.get_package(db, package_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_PACKAGE)
    return detail


@router.patch("/{package_id}", response_model=PackageDetail,
              summary="Edit package details, headline price, images or visibility",
              description="Requires `catalog.manage` (admin only). Only the fields sent are written.",
              responses={404: {"description": _NO_PACKAGE}})
def update_package(
    package_id: int, payload: PackageUpdate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    result = service.update_package(db, package_id, payload.model_dump(exclude_unset=True))
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_PACKAGE)
    detail, changed = result
    log_change(db, request, user, action="Package updated", reference_id=package_id,
               description=f"{user.full_name} updated package {detail['name']!r} ({package_id}): {', '.join(changed) or 'no change'}")
    db.commit()
    return detail


@router.put("/{package_id}/itinerary", response_model=PackageDetail,
            summary="Replace the day-by-day itinerary",
            description="Requires `catalog.manage` (admin only). The body is the whole itinerary as it should now read.",
            responses={404: {"description": _NO_PACKAGE}})
def replace_itinerary(
    package_id: int, payload: ItineraryReplace, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    detail = service.replace_itinerary(db, package_id, [d.model_dump() for d in payload.days])
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_PACKAGE)
    log_change(db, request, user, action="Package itinerary updated", reference_id=package_id,
               description=f"{user.full_name} set package {package_id}'s itinerary to {len(payload.days)} day(s)")
    db.commit()
    return detail


@router.post("/{package_id}/departures", response_model=PackageDetail, status_code=status.HTTP_201_CREATED,
             summary="Add a departure date with its per-person price and seats",
             description="Requires `catalog.manage` (admin only).",
             responses={404: {"description": _NO_PACKAGE}, 409: {"description": "Already a departure on that date."}})
def create_departure(
    package_id: int, payload: DepartureCreate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    detail = service.create_departure(db, package_id, payload.model_dump())
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_PACKAGE)
    log_change(db, request, user, action="Package departure added", reference_id=package_id,
               description=f"{user.full_name} added a {payload.departure_date} departure at {payload.price_per_person} to package {package_id}")
    db.commit()
    return detail


@router.patch("/{package_id}/departures/{departure_id}", response_model=PackageDetail,
              summary="Update a departure's price, seats or availability",
              description="Requires `catalog.manage` (admin only). Departures are disabled, never deleted.",
              responses={404: {"description": "No such package or departure."}})
def update_departure(
    package_id: int, departure_id: int, payload: DepartureUpdate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(require(P.CATALOG_MANAGE)),
):
    result = service.update_departure(db, package_id, departure_id, payload.model_dump(exclude_unset=True))
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such package or departure.")
    detail, changed = result
    log_change(db, request, user, action="Package departure updated", reference_id=package_id,
               description=f"{user.full_name} updated departure {departure_id} of package {package_id}: {', '.join(changed) or 'no change'}")
    db.commit()
    return detail
