"""Unified login for all three portals.

Implements the spec's flow, identical for Super Admin, Admin and Merchant::

    Login -> Password -> OTP -> Dashboard

Two calls:

1. ``POST /api/auth/login`` — verifies email + password *and* that the
   account belongs to the portal being opened, then issues an OTP and
   returns a short-lived challenge token. No session yet.
2. ``POST /api/auth/verify-otp`` — spends the challenge token plus the code
   and returns the access/refresh pair.

Separating the two means a correct password alone never yields a session,
and the challenge token is scoped so it cannot be used as one.
"""
import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.auth.rate_limit import limiter
from app.auth.rbac import effective_permissions
from app.auth.security import create_otp_challenge_token, decode_otp_challenge_token
from app.config import settings
from app.database.session import get_db
from app.models_v2 import MerchantStatus, OtpPurpose, User, UserRole, UserStatus
from app.schemas.auth import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginChallengeResponse,
    LoginRequest,
    MessageResponse,
    RefreshRequest,
    ResendOtpRequest,
    ResetPasswordRequest,
    TokenResponse,
    UserResponse,
    VerifyOtpRequest,
)
from app.services import (
    activity_service,
    auth_service,
    email_service,
    otp_service,
    session_service,
    user_service,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

#: Which roles may open which portal. Enforced at login, so an Admin's
#: credentials cannot open the Super Admin portal even though both are valid.
PORTAL_ROLES: dict[str, tuple[UserRole, ...]] = {
    "super_admin": (UserRole.SUPER_ADMIN,),
    "admin": (UserRole.ADMIN,),
    # The Manager gets its own portal rather than a corner of the Admin one.
    # An Admin signing into a screen it may not act on would be a 403 tour, and
    # the separation between the enquiry desk and the approver is the point of
    # the role (CR-2).
    "manager": (UserRole.MANAGER,),
    "merchant": (UserRole.MERCHANT_ADMIN, UserRole.MERCHANT_USER),
}

_PORTAL_OF_ROLE: dict[UserRole, str] = {
    UserRole.SUPER_ADMIN: "super_admin",
    UserRole.ADMIN: "admin",
    UserRole.MANAGER: "manager",
    UserRole.MERCHANT_ADMIN: "merchant",
    UserRole.MERCHANT_USER: "merchant",
    UserRole.CUSTOMER: "none",
}


def _profile_date(profile: dict, key: str) -> datetime.date | None:
    """``profile`` is JSONB, so dates come back as ISO strings."""
    raw = profile.get(key)
    if not raw:
        return None
    try:
        return datetime.date.fromisoformat(raw)
    except (TypeError, ValueError):
        return None


def user_response(user: User) -> UserResponse:
    profile = user.profile or {}
    return UserResponse(
        id=user.user_id,
        full_name=user.full_name,
        email=user.email,
        role=user.role.value,
        portal=_PORTAL_OF_ROLE[user.role],
        merchant_role=user.merchant_role.value if user.merchant_role else None,
        merchant_id=user.merchant_id,
        merchant_name=user.merchant.company_name if user.merchant else None,
        permissions=sorted(effective_permissions(user)),
        is_active=user.is_active,
        mobile=user.phone,
        first_name=profile.get("first_name"),
        last_name=profile.get("last_name"),
        gender=profile.get("gender"),
        dob=_profile_date(profile, "dob"),
        country=profile.get("country"),
        state=profile.get("state"),
        city=profile.get("city"),
        address=profile.get("address"),
        profile_photo=profile.get("profile_photo"),
        last_login=user.last_login,
    )


def _log_failed_login(db: Session, request: Request, identifier: str, reason: str) -> None:
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, None, "Failed login attempt", meta["ip_address"],
        activity_type="Login", module="Auth",
        description=f"Failed login for '{identifier}': {reason}",
        browser=meta["browser"], device=meta["device"], status="failed",
    )


