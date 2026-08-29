"""One-time-password login step, shared by all three portals.

The spec puts OTP between password and dashboard for Super Admin, Admin and
Merchant alike, so this lives in one place rather than being reimplemented
per portal.

State lives on the ``users`` row (``otp_code_hash``, ``otp_purpose``,
``otp_expires_at``, ``otp_attempts``, ``otp_requested_at``) — only the
in-flight code. Every send is also written to ``msg_logs`` so the delivery
history survives the next request.

Delivery modes
--------------
The legacy Partner Portal returned ``503`` when SMTP was unconfigured,
because the code was never printed anywhere. That makes the app unusable
offline. Instead:

* **SMTP configured** — the code is emailed and never exposed by the API.
* **SMTP not configured** — the code is logged at WARNING and returned in
  the response under ``dev_otp``, so local development and demos work.

:func:`delivery_mode` reports which is active, and the login response says
so explicitly.

There is ONE override, added when SMTP was switched on for the website's
contact form and local logins started waiting on Gmail: ``OTP_DEV_MODE=true``
forces the dev path while leaving every other email sending. It is ANDed with
``DEBUG`` (see ``Settings.otp_dev_mode_active``), because returning a login
code in an API response is an authentication bypass and one stray environment
variable should not be enough to cause it.
"""
import datetime
import hashlib
import logging

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.auth.security import generate_otp_code
from app.config import settings
from app.models_v2 import MessageStatus, MessageType, MsgLog, OtpPurpose, User
from app.services import email_service

logger = logging.getLogger("jackpots.otp")

#: How long a code stays valid.
OTP_TTL_MINUTES = 5
#: Wrong guesses allowed before the code is burned.
MAX_VERIFY_ATTEMPTS = 5
#: Requests allowed per user per hour.
MAX_REQUESTS_PER_HOUR = 5

DEV_MODE = "dev"
EMAIL_MODE = "email"


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _aware(value: datetime.datetime | None) -> datetime.datetime | None:
    """Normalise a possibly-naive timestamp to UTC-aware."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=datetime.timezone.utc)


def _hash(code: str) -> str:
    """OTPs are short, so they are hashed but never stored in the clear."""
    return hashlib.sha256(code.encode()).hexdigest()


def delivery_mode() -> str:
    """``"email"`` when SMTP is configured, otherwise ``"dev"``.

    ``OTP_DEV_MODE`` overrides that, but only with ``DEBUG`` also on — see
    ``Settings.otp_dev_mode_active``. It exists because SMTP is now configured
    for the website's contact form, and without it the only way back to codes
    on screen was to turn that mail off too.
    """
    if settings.otp_dev_mode_active:
        return DEV_MODE
    return EMAIL_MODE if (settings.smtp_host and settings.smtp_from_email) else DEV_MODE


def _rate_limit(db: Session, user: User) -> None:
    requested_at = _aware(user.otp_requested_at)
    if requested_at is None:
        return
    window_start = _now() - datetime.timedelta(hours=1)
    if requested_at < window_start:
        return
    # otp_attempts doubles as the request counter inside the hour window; it
    # is reset on a successful verify and when the window rolls over.
    if (user.otp_attempts or 0) >= MAX_REQUESTS_PER_HOUR:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many verification codes requested. Try again in an hour.",
        )


def issue(db: Session, user: User, purpose: OtpPurpose = OtpPurpose.LOGIN) -> str | None:
    """Generate, store and deliver a code.

    Returns the plaintext code in dev mode (so the caller can surface it),
    or ``None`` when it was emailed.
    """
    _rate_limit(db, user)

    code = generate_otp_code()
    now = _now()

    within_window = (
        _aware(user.otp_requested_at) is not None
        and _aware(user.otp_requested_at) >= now - datetime.timedelta(hours=1)
    )
    user.otp_code_hash = _hash(code)
    user.otp_purpose = purpose
    user.otp_expires_at = now + datetime.timedelta(minutes=OTP_TTL_MINUTES)
    user.otp_attempts = (user.otp_attempts or 0) + 1 if within_window else 1
    user.otp_requested_at = now

    mode = delivery_mode()
    if mode == EMAIL_MODE:
        sent = email_service.send_otp_email(user.email, code, OTP_TTL_MINUTES)
        msg_status = MessageStatus.SENT if sent else MessageStatus.FAILED
    else:
        logger.warning(
            "OTP for %s is %s (SMTP not configured — dev delivery mode). "
            "Set SMTP_HOST and SMTP_FROM_EMAIL in backend/.env to email codes instead.",
            user.email,
            code,
        )
        msg_status = MessageStatus.DELIVERED

    db.add(
        MsgLog(
            user_id=user.user_id,
            merchant_id=user.merchant_id,
            message_type=MessageType.OTP,
            recipient=user.email,
            subject="Login verification code",
            # Never log the code itself into a table an admin can read.
            message=f"OTP issued for {purpose.value} via {mode} delivery.",
            status=msg_status,
            sent_time=now,
            delivered_time=now if msg_status is not MessageStatus.FAILED else None,
        )
    )
    db.commit()

    return code if mode == DEV_MODE else None


def verify(db: Session, user: User, code: str, purpose: OtpPurpose = OtpPurpose.LOGIN) -> None:
    """Consume a code. Raises 400 unless it is correct, current, and unused."""
    expires = _aware(user.otp_expires_at)

    if not user.otp_code_hash or expires is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No verification code outstanding — request one first",
        )
    if expires < _now():
        _clear(db, user)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Verification code has expired — request a new one",
        )
    if user.otp_purpose is not purpose:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Verification code is not valid here"
        )
    if (user.otp_attempts or 0) > MAX_VERIFY_ATTEMPTS + MAX_REQUESTS_PER_HOUR:
        _clear(db, user)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts — request a new code",
        )

    # hmac-style constant-time compare on the hashes.
    import hmac

    if not hmac.compare_digest(user.otp_code_hash, _hash(code)):
        user.otp_attempts = (user.otp_attempts or 0) + 1
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect verification code"
        )

    _clear(db, user)


def _clear(db: Session, user: User) -> None:
    user.otp_code_hash = None
    user.otp_purpose = None
    user.otp_expires_at = None
    user.otp_attempts = 0
    db.commit()
