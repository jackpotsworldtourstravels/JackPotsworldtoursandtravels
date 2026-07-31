from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth.rate_limit import limiter
from app.auth.target_schema.deps import get_current_user
from app.config import settings
from app.database.session import get_db
from app.models.target_schema.users import User
from app.schemas.target_schema.auth import (
    ForgotPasswordRequest,
    ForgotPasswordResetRequest,
    LoginRequest,
    MerchantLoginRequest,
    MessageResponse,
    OTPRequestRequest,
    OTPVerifyRequest,
    OTPVerifyResponse,
    RefreshRequest,
    ResetPasswordRequest,
    SignupRequest,
    TokenResponse,
    UserResponse,
)
# request_context/parse_user_agent are pure Request-header parsing helpers
# with no DB dependency — reused as-is rather than duplicated.
from app.services.activity_service import request_context
from app.services.target_schema import auth_service, msg_log_service, system_log_service

router = APIRouter(prefix="/api/auth", tags=["auth"])
merchant_router = APIRouter(prefix="/api/partner-auth", tags=["partner-auth"])


def _login_and_track(db: Session, user: User, request: Request) -> None:
    ctx = request_context(request)
    system_log_service.log_activity(
        db, user_id=user.id, event=f"{user.full_name} logged in",
        entity_type="user", entity_id=user.id, ip_address=ctx["ip_address"],
        activity_type="Login", module="Auth",
    )
    system_log_service.log_session_start(db, user_id=user.id, ip_address=ctx["ip_address"])


def _log_failed_login(db: Session, request: Request, identifier: str) -> None:
    ctx = request_context(request)
    system_log_service.log_activity(
        db, user_id=None, event=f"Failed login attempt for '{identifier}'", ip_address=ctx["ip_address"],
        activity_type="Login", module="Auth", status="failed",
    )


@router.post("/signup", response_model=TokenResponse, summary="Register a new customer account")
def signup(payload: SignupRequest, request: Request, db: Session = Depends(get_db)):
    user = auth_service.signup(
        db, payload.full_name, payload.email, payload.password,
        phone_number=payload.phone_number, gender=payload.gender, dob=payload.dob,
        country=payload.country, state=payload.state, city=payload.city, address=payload.address,
    )
    ctx = request_context(request)
    system_log_service.log_activity(
        db, user_id=user.id, event=f"{user.full_name} registered a new account",
        entity_type="user", entity_id=user.id, ip_address=ctx["ip_address"],
        activity_type="Registration", module="Auth",
    )
    msg_log_service.send(
        db, channel="notification", user_id=user.id, subject="Welcome to JackPots World Tours!",
        message="Thanks for joining us — start exploring flights, hotels, cruises, and tour packages.",
    )
    access_token, refresh_token = auth_service.issue_tokens(user)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/login", response_model=TokenResponse, summary="Log in with email/phone and password")
@limiter.limit("10/minute")
def login(request: Request, payload: LoginRequest, db: Session = Depends(get_db)):
    try:
        user = auth_service.authenticate(db, payload.identifier, payload.password)
    except HTTPException:
        _log_failed_login(db, request, payload.identifier)
        raise
    _login_and_track(db, user, request)
    access_token, refresh_token = auth_service.issue_tokens(user)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/refresh", response_model=TokenResponse, summary="Exchange a refresh token for a new token pair")
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)):
    access_token, refresh_token = auth_service.refresh_access_token(db, payload.refresh_token)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/logout", response_model=MessageResponse, summary="Log out the current user")
def logout(request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ctx = request_context(request)
    system_log_service.log_activity(
        db, user_id=current_user.id, event=f"{current_user.full_name} logged out",
        entity_type="user", entity_id=current_user.id, ip_address=ctx["ip_address"],
        activity_type="Logout", module="Auth",
    )
    system_log_service.end_latest_session(db, current_user.id)
    auth_service.logout(db, current_user)
    return MessageResponse(message="Logged out — your tokens have been revoked")


@router.post("/forgot-password", response_model=MessageResponse, summary="Start a password reset")
@limiter.limit("5/minute")
def forgot_password(request: Request, payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    raw_token = auth_service.start_password_reset(db, payload.email)
    generic_message = MessageResponse(message="If an account exists for that email, a reset link has been issued")
    if raw_token is None:
        return generic_message

    reset_link = f"{settings.frontend_base_url}/reset-password?token={raw_token}"
    from app.services import email_service
    email_service.send_password_reset_email(payload.email, reset_link, settings.reset_token_expire_minutes)

    if not settings.debug:
        return generic_message
    return MessageResponse(
        message="Reset link generated and emailed (debug mode also returns it directly)",
        reset_link=f"/reset-password?token={raw_token}",
    )


@router.post("/reset-password", response_model=MessageResponse, summary="Complete a password reset")
def reset_password(payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    auth_service.complete_password_reset(db, payload.token, payload.new_password)
    return MessageResponse(message="Password has been reset — you can now log in")


@router.get("/me", response_model=UserResponse, summary="Get the current user's profile")
def me(current_user: User = Depends(get_current_user)):
    return UserResponse.model_validate(current_user)


# ---------------------------------------------------------------------------
# Merchant portal — 3-step OTP login, same URL surface as the legacy
# /api/partner-auth/* router so the frontend needs no changes at cutover.
# ---------------------------------------------------------------------------

@merchant_router.post("/otp/request", response_model=MessageResponse, summary="Step 1 — send a login OTP")
def request_login_otp(payload: OTPRequestRequest, db: Session = Depends(get_db)):
    auth_service.request_login_otp(db, payload.email)
    return MessageResponse(message="OTP sent successfully.")


@merchant_router.post("/otp/verify", response_model=OTPVerifyResponse, summary="Step 2 — verify the login OTP")
def verify_login_otp(payload: OTPVerifyRequest, db: Session = Depends(get_db)):
    auth_service.verify_login_otp(db, payload.email, payload.otp)
    return OTPVerifyResponse(verified=True)


@merchant_router.post("/login", response_model=TokenResponse, summary="Step 3 — password login")
def merchant_login(payload: MerchantLoginRequest, request: Request, db: Session = Depends(get_db)):
    user = auth_service.merchant_login(db, payload.email, payload.password)
    _login_and_track(db, user, request)
    access_token, refresh_token = auth_service.issue_tokens(user)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@merchant_router.post("/forgot-password/request", response_model=MessageResponse, summary="Forgot password — send OTP")
def forgot_password_request(payload: OTPRequestRequest, db: Session = Depends(get_db)):
    auth_service.request_password_reset_otp(db, payload.email)
    return MessageResponse(message="OTP sent successfully.")


@merchant_router.post("/forgot-password/reset", response_model=MessageResponse, summary="Forgot password — set new password")
def forgot_password_reset(payload: ForgotPasswordResetRequest, db: Session = Depends(get_db)):
    auth_service.reset_password_with_otp(db, payload.email, payload.otp, payload.new_password)
    return MessageResponse(message="Password updated. You can now log in.")


@merchant_router.post("/refresh", response_model=TokenResponse, summary="Refresh an expired access token")
def merchant_refresh(payload: RefreshRequest, db: Session = Depends(get_db)):
    access_token, refresh_token = auth_service.refresh_access_token(db, payload.refresh_token)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@merchant_router.post("/logout", response_model=MessageResponse, summary="Log out")
def merchant_logout(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    system_log_service.end_latest_session(db, current_user.id)
    auth_service.logout(db, current_user)
    return MessageResponse(message="Logged out.")
