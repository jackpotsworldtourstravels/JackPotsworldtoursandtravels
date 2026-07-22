import logging
import os

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.security import hash_password, verify_password
from app.models.booking import Booking
from app.models.user import Role, User
from app.services import activity_service, notification_service

DEFAULT_ADMIN_EMAIL = "admin@jackpotsworldtours.com"
DEFAULT_ADMIN_PASSWORD = "AdminPass#2026"

logger = logging.getLogger(__name__)


def _get_role(db: Session, role_name: str) -> Role:
    role = db.scalar(select(Role).where(Role.name == role_name))
    if role is None:
        raise HTTPException(status_code=500, detail=f"Role '{role_name}' not seeded — run migrations")
    return role


def create_user_by_admin(db: Session, full_name: str, email: str, password: str, role: str) -> User:
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")
    user = User(
        full_name=full_name,
        email=email,
        hashed_password=hash_password(password),
        role_id=_get_role(db, role).id,
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
    if existing and existing.id != user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")
    user.full_name = full_name
    user.email = email
    user.role_id = _get_role(db, role).id
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, user_id: int) -> None:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    has_bookings = db.scalar(select(Booking.id).where(Booking.user_id == user_id).limit(1))
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
            detail="Cannot delete this user because related records still reference them — deactivate instead.",
        )


def update_profile(db: Session, user: User, full_name: str, **extended_fields) -> User:
    user.full_name = full_name
    for field in ("mobile", "gender", "dob", "country", "state", "city", "address"):
        if field in extended_fields and extended_fields[field] is not None:
            setattr(user, field, extended_fields[field])
    db.commit()
    db.refresh(user)
    activity_service.log_activity(
        db, user.id, "Profile Updated",
        activity_type="Profile Update", module="Profile", description=f"{user.full_name} updated their profile",
    )
    notification_service.create_notification(db, user.id, "Profile updated", "Your profile details were updated.")
    return user


def change_password(db: Session, user: User, current_password: str, new_password: str) -> None:
    if not verify_password(current_password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    user.hashed_password = hash_password(new_password)
    db.commit()
    activity_service.log_activity(
        db, user.id, "Password Changed",
        activity_type="Password Change", module="Profile", description=f"{user.full_name} changed their password",
    )


def list_all_users(db: Session) -> list[User]:
    return db.scalars(select(User).order_by(User.created_at.desc())).all()


def list_all_users_paginated(db: Session, page: int, page_size: int) -> tuple[list[User], int]:
    total = db.scalar(select(func.count()).select_from(User)) or 0
    stmt = select(User).order_by(User.created_at.desc()).limit(page_size).offset((page - 1) * page_size)
    return db.scalars(stmt).all(), total


def set_user_active(db: Session, user_id: int, is_active: bool) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user.is_active = is_active
    db.commit()
    db.refresh(user)
    return user


def ensure_default_admin(db: Session) -> None:
    """Idempotent self-heal: guarantee a working admin login exists on every app
    startup. Only *creates* the account if it's missing entirely — never touches
    an existing admin row, so a password you've deliberately changed is never
    overwritten. This exists because the admin account has been wiped and
    recreated with an unrecoverable random password more than once (e.g. by a
    migration downgrade/upgrade cycle); restarting the backend now always
    restores a known-good login instead of requiring a manual DB fix.
    """
    admin_email = os.environ.get("ADMIN_SEED_EMAIL", DEFAULT_ADMIN_EMAIL)
    if db.scalar(select(User).where(User.email == admin_email)):
        return

    admin_role = db.scalar(select(Role).where(Role.name == "admin"))
    if admin_role is None:
        return  # roles not seeded yet — migrations haven't run

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
            hashed_password=hash_password(admin_password),
            role_id=admin_role.id,
            is_active=True,
        )
    )
    db.commit()
