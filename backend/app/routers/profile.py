"""Shared Profile screen — every portal edits its own account the same way.

Separate from ``/api/auth/me`` (read-only identity + permissions used at login) even though
the response shape is identical: this router is where the *edit* lives, per
docs/API_CONTRACT.md §6.6. ``email`` is deliberately not editable here — changing the sign-in
identity is a separate, higher-friction flow, out of scope for this milestone.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from pydantic import BaseModel

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.routers.auth import user_response
from app.schemas.auth import UserResponse
from app.schemas.profile import UpdateProfileRequest
from app.services import session_service

router = APIRouter(prefix="/api/profile", tags=["profile"])


class HeartbeatRequest(BaseModel):
    current_page: str | None = None


@router.get(
    "",
    response_model=UserResponse,
    summary="Get my profile",
    description="Requires `profile.manage`. Same shape as `GET /api/auth/me`.",
)
def get_profile(
    current_user: User = Depends(require(P.PROFILE_MANAGE)), db: Session = Depends(get_db)
):
    return user_response(db, current_user)


@router.put(
    "",
    response_model=UserResponse,
    summary="Update my profile",
    description=(
        "Requires `profile.manage`. Only the fields present in the body are changed. `email` "
        "is not editable here."
    ),
)
def update_profile(
    payload: UpdateProfileRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PROFILE_MANAGE)),
):
    fields = payload.model_dump(exclude_unset=True)
    if "full_name" in fields:
        current_user.full_name = fields.pop("full_name")
    if "phone" in fields:
        current_user.phone = fields.pop("phone")

    profile = dict(current_user.profile or {})
    for key, value in fields.items():
        profile[key] = value.isoformat() if hasattr(value, "isoformat") else value
    current_user.profile = profile

    db.commit()
    db.refresh(current_user)
    return user_response(db, current_user)


@router.post(
    "/heartbeat",
    summary="Report this session as active",
    description=(
        "Requires authentication (no specific permission — every signed-in role may call this). "
        "Extends the caller's session_service 'online' window and records the page they're on. "
        "Drives 'who's online now' views; polling this is the only thing that keeps a session "
        "counted as online, so a closed tab simply ages out rather than needing an explicit signal."
    ),
)
def heartbeat(
    payload: HeartbeatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PROFILE_MANAGE)),
):
    session_service.heartbeat(db, current_user.user_id, payload.current_page)
    return {"status": "ok"}
