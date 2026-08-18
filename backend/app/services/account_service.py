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
    HotelEnquiry,
    MerchantRole,
    RequestType,
    ServiceRequest,
    User,
    UserRole,
    UserStatus,
)
from app.services import activity_service, notification_service, session_service

#: Roles a merchant may assign to its own staff.
MERCHANT_ASSIGNABLE_ROLES = (UserRole.MERCHANT_ADMIN, UserRole.MERCHANT_USER)

#: Platform staff accounts the Super Admin's Admin Management screen owns.
#: Manager joined the list with CR-2 — a role nobody can create is a role that
#: does not exist, and the Super Admin is already the account authority for
#: every non-merchant login. Super Admin itself is absent on purpose: it is
#: seeded, not created through the API.
STAFF_MANAGED_ROLES = (UserRole.ADMIN, UserRole.MANAGER)


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
    # A deleted user no longer holds its email — see the partial unique
    # index on users.email (ux_users_email_not_deleted) that enforces the
    # same rule at the database level.
    existing = db.scalar(
        select(User).where(User.email == email, User.status != UserStatus.DELETED)
    )
    if existing and existing.user_id != exclude_user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered"
        )


def _has_history(db: Session, user_id: int) -> bool:
    """True when deleting this user would orphan real activity.

    Hotel Enquiry lives in its own table (``hotel_enquiries``), not
    ``service_requests`` — a user who has only ever raised hotel enquiries
    would otherwise look history-free and be hard-deleted, silently
    detaching those enquiries from the person who raised them.
    """
    if (
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
    ):
        return True
    return (
        db.scalar(
            select(HotelEnquiry.id).where(HotelEnquiry.user_id == user_id).limit(1)
        )
        is not None
    )


# ---------------------------------------------------------------------------
# Super Admin -> Admin
# ---------------------------------------------------------------------------
def create_admin(
    db: Session, actor: User, full_name: str, email: str, phone: str | None,
    password: str | None = None, role: UserRole = UserRole.ADMIN,
) -> tuple[User, str]:
    """Create a platform staff account. Returns the row and its first password.

    ``role`` is Admin unless a Manager is asked for; anything else is refused
    here rather than trusted from the request body, so a crafted payload cannot
    mint a Super Admin through the admin-creation endpoint.
    """
    if role not in STAFF_MANAGED_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "A staff account may be created as "
                + " or ".join(r.value for r in STAFF_MANAGED_ROLES)
            ),
        )
    _require_unique_email(db, email)
    temp_password = password or generate_temp_password()

    admin = User(
        full_name=full_name,
        email=email,
        phone=phone,
        password_hash=hash_password(temp_password),
        role=role,
        permissions=[],
        profile={},
        status=UserStatus.ACTIVE,
        otp_enabled=True,
        email_verified=True,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)

    label = "manager" if role is UserRole.MANAGER else "admin"
    activity_service.log_activity(
        db, actor.user_id, f"{label.capitalize()} created",
        activity_type="Account", module="Admin Management",
        description=f"{actor.full_name} created {label} {admin.email}",
        reference_id=admin.user_id,
    )
    notification_service.create_notification(
        db, admin.user_id,
        f"Your {'manager' if role is UserRole.MANAGER else 'administrator'} account is ready",
        "An account has been created for you on the JackPots admin console."
        if role is UserRole.ADMIN else
        "An account has been created for you on the JackPots manager console. "
        "Booking Requests awaiting your approval appear there.",
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
    presence: str | None = None,
):
    """Cross-merchant Active Users view for the Admin Portal (API_CONTRACT.md §4.1).

    ``presence`` narrows by login state — ``online`` / ``offline`` /
    ``never_logged_in``. It is applied **in SQL**, not to the page after it has
    been fetched: presence is a property of the whole table, so filtering the
    twenty rows a page happens to contain would return a short page under a
    total that counted everyone.

    ``offline`` means "has signed in before, but has no live session now", which
    includes the *Recently Active* shade the row badge distinguishes. The screen
    offers three states and the badge four, deliberately: an admin filtering for
    who is not around wants everyone who is not around.
    """
    conditions = []
    if status is not None:
        conditions.append(User.status == status)
    else:
        # A deleted account is gone as far as this screen is concerned; an
        # explicit status filter can still ask for it directly.
        conditions.append(User.status != UserStatus.DELETED)
    if role is not None:
        conditions.append(User.role == role)
    if merchant_id is not None:
        conditions.append(User.merchant_id == merchant_id)
    if search:
        pattern = f"%{search}%"
        conditions.append(or_(User.full_name.ilike(pattern), User.email.ilike(pattern)))
    if presence == session_service.PRESENCE_NEVER:
        conditions.append(User.last_login.is_(None))
    elif presence == session_service.PRESENCE_ONLINE:
        conditions.append(User.user_id.in_(session_service.online_user_ids_stmt()))
    elif presence == session_service.PRESENCE_OFFLINE:
        conditions.append(User.last_login.is_not(None))
        conditions.append(User.user_id.not_in(session_service.online_user_ids_stmt()))
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


