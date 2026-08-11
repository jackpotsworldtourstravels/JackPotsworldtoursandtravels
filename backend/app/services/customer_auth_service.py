"""Authentication for the Customer Portal (V1).

Mirrors the shape of ``auth_service`` — same password hashing, same JWT
helpers, same ``force_logout_at`` revocation trick — but every read and write
lands in a ``customer_*`` table. Nothing in this module imports
``app.models_v2``, and ``tests/verify_customer_portal.py`` asserts that, because
one convenient `from app.models_v2 import User` is all it would take for the
two identity systems to start leaking into each other.

WHY THE PASSWORD RULES ARE THE MERCHANT SIDE'S RULES EXACTLY
bcrypt truncates silently past 72 bytes, so the max is a correctness bound
rather than a policy choice, and the min matches ``ResetPasswordRequest`` on
the B2B side. Diverging here would mean "the existing authentication standards"
had two meanings.
"""
import datetime
import logging

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.security import (
    create_customer_access_token,
    create_customer_refresh_token,
    decode_token,
    generate_reset_token,
    hash_password,
    hash_reset_token,
    verify_password,
)
from app.config import settings
from app.models_customer import (
    Customer,
    CustomerAuth,
    CustomerPasswordReset,
    CustomerProfile,
    CustomerStatus,
)

logger = logging.getLogger("jackpots.customer.auth")

#: Same generic text for "no such account" and "wrong password". Telling the
#: two apart turns the login form into an account-existence oracle.
_BAD_CREDENTIALS = "Invalid credentials — check your email/mobile and password"


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _aware(value: datetime.datetime | None) -> datetime.datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=datetime.timezone.utc)


def normalise_email(email: str) -> str:
    """Lowercased and trimmed, matching ``uq_customers_email_lower``."""
    return (email or "").strip().lower()


def normalise_mobile(mobile: str) -> str:
    """Trimmed, with spaces and dashes removed.

    Not reformatted beyond that: ``uq_customers_mobile`` is a plain unique
    index, so "+91 98765 43210" and "+919876543210" must not both be storable.
    Stripping the separators is what makes that one value. The country code is
    left alone — deciding a default country here would silently rewrite a
    number somebody typed correctly.
    """
    return (mobile or "").strip().replace(" ", "").replace("-", "")


def next_customer_code(db: Session) -> str:
    """``CUS-000001``, from ``seq_customer_code``.

    ``nextval`` is non-transactional on purpose, exactly as in
    ``provider_service.next_provider_code``: a rolled-back signup leaves a gap
    in the series rather than handing CUS-000007 to two people. Six digits is
    presentation only — past 999999 it grows to CUS-1000000 rather than wrapping.
    """
    seq = db.scalar(select(func.nextval("seq_customer_code")))
    return f"CUS-{int(seq):06d}"


def get_by_email(db: Session, email: str) -> Customer | None:
    return db.scalar(select(Customer).where(func.lower(Customer.email) == normalise_email(email)))


def get_by_mobile(db: Session, mobile: str) -> Customer | None:
    return db.scalar(select(Customer).where(Customer.mobile == normalise_mobile(mobile)))


def get_by_identifier(db: Session, identifier: str) -> Customer | None:
    """Look up by email **or** mobile — the login form accepts either."""
    raw = (identifier or "").strip()
    return db.scalar(
        select(Customer).where(
            or_(
                func.lower(Customer.email) == raw.lower(),
                Customer.mobile == normalise_mobile(raw),
            )
        )
    )


def signup(
    db: Session,
    *,
    full_name: str,
    email: str,
    mobile: str,
    password: str,
    date_of_birth: datetime.date | None = None,
) -> Customer:
    """Register a customer. Creates identity, credentials and profile together.

    The three rows are one unit of work: a ``customers`` row with no
    ``customer_auth`` row is an account nobody can ever sign in to, and it
    would still hold the email address against a retry.
    """
    email = normalise_email(email)
    mobile = normalise_mobile(mobile)

    # Checked here for a readable message, and again by the unique indexes
    # below for correctness — two simultaneous signups both pass this check.
    if get_by_email(db, email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An account with this email address already exists",
        )
    if get_by_mobile(db, mobile):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An account with this mobile number already exists",
        )

    customer = Customer(
        customer_code=next_customer_code(db),
        full_name=full_name.strip(),
        email=email,
        mobile=mobile,
        date_of_birth=date_of_birth,
        status=CustomerStatus.ACTIVE,
    )
    customer.auth = CustomerAuth(password_hash=hash_password(password))
    customer.profile = CustomerProfile()
    db.add(customer)

    try:
        db.commit()
    except IntegrityError:
        # The race the check above cannot close. Rolled back and reported as
        # the same 400 the sequential case gives, so the caller sees one
        # behaviour rather than a 500 that depends on timing.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An account with this email address or mobile number already exists",
        )

    db.refresh(customer)
    return customer


