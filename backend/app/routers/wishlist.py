from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database.session import get_db
from app.models.user import User
from app.schemas.wishlist import WishlistCreate, WishlistOut
from app.services import wishlist_service

router = APIRouter(prefix="/api/wishlist", tags=["wishlist"])


@router.post(
    "",
    response_model=WishlistOut,
    status_code=status.HTTP_201_CREATED,
    summary="Add an item to my wishlist",
    description="Requires authentication. Saves an item (flight/hotel/cruise/package) to the current user's wishlist.",
)
def add_to_wishlist(payload: WishlistCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return wishlist_service.add_to_wishlist(db, current_user, payload.item_type, payload.item_id)


@router.get(
    "",
    response_model=list[WishlistOut],
    summary="List my wishlist",
    description="Requires authentication. Returns all items saved to the current user's wishlist.",
)
def my_wishlist(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return wishlist_service.list_user_wishlist(db, current_user)


@router.delete(
    "/{wishlist_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove an item from my wishlist",
    description="Requires authentication. Removes an entry from the current user's wishlist.",
)
def remove_from_wishlist(wishlist_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    wishlist_service.remove_from_wishlist(db, current_user, wishlist_id)
