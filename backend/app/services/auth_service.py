import datetime

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.auth.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_reset_token,
    hash_password,
    hash_reset_token,
    verify_password,
)
from app.config import settings
from app.models.user import Role, User

_EXTENDED_PROFILE_FIELDS = (
    "first_name", "last_name", "mobile", "gender", "dob", "country", "state", "city", "address",
)


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == email))


def get_user_by_identifier(db: Session, identifier: str) -> User | None:
    """Look up a user by email or mobile number, for login forms that accept either."""
    return db.scalar(select(User).where(or_(User.email == identifier, User.mobile == identifier)))


def signup(db: Session, full_name: str, email: str, password: str, **extended_fields) -> User:
    if get_user_by_email(db, email):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")

    user_role = db.scalar(select(Role).where(Role.name == "user"))
    if user_role is None:
        raise HTTPException(status_code=500, detail="Default role not seeded — run migrations")

    profile_values = {k: v for k, v in extended_fields.items() if k in _EXTENDED_PROFILE_FIELDS and v is not None}

    user = User(
        full_name=full_name,
        email=email,
        hashed_password=hash_password(password),
        role_id=user_role.id,
        **profile_values,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def authenticate(db: Session, identifier: str, password: str, required_role: str | None = None) -> User:
    """Authenticate by email or (for user-role logins) mobile number."""
    user = get_user_by_identifier(db, identifier)
    if not user or not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if required_role is not None and user.role.name != required_role:
        # Deliberately the same generic message as a wrong password — don't reveal
        # that the account exists but belongs to the other login surface.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is disabled")
    if user.is_blocked:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is blocked. Please contact support.")
    return user


def record_login(db: Session, user: User) -> None:
    user.last_login_at = datetime.datetime.utcnow()
    user.login_count = (user.login_count or 0) + 1
    db.commit()


def issue_tokens(user: User) -> tuple[str, str]:
    return create_access_token(user.id), create_refresh_token(user.id)


def logout(db: Session, user: User) -> None:
    """Revokes the user's outstanding access/refresh tokens immediately, rather than
    leaving them valid until natural expiry (JWTs are stateless, so this works by
    moving force_logout_at forward — the same mechanism the admin "force logout"
    action uses)."""
    user.force_logout_at = datetime.datetime.utcnow()
    db.commit()


def refresh_access_token(db: Session, refresh_token: str) -> tuple[str, str]:
    payload = decode_token(refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    user = db.get(User, int(payload["sub"]))
    if not user or not user.is_active or user.is_blocked:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    if user.force_logout_at is not None:
        issued_at = payload.get("iat")
        if issued_at is None or datetime.datetime.utcfromtimestamp(issued_at) < user.force_logout_at:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session ended — please log in again")
    return issue_tokens(user)


def start_password_reset(db: Session, email: str) -> str | None:
    user = get_user_by_email(db, email)
    if not user:
        return None
    raw_token, hashed = generate_reset_token()
    user.reset_token_hash = hashed
    user.reset_token_expires_at = datetime.datetime.utcnow() + datetime.timedelta(minutes=settings.reset_token_expire_minutes)
    db.commit()
    return raw_token


def complete_password_reset(db: Session, raw_token: str, new_password: str) -> None:
    hashed = hash_reset_token(raw_token)
    user = db.scalar(select(User).where(User.reset_token_hash == hashed))
    if not user or not user.reset_token_expires_at or user.reset_token_expires_at < datetime.datetime.utcnow():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reset token is invalid or expired")
    user.hashed_password = hash_password(new_password)
    user.reset_token_hash = None
    user.reset_token_expires_at = None
    db.commit()
