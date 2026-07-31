"""System Configuration / Global Settings — assembles the read-only snapshot.

See app/schemas/system_info.py for why this has no write path.
"""
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.services import otp_service


def get_system_info(db: Session) -> dict:
    schema_version = db.scalar(text("SELECT version_num FROM alembic_version")) or "unknown"

    return {
        "schema_version": schema_version,
        "cors_origins": settings.cors_origins_list,
        "debug_mode": settings.debug,
        "auth": {
            "jwt_algorithm": settings.jwt_algorithm,
            "access_token_expire_minutes": settings.access_token_expire_minutes,
            "refresh_token_expire_days": settings.refresh_token_expire_days,
            "reset_token_expire_minutes": settings.reset_token_expire_minutes,
            "otp_ttl_minutes": otp_service.OTP_TTL_MINUTES,
            "otp_max_verify_attempts": otp_service.MAX_VERIFY_ATTEMPTS,
            "otp_max_requests_per_hour": otp_service.MAX_REQUESTS_PER_HOUR,
        },
        "communication": {
            "otp_delivery_mode": otp_service.delivery_mode(),
            "smtp_configured": bool(settings.smtp_host and settings.smtp_from_email),
            "smtp_host": settings.smtp_host,
            "smtp_from_name": settings.smtp_from_name,
            "frontend_base_url": settings.frontend_base_url,
        },
    }
