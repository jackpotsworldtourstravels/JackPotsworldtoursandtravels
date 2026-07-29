"""Catalog / inventory — what Ticket Enquiry searches.

Inventory lives in ``service_requests`` with ``request_type='catalog_item'``
and no owner (a CHECK constraint enforces ``merchant_id IS NULL``). The
type-specific attributes sit in ``travel_details`` JSONB, because one table
cannot carry typed columns for flights, hotels and cruises at once without
forty mostly-NULL columns. See the trade-off note in docs/SCHEMA_V2.md.

Search filters on the indexed columns (``travel_type``, ``travel_date``)
first and only then narrows on JSONB keys, so the partial index
``ix_sr_catalog_live`` does the heavy lifting.
"""
import datetime
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models_v2 import RequestStatus, RequestType, ServiceRequest, TravelType

#: A catalog row is "live" when approved; anything else is hidden from search.
LIVE_STATUS = RequestStatus.APPROVED


def _base_filter():
    return and_(
        ServiceRequest.request_type == RequestType.CATALOG_ITEM,
        ServiceRequest.status == LIVE_STATUS,
    )


def _detail(key: str):
    """Text accessor for a ``travel_details`` key."""
    return ServiceRequest.travel_details[key].astext


def search(
    db: Session,
    *,
    travel_type: TravelType | None = None,
    origin: str | None = None,
    destination: str | None = None,
    travel_date: datetime.date | None = None,
    cabin_class: str | None = None,
    passengers: int = 1,
    max_price: Decimal | None = None,
    airline: str | None = None,
    query: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[ServiceRequest], int]:
    """Search live inventory. Returns ``(items, total)``."""
    conditions = [_base_filter()]

    if travel_type is not None:
        conditions.append(ServiceRequest.travel_type == travel_type)
    if origin:
        conditions.append(_detail("origin").ilike(f"%{origin}%"))
    if destination:
        conditions.append(_detail("destination").ilike(f"%{destination}%"))
    if cabin_class:
        conditions.append(_detail("cabin_class") == cabin_class)
    if airline:
        conditions.append(_detail("airline").ilike(f"%{airline}%"))
    if travel_date is not None:
        conditions.append(ServiceRequest.travel_date == travel_date)
    if max_price is not None:
        conditions.append(ServiceRequest.total_amount <= max_price)
    if passengers > 0:
        # Never surface inventory that cannot seat the party.
        conditions.append(
            (ServiceRequest.available_units.is_(None))
            | (ServiceRequest.available_units >= passengers)
        )
    if query:
        pattern = f"%{query}%"
        conditions.append(
            ServiceRequest.title.ilike(pattern)
            | _detail("airline").ilike(pattern)
            | _detail("flight_number").ilike(pattern)
            | _detail("origin_city").ilike(pattern)
            | _detail("destination_city").ilike(pattern)
        )

    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    stmt = (
        select(ServiceRequest)
        .where(where)
        .order_by(ServiceRequest.total_amount.asc(), ServiceRequest.travel_date.asc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.scalars(stmt).all()), total


def get_item(db: Session, request_id: int) -> ServiceRequest:
    item = db.get(ServiceRequest, request_id)
    if not item or item.request_type is not RequestType.CATALOG_ITEM:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Catalog item not found"
        )
    return item


def quote(item: ServiceRequest, passengers: int) -> dict:
    """Price a party against an item — the spec's Review Price step.

    Prices are recomputed here from the catalog row rather than trusted from
    the client, so a tampered request body cannot buy a seat cheaply.
    """
    pricing = item.pricing or {}
    base_fare = Decimal(str(pricing.get("base_fare", 0)))
    taxes = Decimal(str(pricing.get("taxes", 0)))
    per_head = base_fare + taxes
    total = per_head * passengers
    return {
        "currency": pricing.get("currency", "INR"),
        "base_fare": base_fare,
        "taxes": taxes,
        "per_passenger": per_head,
        "passengers": passengers,
        "total": total,
    }


def reserve_units(db: Session, item: ServiceRequest, count: int) -> None:
    """Decrement inventory, locking the row so two requests cannot oversell.

    Called when a booking is submitted for approval, not when it is drafted —
    a draft that is never submitted should not hold seats.
    """
    locked = db.execute(
        select(ServiceRequest)
        .where(ServiceRequest.request_id == item.request_id)
        .with_for_update()
    ).scalar_one()

    if locked.available_units is None:
        return  # unlimited inventory
    if locked.available_units < count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Only {locked.available_units} seat(s) left on this fare — "
                "reduce the passenger count or pick another option."
            ),
        )
    locked.available_units -= count
    db.flush()


def release_units(db: Session, item: ServiceRequest | None, count: int) -> None:
    """Return inventory when a submitted request is rejected or cancelled."""
    if item is None:
        return
    locked = db.execute(
        select(ServiceRequest)
        .where(ServiceRequest.request_id == item.request_id)
        .with_for_update()
    ).scalar_one()
    if locked.available_units is None:
        return
    locked.available_units += count
    db.flush()
