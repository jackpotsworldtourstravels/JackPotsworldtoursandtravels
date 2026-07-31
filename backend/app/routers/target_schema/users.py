from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.target_schema.deps import get_current_user
from app.database.session import get_db
from app.models.target_schema.users import User
from app.schemas.target_schema.auth import MessageResponse, UserResponse
from app.schemas.target_schema.user import ChangePasswordRequest, HeartbeatRequest, ProfileUpdate
from app.services.target_schema import system_log_service, user_service

# Admin-side CRUD (list/create/update/delete users) is Admin Portal scope,
# deferred — see docs/ROUTER_CUTOVER_CHECKLIST.md. This router is the
# customer/self-service subset only.
router = APIRouter(prefix="/api/users", tags=["users"])


@router.put("/me", response_model=UserResponse, summary="Update my profile")
def update_my_profile(payload: ProfileUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    user = user_service.update_profile(
        db, current_user, full_name=payload.full_name, phone_number=payload.phone_number, gender=payload.gender,
        dob=payload.dob, country=payload.country, state=payload.state, city=payload.city, address=payload.address,
    )
    return UserResponse.model_validate(user)


@router.post("/change-password", response_model=MessageResponse, summary="Change my password")
def change_my_password(payload: ChangePasswordRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    user_service.change_password(db, current_user, payload.current_password, payload.new_password)
    return MessageResponse(message="Password updated successfully")


@router.post(
    "/heartbeat", status_code=status.HTTP_204_NO_CONTENT,
    summary="Report presence for online-user tracking",
)
def heartbeat(payload: HeartbeatRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    system_log_service.heartbeat(db, current_user.id, payload.current_page)
