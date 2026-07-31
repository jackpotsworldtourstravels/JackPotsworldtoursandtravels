"""Request-scoped auth dependencies for the v2 schema.

Roles are now an enum on ``users`` rather than a joined ``roles`` row, and
merchant staff are ordinary ``users`` rows with ``merchant_id`` set. The three
token scopes stay mutually exclusive:

* no ``scope`` claim  -> core user/admin token, accepted here
* ``scope='partner'`` -> Partner Portal, see ``app/auth/partner_deps.py``
* ``scope='super_admin'`` -> Super Admin Portal, see ``app/auth/super_admin_deps.py``
"""
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.auth.security import decode_token
from app.database.session import get_db
from app.models_v2 import User, UserRole, UserStatus
from app.services.auth_service import is_token_revoked

bearer_scheme = HTTPBearer()
optional_bearer_scheme = HTTPBearer(auto_error=False)

_ADMIN_ROLES = (UserRole.SUPER_ADMIN, UserRole.ADMIN)


def _credentials_error(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access" or payload.get("scope") is not None:
        raise _credentials_error("Invalid or expired token")
    user = db.get(User, int(payload["sub"]))
    if not user or user.status is not UserStatus.ACTIVE:
        raise _credentials_error("User not found or inactive")
    if is_token_revoked(user, payload):
        raise _credentials_error("Session ended — please log in again")
    return user


def get_current_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in _ADMIN_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required"
        )
    return current_user


def get_current_user_optional(
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_bearer_scheme),
    db: Session = Depends(get_db),
) -> User | None:
    """As ``get_current_user`` but returns None instead of raising.

    For public endpoints (catalog search) that still want to attribute the
    activity to a logged-in user when one is present.
    """
    if not credentials:
        return None
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access" or payload.get("scope") is not None:
        return None
    user = db.get(User, int(payload["sub"]))
    if not user or user.status is not UserStatus.ACTIVE:
        return None
    if is_token_revoked(user, payload):
        return None
    return user


def require_permission(code: str):
    """Dependency factory for a fine-grained permission check.

    Permissions moved from the ``permissions``/``role_permissions`` tables
    into ``users.permissions`` (a JSONB array of codes). A super admin
    implicitly holds every permission.
    """

    def _dependency(current_user: User = Depends(get_current_user)) -> User:
        if not current_user.has_permission(code):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing required permission: {code}",
            )
        return current_user

    return _dependency
