"""Account lifecycle: Super Admin manages Admins, Merchant manages its staff.

Two hierarchies, one implementation, because the rules are the same shape:

* Super Admin creates/edits/suspends/deletes **admins**.
* A Merchant creates/edits/suspends/deletes **its own staff**, and the
  merchant is always the parent — a merchant can never create a user
  outside its own company, enforced here rather than trusted from the
  request body.

Deleting an account that has history is refused rather than cascaded:
``service_requests.user_id`` is ``ON DELETE SET NULL``, so a hard delete
would silently orphan a merchant's request history. Suspend instead.
"""
import secrets
import string

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.security import hash_password
from app.models_v2 import (
    MerchantRole,
    RequestType,
    ServiceRequest,
    User,
    UserRole,
    UserStatus,
)
from app.services import activity_service, notification_service

#: Roles a merchant may assign to its own staff.
MERCHANT_ASSIGNABLE_ROLES = (UserRole.MERCHANT_ADMIN, UserRole.MERCHANT_USER)


def generate_temp_password(length: int = 14) -> str:
    """A readable-but-random first password, handed over once at creation.

    Excludes characters that are ambiguous in a handover email (0/O, 1/l/I).
    """
    alphabet = (
        "".join(c for c in string.ascii_letters if c not in "lIO")
        + "".join(c for c in string.digits if c not in "01")
        + "!@#$%*?"
    )
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _require_unique_email(db: Session, email: str, exclude_user_id: int | None = None) -> None:
    existing = db.scalar(select(User).where(User.email == email))
    if existing and existing.user_id != exclude_user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered"
        )


def _has_history(db: Session, user_id: int) -> bool:
    return (
        db.scalar(
            select(ServiceRequest.request_id)
            .where(
                and_(
                    ServiceRequest.user_id == user_id,
                    ServiceRequest.request_type != RequestType.CATALOG_ITEM,
                )
            )
            .limit(1)
        )
        is not None
    )


# ---------------------------------------------------------------------------
# Super Admin -> Admin
# ---------------------------------------------------------------------------
def create_admin(
    db: Session, actor: User, full_name: str, email: str, phone: str | None,
    password: str | None = None,
) -> tuple[User, str]:
    """Create an Admin. Returns the row and the plaintext first password."""
    _require_unique_email(db, email)
    temp_password = password or generate_temp_password()

    admin = User(
        full_name=full_name,
        email=email,
        phone=phone,
        password_hash=hash_password(temp_password),
        role=UserRole.ADMIN,
        permissions=[],
        profile={},
        status=UserStatus.ACTIVE,
        otp_enabled=True,
        email_verified=True,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)

    activity_service.log_activity(
        db, actor.user_id, "Admin created",
        activity_type="Account", module="Admin Management",
        description=f"{actor.full_name} created admin {admin.email}",
        reference_id=admin.user_id,
    )
    notification_service.create_notification(
        db, admin.user_id, "Your administrator account is ready",
        "An account has been created for you on the JackPots admin console.",
    )
    return admin, temp_password


