"""Request/response shapes for 'Continue with Google'.

The browser only ever sends the raw Google credential (an ID token) or, for a
brand-new user finishing sign-up, the signed pending token plus a mobile. It
NEVER sends an email or a Google subject for us to trust — those come only from
the verified token on the server.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.schemas.customer import CustomerResponse


class GoogleConfigResponse(BaseModel):
    """Public config the button needs. The client id is public by design."""
    enabled: bool
    client_id: Optional[str] = None


class GoogleLoginRequest(BaseModel):
    #: The ID token from Google Identity Services. Verified server-side.
    credential: str = Field(min_length=1)


class GoogleCompleteSignupRequest(BaseModel):
    #: The short-lived token minted by /google when the user was new.
    pending_token: str = Field(min_length=1)
    #: The one field Google does not provide; required by the customer model.
    mobile: str = Field(min_length=3, max_length=30)
    full_name: Optional[str] = Field(default=None, max_length=150)


class GoogleAuthResponse(BaseModel):
    """Either an authenticated session, or a request to finish sign-up.

    ``status == "authenticated"``: access/refresh/customer are set and behave
    exactly like the OTP verify response.
    ``status == "needs_signup"``: pending_token + prefill are set; the customer
    supplies a mobile and calls /google/complete.
    """
    status: Literal["authenticated", "needs_signup"]
    # authenticated
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    token_type: str = "bearer"
    customer: Optional[CustomerResponse] = None
    linked: bool = False
    # needs_signup
    pending_token: Optional[str] = None
    prefill: Optional[dict] = None
