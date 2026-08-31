"""Customer Portal (V1) authentication — ``/api/customer/auth/*``.

The login is the same two-call flow the three B2B portals use::

    Signup / Login -> Password -> OTP -> Dashboard

1. ``POST /login`` verifies email-or-mobile plus password, issues an OTP and
   returns a short-lived challenge token. No session yet.
2. ``POST /verify-otp`` spends the challenge token plus the code and returns
   the access/refresh pair.

WHY THIS IS A SEPARATE ROUTER AND NOT A FOURTH ``portal`` VALUE
``/api/auth/login`` takes ``portal`` and looks the account up in ``users``.
Adding ``"customer"`` there would have meant one endpoint reading two identity
tables and deciding which by a request field — the single place where a bug
lets a merchant account answer a customer login. Two routers over two tables
cannot make that mistake: this file never imports ``models_v2``, and the
tokens it mints are refused by every endpoint in the other one.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.auth.rate_limit import limiter
from app.auth.security import (
    create_customer_otp_challenge_token,
    decode_customer_otp_challenge_token,
)
from app.config import settings
from app.database.session import get_db
from app.models_customer import Customer, CustomerOtpPurpose, CustomerStatus
from app.schemas.customer import (
    CustomerChangePasswordRequest,
    CustomerForgotPasswordRequest,
    CustomerLoginChallengeResponse,
    CustomerLoginRequest,
    CustomerMessageResponse,
    CustomerRefreshRequest,
    CustomerResendOtpRequest,
    CustomerResetPasswordRequest,
    CustomerResponse,
    CustomerSignupRequest,
    CustomerTokenResponse,
    CustomerVerifyOtpRequest,
)
from app.services import (
    activity_service,
    customer_audit_service,
    customer_auth_service,
    customer_otp_service,
    customer_session_service,
    email_service,
)

router = APIRouter(prefix="/api/customer/auth", tags=["customer-auth"])


def customer_response(customer: Customer) -> CustomerResponse:
    """Flatten customer + profile + auth into one response object."""
    profile = customer.profile
    return CustomerResponse(
        id=customer.customer_id,
        customer_code=customer.customer_code,
        full_name=customer.full_name,
        email=customer.email,
        mobile=customer.mobile,
        date_of_birth=customer.date_of_birth,
        status=customer.status.value,
        email_verified=customer.email_verified,
        mobile_verified=customer.mobile_verified,
        gender=profile.gender if profile else None,
        address_line1=profile.address_line1 if profile else None,
        address_line2=profile.address_line2 if profile else None,
        city=profile.city if profile else None,
        state=profile.state if profile else None,
        country=profile.country if profile else None,
        postal_code=profile.postal_code if profile else None,
        profile_photo=profile.profile_photo if profile else None,
        last_login=customer.auth.last_login if customer.auth else None,
        created_at=customer.created_at,
    )


def _customer_for_challenge(db: Session, challenge_token: str) -> Customer:
    customer_id = decode_customer_otp_challenge_token(challenge_token)
    if customer_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Login session expired — please sign in again",
        )
    customer = db.get(Customer, customer_id)
    if not customer or customer.status is not CustomerStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Account not found or inactive"
        )
    return customer


@router.post(
    "/signup",
    response_model=CustomerLoginChallengeResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a customer account",
    description=(
        "Public endpoint. Creates the customer, their credentials and an empty profile, then "
        "issues a verification code and returns a challenge token — so signup finishes at the "
        "same /verify-otp step as a login and the new account is signed in once verified. "
        "Email and mobile must each be unused by any other **customer**; merchant accounts are "
        "a separate table and are never consulted."
    ),
)
@limiter.limit("5/minute")
def signup(request: Request, payload: CustomerSignupRequest, db: Session = Depends(get_db)):
    customer = customer_auth_service.signup(
        db,
        full_name=payload.full_name,
        email=payload.email,
        mobile=payload.mobile,
        password=payload.password,
        date_of_birth=payload.date_of_birth,
    )

    meta = activity_service.request_context(request)
    customer_audit_service.log(
        db, customer, "Signup", module="Auth",
        description=f"{customer.full_name} registered as {customer.customer_code}",
        meta=meta,
    )

    dev_code = customer_otp_service.issue(db, customer, CustomerOtpPurpose.SIGNUP)
    mode = customer_otp_service.delivery_mode()
    return CustomerLoginChallengeResponse(
        challenge_token=create_customer_otp_challenge_token(customer.customer_id),
        delivery=mode,
        message=(
            f"Account created. A verification code was sent to {customer.email}."
            if mode == customer_otp_service.EMAIL_MODE
            else "Account created. Development mode — the code is shown here and in the server log."
        ),
        dev_otp=dev_code,
    )


@router.post(
    "/login",
    response_model=CustomerLoginChallengeResponse,
    summary="Step 1 — verify password and issue an OTP",
    description=(
        "Public endpoint. Accepts an email address **or** a mobile number. Verifies the password "
        "against the customer database only, then sends a one-time code and returns a short-lived "
        "challenge token. **No session is issued here.** A merchant or admin account presented "
        "here fails exactly as an unknown address does."
    ),
)
@limiter.limit("10/minute")
def login(request: Request, payload: CustomerLoginRequest, db: Session = Depends(get_db)):
    meta = activity_service.request_context(request)
    try:
        customer = customer_auth_service.authenticate(db, payload.identifier, payload.password)
    except HTTPException as exc:
        customer_audit_service.log_failure(
            db, None, "Failed login",
            f"Failed login for '{payload.identifier}': {exc.detail}", meta=meta,
        )
        raise

    dev_code = customer_otp_service.issue(db, customer, CustomerOtpPurpose.LOGIN)
    mode = customer_otp_service.delivery_mode()

    customer_audit_service.log(
        db, customer, "OTP requested", module="Auth",
        description=f"{customer.full_name} passed the password step", meta=meta,
    )

    return CustomerLoginChallengeResponse(
        challenge_token=create_customer_otp_challenge_token(customer.customer_id),
        delivery=mode,
        message=(
            f"A verification code was sent to {customer.email}."
            if mode == customer_otp_service.EMAIL_MODE
            else "Development mode — the code is shown here and in the server log."
        ),
        dev_otp=dev_code,
    )


@router.post(
    "/verify-otp",
    response_model=CustomerTokenResponse,
    summary="Step 2 — exchange the OTP for a session",
    description=(
        "Public endpoint. Spends the challenge token from /login or /signup together with the "
        "code, and returns the access/refresh pair plus the customer's profile. The tokens carry "
        "`scope: \"customer\"` and are rejected by every merchant and admin endpoint."
    ),
)
@limiter.limit("20/minute")
def verify_otp(request: Request, payload: CustomerVerifyOtpRequest, db: Session = Depends(get_db)):
    customer = _customer_for_challenge(db, payload.challenge_token)

    # A challenge token does not say which purpose it was minted for, and both
    # signup and login mint one. Spending either proves the same thing (this
    # person holds the mailbox), so the lookup covers both in ONE query.
    #
    # This used to try LOGIN and fall back to SIGNUP on any 400, which reported
    # the fallback's failure rather than the real one: a mistyped login code
    # counted an attempt, then the absent SIGNUP code produced "No verification
    # code outstanding — request one first" for a code the traveller was
    # looking at. See customer_otp_service.verify().
    customer_otp_service.verify(
        db, customer, payload.code,
        (CustomerOtpPurpose.LOGIN, CustomerOtpPurpose.SIGNUP),
    )

    meta = activity_service.request_context(request)
    customer_audit_service.log(
        db, customer, "Login", module="Auth",
        description=f"{customer.full_name} signed in", meta=meta,
    )
    customer_auth_service.record_login(db, customer)
    customer_session_service.start_session(db, customer, meta)

    access_token, refresh_token = customer_auth_service.issue_tokens(customer)
    return CustomerTokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        customer=customer_response(customer),
    )


@router.post(
    "/resend-otp",
    response_model=CustomerLoginChallengeResponse,
    summary="Re-send the verification code",
    description="Public endpoint. Issues a fresh code for an outstanding challenge.",
)
@limiter.limit("5/minute")
def resend_otp(request: Request, payload: CustomerResendOtpRequest, db: Session = Depends(get_db)):
    customer = _customer_for_challenge(db, payload.challenge_token)
    dev_code = customer_otp_service.issue(db, customer, CustomerOtpPurpose.LOGIN)
    mode = customer_otp_service.delivery_mode()
    return CustomerLoginChallengeResponse(
        challenge_token=create_customer_otp_challenge_token(customer.customer_id),
        delivery=mode,
        message="A new verification code has been issued.",
        dev_otp=dev_code,
    )


@router.post(
    "/refresh",
    response_model=CustomerTokenResponse,
    summary="Exchange a customer refresh token for a new pair",
    description=(
        "Public endpoint (the refresh token is the credential). Rejects any token that is not "
        "customer-scoped, so a merchant refresh token cannot mint a customer session."
    ),
)
def refresh(payload: CustomerRefreshRequest, db: Session = Depends(get_db)):
    access_token, refresh_token = customer_auth_service.refresh_access_token(
        db, payload.refresh_token
    )
    return CustomerTokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post(
    "/logout",
    response_model=CustomerMessageResponse,
    summary="Log out",
    description=(
        "Requires a customer session. Closes the session rows and revokes every outstanding "
        "customer token for the account, so a copied token stops working immediately."
    ),
)
def logout(
    request: Request,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    meta = activity_service.request_context(request)
    customer_audit_service.log(
        db, customer, "Logout", module="Auth",
        description=f"{customer.full_name} signed out", meta=meta,
    )
    customer_session_service.end_session(db, customer.customer_id)
    customer_auth_service.logout(db, customer)
    return CustomerMessageResponse(message="Logged out — your tokens have been revoked")


@router.post(
    "/forgot-password",
    response_model=CustomerMessageResponse,
    summary="Start a password reset",
    description=(
        "Public endpoint. Always returns the same message whether or not the address is "
        "registered, so it cannot be used to enumerate customers. With settings.debug enabled "
        "the reset link is also returned directly, for local testing without SMTP."
    ),
)
@limiter.limit("5/minute")
def forgot_password(
    request: Request, payload: CustomerForgotPasswordRequest, db: Session = Depends(get_db)
):
    meta = activity_service.request_context(request)
    raw_token = customer_auth_service.start_password_reset(
        db, payload.email, ip_address=meta.get("ip_address")
    )
    generic = CustomerMessageResponse(
        message="If an account exists for that email, a reset link has been issued"
    )
    if raw_token is None:
        return generic

    reset_link = (
        f"{settings.frontend_base_url}/customer/reset-password.html?token={raw_token}"
    )
    email_service.send_password_reset_email(
        payload.email, reset_link, settings.reset_token_expire_minutes
    )
    if not settings.debug:
        return generic
    return CustomerMessageResponse(
        message="Reset link generated (debug mode returns it directly)",
        reset_link=f"/customer/reset-password.html?token={raw_token}",
    )


@router.post(
    "/reset-password",
    response_model=CustomerMessageResponse,
    summary="Complete a password reset",
    description=(
        "Public endpoint. Validates the token from /forgot-password and sets the new password. "
        "Also signs out every existing session for the account. Rate-limited to 5/minute per IP."
    ),
)
@limiter.limit("5/minute")
def reset_password(
    request: Request, payload: CustomerResetPasswordRequest, db: Session = Depends(get_db)
):
    customer = customer_auth_service.complete_password_reset(
        db, payload.token, payload.new_password
    )
    meta = activity_service.request_context(request)
    customer_audit_service.log(
        db, customer, "Password reset", module="Auth",
        description="Password reset via emailed link; all sessions revoked", meta=meta,
    )
    customer_session_service.end_session(db, customer.customer_id)
    return CustomerMessageResponse(
        message="Password has been reset — you can now log in"
    )


@router.post(
    "/change-password",
    response_model=CustomerMessageResponse,
    summary="Change your own password",
    description=(
        "Requires a customer session. Verifies the current password before setting the new one. "
        "Rate-limited to 10/minute per IP."
    ),
)
@limiter.limit("10/minute")
def change_password(
    request: Request,
    payload: CustomerChangePasswordRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    customer_auth_service.change_password(
        db, customer, payload.current_password, payload.new_password
    )
    meta = activity_service.request_context(request)
    customer_audit_service.log(
        db, customer, "Password changed", module="Profile",
        description="Password changed from the profile screen", meta=meta,
    )
    return CustomerMessageResponse(message="Password changed")


@router.get(
    "/me",
    response_model=CustomerResponse,
    summary="Get the signed-in customer",
    description=(
        "Requires a customer session. Returns identity and profile. There are no permissions in "
        "the response because a customer holds none — see app/auth/customer_deps.py."
    ),
)
def me(customer: Customer = Depends(get_current_customer)):
    return customer_response(customer)
