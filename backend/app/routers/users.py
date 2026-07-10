from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin, get_current_user
from app.database.session import get_db
from app.models.user import User
from app.schemas.auth import MessageResponse, UserResponse
from app.schemas.user import ChangePasswordRequest, ProfileUpdate, SetActiveRequest
from app.services import user_service

router = APIRouter(prefix="/api/users", tags=["users"])
admin_router = APIRouter(prefix="/api/admin/users", tags=["admin"])


def _user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id, full_name=user.full_name, email=user.email, role=user.role.name, is_active=user.is_active
    )


@router.put("/me", response_model=UserResponse)
def update_my_profile(
    payload: ProfileUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    user = user_service.update_profile(db, current_user, payload.full_name)
    return _user_response(user)


@router.post("/change-password", response_model=MessageResponse)
def change_my_password(
    payload: ChangePasswordRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    user_service.change_password(db, current_user, payload.current_password, payload.new_password)
    return MessageResponse(message="Password updated successfully")


@admin_router.get("", response_model=list[UserResponse])
def list_users(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return [_user_response(u) for u in user_service.list_all_users(db)]


@admin_router.patch("/{user_id}", response_model=UserResponse)
def set_user_active(
    user_id: int, payload: SetActiveRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    user = user_service.set_user_active(db, user_id, payload.is_active)
    return _user_response(user)
