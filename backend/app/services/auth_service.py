"""Authentication against the v2 ``users`` table.

Column renames from the legacy schema:

===========================  ===================================
Legacy                       v2
===========================  ===================================
``users.id``                 ``users.user_id``
``users.hashed_password``    ``users.password_hash``
``users.mobile``             ``users.phone``
``users.role_id`` -> roles   ``users.role`` (enum)
``users.is_active``          ``users.status == 'active'``
``users.is_blocked``         ``users.status == 'blocked'``
``users.last_login_at``      ``users.last_login``
extended profile columns     ``users.profile`` (JSONB)
===========================  ===================================
"""
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
from app.models_v2 import User, UserRole, UserStatus

#: Keys accepted into ``users.profile``. Previously real columns on ``users``.
PROFILE_FIELDS = (
    "first_name",
    "last_name",
    "gender",
    "dob",
    "country",
    "state",
    "city",
    "address",
    "profile_photo",
)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == email))


def get_user_by_identifier(db: Session, identifier: str) -> User | None:
    """Look up by email or phone, for login forms that accept either."""
    return db.scalar(select(User).where(or_(User.email == identifier, User.phone == identifier)))


def signup(db: Session, full_name: str, email: str, password: str, **extended_fields) -> User:
    if get_user_by_email(db, email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered"
        )

    profile = {
        k: (v.isoformat() if isinstance(v, (datetime.date, datetime.datetime)) else v)
        for k, v in extended_fields.items()
        if k in PROFILE_FIELDS and v is not None
    }

    user = User(
        full_name=full_name,
        email=email,
        phone=extended_fields.get("mobile"),
        password_hash=hash_password(password),
        role=UserRole.CUSTOMER,
        permissions=[],
        profile=profile,
        status=UserStatus.ACTIVE,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def authenticate(
    db: Session, identifier: str, password: str, required_role: str | None = None
) -> User:
    """Authenticate by email or phone.

    ``required_role`` keeps the customer and admin sign-in surfaces separate.
    It accepts the legacy value ``"user"`` as an alias for the v2
    ``customer`` role so the existing /api/auth/user/login contract holds.
    """
    user = get_user_by_identifier(db, identifier)
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password"
        )

    if required_role is not None:
        wanted = UserRole.CUSTOMER if required_role in ("user", "customer") else UserRole(required_role)
        if user.role is not wanted:
            # Deliberately the same generic message as a wrong password — don't
            # reveal that the account exists but belongs to the other surface.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password"
            )

    if user.status is UserStatus.BLOCKED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is blocked. Please contact support.",
        )
    if user.status is not UserStatus.ACTIVE:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is disabled")
    return user


def record_login(db: Session, user: User) -> None:
    user.last_login = _now()
    user.login_count = (user.login_count or 0) + 1
    user.failed_login_attempts = 0
    db.commit()


def record_failed_login(db: Session, user: User | None) -> None:
    if user is None:
        return
    user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
    db.commit()


def issue_tokens(user: User) -> tuple[str, str]:
    return create_access_token(user.user_id), create_refresh_token(user.user_id)


def logout(db: Session, user: User) -> None:
    """Revoke outstanding tokens immediately.

    JWTs are stateless, so this moves ``force_logout_at`` forward and every
    dependency rejects tokens issued before it — the same mechanism behind
    the admin "force logout" action.
    """
    user.force_logout_at = _now()
    db.commit()


def is_token_revoked(user: User, payload: dict) -> bool:
    """True when ``force_logout_at`` postdates the token's ``iat``."""
    if user.force_logout_at is None:
        return False
    issued_at = payload.get("iat")
    if issued_at is None:
        return True
    issued = datetime.datetime.fromtimestamp(issued_at, tz=datetime.timezone.utc)
    forced = user.force_logout_at
    if forced.tzinfo is None:
        forced = forced.replace(tzinfo=datetime.timezone.utc)
    return issued < forced


def refresh_access_token(db: Session, refresh_token: str) -> tuple[str, str]:
    payload = decode_token(refresh_token)
    # The scope check is as load-bearing as the type check, and this endpoint is
    # the one place it was missing.
    #
    # get_current_user() refuses any token carrying a `scope` claim (deps.py), but
    # /api/auth/refresh is PUBLIC — the refresh token is itself the credential, so
    # no dependency runs and nothing else looked at the scope. Without this line a
    # CUSTOMER refresh token reached `db.get(User, sub)` below, and because
    # customers.customer_id and users.user_id are INDEPENDENT SEQUENCES, a customer
    # whose id happens to collide with an active users row was handed a full,
    # unscoped token pair for that unrelated merchant. The ids collide routinely;
    # this was found when the id landed on a real merchant admin.
    #
    # Unscoped (merchant/admin/manager) tokens are unaffected — they are what this
    # endpoint is for. Super Admin already fails below on its `-1` sentinel sub.
    if not payload or payload.get("type") != "refresh" or payload.get("scope") is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )
    user = db.get(User, int(payload["sub"]))
    if not user or user.status is not UserStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )
    if is_token_revoked(user, payload):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session ended — please log in again",
        )
    return issue_tokens(user)


def start_password_reset(db: Session, email: str) -> str | None:
    user = get_user_by_email(db, email)
    if not user:
        return None
    raw_token, hashed = generate_reset_token()
    user.reset_token_hash = hashed
    user.reset_token_expires_at = _now() + datetime.timedelta(
        minutes=settings.reset_token_expire_minutes
    )
    db.commit()
    return raw_token


def complete_password_reset(db: Session, raw_token: str, new_password: str) -> None:
    hashed = hash_reset_token(raw_token)
    user = db.scalar(select(User).where(User.reset_token_hash == hashed))
    expires = user.reset_token_expires_at if user else None
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=datetime.timezone.utc)
    if not user or expires is None or expires < _now():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Reset token is invalid or expired"
        )
    user.password_hash = hash_password(new_password)
    user.reset_token_hash = None
    user.reset_token_expires_at = None
    db.commit()
