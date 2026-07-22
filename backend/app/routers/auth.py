from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.auth.rate_limit import limiter
from app.config import settings
from app.database.session import get_db
from app.models.user import User
from app.schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    MessageResponse,
    RefreshRequest,
    ResetPasswordRequest,
    SignupRequest,
    TokenResponse,
    UserLoginRequest,
    UserResponse,
)
from app.services import activity_service, auth_service, email_service, notification_service, session_service

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _login_and_track(db: Session, user: User, request: Request) -> None:
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.id, "Login", meta["ip_address"],
        activity_type="Login", module="Auth", description=f"{user.full_name} logged in",
        browser=meta["browser"], device=meta["device"],
    )
    auth_service.record_login(db, user)
    session_service.start_session(db, user, meta)


def _log_failed_login(db: Session, request: Request, identifier: str) -> None:
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, None, "Failed login attempt", meta["ip_address"],
        activity_type="Login", module="Auth", description=f"Failed login attempt for '{identifier}'",
        browser=meta["browser"], device=meta["device"], status="failed",
    )


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


@router.post(
    "/signup",
    response_model=TokenResponse,
    summary="Register a new user",
    description=(
        "Public endpoint. Creates a new user account, sends a welcome notification, and returns a fresh "
        "access/refresh token pair so the caller is immediately logged in."
    ),
)
def signup(payload: SignupRequest, request: Request, db: Session = Depends(get_db)):
    user = auth_service.signup(
        db, payload.full_name, payload.email, payload.password,
        first_name=payload.first_name, last_name=payload.last_name, mobile=payload.mobile,
        gender=payload.gender, dob=payload.dob, country=payload.country, state=payload.state,
        city=payload.city, address=payload.address,
    )
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.id, "Registration", meta["ip_address"],
        activity_type="Registration", module="Auth", description=f"{user.full_name} registered a new account",
        browser=meta["browser"], device=meta["device"],
    )
    notification_service.create_notification(
        db, user.id, "Welcome to JackPots World Tours!",
        "Thanks for joining us — start exploring flights, hotels, cruises, and tour packages.",
    )
    notification_service.notify_admins(
        db, "New user registered", f"{user.full_name} ({user.email}) just created an account.",
    )
    access_token, refresh_token = auth_service.issue_tokens(user)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post(
    "/login",
    response_model=TokenResponse,
    summary="Log in with email and password",
    description="Public endpoint. Verifies credentials, records a login activity entry, and returns a new access/refresh token pair.",
)
@limiter.limit("10/minute")
def login(request: Request, payload: LoginRequest, db: Session = Depends(get_db)):
    try:
        user = auth_service.authenticate(db, payload.email, payload.password)
    except HTTPException:
        _log_failed_login(db, request, payload.email)
        raise
    _login_and_track(db, user, request)
    access_token, refresh_token = auth_service.issue_tokens(user)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post(
    "/user/login",
    response_model=TokenResponse,
    summary="Customer-only login",
    description=(
        "Public endpoint for the dedicated customer login page. Identical to /login except it rejects "
        "accounts with the admin role, keeping the customer and admin sign-in surfaces fully independent — "
        "admin credentials will never succeed here."
    ),
)
@limiter.limit("10/minute")
def user_login(request: Request, payload: UserLoginRequest, db: Session = Depends(get_db)):
    try:
        user = auth_service.authenticate(db, payload.identifier, payload.password, required_role="user")
    except HTTPException:
        _log_failed_login(db, request, payload.identifier)
        raise
    _login_and_track(db, user, request)
    access_token, refresh_token = auth_service.issue_tokens(user)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post(
    "/refresh",
    response_model=TokenResponse,
    summary="Exchange a refresh token for a new token pair",
    description="Public endpoint (the refresh token itself is the credential). Validates the refresh token and issues a new access/refresh token pair.",
)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)):
    access_token, refresh_token = auth_service.refresh_access_token(db, payload.refresh_token)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post(
    "/logout",
    response_model=MessageResponse,
    summary="Log out the current user",
    description=(
        "Requires authentication. Records a logout activity entry and immediately revokes the "
        "current access/refresh token pair (and any others issued before this call), so a copied "
        "token can't keep being used after logout."
    ),
)
def logout(request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, current_user.id, "Logout", meta["ip_address"],
        activity_type="Logout", module="Auth", description=f"{current_user.full_name} logged out",
        browser=meta["browser"], device=meta["device"],
    )
    session_service.end_session(db, current_user.id)
    auth_service.logout(db, current_user)
    return MessageResponse(message="Logged out — your tokens have been revoked")


@router.post(
    "/forgot-password",
    response_model=MessageResponse,
    summary="Start a password reset",
    description=(
        "Public endpoint. If the email matches an account, issues a reset token and emails the reset link "
        "(if SMTP is configured). Always returns a generic success message regardless of whether the account "
        "exists, to avoid leaking which emails are registered. With settings.debug enabled, the reset link is "
        "also returned directly in the response — handy for local testing without SMTP configured."
    ),
)
@limiter.limit("5/minute")
def forgot_password(request: Request, payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    raw_token = auth_service.start_password_reset(db, payload.email)
    generic_message = MessageResponse(message="If an account exists for that email, a reset link has been issued")
    if raw_token is None:
        return generic_message

    reset_link = f"{settings.frontend_base_url}/reset-password?token={raw_token}"
    email_service.send_password_reset_email(payload.email, reset_link, settings.reset_token_expire_minutes)

    if not settings.debug:
        return generic_message
    return MessageResponse(
        message="Reset link generated and emailed (debug mode also returns it directly)",
        reset_link=f"/reset-password?token={raw_token}",
    )


@router.post(
    "/reset-password",
    response_model=MessageResponse,
    summary="Complete a password reset",
    description="Public endpoint. Validates the reset token issued by /forgot-password and sets the new password.",
)
def reset_password(payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    auth_service.complete_password_reset(db, payload.token, payload.new_password)
    return MessageResponse(message="Password has been reset — you can now log in")


@router.get(
    "/me",
    response_model=UserResponse,
    summary="Get the current user's profile",
    description="Requires authentication. Returns the profile of the user identified by the access token.",
)
def me(current_user: User = Depends(get_current_user)):
    return _user_response(current_user)
