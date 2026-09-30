"""Catalogue-level admin endpoints — ``/api/admin/catalogue/*``. Phase 5 of the
B2C Admin Portal build-out: the flight-supplier status screen and the shared
image library the hotel/package/destination editors choose from. The
per-catalogue routers (hotels, packages, destinations) sit beside this one.

Gated on ``catalog.manage`` (Admin only) — see ``P.CATALOG_MANAGE``.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.auth.rbac import P, require
from app.models_v2 import User
from app.schemas.catalogue_admin import FlightSupplierStatus, ImageChoice
from app.services import catalogue_flight_admin_service, catalogue_images

router = APIRouter(prefix="/api/admin/catalogue", tags=["admin-catalogue"])

_IMAGE_ROWS = ("hotel", "package", "destination", "location")


@router.get(
    "/flights/supplier",
    response_model=FlightSupplierStatus,
    summary="Flight supplier status (there is no flight inventory to manage)",
    description=(
        "Requires `catalog.manage` (admin only). Which supplier answers flight "
        "searches and whether it is configured. Reads configuration only — it "
        "never calls a supplier."
    ),
)
def flight_supplier_status(_: User = Depends(require(P.CATALOG_MANAGE))):
    return catalogue_flight_admin_service.supplier_status()


@router.get(
    "/images",
    response_model=list[ImageChoice],
    summary="Shipped images a catalogue row may point at",
    description=(
        "Requires `catalog.manage` (admin only). Images are keys into artwork "
        "that ships with the site, not uploads — see catalogue_images."
    ),
)
def image_library(
    _: User = Depends(require(P.CATALOG_MANAGE)),
    row: str = Query(..., description="hotel | package | destination | location"),
):
    if row not in _IMAGE_ROWS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown row type {row!r}.")
    return catalogue_images.library(row)
