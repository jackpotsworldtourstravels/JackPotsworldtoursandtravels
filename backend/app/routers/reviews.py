from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database.session import get_db
from app.models.user import User
from app.schemas.booking import BookingType
from app.schemas.review import ReviewCreate, ReviewOut, ReviewUpdate
from app.services import review_service

router = APIRouter(prefix="/api/reviews", tags=["reviews"])


@router.get(
    "",
    response_model=list[ReviewOut],
    summary="List reviews for an item",
    description="Public endpoint. Returns all reviews for the given item (flight/hotel/cruise/package) and item_id.",
)
def list_reviews(item_type: BookingType, item_id: int, db: Session = Depends(get_db)):
    return review_service.list_reviews_for_item(db, item_type, item_id)


@router.get(
    "/mine",
    response_model=list[ReviewOut],
    summary="List my reviews",
    description="Requires authentication. Returns all reviews written by the current user.",
)
def my_reviews(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return review_service.list_user_reviews(db, current_user)


@router.post(
    "",
    response_model=ReviewOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a review",
    description="Requires authentication. Adds a rating/comment from the current user for the given item.",
)
def create_review(payload: ReviewCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return review_service.create_review(db, current_user, payload.item_type, payload.item_id, payload.rating, payload.comment)


@router.put(
    "/{review_id}",
    response_model=ReviewOut,
    summary="Update my review",
    description="Requires authentication. Updates the rating/comment of a review owned by the current user.",
)
def update_review(
    review_id: int, payload: ReviewUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    return review_service.update_review(db, current_user, review_id, payload.rating, payload.comment)


@router.delete(
    "/{review_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete my review",
    description="Requires authentication. Deletes a review owned by the current user. Returns 404 if it doesn't exist or belongs to someone else.",
)
def delete_review(review_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    review_service.delete_review(db, current_user, review_id)