def list_all_users(
    db: Session,
    page: int,
    page_size: int,
    *,
    status: UserStatus | None = None,
    role: UserRole | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
):
    """Cross-merchant Active Users view for the Admin Portal (API_CONTRACT.md §4.1)."""
    conditions = []
    if status is not None:
        conditions.append(User.status == status)
    if role is not None:
        conditions.append(User.role == role)
    if merchant_id is not None:
        conditions.append(User.merchant_id == merchant_id)
    if search:
        pattern = f"%{search}%"
        conditions.append(or_(User.full_name.ilike(pattern), User.email.ilike(pattern)))
    where = and_(*conditions) if conditions else True

    total = db.scalar(select(func.count()).select_from(User).where(where)) or 0
    stmt = (
        select(User)
        .where(where)
        .order_by(User.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.scalars(stmt).all()), total


def list_admins(db: Session, page: int, page_size: int, search: str | None = None):
    conditions = [User.role == UserRole.ADMIN]
    if search:
        pattern = f"%{search}%"
        conditions.append(or_(User.full_name.ilike(pattern), User.email.ilike(pattern)))
    where = and_(*conditions)

    total = db.scalar(select(func.count()).select_from(User).where(where)) or 0
    stmt = (
        select(User)
        .where(where)
        .order_by(User.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.scalars(stmt).all()), total


def get_admin(db: Session, user_id: int) -> User:
    """Fetch an Admin by id. 404 when missing or when the row is not an Admin."""
    admin = db.get(User, user_id)
    if not admin or admin.role is not UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Admin not found")
    return admin


def update_admin(
    db: Session, actor: User, user_id: int, full_name: str, email: str, phone: str | None
) -> User:
    admin = get_admin(db,user_id)
    _require_unique_email(db, email, exclude_user_id=user_id)
    admin.full_name = full_name
    admin.email = email
    admin.phone = phone
    db.commit()
    db.refresh(admin)
    activity_service.log_activity(
        db, actor.user_id, "Admin updated",
        activity_type="Account", module="Admin Management",
        description=f"{actor.full_name} updated admin {admin.email}",
        reference_id=admin.user_id,
    )
    return admin


def set_admin_status(db: Session, actor: User, user_id: int, new_status: UserStatus) -> User:
    admin = get_admin(db,user_id)
    if admin.user_id == actor.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot suspend your own account"
        )
    admin.status = new_status
    if new_status is not UserStatus.ACTIVE:
        # Suspending must end the session, not just block the next login.
        from app.services import session_service

        session_service.force_logout_all(db, admin.user_id)
        from app.services.auth_service import logout as revoke_tokens

        revoke_tokens(db, admin)
    db.commit()
    db.refresh(admin)
    activity_service.log_activity(
        db, actor.user_id, f"Admin {new_status.value}",
        activity_type="Account", module="Admin Management",
        description=f"{actor.full_name} set admin {admin.email} to {new_status.value}",
        reference_id=admin.user_id,
    )
    return admin


def reset_admin_password(db: Session, actor: User, user_id: int) -> tuple[User, str]:
    """Issue a new password for an admin. Returns it once, in the response."""
    admin = get_admin(db,user_id)
    temp_password = generate_temp_password()
    admin.password_hash = hash_password(temp_password)
    admin.reset_token_hash = None
    admin.reset_token_expires_at = None
    db.commit()

    from app.services.auth_service import logout as revoke_tokens

    revoke_tokens(db, admin)

    activity_service.log_activity(
        db, actor.user_id, "Admin password reset",
        activity_type="Account", module="Admin Management",
        description=f"{actor.full_name} reset the password for {admin.email}",
        reference_id=admin.user_id,
    )
    notification_service.create_notification(
        db, admin.user_id, "Your password was reset",
        "An administrator reset your password. You will need the new one to sign in.",
    )
    return admin, temp_password


def get_admin_permissions(db: Session, user_id: int) -> dict:
    """One admin's permission picture: role defaults, extra grants, union.

    See app/auth/rbac.py::effective_permissions — the source of truth this
    mirrors, not a separate calculation.
    """
    from app.auth.rbac import ROLE_PERMISSIONS, effective_permissions

    admin = get_admin(db, user_id)
    role_defaults = sorted(ROLE_PERMISSIONS.get(admin.role, frozenset()))
    return {
        "admin_id": admin.user_id,
        "role_defaults": role_defaults,
        "extra_grants": sorted(admin.permissions or []),
        "effective": sorted(effective_permissions(admin)),
    }


def set_admin_extra_permissions(
    db: Session, actor: User, user_id: int, extra_grants: list[str]
) -> dict:
    """Replace an admin's *extra* permission grants.

    Additive-only, matching the union model in rbac.py: this can give an
    admin a capability their role doesn't have by default, but cannot take
    away a role-default one (unknown codes are rejected rather than silently
    dropped, so a typo doesn't look like it worked).
    """
    from app.auth.rbac import ALL_PERMISSION_CODES

    admin = get_admin(db, user_id)
    unknown = sorted(set(extra_grants) - set(ALL_PERMISSION_CODES))
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown permission code(s): {', '.join(unknown)}",
        )
    admin.permissions = sorted(set(extra_grants))
    db.commit()
    activity_service.log_activity(
        db, actor.user_id, "Admin permissions updated",
        activity_type="Account", module="Role & Permission Management",
        description=f"{actor.full_name} set extra permissions for {admin.email}: "
                    f"{', '.join(admin.permissions) or '(none)'}",
        reference_id=admin.user_id,
    )
    return get_admin_permissions(db, user_id)


def delete_admin(db: Session, actor: User, user_id: int) -> None:
    admin = get_admin(db,user_id)
    if admin.user_id == actor.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delete your own account"
        )
    if _has_history(db, user_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "This admin has handled requests and cannot be deleted without "
                "orphaning that history — suspend the account instead."
            ),
        )
    email = admin.email
    db.delete(admin)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Related records still reference this admin — suspend instead.",
        )
    activity_service.log_activity(
        db, actor.user_id, "Admin deleted",
        activity_type="Account", module="Admin Management",
        description=f"{actor.full_name} deleted admin {email}",
    )


