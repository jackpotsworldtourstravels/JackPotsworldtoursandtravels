from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.security import decode_token

super_admin_bearer_scheme = HTTPBearer()


class CurrentSuperAdmin:
    """Lightweight identity built from JWT claims only — there is no
    `super_admins` table yet, so unlike get_current_partner_user this does
    NOT do a database lookup.

    # TODO: Once a real `super_admins` table exists, change this dependency
    # to look the row up by ID (mirroring app/auth/partner_deps.py's
    # get_current_partner_user) so a deactivated/deleted super admin's
    # existing token stops working immediately instead of staying valid
    # until it naturally expires.
    """

    def __init__(self, username: str, full_name: str):
        self.username = username
        self.full_name = full_name


def get_current_super_admin(
    credentials: HTTPAuthorizationCredentials = Depends(super_admin_bearer_scheme),
) -> CurrentSuperAdmin:
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access" or payload.get("scope") != "super_admin":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    return CurrentSuperAdmin(username=payload.get("username", ""), full_name=payload.get("full_name", ""))
