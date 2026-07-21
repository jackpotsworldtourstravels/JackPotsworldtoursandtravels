from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.services.catalog_items import AVAILABILITY_FIELD, ITEM_MODELS, ITEM_NAME_FN

_PRICE_FIELD = {"flight": "price", "hotel": "price_per_night", "cruise": "price", "package": "price"}


def to_inventory_out(item_type: str, item) -> dict:
    available = getattr(item, AVAILABILITY_FIELD[item_type])
    return {
        "item_type": item_type,
        "item_id": item.id,
        "name": ITEM_NAME_FN[item_type](item),
        "price": float(getattr(item, _PRICE_FIELD[item_type])),
        "available": available,
        "low_stock_threshold": item.low_stock_threshold,
        "is_sold_out": item.is_sold_out,
        "is_low_stock": item.is_low_stock,
    }


def list_inventory(
    db: Session,
    item_type: str | None = None,
    low_stock_only: bool = False,
    sold_out_only: bool = False,
    search: str | None = None,
) -> list[dict]:
    types = [item_type] if item_type else list(ITEM_MODELS.keys())
    results: list[dict] = []
    for t in types:
        model = ITEM_MODELS[t]
        items = db.scalars(select(model).order_by(model.id)).all()
        for item in items:
            row = to_inventory_out(t, item)
            if low_stock_only and not row["is_low_stock"]:
                continue
            if sold_out_only and not row["is_sold_out"]:
                continue
            if search and search.lower() not in row["name"].lower():
                continue
            results.append(row)
    results.sort(key=lambda r: r["available"])
    return results


def get_inventory_stats(db: Session) -> dict:
    all_items = list_inventory(db)
    return {
        "total_items": len(all_items),
        "sold_out": sum(1 for i in all_items if i["is_sold_out"]),
        "low_stock": sum(1 for i in all_items if i["is_low_stock"] and not i["is_sold_out"]),
        "healthy": sum(1 for i in all_items if not i["is_low_stock"] and not i["is_sold_out"]),
    }


def adjust_inventory(
    db: Session, item_type: str, item_id: int, available: int, low_stock_threshold: int | None = None
) -> dict:
    model = ITEM_MODELS.get(item_type)
    if not model:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown item type")
    item = db.get(model, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{item_type} {item_id} not found")
    setattr(item, AVAILABILITY_FIELD[item_type], available)
    if low_stock_threshold is not None:
        item.low_stock_threshold = low_stock_threshold
    db.commit()
    db.refresh(item)
    return to_inventory_out(item_type, item)
