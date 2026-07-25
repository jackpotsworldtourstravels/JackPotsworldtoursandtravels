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


def generate_otp_code() -> str:
    """Cryptographically random 6-digit numeric OTP."""
    return f"{secrets.randbelow(1_000_000):06d}"


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
