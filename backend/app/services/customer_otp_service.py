"""One-time codes for the Customer Portal.

Same delivery contract as the B2B ``otp_service``:

* **SMTP configured**   — the code is emailed and never exposed by the API.
* **SMTP not configured** — the code is logged at WARNING and returned as
  ``dev_otp``, so local development and demos work without a mail account.

WHAT IS DIFFERENT FROM THE B2B SERVICE, AND WHY
That one keeps the in-flight code in five columns on ``users``, which holds
exactly one code per person. Here a code is a **row** (``customer_otps``), so a
signup verification and a password-reset code can be outstanding at the same
time without one silently overwriting the other, and the delivery history
survives. Consuming a code sets ``consumed_at`` rather than clearing columns,
so "this code was already used" stays distinguishable from "there is no code".

Nothing here writes to ``msg_logs`` — that table is the merchant side's message
history and feeds the Admin message-delivery screen.
"""
import datetime
import hashlib
import hmac
import logging
from collections.abc import Sequence

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.security import generate_otp_code
from app.config import settings
from app.models_customer import Customer, CustomerOtp, CustomerOtpPurpose
from app.services import email_service

logger = logging.getLogger("jackpots.customer.otp")

#: How long a code stays valid. Matches the B2B service.
OTP_TTL_MINUTES = 5
#: Wrong guesses allowed against one code before it is burned.
MAX_VERIFY_ATTEMPTS = 5
#: Codes issuable per customer per hour, counted across all purposes.
MAX_REQUESTS_PER_HOUR = 5

DEV_MODE = "dev"
EMAIL_MODE = "email"


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _aware(value: datetime.datetime | None) -> datetime.datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=datetime.timezone.utc)


def _hash(code: str) -> str:
    """Codes are six digits, so they are hashed but never stored in the clear."""
    return hashlib.sha256(code.encode()).hexdigest()


def delivery_mode() -> str:
    """Same rule as the staff portals' otp_service, and deliberately the same
    switch: a developer who asks for codes on screen means all of them, not
    just the half of the platform they happened to be looking at."""
    if settings.otp_dev_mode_active:
        return DEV_MODE
    return EMAIL_MODE if (settings.smtp_host and settings.smtp_from_email) else DEV_MODE


def _rate_limit(db: Session, customer: Customer) -> None:
    """At most MAX_REQUESTS_PER_HOUR codes in the last hour, counted as rows.

    The B2B service reuses ``otp_attempts`` as both the request counter and the
    wrong-guess counter, which couples two unrelated limits. Counting rows in
    the window is what the table makes possible and is simply what was meant.
    """
    window_start = _now() - datetime.timedelta(hours=1)
    issued = db.scalar(
        select(func.count(CustomerOtp.customer_otp_id)).where(
            CustomerOtp.customer_id == customer.customer_id,
            CustomerOtp.created_at >= window_start,
        )
    )
    if (issued or 0) >= MAX_REQUESTS_PER_HOUR:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many verification codes requested. Try again in an hour.",
        )


def issue(
    db: Session,
    customer: Customer,
    purpose: CustomerOtpPurpose = CustomerOtpPurpose.LOGIN,
) -> str | None:
    """Generate, store and deliver a code.

    Returns the plaintext in dev mode so the caller can surface it, or ``None``
    when it was emailed.
    """
    _rate_limit(db, customer)

    # Any earlier unspent code for this purpose is retired first. Two live
    # login codes means the older one still works, which is a longer window
    # than the TTL advertises.
    now = _now()
    for stale in db.scalars(
        select(CustomerOtp).where(
            CustomerOtp.customer_id == customer.customer_id,
            CustomerOtp.purpose == purpose,
            CustomerOtp.consumed_at.is_(None),
        )
    ):
        stale.consumed_at = now

    code = generate_otp_code()
    mode = delivery_mode()

    db.add(
        CustomerOtp(
            customer_id=customer.customer_id,
            code_hash=_hash(code),
            purpose=purpose,
            delivery_channel=mode,
            recipient=customer.email,
            expires_at=now + datetime.timedelta(minutes=OTP_TTL_MINUTES),
        )
    )

    if mode == EMAIL_MODE:
        email_service.send_otp_email(customer.email, code, OTP_TTL_MINUTES)
    else:
        logger.warning(
            "Customer OTP for %s is %s (SMTP not configured — dev delivery mode). "
            "Set SMTP_HOST and SMTP_FROM_EMAIL in backend/.env to email codes instead.",
            customer.email,
            code,
        )

    db.commit()
    return code if mode == DEV_MODE else None


def verify(
    db: Session,
    customer: Customer,
    code: str,
    purpose: CustomerOtpPurpose | Sequence[CustomerOtpPurpose] = CustomerOtpPurpose.LOGIN,
) -> None:
    """Consume a code. Raises 400/429 unless it is correct, current and unused.

    ``purpose`` may be several purposes. The caller at /verify-otp cannot tell
    which kind of code is outstanding — a challenge token does not record
    whether signup or login minted it — and it used to resolve that by trying
    LOGIN and falling back to SIGNUP on any 400. That produced the WRONG error
    and a spurious attempt: mistyping a login code raised "Incorrect
    verification code" (incrementing attempts), the fallback then found no
    outstanding SIGNUP code, and the traveller was told "No verification code
    outstanding — request one first" about a code sitting in their inbox.

    Widening the lookup instead means one query, one attempt counted, and the
    message describing what actually happened.
    """
    otp = db.scalar(
        select(CustomerOtp)
        .where(
            CustomerOtp.customer_id == customer.customer_id,
            CustomerOtp.purpose.in_(
                (purpose,) if isinstance(purpose, CustomerOtpPurpose) else tuple(purpose)
            ),
            CustomerOtp.consumed_at.is_(None),
        )
        .order_by(CustomerOtp.created_at.desc())
        .limit(1)
    )

    if otp is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No verification code outstanding — request one first",
        )
    if _aware(otp.expires_at) < _now():
        otp.consumed_at = _now()
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Verification code has expired — request a new one",
        )
    if (otp.attempts or 0) >= MAX_VERIFY_ATTEMPTS:
        otp.consumed_at = _now()
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts — request a new code",
        )

    if not hmac.compare_digest(otp.code_hash, _hash(code)):
        otp.attempts = (otp.attempts or 0) + 1
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect verification code"
        )

    otp.consumed_at = _now()
    # A spent login/signup code is also proof the address receives mail.
    #
    # This reads otp.purpose — the purpose actually SPENT — not the `purpose`
    # argument, which may be several. Testing the argument silently stopped
    # verifying anyone's email the moment callers began passing a tuple:
    # `(LOGIN, SIGNUP) in (LOGIN, SIGNUP, EMAIL_VERIFY)` is False.
    if otp.purpose in (CustomerOtpPurpose.LOGIN, CustomerOtpPurpose.SIGNUP,
                       CustomerOtpPurpose.EMAIL_VERIFY):
        customer.email_verified = True
    db.commit()
