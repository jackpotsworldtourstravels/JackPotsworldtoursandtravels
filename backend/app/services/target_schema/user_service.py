import datetime
import secrets

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.security import hash_password, verify_password
from app.models.target_schema.users import User

OTP_TTL_MINUTES = 10
OTP_MAX_ATTEMPTS = 5


def get_by_id(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def get_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == email))


def create_user(
    db: Session, *, user_type: str, email: str, password: str, full_name: str,
    merchant_id: int | None = None, role_type: str | None = None, member_role: str | None = None,
    username: str | None = None, phone_number: str | None = None,
) -> User:
    if get_by_email(db, email):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")
    if user_type == "merchant_staff" and merchant_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="merchant_id required for merchant staff")
    now = datetime.datetime.now(datetime.timezone.utc)
    user = User(
        user_type=user_type, email=email, hashed_password=hash_password(password), full_name=full_name,
        merchant_id=merchant_id, role_type=role_type, member_role=member_role, username=username,
        phone_number=phone_number, created_at=now, updated_at=now,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def authenticate(db: Session, email: str, password: str) -> User:
    user = get_by_email(db, email)
    if not user or not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if user.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Account is {user.status}")
    return user


def update_profile(db: Session, user: User, **fields) -> User:
    for field in ("full_name", "phone_number", "gender", "dob", "country", "state", "city", "address"):
        if field in fields and fields[field] is not None:
            setattr(user, field, fields[field])
    db.commit()
    db.refresh(user)
    return user


def change_password(db: Session, user: User, current_password: str, new_password: str) -> None:
    if not verify_password(current_password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    user.hashed_password = hash_password(new_password)
    db.commit()


def set_status(db: Session, user_id: int, new_status: str) -> User:
    user = get_by_id(db, user_id)
    user.status = new_status
    # blocked/deleted are punitive/terminal — kill the session immediately,
    # matching legacy is_blocked/is_deleted behavior. 'inactive' (legacy
    # is_active=False) deliberately does NOT force logout, matching
    # set_user_active, which never touched force_logout_at either.
    if new_status in ("blocked", "deleted"):
        user.force_logout_at = datetime.datetime.now(datetime.timezone.utc)
    db.commit()
    db.refresh(user)
    return user


def issue_otp(db: Session, user: User, purpose: str) -> str:
    """Generates and stores a 6-digit OTP for merchant-portal login/forgot-password.
    Returns the plaintext code for the caller to send via msg_log_service — the
    row itself only ever stores the hash.
    """
    if user.otp_attempts >= OTP_MAX_ATTEMPTS:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many OTP attempts")
    code = f"{secrets.randbelow(1_000_000):06d}"
    user.otp_hash = hash_password(code)
    user.otp_purpose = purpose
    user.otp_expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=OTP_TTL_MINUTES)
    user.otp_attempts = 0
    db.commit()
    return code


def verify_otp(db: Session, user: User, code: str, purpose: str) -> bool:
    if not user.otp_hash or user.otp_purpose != purpose:
        return False
    if user.otp_expires_at is None or user.otp_expires_at < datetime.datetime.now(datetime.timezone.utc):
        return False
    user.otp_attempts += 1
    db.commit()
    if not verify_password(code, user.otp_hash):
        if user.otp_attempts >= OTP_MAX_ATTEMPTS:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many OTP attempts")
        return False
    user.otp_hash = None
    user.otp_purpose = None
    user.otp_expires_at = None
    user.otp_attempts = 0
    user.otp_verified_at = datetime.datetime.now(datetime.timezone.utc)
    db.commit()
    return True


def otp_recently_verified(user: User, window_minutes: int = 15) -> bool:
    """Gates step 3 (password submit) of the merchant portal's 3-step OTP
    login/reset flow — must be called after verify_otp already cleared the
    OTP fields in step 2.
    """
    if user.otp_verified_at is None:
        return False
    return user.otp_verified_at > datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=window_minutes)


