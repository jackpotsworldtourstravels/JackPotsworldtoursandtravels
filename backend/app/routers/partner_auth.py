from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.auth.partner_deps import get_current_partner_user
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.schemas.partner_auth import (
    ForgotPasswordResetRequest,
    MessageResponse,
    OTPRequestRequest,
    OTPVerifyRequest,
    OTPVerifyResponse,
    PartnerLoginRequest,
    PartnerRefreshRequest,
    PartnerRefreshResponse,
    PartnerTokenResponse,
)
from app.services import partner_auth_service

router = APIRouter(prefix="/api/partner-auth", tags=["partner-auth"])


@router.post("/otp/request", response_model=MessageResponse, summary="Step 1 — send a login OTP")
def request_login_otp(payload: OTPRequestRequest, db: Session = Depends(get_db)):
    partner_auth_service.request_login_otp(db, payload.email)
    return MessageResponse(message="OTP sent to your email.")


@router.post("/otp/verify", response_model=OTPVerifyResponse, summary="Step 2 — verify the login OTP")
def verify_login_otp(payload: OTPVerifyRequest, db: Session = Depends(get_db)):
    partner_auth_service.verify_login_otp(db, payload.email, payload.otp)
    return OTPVerifyResponse(verified=True)


@router.post("/login", response_model=PartnerTokenResponse, summary="Step 3 — password login (after OTP verification)")
def login(payload: PartnerLoginRequest, request: Request, db: Session = Depends(get_db)):
    result = partner_auth_service.login(db, payload.email, payload.password, request.client.host if request.client else None)
    return PartnerTokenResponse(**result)


@router.post("/forgot-password/request", response_model=MessageResponse, summary="Forgot password — send OTP")
def forgot_password_request(payload: OTPRequestRequest, db: Session = Depends(get_db)):
    partner_auth_service.request_password_reset_otp(db, payload.email)
    return MessageResponse(message="If an account exists for this email, an OTP has been sent.")


@router.post("/forgot-password/reset", response_model=MessageResponse, summary="Forgot password — set new password")
def forgot_password_reset(payload: ForgotPasswordResetRequest, db: Session = Depends(get_db)):
    partner_auth_service.reset_password(db, payload.email, payload.otp, payload.new_password)
    return MessageResponse(message="Password updated. You can now log in.")


@router.post("/refresh", response_model=PartnerRefreshResponse, summary="Refresh an expired access token")
def refresh(payload: PartnerRefreshRequest):
    return PartnerRefreshResponse(**partner_auth_service.refresh(payload.refresh_token))


@router.post("/logout", response_model=MessageResponse, summary="Log out")
def logout(current: PartnerUser = Depends(get_current_partner_user)):
    return MessageResponse(message="Logged out.")