# ---------------------------------------------------------------------------
# Merchant -> its own staff
# ---------------------------------------------------------------------------
def create_merchant_user(
    db: Session,
    actor: User,
    merchant_id: int,
    full_name: str,
    email: str,
    phone: str | None,
    role: UserRole = UserRole.MERCHANT_USER,
    merchant_role: MerchantRole | None = None,
    password: str | None = None,
) -> tuple[User, str]:
    """Create a user under a merchant. The merchant is always the parent.

    ``merchant_id`` is taken from the caller's own account when the caller is
    a merchant, never from the request body — otherwise one merchant could
    create a user inside another merchant's company.
    """
    if role not in MERCHANT_ASSIGNABLE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A merchant can only create merchant_admin or merchant_user accounts",
        )
    _require_unique_email(db, email)

    temp_password = password or generate_temp_password()
    user = User(
        merchant_id=merchant_id,
        full_name=full_name,
        email=email,
        phone=phone,
        password_hash=hash_password(temp_password),
        role=role,
        merchant_role=merchant_role,
        permissions=[],
        profile={},
        status=UserStatus.ACTIVE,
        otp_enabled=True,
        email_verified=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    activity_service.log_activity(
        db, actor.user_id, "Merchant user created",
        activity_type="Account", module="Merchant Users",
        description=f"{actor.full_name} created {user.email} ({role.value})",
        reference_id=user.user_id, merchant_id=merchant_id,
    )
    notification_service.create_notification(
        db, user.user_id, "Your account is ready",
        "An account has been created for you on the JackPots merchant portal.",
    )
    return user, temp_password


def list_merchant_users(
    db: Session, merchant_id: int, page: int, page_size: int, search: str | None = None
):
    conditions = [User.merchant_id == merchant_id]
    if search:
        pattern = f"%{search}%"
        conditions.append(or_(User.full_name.ilike(pattern), User.email.ilike(pattern)))
    where = and_(*conditions)

    total = db.scalar(select(func.count()).select_from(User).where(where)) or 0
    stmt = (
        select(User)
        .where(where)
        .order_by(User.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.scalars(stmt).all()), total


def get_merchant_user(db: Session, merchant_id: int, user_id: int) -> User:
    user = db.get(User, user_id)
    # 404 rather than 403 when it belongs to another merchant — don't confirm
    # that the account exists.
    if not user or user.merchant_id != merchant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def update_merchant_user(
    db: Session,
    actor: User,
    merchant_id: int,
    user_id: int,
    full_name: str,
    phone: str | None,
    merchant_role: MerchantRole | None,
) -> User:
    user = get_merchant_user(db, merchant_id, user_id)
    user.full_name = full_name
    user.phone = phone
    user.merchant_role = merchant_role
    db.commit()
    db.refresh(user)
    activity_service.log_activity(
        db, actor.user_id, "Merchant user updated",
        activity_type="Account", module="Merchant Users",
        description=f"{actor.full_name} updated {user.email}",
        reference_id=user.user_id, merchant_id=merchant_id,
    )
    return user


def set_merchant_user_status(
    db: Session, actor: User, merchant_id: int, user_id: int, new_status: UserStatus
) -> User:
    user = get_merchant_user(db, merchant_id, user_id)
    if user.user_id == actor.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot suspend your own account"
        )
    user.status = new_status
    db.commit()
    if new_status is not UserStatus.ACTIVE:
        from app.services import session_service
        from app.services.auth_service import logout as revoke_tokens

        session_service.force_logout_all(db, user.user_id)
        revoke_tokens(db, user)
    db.refresh(user)
    activity_service.log_activity(
        db, actor.user_id, f"Merchant user {new_status.value}",
        activity_type="Account", module="Merchant Users",
        description=f"{actor.full_name} set {user.email} to {new_status.value}",
        reference_id=user.user_id, merchant_id=merchant_id,
    )
    return user


def reset_merchant_user_password(
    db: Session, actor: User, merchant_id: int, user_id: int
) -> tuple[User, str]:
    user = get_merchant_user(db, merchant_id, user_id)
    temp_password = generate_temp_password()
    user.password_hash = hash_password(temp_password)
    db.commit()
    from app.services.auth_service import logout as revoke_tokens

    revoke_tokens(db, user)
    activity_service.log_activity(
        db, actor.user_id, "Merchant user password reset",
        activity_type="Account", module="Merchant Users",
        description=f"{actor.full_name} reset the password for {user.email}",
        reference_id=user.user_id, merchant_id=merchant_id,
    )
    return user, temp_password
