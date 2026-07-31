import datetime

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.auth.target_schema.security import decode_token
from app.database.session import get_db
from app.models.target_schema.users import User

bearer_scheme = HTTPBearer()
optional_bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Single dependency for every portal — replaces get_current_user (core),
    get_current_partner_user (partner), and get_current_super_admin (JWT-only,
    no DB row) since all four actor types now live in one ts_users table.
    """
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user = db.get(User, int(payload["sub"]))
    if not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account not found or inactive")
    if user.force_logout_at is not None:
        issued_at = payload.get("iat")
        if issued_at is None or datetime.datetime.utcfromtimestamp(issued_at) < user.force_logout_at:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session ended — please log in again")
    return user


def get_current_user_optional(
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_bearer_scheme),
    db: Session = Depends(get_db),
) -> User | None:
    """Same as get_current_user but returns None instead of 401 for public
    endpoints (e.g. catalog search) that still want to attribute activity to
    a logged-in user when one is present.
    """
    if not credentials:
        return None
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access":
        return None
    user = db.get(User, int(payload["sub"]))
    if not user or user.status != "active":
        return None
    return user


def require_user_type(*allowed_types: str):
    """Dependency factory — replaces get_current_admin, get_current_partner_admin,
    and the get_current_super_admin scope check with one parameterized check
    against ts_users.user_type. Usage: Depends(require_user_type("admin")).
    """

    def _checker(current_user: User = Depends(get_current_user)) -> User:
        if current_user.user_type not in allowed_types:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have access to this resource")
        return current_user

    return _checker


get_current_admin = require_user_type("admin")
get_current_super_admin = require_user_type("super_admin")
get_current_merchant_staff = require_user_type("merchant_staff")


def require_merchant_role(*allowed_role_types: str):
    """Merchant-portal-specific check — replaces get_current_partner_admin's
    role_type == 'admin' check, generalized to any role_type value.
    """

    def _checker(current_user: User = Depends(get_current_merchant_staff)) -> User:
        if current_user.role_type not in allowed_role_types:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Merchant admin access required")
        return current_user

    return _checker


get_current_merchant_admin = require_merchant_role("admin")
