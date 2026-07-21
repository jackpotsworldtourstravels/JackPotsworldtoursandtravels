from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin, get_current_user
from app.database.session import get_db
from app.models.user import User
from app.schemas.auth import MessageResponse, UserResponse
from app.schemas.pagination import Page
from app.schemas.user import (
    AdminUserCreate,
    AdminUserUpdate,
    ChangePasswordRequest,
    HeartbeatRequest,
    ProfileUpdate,
    SetActiveRequest,
)
from app.services import activity_service, session_service, user_service

router = APIRouter(prefix="/api/users", tags=["users"])
admin_router = APIRouter(prefix="/api/admin/users", tags=["admin"])


def _user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        full_name=user.full_name,
        email=user.email,
        role=user.role.name,
        is_active=user.is_active,
        first_name=user.first_name,
        last_name=user.last_name,
        mobile=user.mobile,
        gender=user.gender,
        dob=user.dob,
        country=user.country,
        state=user.state,
        city=user.city,
        address=user.address,
        profile_photo=user.profile_photo,
    )


@router.put(
    "/me",
    response_model=UserResponse,
    summary="Update my profile",
    description="Requires authentication. Updates the current user's full name.",
)
def update_my_profile(
    payload: ProfileUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    user = user_service.update_profile(
        db, current_user, payload.full_name,
        mobile=payload.mobile, gender=payload.gender, dob=payload.dob,
        country=payload.country, state=payload.state, city=payload.city, address=payload.address,
    )
    return _user_response(user)


@router.post(
    "/change-password",
    response_model=MessageResponse,
    summary="Change my password",
    description="Requires authentication. Verifies the current password and sets a new one.",
)
def change_my_password(
    payload: ChangePasswordRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    user_service.change_password(db, current_user, payload.current_password, payload.new_password)
    return MessageResponse(message="Password updated successfully")


@router.post(
    "/heartbeat",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Report presence for online-user tracking",
    description=(
        "Requires authentication. Called periodically (e.g. every ~30s) by the frontend while a page is "
        "open, so the admin dashboard can show who is online and what page they're on."
    ),
)
def heartbeat(
    payload: HeartbeatRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    session_service.heartbeat(db, current_user.id, payload.current_page)


@admin_router.get(
    "",
    response_model=Page[UserResponse],
    summary="List all users (admin)",
    description="Requires admin role. Returns a paginated list of all user accounts.",
)
def list_users(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=1000),
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    users, total = user_service.list_all_users_paginated(db, page, page_size)
    return Page.build([_user_response(u) for u in users], total, page, page_size)


@admin_router.post(
    "",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a user (admin)",
    description="Requires admin role. Creates a new user account with the given role.",
)
def create_user(
    payload: AdminUserCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    user = user_service.create_user_by_admin(db, payload.full_name, payload.email, payload.password, payload.role)
    activity_service.log_activity(db, _admin.id, f"Admin created user {user.email}", module="Admin", activity_type="Admin Action")
    return _user_response(user)


@admin_router.put(
    "/{user_id}",
    response_model=UserResponse,
    summary="Update a user (admin)",
    description="Requires admin role. Updates a user's name, email, and role.",
)
def update_user(
    user_id: int,
    payload: AdminUserUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    user = user_service.update_user_by_admin(db, user_id, payload.full_name, payload.email, payload.role)
    activity_service.log_activity(db, _admin.id, f"Admin updated user {user.email}", module="Admin", activity_type="Admin Action")
    return _user_response(user)


@admin_router.delete(
    "/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a user (admin)",
    description="Requires admin role. Permanently deletes a user account.",
)
def delete_user(user_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    user_service.delete_user(db, user_id)
    activity_service.log_activity(db, _admin.id, f"Admin deleted user #{user_id}", module="Admin", activity_type="Admin Action")


@admin_router.patch(
    "/{user_id}",
    response_model=UserResponse,
    summary="Activate/deactivate a user (admin)",
    description="Requires admin role. Sets whether a user account is active, which controls their ability to log in.",
)
def set_user_active(
    user_id: int, payload: SetActiveRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    user = user_service.set_user_active(db, user_id, payload.is_active)
    activity_service.log_activity(
        db, _admin.id, f"Admin {'activated' if payload.is_active else 'deactivated'} user {user.email}",
        module="Admin", activity_type="Admin Action",
    )
    return _user_response(user)