def clear_otp_verification(db: Session, user: User) -> None:
    user.otp_verified_at = None
    db.commit()


# Mirrors schemas/admin_merchant.py's ROLE_TYPE_MEMBER_ROLES — kept here too
# since the service layer must enforce it independent of what schema a
# caller happens to validate against.
ROLE_TYPE_MEMBER_ROLES: dict[str, list[str]] = {
    "admin": ["admin"],
    "user": ["user"],
    "maker": ["data_operator", "request_ticket", "cancellation_ticket"],
    "checker": ["supervisor", "manager"],
}


def _check_merchant_staff_uniqueness(
    db: Session, *, username: str, email: str, phone_number: str, exclude_user_id: int | None = None
) -> None:
    """Uniqueness is enforced only within merchant_staff, matching the legacy
    partner_users table's own scope — customers/admins aren't required to
    have globally unique phone numbers, so this isn't a DB-level constraint."""
    for field, value in (("username", username), ("email", email), ("phone_number", phone_number)):
        column = getattr(User, field)
        stmt = select(User.id).where(column == value, User.user_type == "merchant_staff")
        if exclude_user_id is not None:
            stmt = stmt.where(User.id != exclude_user_id)
        if db.scalar(stmt):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"This {field.replace('_', ' ')} is already in use")


def create_merchant_staff(
    db: Session, *, merchant_id: int, full_name: str, username: str, email: str, phone_number: str,
    password: str, role_type: str, member_role: str,
) -> User:
    if member_role not in ROLE_TYPE_MEMBER_ROLES.get(role_type, []):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Member Role '{member_role}' is not valid for Role Type '{role_type}'",
        )
    _check_merchant_staff_uniqueness(db, username=username, email=email, phone_number=phone_number)
    return create_user(
        db, user_type="merchant_staff", email=email, password=password, full_name=full_name,
        merchant_id=merchant_id, role_type=role_type, member_role=member_role,
        username=username, phone_number=phone_number,
    )


def update_merchant_staff(
    db: Session, user_id: int, *, full_name: str | None = None, phone_number: str | None = None,
    role_type: str | None = None, member_role: str | None = None,
) -> User:
    user = get_by_id(db, user_id)
    if (role_type is None) != (member_role is None):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role Type and Member Role must be updated together")
    if role_type is not None and member_role not in ROLE_TYPE_MEMBER_ROLES.get(role_type, []):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Member Role '{member_role}' is not valid for Role Type '{role_type}'",
        )
    if phone_number:
        _check_merchant_staff_uniqueness(db, username=user.username, email=user.email, phone_number=phone_number, exclude_user_id=user_id)
    for field, value in (("full_name", full_name), ("phone_number", phone_number), ("role_type", role_type), ("member_role", member_role)):
        if value is not None:
            setattr(user, field, value)
    db.commit()
    db.refresh(user)
    return user


def admin_reset_password(db: Session, user_id: int) -> str:
    """Admin-triggered reset for a merchant staff account — generates and
    sets a new random password, returned once for the admin to relay."""
    user = get_by_id(db, user_id)
    new_password = secrets.token_urlsafe(9)
    user.hashed_password = hash_password(new_password)
    db.commit()
    return new_password


def list_by_merchant(db: Session, merchant_id: int) -> list[User]:
    return db.scalars(
        select(User).where(User.merchant_id == merchant_id).order_by(User.created_at.desc())
    ).all()


def list_paginated(db: Session, *, user_type: str | None, page: int, page_size: int) -> tuple[list[User], int]:
    stmt = select(User)
    count_stmt = select(func.count()).select_from(User)
    if user_type:
        stmt = stmt.where(User.user_type == user_type)
        count_stmt = count_stmt.where(User.user_type == user_type)
    total = db.scalar(count_stmt) or 0
    stmt = stmt.order_by(User.created_at.desc()).limit(page_size).offset((page - 1) * page_size)
    return db.scalars(stmt).all(), total
