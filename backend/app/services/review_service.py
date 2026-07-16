from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.misc import Review
from app.models.user import User
from app.services.catalog_items import ITEM_MODELS


def _review_out(review: Review, full_name: str) -> dict:
    return {**review.__dict__, "user_name": full_name}


def create_review(db: Session, user: User, item_type: str, item_id: int, rating: int, comment: str | None) -> dict:
    model = ITEM_MODELS[item_type]
    if not db.get(model, item_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{item_type} {item_id} not found")
    existing = db.scalar(
        select(Review).where(Review.user_id == user.id, Review.item_type == item_type, Review.item_id == item_id)
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You've already reviewed this item — edit your existing review instead.",
        )
    review = Review(user_id=user.id, item_type=item_type, item_id=item_id, rating=rating, comment=comment)
    db.add(review)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You've already reviewed this item — edit your existing review instead.",
        )
    db.refresh(review)
    return _review_out(review, user.full_name)


def update_review(db: Session, user: User, review_id: int, rating: int, comment: str | None) -> dict:
    review = db.get(Review, review_id)
    if not review or review.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Review not found")
    review.rating = rating
    review.comment = comment
    db.commit()
    db.refresh(review)
    return _review_out(review, user.full_name)


def delete_review(db: Session, user: User, review_id: int, is_admin: bool = False) -> None:
    review = db.get(Review, review_id)
    if not review or (not is_admin and review.user_id != user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Review not found")
    db.delete(review)
    db.commit()


def list_reviews_for_item(db: Session, item_type: str, item_id: int) -> list[dict]:
    stmt = (
        select(Review, User.full_name)
        .join(User, Review.user_id == User.id)
        .where(Review.item_type == item_type, Review.item_id == item_id)
        .order_by(Review.created_at.desc())
    )
    return [_review_out(review, full_name) for review, full_name in db.execute(stmt).all()]


def list_user_reviews(db: Session, user: User) -> list[dict]:
    stmt = select(Review).where(Review.user_id == user.id).order_by(Review.created_at.desc())
    return [_review_out(review, user.full_name) for review in db.scalars(stmt).all()]


def list_all_reviews(db: Session):
    stmt = select(Review, User.full_name, User.email).join(User, Review.user_id == User.id).order_by(Review.created_at.desc())
    return [
        {**review.__dict__, "user_name": full_name, "user_email": email}
        for review, full_name, email in db.execute(stmt).all()
    ]


def list_all_reviews_paginated(db: Session, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(Review)) or 0
    stmt = (
        select(Review, User.full_name, User.email)
        .join(User, Review.user_id == User.id)
        .order_by(Review.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    items = [
        {**review.__dict__, "user_name": full_name, "user_email": email}
        for review, full_name, email in db.execute(stmt).all()
    ]
    return items, total
