"""User management against the v2 ``users`` table.

Roles are an enum column rather than a joined ``roles`` row, and the
extended profile fields live in ``users.profile`` (JSONB). Bookings are
``service_requests`` rows with ``request_type='booking'``.
"""
import datetime
import logging
import os

from fastapi import HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.security import hash_password, verify_password
from app.models_v2 import RequestType, ServiceRequest, User, UserRole, UserStatus
from app.services import activity_service, notification_service
from app.services.auth_service import PROFILE_FIELDS

DEFAULT_ADMIN_EMAIL = "admin@jackpotsworldtours.com"
DEFAULT_ADMIN_PASSWORD = "AdminPass#2026"

logger = logging.getLogger(__name__)

#: Legacy role names accepted by the admin API, mapped to v2 enum members.
_ROLE_ALIASES = {
    "user": UserRole.CUSTOMER,
    "customer": UserRole.CUSTOMER,
    "admin": UserRole.ADMIN,
    "super_admin": UserRole.SUPER_ADMIN,
    "merchant_admin": UserRole.MERCHANT_ADMIN,
    "merchant_user": UserRole.MERCHANT_USER,
}


def resolve_role(role_name: str) -> UserRole:
    try:
        return _ROLE_ALIASES[role_name]
    except KeyError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown role '{role_name}'"
        )


def create_user_by_admin(db: Session, full_name: str, email: str, password: str, role: str) -> User:
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered"
        )
    resolved = resolve_role(role)
    if resolved in (UserRole.MERCHANT_ADMIN, UserRole.MERCHANT_USER):
        # ck_users_merchant_scope would reject this at the database level.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Merchant users must be created through merchant management, not here.",
        )
    user = User(
        full_name=full_name,
        email=email,
        password_hash=hash_password(password),
        role=resolved,
        permissions=[],
        profile={},
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def update_user_by_admin(db: Session, user_id: int, full_name: str, email: str, role: str) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    existing = db.scalar(select(User).where(User.email == email))
    if existing and existing.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered"
        )
    user.full_name = full_name
    user.email = email
    user.role = resolve_role(role)
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, user_id: int) -> None:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    has_bookings = db.scalar(
        select(ServiceRequest.request_id)
        .where(
            and_(
                ServiceRequest.user_id == user_id,
                ServiceRequest.request_type == RequestType.BOOKING,
            )
        )
        .limit(1)
    )
    if has_bookings:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete a user with existing bookings — deactivate instead.",
        )
    db.delete(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Cannot delete this user because related records still reference "
                "them — deactivate instead."
            ),
        )


def update_profile(db: Session, user: User, full_name: str, **extended_fields) -> User:
    user.full_name = full_name
    if extended_fields.get("mobile") is not None:
        user.phone = extended_fields["mobile"]

    profile = dict(user.profile or {})
    for field in PROFILE_FIELDS:
        value = extended_fields.get(field)
        if value is not None:
            profile[field] = (
                value.isoformat() if isinstance(value, (datetime.date, datetime.datetime)) else value
            )
    # Reassign rather than mutate: SQLAlchemy does not track in-place JSONB edits.
    user.profile = profile

    db.commit()
    db.refresh(user)
    activity_service.log_activity(
        db,
        user.user_id,
        "Profile Updated",
        activity_type="Profile Update",
        module="Profile",
        description=f"{user.full_name} updated their profile",
    )
    notification_service.create_notification(
        db, user.user_id, "Profile updated", "Your profile details were updated."
    )
    return user


def change_password(db: Session, user: User, current_password: str, new_password: str) -> None:
    if not verify_password(current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect"
        )
    user.password_hash = hash_password(new_password)
    db.commit()
    activity_service.log_activity(
        db,
        user.user_id,
        "Password Changed",
        activity_type="Password Change",
        module="Profile",
        description=f"{user.full_name} changed their password",
    )


def list_all_users(db: Session) -> list[User]:
    return list(db.scalars(select(User).order_by(User.created_at.desc())).all())


def list_all_users_paginated(db: Session, page: int, page_size: int) -> tuple[list[User], int]:
    total = db.scalar(select(func.count()).select_from(User)) or 0
    stmt = (
        select(User)
        .order_by(User.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.scalars(stmt).all()), total


def set_user_active(db: Session, user_id: int, is_active: bool) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user.status = UserStatus.ACTIVE if is_active else UserStatus.INACTIVE
    db.commit()
    db.refresh(user)
    return user


def ensure_default_admin(db: Session) -> None:
    """Idempotent self-heal: guarantee a working admin login exists on startup.

    Only *creates* the account when missing entirely — never touches an
    existing admin row, so a deliberately changed password is never
    overwritten. This exists because the admin account has been wiped and
    recreated with an unrecoverable random password more than once (e.g. by a
    migration downgrade/upgrade cycle).
    """
    admin_email = os.environ.get("ADMIN_SEED_EMAIL", DEFAULT_ADMIN_EMAIL)
    if db.scalar(select(User).where(User.email == admin_email)):
        return

    admin_password = os.environ.get("ADMIN_SEED_PASSWORD", DEFAULT_ADMIN_PASSWORD)
    if admin_password == DEFAULT_ADMIN_PASSWORD:
        logger.warning(
            "ensure_default_admin: seeding admin account with the hardcoded default "
            "password because ADMIN_SEED_PASSWORD is not set. Set ADMIN_SEED_PASSWORD "
            "in the environment before deploying anywhere reachable by the public."
        )
    db.add(
        User(
            full_name="JackPots Admin",
            email=admin_email,
            password_hash=hash_password(admin_password),
            role=UserRole.SUPER_ADMIN,
            permissions=[],
            profile={},
            status=UserStatus.ACTIVE,
            email_verified=True,
        )
    )
    db.commit()
