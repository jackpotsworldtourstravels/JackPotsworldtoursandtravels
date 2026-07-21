from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.misc import Wishlist
from app.models.user import User
from app.services import activity_service
from app.services.catalog_items import ITEM_MODELS


def add_to_wishlist(db: Session, user: User, item_type: str, item_id: int) -> Wishlist:
    model = ITEM_MODELS[item_type]
    if not db.get(model, item_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{item_type} {item_id} not found")
    existing = db.scalar(
        select(Wishlist).where(
            Wishlist.user_id == user.id, Wishlist.item_type == item_type, Wishlist.item_id == item_id
        )
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Already in your wishlist")
    entry = Wishlist(user_id=user.id, item_type=item_type, item_id=item_id)
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Already in your wishlist")
    db.refresh(entry)
    activity_service.log_activity(
        db, user.id, f"Wishlist Added ({item_type} #{item_id})",
        activity_type="Wishlist Added", module="Wishlist", reference_id=entry.id,
        description=f"{user.full_name} added {item_type} #{item_id} to their wishlist",
    )
    return entry


def list_user_wishlist(db: Session, user: User) -> list[Wishlist]:
    stmt = select(Wishlist).where(Wishlist.user_id == user.id).order_by(Wishlist.created_at.desc())
    return db.scalars(stmt).all()


def remove_from_wishlist(db: Session, user: User, wishlist_id: int) -> None:
    entry = db.get(Wishlist, wishlist_id)
    if not entry or entry.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Wishlist entry not found")
    item_type, item_id = entry.item_type, entry.item_id
    db.delete(entry)
    db.commit()
    activity_service.log_activity(
        db, user.id, f"Wishlist Removed ({item_type} #{item_id})",
        activity_type="Wishlist Removed", module="Wishlist",
        description=f"{user.full_name} removed {item_type} #{item_id} from their wishlist",
    )


def list_all_wishlist(db: Session):
    stmt = select(Wishlist, User.email).join(User, Wishlist.user_id == User.id).order_by(Wishlist.created_at.desc())
    return db.execute(stmt).all()


def list_all_wishlist_paginated(db: Session, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(Wishlist)) or 0
    stmt = (
        select(Wishlist, User.email)
        .join(User, Wishlist.user_id == User.id)
        .order_by(Wishlist.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return db.execute(stmt).all(), total


def delete_wishlist_admin(db: Session, wishlist_id: int) -> None:
    entry = db.get(Wishlist, wishlist_id)
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Wishlist entry not found")
    db.delete(entry)
    db.commit()
