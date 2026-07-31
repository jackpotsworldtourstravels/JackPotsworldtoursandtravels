from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    database_url: str
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7
    reset_token_expire_minutes: int = 60
    cors_origins: str = "http://127.0.0.1:5500,http://localhost:5500"
    debug: bool = False

    # Base URL of the deployed frontend, used to build the absolute link sent in
    # password-reset emails (the API itself only ever returns a relative path).
    frontend_base_url: str = "http://localhost:8420"

    # SMTP for transactional email (currently just password-reset links). If
    # smtp_host is unset, email sending is skipped and a warning is logged —
    # the reset flow still works via the admin "reset customer password" action.
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_use_tls: bool = True
    smtp_from_email: str | None = None
    smtp_from_name: str = "JackPots World Tours & Travels"

    # Where booking-request documents (passports, visas, IDs) are written.
    # Deliberately OUTSIDE any served directory and never mounted with
    # StaticFiles — these files are returned only through an authenticated
    # endpoint that re-checks merchant scope on every read. Point this at a
    # volume with restricted filesystem permissions in production.
    upload_root: str = str(BACKEND_DIR.parent / "uploads")
    #: Per-file cap, in megabytes. A passport scan is well under this.
    max_upload_mb: int = 10

    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def upload_root_path(self) -> Path:
        return Path(self.upload_root).resolve()

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
