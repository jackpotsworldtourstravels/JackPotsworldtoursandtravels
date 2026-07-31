import datetime

from jose import JWTError, jwt

from app.config import settings
# Pure crypto/JWT utilities have zero dependency on which table a user lives
# in — reused as-is rather than duplicated. Only token *claim shape* changes
# below (a single user_type claim replaces the old scope/sentinel-sub tricks
# that existed to fake three separate identity tables sharing one JWT format).
from app.auth.security import (  # noqa: F401
    generate_otp_code,
    generate_reset_token,
    hash_password,
    hash_reset_token,
    verify_password,
)
from app.models.target_schema.users import User


def _create_token(user: User, expires_delta: datetime.timedelta, token_type: str) -> str:
    now = datetime.datetime.utcnow()
    payload = {
        "sub": str(user.id),
        "type": token_type,
        "user_type": user.user_type,
        "iat": now,
        "exp": now + expires_delta,
    }
    if user.user_type == "merchant_staff":
        payload["merchant_id"] = user.merchant_id
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_access_token(user: User) -> str:
    return _create_token(user, datetime.timedelta(minutes=settings.access_token_expire_minutes), "access")


def create_refresh_token(user: User) -> str:
    return _create_token(user, datetime.timedelta(days=settings.refresh_token_expire_days), "refresh")


def issue_tokens(user: User) -> tuple[str, str]:
    return create_access_token(user), create_refresh_token(user)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
