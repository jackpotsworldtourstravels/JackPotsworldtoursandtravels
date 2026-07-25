from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.partner_deps import get_current_partner_user
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.schemas.partner_auth import (
    MessageResponse,
    PartnerChangePasswordRequest,
    PartnerProfileOut,
    PartnerProfileUpdateRequest,
)
from app.services import partner_auth_service

router = APIRouter(prefix="/api/partner/profile", tags=["partner-profile"])


@router.get("", response_model=PartnerProfileOut, summary="View own profile")
def get_profile(db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)):
    return partner_auth_service.get_profile(db, current.partner_user_id)


@router.patch("", response_model=PartnerProfileOut, summary="Update name/phone")
def update_profile(
    payload: PartnerProfileUpdateRequest,
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    return partner_auth_service.update_profile(db, current.partner_user_id, payload.full_name, payload.phone_number)


@router.post("/change-password", response_model=MessageResponse, summary="Change password")
def change_password(
    payload: PartnerChangePasswordRequest,
    db: Session = Depends(get_db),
    current: PartnerUser = Depends(get_current_partner_user),
):
    partner_auth_service.change_password(db, current.partner_user_id, payload.current_password, payload.new_password)
    return MessageResponse(message="Password changed.")
