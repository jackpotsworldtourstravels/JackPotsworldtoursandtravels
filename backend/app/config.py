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

    # Where those documents are actually stored: "local" (the machine's own
    # disk, at upload_root) or "s3". Use s3 wherever the server is disposable —
    # on EC2 an instance refresh takes its disk with it, and these files must
    # outlive any one server. The bucket must be private; downloads are proxied
    # through the authenticated endpoint either way, never served by URL.
    storage_backend: str = "local"
    s3_bucket: str | None = None
    s3_region: str | None = None
    #: Key prefix inside the bucket, so one bucket can hold other things safely.
    s3_prefix: str = "documents"
    #: Override only for an S3-compatible service or a local test double.
    s3_endpoint_url: str | None = None
    #: Server-side encryption. "AES256" is S3-managed keys; set to a KMS mode
    #: only alongside a key policy that the instance role can actually use.
    s3_sse: str = "AES256"

    # -----------------------------------------------------------------------
    # Automatic booking completion (booking_completion_service).
    # -----------------------------------------------------------------------
    # A ticketed booking becomes Completed once its scheduled journey is over,
    # on a timer rather than by an Admin pressing a button. All four knobs have
    # working defaults; none needs to be set for the feature to run.
    booking_completion_enabled: bool = True
    #: How often the sweep runs. Completion is never urgent to the minute — the
    #: journey ended whenever it ended — so this trades promptness for load, and
    #: a quarter of an hour is well inside the resolution anyone reads a booking
    #: status at.
    booking_completion_interval_minutes: int = 15
    #: Extra hours after the scheduled departure before a booking is considered
    #: finished. Zero implements the rule as specified — travel time has passed,
    #: so the booking is complete — and is the honest default, because the
    #: platform records a *departure* time and has never been told a flight
    #: duration or an arrival time. Raise it if the desk would rather a booking
    #: stayed Ticket Issued until the aircraft has plausibly landed.
    booking_completion_buffer_hours: int = 0
    #: Most a single sweep will complete. Only ever reached on the first run
    #: after this shipped (every booking ticketed for a journey already behind
    #: us completes at once); after that a tick has a handful at most. Bounded
    #: so that first run cannot become one enormous transaction.
    booking_completion_batch_size: int = 500
    #: Minutes east of UTC that bare travel dates and "HH:MM" departure times
    #: are written in. 330 is IST, which is where this business and every
    #: departure board it quotes actually are. It is NOT the server's timezone —
    #: every real timestamp in this database is UTC and stays UTC; this exists
    #: only to turn "10 Aug, 09:30" into an instant.
    booking_local_utc_offset_minutes: int = 330

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