def authenticate(db: Session, identifier: str, password: str) -> Customer:
    """Verify email-or-mobile plus password. Raises 401/403, never returns None."""
    customer = get_by_identifier(db, identifier)
    if customer is None or customer.auth is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_BAD_CREDENTIALS)

    if not verify_password(password, customer.auth.password_hash):
        record_failed_login(db, customer)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_BAD_CREDENTIALS)

    if customer.status is CustomerStatus.BLOCKED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is blocked. Please contact support.",
        )
    if customer.status is not CustomerStatus.ACTIVE:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is disabled")
    return customer


def record_login(db: Session, customer: Customer) -> None:
    auth = customer.auth
    if auth is None:
        return
    auth.last_login = _now()
    auth.login_count = (auth.login_count or 0) + 1
    auth.failed_login_attempts = 0
    db.commit()


def record_failed_login(db: Session, customer: Customer | None) -> None:
    if customer is None or customer.auth is None:
        return
    customer.auth.failed_login_attempts = (customer.auth.failed_login_attempts or 0) + 1
    db.commit()


def issue_tokens(customer: Customer) -> tuple[str, str]:
    """An access/refresh pair carrying ``scope: "customer"``.

    That claim is what every merchant and admin endpoint refuses — see
    ``app/auth/security.py``'s note on CUSTOMER_SCOPE.
    """
    return (
        create_customer_access_token(customer.customer_id),
        create_customer_refresh_token(customer.customer_id),
    )


def logout(db: Session, customer: Customer) -> None:
    """Revoke every outstanding token for this customer immediately."""
    if customer.auth is None:
        return
    customer.auth.force_logout_at = _now()
    db.commit()


def is_token_revoked(customer: Customer, payload: dict) -> bool:
    """True when ``force_logout_at`` postdates the token's ``iat``."""
    auth = customer.auth
    if auth is None or auth.force_logout_at is None:
        return False
    issued_at = payload.get("iat")
    if issued_at is None:
        return True
    issued = datetime.datetime.fromtimestamp(issued_at, tz=datetime.timezone.utc)
    return issued < _aware(auth.force_logout_at)


def refresh_access_token(db: Session, refresh_token: str) -> tuple[str, str]:
    from app.auth.security import CUSTOMER_SCOPE

    payload = decode_token(refresh_token)
    # The scope check matters as much as the type check: without it a merchant
    # refresh token would mint a customer session for whichever customer_id
    # happens to match that user_id.
    if (
        not payload
        or payload.get("type") != "refresh"
        or payload.get("scope") != CUSTOMER_SCOPE
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )

    customer = db.get(Customer, int(payload["sub"]))
    if not customer or customer.status is not CustomerStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )
    if is_token_revoked(customer, payload):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session ended — please log in again",
        )
    return issue_tokens(customer)


def change_password(
    db: Session, customer: Customer, current_password: str, new_password: str
) -> None:
    if customer.auth is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Account has no password set"
        )
    if not verify_password(current_password, customer.auth.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect"
        )
    customer.auth.password_hash = hash_password(new_password)
    customer.auth.password_changed_at = _now()
    db.commit()


def start_password_reset(db: Session, email: str, ip_address: str | None = None) -> str | None:
    """Issue a reset token, or None when no such account exists.

    The caller must return the same message either way — see the router.
    """
    customer = get_by_email(db, email)
    if not customer:
        return None

    raw_token, hashed = generate_reset_token()
    db.add(
        CustomerPasswordReset(
            customer_id=customer.customer_id,
            token_hash=hashed,
            expires_at=_now() + datetime.timedelta(minutes=settings.reset_token_expire_minutes),
            requested_ip=ip_address,
        )
    )
    db.commit()
    return raw_token


def complete_password_reset(db: Session, raw_token: str, new_password: str) -> Customer:
    hashed = hash_reset_token(raw_token)
    reset = db.scalar(
        select(CustomerPasswordReset).where(CustomerPasswordReset.token_hash == hashed)
    )

    # One message for "no such token", "already spent" and "expired". They are
    # different facts, and telling them apart would let someone with a captured
    # link learn whether it had been used.
    invalid = HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST, detail="Reset link is invalid or has expired"
    )
    if reset is None or reset.used_at is not None:
        raise invalid
    if _aware(reset.expires_at) < _now():
        raise invalid

    customer = db.get(Customer, reset.customer_id)
    if customer is None or customer.auth is None:
        raise invalid

    customer.auth.password_hash = hash_password(new_password)
    customer.auth.password_changed_at = _now()
    # Spend the token, and sign every existing session out: a password reset is
    # the one moment where "somebody else may be holding a live token for this
    # account" is the most likely reason it is happening.
    reset.used_at = _now()
    customer.auth.force_logout_at = _now()
    db.commit()
    return customer