def _assert_portal_allowed(user: User, portal: str) -> None:
    """Reject an account that doesn't belong to the portal being opened.

    Uses the same generic message as a wrong password: revealing "right
    password, wrong portal" would confirm the account exists.
    """
    if user.role not in PORTAL_ROLES[portal]:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password"
        )


def _assert_merchant_tradeable(user: User) -> None:
    """A merchant's staff cannot sign in until the company is approved."""
    if user.role not in (UserRole.MERCHANT_ADMIN, UserRole.MERCHANT_USER):
        return
    merchant = user.merchant
    if merchant is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Account is not linked to a merchant"
        )
    if merchant.status is MerchantStatus.PENDING_APPROVAL:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your company is awaiting approval by an administrator.",
        )
    if merchant.status is not MerchantStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Your company account is {merchant.status.value}. Please contact support.",
        )


@router.post(
    "/login",
    response_model=LoginChallengeResponse,
    summary="Step 1 — verify password and issue an OTP",
    description=(
        "Public endpoint. Verifies the credentials and that the account belongs to the requested "
        "portal, then sends a one-time code and returns a short-lived challenge token. **No session "
        "is issued here** — call /verify-otp with the challenge token and the code to finish signing "
        "in. When SMTP is unconfigured the code is returned in `dev_otp` and logged, so local "
        "development works without an email account."
    ),
)
@limiter.limit("10/minute")
def login(request: Request, payload: LoginRequest, db: Session = Depends(get_db)):
    try:
        user = auth_service.authenticate(db, payload.email, payload.password)
    except HTTPException as exc:
        _log_failed_login(db, request, payload.email, exc.detail)
        raise

    try:
        _assert_portal_allowed(user, payload.portal)
        _assert_merchant_tradeable(user)
    except HTTPException as exc:
        _log_failed_login(db, request, payload.email, str(exc.detail))
        raise

    dev_code = otp_service.issue(db, user, OtpPurpose.LOGIN)
    mode = otp_service.delivery_mode()

    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "OTP requested", meta["ip_address"],
        activity_type="Login", module="Auth",
        description=f"{user.full_name} passed password step for the {payload.portal} portal",
        browser=meta["browser"], device=meta["device"], merchant_id=user.merchant_id,
    )

    return LoginChallengeResponse(
        challenge_token=create_otp_challenge_token(user.user_id),
        delivery=mode,
        message=(
            f"A verification code was sent to {user.email}."
            if mode == otp_service.EMAIL_MODE
            else "SMTP is not configured — the code is shown here and in the server log."
        ),
        dev_otp=dev_code,
    )


def _user_for_challenge(db: Session, challenge_token: str) -> User:
    user_id = decode_otp_challenge_token(challenge_token)
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Login session expired — please sign in again",
        )
    user = db.get(User, user_id)
    if not user or user.status is not UserStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive"
        )
    return user


@router.post(
    "/verify-otp",
    response_model=TokenResponse,
    summary="Step 2 — exchange the OTP for a session",
    description=(
        "Public endpoint. Spends the challenge token from /login together with the emailed code, "
        "and returns the access/refresh token pair plus the signed-in user's profile and effective "
        "permissions."
    ),
)
@limiter.limit("20/minute")
def verify_otp(request: Request, payload: VerifyOtpRequest, db: Session = Depends(get_db)):
    user = _user_for_challenge(db, payload.challenge_token)
    otp_service.verify(db, user, payload.code, OtpPurpose.LOGIN)

    # Re-check: the company could have been suspended between the two steps.
    _assert_merchant_tradeable(user)

    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Login", meta["ip_address"],
        activity_type="Login", module="Auth",
        description=f"{user.full_name} logged in",
        browser=meta["browser"], device=meta["device"], merchant_id=user.merchant_id,
    )
    auth_service.record_login(db, user)
    session_service.start_session(db, user, meta)

    access_token, refresh_token = auth_service.issue_tokens(user)
    return TokenResponse(
        access_token=access_token, refresh_token=refresh_token, user=user_response(user)
    )


