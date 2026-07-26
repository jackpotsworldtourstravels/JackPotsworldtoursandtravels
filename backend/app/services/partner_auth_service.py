from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.auth.security import (
    create_partner_access_token,
    create_partner_refresh_token,
    decode_token,
    generate_otp_code,
    hash_password,
    hash_reset_token,
    verify_password,
)
from app.services import email_service

OTP_TTL_MINUTES = 5


def _login_lookup(db: Session, email: str) -> dict | None:
    row = db.execute(text("SELECT * FROM sp_partner_login_lookup(:email)"), {"email": email}).mappings().first()
    return dict(row) if row else None


def request_login_otp(db: Session, email: str) -> None:
    """Step 1. Unlike forgot-password, login can't proceed without a valid
    account, so an unknown email is reported directly rather than silently
    no-op'd — this is an invitation-only B2B portal, not public signup."""
    user = _login_lookup(db, email)
    if not user or user["status"] != "active":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active partner account found for this email")
    _issue_otp(db, user["partner_user_id"], email, "login")


def verify_login_otp(db: Session, email: str, otp: str) -> None:
    user = _login_lookup(db, email)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No partner account found for this email")
    ok = db.execute(
        text("SELECT sp_verify_otp(:partner_user_id, 'login', :otp_hash)"),
        {"partner_user_id": user["partner_user_id"], "otp_hash": hash_reset_token(otp)},
    ).scalar()
    db.commit()
    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect or expired OTP")


def login(db: Session, email: str, password: str, ip_address: str | None) -> dict:
    """Step 3. Requires a prior verified OTP for 'login' — same as the
    two-factor pattern the auth flow was designed around, not just a
    password check."""
    user = _login_lookup(db, email)
    if not user or not user["password_hash"] or not verify_password(password, user["password_hash"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if user["status"] != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This partner account is not active")

    verified = db.execute(
        text("""
            SELECT 1 FROM partner_otp_requests
            WHERE partner_user_id = :id AND purpose = 'login' AND verified_at IS NOT NULL
              AND verified_at > now() - interval '15 minutes'
            ORDER BY created_at DESC LIMIT 1
        """),
        {"id": user["partner_user_id"]},
    ).first()
    if not verified:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Please verify the OTP sent to your email first")

    db.execute(text("SELECT sp_partner_record_login(:id, :ip)"), {"id": user["partner_user_id"], "ip": ip_address})
    db.commit()

    partner = db.execute(
        text("SELECT company_name FROM partners WHERE partner_id = :pid"), {"pid": user["partner_id"]}
    ).mappings().first()

    return {
        "access_token": create_partner_access_token(user["partner_user_id"]),
        "refresh_token": create_partner_refresh_token(user["partner_user_id"]),
        "partner_user_id": user["partner_user_id"],
        "partner_id": user["partner_id"],
        "full_name": user["full_name"],
        "company_name": partner["company_name"] if partner else "",
    }


def refresh(refresh_token: str) -> dict:
    payload = decode_token(refresh_token)
    if not payload or payload.get("type") != "refresh" or payload.get("scope") != "partner":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    partner_user_id = int(payload["sub"])
    return {
        "access_token": create_partner_access_token(partner_user_id),
        "refresh_token": create_partner_refresh_token(partner_user_id),
    }


def request_password_reset_otp(db: Session, email: str) -> None:
    """Forgot Password — deliberately silent on an unknown email (unlike
    request_login_otp) since this flow is more sensitive to account
    enumeration than the login step is."""
    user = _login_lookup(db, email)
    if user and user["status"] == "active":
        _issue_otp(db, user["partner_user_id"], email, "password_reset")


def reset_password(db: Session, email: str, otp: str, new_password: str) -> None:
    user = _login_lookup(db, email)
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect or expired OTP")
    ok = db.execute(
        text("SELECT sp_verify_otp(:id, 'password_reset', :otp_hash)"),
        {"id": user["partner_user_id"], "otp_hash": hash_reset_token(otp)},
    ).scalar()
    if not ok:
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect or expired OTP")

    db.execute(
        text("UPDATE partner_users SET password_hash = :hash WHERE partner_user_id = :id"),
        {"hash": hash_password(new_password), "id": user["partner_user_id"]},
    )
    db.commit()


def change_password(db: Session, partner_user_id: int, current_password: str, new_password: str) -> None:
    row = db.execute(
        text("SELECT password_hash FROM partner_users WHERE partner_user_id = :id"), {"id": partner_user_id}
    ).mappings().first()
    if not row or not row["password_hash"] or not verify_password(current_password, row["password_hash"]):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    db.execute(
        text("UPDATE partner_users SET password_hash = :hash WHERE partner_user_id = :id"),
        {"hash": hash_password(new_password), "id": partner_user_id},
    )
    db.commit()


def get_profile(db: Session, partner_user_id: int) -> dict:
    row = db.execute(
        text("""
            SELECT pu.partner_user_id, pu.full_name, pu.email, pu.phone_number,
                   p.partner_id, p.company_name, p.company_code
            FROM partner_users pu JOIN partners p ON p.partner_id = pu.partner_id
            WHERE pu.partner_user_id = :id
        """),
        {"id": partner_user_id},
    ).mappings().first()
    return dict(row)


def update_profile(db: Session, partner_user_id: int, full_name: str | None, phone_number: str | None) -> dict:
    try:
        db.execute(
            text("SELECT sp_update_partner_profile(:id, :full_name, :phone_number)"),
            {"id": partner_user_id, "full_name": full_name, "phone_number": phone_number},
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc.orig).split("CONTEXT")[0].strip()) from exc
    return get_profile(db, partner_user_id)


def _issue_otp(db: Session, partner_user_id: int, email: str, purpose: str) -> None:
    otp_code = generate_otp_code()
    try:
        db.execute(
            text("SELECT sp_request_otp(:id, :hash, :purpose, :ttl)"),
            {"id": partner_user_id, "hash": hash_reset_token(otp_code), "purpose": purpose, "ttl": OTP_TTL_MINUTES},
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        if "RATE_LIMIT_EXCEEDED" in str(exc):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many OTP requests for this account. Please try again in an hour.",
            ) from exc
        raise

    sent = email_service.send_otp_email(email, otp_code, OTP_TTL_MINUTES)
    if not sent:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to send the OTP email right now. Please try again shortly.",
        )
