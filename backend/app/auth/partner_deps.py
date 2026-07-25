from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.auth.security import decode_token
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.models.user import Role

partner_bearer_scheme = HTTPBearer()


def get_current_partner_user(
    credentials: HTTPAuthorizationCredentials = Depends(partner_bearer_scheme),
    db: Session = Depends(get_db),
) -> PartnerUser:
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access" or payload.get("scope") != "partner":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    partner_user = db.get(PartnerUser, int(payload["sub"]))
    if not partner_user or partner_user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account not found or inactive")
    return partner_user


def get_current_partner_admin(
    current: PartnerUser = Depends(get_current_partner_user),
    db: Session = Depends(get_db),
) -> PartnerUser:
    role = db.get(Role, current.role_id)
    if not role or role.name != "partner_admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Partner admin access required")
    return current
