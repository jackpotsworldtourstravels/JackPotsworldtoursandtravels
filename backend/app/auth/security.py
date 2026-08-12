import datetime
import hashlib
import secrets

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def _create_token(subject: str, expires_delta: datetime.timedelta, token_type: str, extra_claims: dict | None = None) -> str:
    now = datetime.datetime.utcnow()
    payload = {"sub": subject, "type": token_type, "iat": now, "exp": now + expires_delta}
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: int) -> str:
    delta = datetime.timedelta(minutes=settings.access_token_expire_minutes)
    return _create_token(str(user_id), delta, "access")


def create_refresh_token(user_id: int) -> str:
    delta = datetime.timedelta(days=settings.refresh_token_expire_days)
    return _create_token(str(user_id), delta, "refresh")


# Partner Portal tokens carry an extra `scope: "partner"` claim so they can
# never be mistaken for a core `users` token (or vice versa) even if a
# partner_user_id happens to numerically match a users.id — get_current_user
# rejects any token with this claim, and get_current_partner_user requires it.
def create_partner_access_token(partner_user_id: int) -> str:
    delta = datetime.timedelta(minutes=settings.access_token_expire_minutes)
    return _create_token(str(partner_user_id), delta, "access", extra_claims={"scope": "partner"})


def create_partner_refresh_token(partner_user_id: int) -> str:
    delta = datetime.timedelta(days=settings.refresh_token_expire_days)
    return _create_token(str(partner_user_id), delta, "refresh", extra_claims={"scope": "partner"})


# Customer Portal (V1) tokens carry `scope: "customer"`, and that single claim
# is the whole of the cross-login guarantee, in both directions:
#
#   * get_current_user (app/auth/deps.py) rejects ANY token with a scope claim,
#     so a customer token is refused by all 176 merchant/admin endpoints —
#     including ones written after this, with no change needed there.
#   * get_current_customer (app/auth/customer_deps.py) REQUIRES scope ==
#     "customer", so a merchant or admin token is refused by the customer API.
#
# The two subject spaces overlap — customers.customer_id 5 and users.user_id 5
# both exist — which is exactly why the scope, not the id, is what separates
# them. Same reasoning as the `partner` scope this replaces.
CUSTOMER_SCOPE = "customer"


def create_customer_access_token(customer_id: int) -> str:
    delta = datetime.timedelta(minutes=settings.access_token_expire_minutes)
    return _create_token(str(customer_id), delta, "access", extra_claims={"scope": CUSTOMER_SCOPE})


def create_customer_refresh_token(customer_id: int) -> str:
    delta = datetime.timedelta(days=settings.refresh_token_expire_days)
    return _create_token(str(customer_id), delta, "refresh", extra_claims={"scope": CUSTOMER_SCOPE})


#: The customer login is password -> OTP -> dashboard, same as the three B2B
#: portals. Between the steps the caller holds this instead of a session. It is
#: scoped `customer_otp_challenge`, so it is neither a customer session token
#: nor spendable at the merchant side's /api/auth/verify-otp.
CUSTOMER_OTP_CHALLENGE_SCOPE = "customer_otp_challenge"


def create_customer_otp_challenge_token(customer_id: int) -> str:
    delta = datetime.timedelta(minutes=OTP_CHALLENGE_TTL_MINUTES)
    return _create_token(
        str(customer_id), delta, "challenge",
        extra_claims={"scope": CUSTOMER_OTP_CHALLENGE_SCOPE},
    )


def decode_customer_otp_challenge_token(token: str) -> int | None:
    """Returns the customer id a challenge token refers to, or None."""
    payload = decode_token(token)
    if not payload or payload.get("type") != "challenge":
        return None
    if payload.get("scope") != CUSTOMER_OTP_CHALLENGE_SCOPE:
        return None
    try:
        return int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        return None


SUPER_ADMIN_SENTINEL_SUB = "-1"  # never a real users.id / partner_user_id — see super_admin_deps.py


def create_super_admin_access_token(username: str, full_name: str) -> str:
    # `sub` is a fixed numeric sentinel, not the username — every OTHER auth
    # dependency in this app does `int(payload["sub"])` and looks the row up
    # by numeric ID (see app/auth/deps.py, app/auth/partner_deps.py). If a
    # super-admin token were ever presented to one of those by mistake, a
    # non-numeric `sub` would raise an unhandled ValueError instead of a
    # clean 401. "-1" casts fine and can never match a real row.
    delta = datetime.timedelta(minutes=settings.access_token_expire_minutes)
    return _create_token(
        SUPER_ADMIN_SENTINEL_SUB, delta, "access",
        extra_claims={"scope": "super_admin", "username": username, "full_name": full_name},
    )


def create_super_admin_refresh_token(username: str) -> str:
    delta = datetime.timedelta(days=settings.refresh_token_expire_days)
    return _create_token(
        SUPER_ADMIN_SENTINEL_SUB, delta, "refresh", extra_claims={"scope": "super_admin", "username": username}
    )


def generate_otp_code() -> str:
    """Cryptographically random 6-digit numeric OTP."""
    return f"{secrets.randbelow(1_000_000):06d}"


# The spec's login is password -> OTP -> dashboard. Between those two steps
# the caller has proved the password but is not yet authenticated, so it
# carries a short-lived challenge token instead of a session. Signed with the
# same secret and marked `scope: "otp_challenge"`, so it is rejected by every
# other dependency — it can only be spent at /api/auth/verify-otp.
OTP_CHALLENGE_SCOPE = "otp_challenge"
OTP_CHALLENGE_TTL_MINUTES = 10


def create_otp_challenge_token(user_id: int) -> str:
    delta = datetime.timedelta(minutes=OTP_CHALLENGE_TTL_MINUTES)
    return _create_token(str(user_id), delta, "challenge", extra_claims={"scope": OTP_CHALLENGE_SCOPE})


def decode_otp_challenge_token(token: str) -> int | None:
    """Returns the user id a challenge token refers to, or None if invalid."""
    payload = decode_token(token)
    if not payload or payload.get("type") != "challenge":
        return None
    if payload.get("scope") != OTP_CHALLENGE_SCOPE:
        return None
    try:
        return int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        return None


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None


def generate_reset_token() -> tuple[str, str]:
    """Returns (raw_token_for_user, hashed_token_for_storage)."""
    raw_token = secrets.token_urlsafe(32)
    hashed = hashlib.sha256(raw_token.encode()).hexdigest()
    return raw_token, hashed


def hash_reset_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode()).hexdigest()
