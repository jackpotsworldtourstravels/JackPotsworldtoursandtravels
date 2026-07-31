import datetime

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.auth.security import generate_reset_token, hash_password, hash_reset_token
from app.auth.target_schema.security import create_access_token, create_refresh_token, decode_token, verify_password
from app.config import settings
from app.models.target_schema.users import User
from app.services import email_service
from app.services.target_schema import user_service

OTP_TTL_MINUTES = 5


def signup(db: Session, full_name: str, email: str, password: str, **profile_fields) -> User:
    return user_service.create_user(
        db, user_type="customer", email=email, password=password, full_name=full_name, **profile_fields
    )


def get_by_identifier(db: Session, identifier: str) -> User | None:
    """Look up by email or phone number, for login forms that accept either."""
    return db.scalar(select(User).where(or_(User.email == identifier, User.phone_number == identifier)))


def authenticate(db: Session, identifier: str, password: str, required_user_type: str | None = None) -> User:
    user = get_by_identifier(db, identifier)
    if not user or not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if required_user_type is not None and user.user_type != required_user_type:
        # Same generic message as a wrong password — don't reveal that the
        # account exists but belongs to a different login surface.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if user.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Account is {user.status}")
    return user


def issue_tokens(user: User) -> tuple[str, str]:
    return create_access_token(user), create_refresh_token(user)


def logout(db: Session, user: User) -> None:
    """Revokes outstanding tokens immediately by moving force_logout_at
    forward — JWTs are stateless, so this is the same mechanism admin
    "force logout" uses."""
    user.force_logout_at = datetime.datetime.now(datetime.timezone.utc)
    db.commit()


def refresh_access_token(db: Session, refresh_token: str) -> tuple[str, str]:
    payload = decode_token(refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    user = db.get(User, int(payload["sub"]))
    if not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    if user.force_logout_at is not None:
        issued_at = payload.get("iat")
        if issued_at is None or datetime.datetime.utcfromtimestamp(issued_at) < user.force_logout_at:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session ended — please log in again")
    return issue_tokens(user)


def start_password_reset(db: Session, email: str) -> str | None:
    user = user_service.get_by_email(db, email)
    if not user:
        return None
    raw_token, hashed = generate_reset_token()
    user.reset_token_hash = hashed
    user.reset_token_expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        minutes=settings.reset_token_expire_minutes
    )
    db.commit()
    return raw_token


def complete_password_reset(db: Session, raw_token: str, new_password: str) -> None:
    hashed = hash_reset_token(raw_token)
    user = db.scalar(select(User).where(User.reset_token_hash == hashed))
    now = datetime.datetime.now(datetime.timezone.utc)
    if not user or not user.reset_token_expires_at or user.reset_token_expires_at < now:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reset token is invalid or expired")
    user.hashed_password = hash_password(new_password)
    user.reset_token_hash = None
    user.reset_token_expires_at = None
    db.commit()


# ---------------------------------------------------------------------------
# Merchant portal 3-step OTP login (request -> verify -> password). All
# actor types share ts_users, but only merchant_staff uses OTP as a second
# factor — customer/admin/super_admin log in with password only, above.
# ---------------------------------------------------------------------------

def request_login_otp(db: Session, email: str) -> None:
    """Unlike forgot-password, login can't proceed without a valid account —
    reported directly rather than silently no-op'd, since this is an
    invitation-only B2B portal, not public signup."""
    user = user_service.get_by_email(db, email)
    if not user or user.user_type != "merchant_staff" or user.status != "active":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active partner account found for this email")
    code = user_service.issue_otp(db, user, purpose="login")
    if not email_service.send_otp_email(email, code, OTP_TTL_MINUTES):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to send the OTP email right now. Please try again shortly.",
        )


def verify_login_otp(db: Session, email: str, otp: str) -> None:
    user = user_service.get_by_email(db, email)
    if not user or user.user_type != "merchant_staff":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No partner account found for this email")
    if not user_service.verify_otp(db, user, otp, purpose="login"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect or expired OTP")


def merchant_login(db: Session, email: str, password: str) -> User:
    """Step 3 — requires a prior verified OTP for 'login' within the last 15
    minutes (see user_service.otp_recently_verified), same two-factor
    pattern the flow was originally designed around, not just a password
    check."""
    user = get_by_identifier(db, email)
    if not user or user.user_type != "merchant_staff" or not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if user.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This partner account is not active")
    if not user_service.otp_recently_verified(user):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Please verify the OTP sent to your email first")
    user_service.clear_otp_verification(db, user)
    return user


def request_password_reset_otp(db: Session, email: str) -> None:
    """More sensitive to account enumeration than login OTP — silent on an
    unknown email rather than a 404."""
    user = user_service.get_by_email(db, email)
    if user and user.user_type == "merchant_staff" and user.status == "active":
        code = user_service.issue_otp(db, user, purpose="password_reset")
        email_service.send_otp_email(email, code, OTP_TTL_MINUTES)


def reset_password_with_otp(db: Session, email: str, otp: str, new_password: str) -> None:
    user = user_service.get_by_email(db, email)
    if not user or user.user_type != "merchant_staff":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect or expired OTP")
    if not user_service.verify_otp(db, user, otp, purpose="password_reset"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect or expired OTP")
    user_service.clear_otp_verification(db, user)
    user.hashed_password = hash_password(new_password)
    db.commit()
