"""System Configuration / Global Settings — read-only system overview.

There is deliberately no settings table and no write endpoint here. Runtime
configuration lives in ``backend/.env`` (``app/config.py``) by design — see
docs/SCHEMA_V2.md's trade-off notes on not inventing persistence for things
the schema doesn't need. This surfaces the non-secret operational values a
Super Admin would otherwise have to read `.env` to find, without ever
exposing SMTP credentials, the JWT signing key, or the database URL.
"""
from pydantic import BaseModel


class AuthSettings(BaseModel):
    jwt_algorithm: str
    access_token_expire_minutes: int
    refresh_token_expire_days: int
    reset_token_expire_minutes: int
    otp_ttl_minutes: int
    otp_max_verify_attempts: int
    otp_max_requests_per_hour: int


class CommunicationSettings(BaseModel):
    #: "email" once SMTP_HOST/SMTP_FROM_EMAIL are set, else "dev" — the
    #: OTP/reset-link fallback mode described in otp_service.py.
    otp_delivery_mode: str
    smtp_configured: bool
    smtp_host: str | None = None
    smtp_from_name: str | None = None
    frontend_base_url: str


class SystemInfoResponse(BaseModel):
    schema_version: str
    cors_origins: list[str]
    debug_mode: bool
    auth: AuthSettings
    communication: CommunicationSettings