def list_admins(
    db: Session, page: int, page_size: int, search: str | None = None,
    role: UserRole | None = None,
):
    """Platform staff accounts — Admins and Managers, newest first.

    Managers are listed alongside Admins rather than on a screen of their own:
    they are the same kind of thing to the Super Admin (a staff login it
    created and can suspend), and a separate screen would have been the same
    table twice. ``role`` narrows it when the caller wants only one.
    """
    conditions = [
        User.role == role if role is not None else User.role.in_(STAFF_MANAGED_ROLES)
    ]
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
    """Fetch a staff account by id. 404 when missing or not staff-managed.

    Covers Managers as well as Admins, so every screen that already edits,
    suspends, resets or deletes an administrator does the same for a Manager
    without a second copy of each rule.
    """
    admin = db.get(User, user_id)
    if not admin or admin.role not in STAFF_MANAGED_ROLES:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Admin not found")
    return admin


def _assert_manager_holds_no_claims(db: Session, admin: User) -> None:
    """Refuse to move a Manager off the role while it is mid-review.

    A Manager claims a booking by taking it to Under Manager Review, and only
    the holder may decide it. Converting that account to an Admin would leave
    the claim standing while its holder no longer has the permission to act on
    it — a booking stuck In Review that nobody can approve or return.

    Refused rather than silently released: releasing would rewrite booking
    status as a side effect of an account edit, which is exactly the kind of
    hidden state change the lifecycle rules exist to prevent. The Super Admin is
    told which bookings to have decided first.
    """
    from app.models_v2 import RequestStatus, ServiceRequest

    held = db.scalars(
        select(ServiceRequest.request_number).where(
            and_(
                ServiceRequest.status == RequestStatus.IN_REVIEW,
                ServiceRequest.travel_details["manager_claimed_by"].astext
                == str(admin.user_id),
            )
        ).limit(6)
    ).all()
    if held:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{admin.full_name} is still reviewing {', '.join(held)}. "
                "Those booking requests must be approved or returned before this "
                "account can stop being a Manager."
            ),
        )


def update_admin(
    db: Session, actor: User, user_id: int, full_name: str, email: str, phone: str | None,
    role: UserRole | None = None,
) -> User:
    """Edit a staff account. ``role`` may move it between Admin and Manager.

    ``role=None`` leaves it alone, so every caller written before CR-2 keeps
    working and an edit that only changes a phone number cannot reclassify
    anybody by omission.
    """
    admin = get_admin(db,user_id)
    _require_unique_email(db, email, exclude_user_id=user_id)

    previous_role = admin.role
    if role is not None and role is not previous_role:
        if role not in STAFF_MANAGED_ROLES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "A staff account may be "
                    + " or ".join(r.value for r in STAFF_MANAGED_ROLES)
                ),
            )
        if admin.user_id == actor.user_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You cannot change your own role",
            )
        if previous_role is UserRole.MANAGER:
            _assert_manager_holds_no_claims(db, admin)
        admin.role = role

    admin.full_name = full_name
    admin.email = email
    admin.phone = phone
    db.commit()
    db.refresh(admin)

    changed_role = role is not None and role is not previous_role
    activity_service.log_activity(
        db, actor.user_id, "Admin updated",
        activity_type="Account", module="Admin Management",
        description=(
            f"{actor.full_name} updated {admin.role.value} {admin.email}"
            + (f" (role changed from {previous_role.value})" if changed_role else "")
        ),
        reference_id=admin.user_id,
    )
    if changed_role:
        # The permission set changes underneath them; an open session would keep
        # the old one until its token expired.
        from app.services import session_service
        from app.services.auth_service import logout as revoke_tokens

        session_service.force_logout_all(db, admin.user_id)
        revoke_tokens(db, admin)
        db.commit()
        notification_service.create_notification(
            db, admin.user_id, "Your role has changed",
            f"Your account is now a {admin.role.value.replace('_', ' ')}. "
            "Please sign in again.",
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
    # A deleted user is gone as far as this table/search is concerned, unlike
    # suspended/inactive which stay visible with a status badge.
    conditions = [User.merchant_id == merchant_id, User.status != UserStatus.DELETED]
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


def delete_merchant_user(db: Session, actor: User, merchant_id: int, user_id: int) -> None:
    """Soft-delete one merchant user.

    Always a status flip, never a row delete: a hard delete would ``SET
    NULL`` the FK on every historical booking/enquiry the user raised,
    which erases "who did this" from the audit trail even though the
    request row itself survives. Soft delete keeps that attribution intact.
    The email is freed for reuse by the partial unique index on
    ``users.email`` (``ux_users_email_not_deleted``), not by this function —
    a deleted row keeps its real email. Only this one user is touched — the
    merchant account and every other user are left alone.
    """
    user = get_merchant_user(db, merchant_id, user_id)
    if user.user_id == actor.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delete your own account"
        )

    from app.services import session_service
    from app.services.auth_service import logout as revoke_tokens

    email = user.email
    user.status = UserStatus.DELETED
    db.commit()
    session_service.force_logout_all(db, user.user_id)
    revoke_tokens(db, user)

    activity_service.log_activity(
        db, actor.user_id, "Merchant user deleted",
        activity_type="Account", module="Merchant Users",
        description=f"{actor.full_name} deleted {email}",
        merchant_id=merchant_id,
    )


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
