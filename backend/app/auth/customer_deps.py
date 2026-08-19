"""Request-scoped auth dependency for the Customer Portal (V1).

The token scopes stay mutually exclusive, and each dependency is strict about
the one it wants:

* no ``scope`` claim        -> merchant / admin token, see ``app/auth/deps.py``
* ``scope='customer'``      -> accepted **here and nowhere else**
* ``scope='super_admin'``   -> Super Admin
* ``scope='customer_otp_challenge'`` -> mid-login, spendable only at verify-otp

A customer id and a user id are both small integers drawn from independent
sequences, so ``customers.customer_id = 4`` and ``users.user_id = 4`` will
routinely both exist. The scope claim, not the subject, is what keeps a token
for one from resolving as the other — which is why this module never widens
its check to "any valid token whose sub happens to name a customer".

There is no ``require_permission`` here and there must not be. Permissions are
a merchant-side concept (staff who may do different things); a customer acts
only for themselves, so the only question this file can answer is "is this the
signed-in customer, and are they still allowed in".
"""
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.auth.security import CUSTOMER_SCOPE, decode_token
from app.database.session import get_db
from app.models_customer import Customer, CustomerStatus
from app.services.customer_auth_service import is_token_revoked

customer_bearer_scheme = HTTPBearer()
optional_customer_bearer_scheme = HTTPBearer(auto_error=False)


def _credentials_error(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def _resolve(token: str, db: Session) -> Customer:
    payload = decode_token(token)
    # `is not CUSTOMER_SCOPE` would be an identity test on a str and would pass
    # or fail on interning; the equality check is deliberate.
    if not payload or payload.get("type") != "access" or payload.get("scope") != CUSTOMER_SCOPE:
        raise _credentials_error("Invalid or expired token")

    try:
        customer_id = int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        raise _credentials_error("Invalid or expired token")

    customer = db.get(Customer, customer_id)
    if not customer:
        raise _credentials_error("Account not found or inactive")

    if customer.status is CustomerStatus.BLOCKED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is blocked. Please contact support.",
        )
    if customer.status is not CustomerStatus.ACTIVE:
        raise _credentials_error("Account not found or inactive")

    if is_token_revoked(customer, payload):
        raise _credentials_error("Session ended — please log in again")
    return customer


def get_current_customer(
    credentials: HTTPAuthorizationCredentials = Depends(customer_bearer_scheme),
    db: Session = Depends(get_db),
) -> Customer:
    return _resolve(credentials.credentials, db)


def get_current_customer_optional(
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_customer_bearer_scheme),
    db: Session = Depends(get_db),
) -> Customer | None:
    """As above but returns None instead of raising.

    For the public surfaces the portal will grow (flight search, fare quotes)
    that work signed out but personalise when a session is present.
    """
    if not credentials:
        return None
    try:
        return _resolve(credentials.credentials, db)
    except HTTPException:
        return None