@router.post(
    "/resend-otp",
    response_model=LoginChallengeResponse,
    summary="Re-send the verification code",
    description="Public endpoint. Issues a fresh code for an outstanding login challenge.",
)
@limiter.limit("5/minute")
def resend_otp(request: Request, payload: ResendOtpRequest, db: Session = Depends(get_db)):
    user = _user_for_challenge(db, payload.challenge_token)
    dev_code = otp_service.issue(db, user, OtpPurpose.LOGIN)
    mode = otp_service.delivery_mode()
    return LoginChallengeResponse(
        challenge_token=create_otp_challenge_token(user.user_id),
        delivery=mode,
        message="A new verification code has been issued.",
        dev_otp=dev_code,
    )


@router.post(
    "/refresh",
    response_model=TokenResponse,
    summary="Exchange a refresh token for a new token pair",
    description="Public endpoint (the refresh token is itself the credential). No OTP is required.",
)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)):
    access_token, refresh_token = auth_service.refresh_access_token(db, payload.refresh_token)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post(
    "/logout",
    response_model=MessageResponse,
    summary="Log out",
    description=(
        "Requires authentication. Ends the session and revokes the current access/refresh pair "
        "(and any others issued earlier), so a copied token stops working immediately."
    ),
)
def logout(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, current_user.user_id, "Logout", meta["ip_address"],
        activity_type="Logout", module="Auth",
        description=f"{current_user.full_name} logged out",
        browser=meta["browser"], device=meta["device"], merchant_id=current_user.merchant_id,
    )
    session_service.end_session(db, current_user.user_id)
    auth_service.logout(db, current_user)
    return MessageResponse(message="Logged out — your tokens have been revoked")


@router.post(
    "/forgot-password",
    response_model=MessageResponse,
    summary="Start a password reset",
    description=(
        "Public endpoint. Always returns the same generic message whether or not the address is "
        "registered, so it cannot be used to enumerate accounts. With settings.debug enabled the "
        "reset link is also returned directly, for local testing without SMTP."
    ),
)
@limiter.limit("5/minute")
def forgot_password(request: Request, payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    raw_token = auth_service.start_password_reset(db, payload.email)
    generic = MessageResponse(
        message="If an account exists for that email, a reset link has been issued"
    )
    if raw_token is None:
        return generic

    reset_link = f"{settings.frontend_base_url}/reset-password.html?token={raw_token}"
    email_service.send_password_reset_email(
        payload.email, reset_link, settings.reset_token_expire_minutes
    )
    if not settings.debug:
        return generic
    return MessageResponse(
        message="Reset link generated (debug mode returns it directly)",
        reset_link=f"/reset-password.html?token={raw_token}",
    )


@router.post(
    "/reset-password",
    response_model=MessageResponse,
    summary="Complete a password reset",
    description="Public endpoint. Validates the token from /forgot-password and sets the new password.",
)
def reset_password(payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    auth_service.complete_password_reset(db, payload.token, payload.new_password)
    return MessageResponse(message="Password has been reset — you can now log in")


@router.post(
    "/change-password",
    response_model=MessageResponse,
    summary="Change your own password",
    description="Requires authentication. Verifies the current password before setting the new one.",
)
def change_password(
    payload: ChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    user_service.change_password(db, current_user, payload.current_password, payload.new_password)
    return MessageResponse(message="Password changed")


@router.get(
    "/me",
    response_model=UserResponse,
    summary="Get the signed-in user's profile and permissions",
    description=(
        "Requires authentication. Returns the profile plus the caller's effective permission codes, "
        "so each portal can hide what the user may not do (the server enforces it regardless)."
    ),
)
def me(current_user: User = Depends(get_current_user)):
    return user_response(current_user)
