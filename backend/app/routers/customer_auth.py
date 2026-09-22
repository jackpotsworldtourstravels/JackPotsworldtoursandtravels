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
    CustomerGuestClaimRequest,
    CustomerGuestClaimResponse,
    CustomerLoginChallengeResponse,
    CustomerLoginRequest,
    CustomerMessageResponse,
    CustomerOtpRequest,
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
    customer_guest_service,
    customer_otp_service,
    customer_session_service,
    email_service,
)

router = APIRouter(prefix="/api/customer/auth", tags=["customer-auth"])


def customer_response(customer: Customer) -> CustomerResponse:
    """Flatten customer + profile + auth into one response object.

    A GUEST'S ADDRESS FIELDS COME BACK NULL. The row carries placeholders to
    satisfy NOT NULL, and those are an implementation detail of "no
    credentials" rather than something the traveller told us. Returning them
    would put a fake email on the profile screen and, worse, into anything that
    later reads a contact address off it.
    """
    profile = customer.profile
    guest = customer.is_guest
    return CustomerResponse(
        id=customer.customer_id,
        customer_code=customer.customer_code,
        full_name=customer.full_name,
        email=None if guest else customer.email,
        mobile=None if guest else customer.mobile,
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
        is_guest=guest,
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
    "/request-otp",
    response_model=CustomerLoginChallengeResponse,
    summary="Passwordless step 1 — issue an OTP for an email or mobile",
    description=(
        "Public endpoint. Accepts an email address **or** a mobile number (dial code included, "
        "as signup stored it) and sends a one-time code to the account's email, returning the "
        "same short-lived challenge token /login does. **No session is issued here** — the "
        "traveller still has to spend the code at /verify-otp. Rate-limited to 5/minute per IP, "
        "on top of the 5-codes-per-hour-per-customer limit in customer_otp_service."
    ),
)
@limiter.limit("5/minute")
def request_otp(request: Request, payload: CustomerOtpRequest, db: Session = Depends(get_db)):
    """The customer site's sign-in: an address, then a code — no password.

    WHY THIS EXISTS BESIDE /login. /login verifies a password before issuing
    the code; the public sign-in dialog asks for the address only. This is the
    same OTP machinery (customer_otp_service, the same challenge token, the
    same /verify-otp and /resend-otp) reached without the password check. The
    code is what proves the traveller holds the account's mailbox.

    WHY AN UNKNOWN ADDRESS IS ANSWERED PLAINLY. The alternative, a decoy
    "code sent" for every address, protects nothing here: /signup already
    answers "an account with this email/mobile already exists", so whether an
    address is registered is not a secret this API keeps. Telling a traveller
    who mistyped their number that no account matched is what lets them fix it
    instead of waiting for an email that will never arrive. The 5/minute limit
    is what stops the answer being farmed.
    """
    meta = activity_service.request_context(request)
    customer = customer_auth_service.get_by_identifier(db, payload.identifier)
    if customer is None:
        customer_audit_service.log_failure(
            db, None, "Failed login",
            f"OTP requested for unknown identifier '{payload.identifier}'", meta=meta,
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="We couldn't find an account with those details.",
        )
    # Same refusals, in the same words, as the password login.
    if customer.status is CustomerStatus.BLOCKED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is blocked. Please contact support.",
        )
    if customer.status is not CustomerStatus.ACTIVE:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is disabled")

    dev_code = customer_otp_service.issue(db, customer, CustomerOtpPurpose.LOGIN)
    mode = customer_otp_service.delivery_mode()

    customer_audit_service.log(
        db, customer, "OTP requested", module="Auth",
        description=f"{customer.full_name} requested a sign-in code", meta=meta,
    )

    return CustomerLoginChallengeResponse(
        challenge_token=create_customer_otp_challenge_token(customer.customer_id),
        delivery=mode,
        message=(
            "A verification code was sent to the email on your account."
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
    "/guest",
    response_model=CustomerTokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Continue as guest",
    description=(
        "Public. Starts an anonymous session and returns the SAME access/refresh pair a "
        "sign-in returns, so every customer endpoint - wishlist, bookings, notifications, "
        "reviews, support - works for a guest with no second code path and no new isolation "
        "rule to get wrong. The customer it names carries `is_guest: true`, no credentials "
        "and no way to sign back into it: losing the token is losing the session, which is "
        "what guest means. "
        "**The server mints the identity.** A `guest_session_id` invented in the browser and "
        "trusted here would be a login with no password. Rate-limited to 10/minute per IP so "
        "the table cannot be filled by a script."
    ),
)
@limiter.limit("10/minute")
def start_guest(request: Request, db: Session = Depends(get_db)):
    guest, access, refresh = customer_guest_service.start_guest(db)
    return CustomerTokenResponse(
        access_token=access, refresh_token=refresh, customer=customer_response(guest),
    )


@router.post(
    "/guest/claim",
    response_model=CustomerGuestClaimResponse,
    summary="Keep what a guest did, after signing in",
    description=(
        "Requires a customer session - the ACCOUNT's, not the guest's - and takes the guest "
        "session's own access token in the body as proof the caller held it. Everything that "
        "session did (wishlist, bookings, notifications, reviews, support threads, travellers, "
        "assistant conversations) is repointed at the account in one transaction. Nothing is "
        "copied, so nothing is duplicated. "
        "**An unusable token is not an error.** Expired, tampered with, already claimed, or "
        "naming a real account, all return `claimed: false`: this runs immediately after a "
        "successful sign-in, and a failure to migrate must never undo the sign-in."
    ),
)
@limiter.limit("20/minute")
def claim_guest_session(
    request: Request,
    payload: CustomerGuestClaimRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    if customer.is_guest:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Sign in first - a guest session cannot inherit another one.",
        )
    guest = customer_guest_service.guest_from_token(db, payload.guest_token)
    if guest is None or guest.status is not CustomerStatus.ACTIVE:
        return CustomerGuestClaimResponse(claimed=False)
    moved = customer_guest_service.claim_guest(db, guest, customer)
    return CustomerGuestClaimResponse(claimed=True, moved=moved)


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
    # A guest has never set a password: there is nothing to change and nothing
    # to check the current one against.
    customer_guest_service.assert_not_guest(customer, "Changing a password")
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
