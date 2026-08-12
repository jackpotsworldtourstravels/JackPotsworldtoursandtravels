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
    # Which emails actually leave the building.
    # -----------------------------------------------------------------------
    # OFF, and that is the intended production posture. The platform notifies
    # people about roughly thirty lifecycle events — enquiry raised, quotation
    # sent, booking approved, ticket issued, wallet credited, payment approved —
    # and all of them are things the merchant sees in the portal the moment they
    # happen. Mailing every one turned an active account into a mailbox nobody
    # reads, and the in-app notification is the record either way.
    #
    # WHAT THIS DOES **NOT** TOUCH: the Login OTP and the password-reset mail.
    # Those are the two messages a person cannot get *in* the portal, because
    # they are how you get into it. They call ``email_service`` directly and
    # never pass through ``delivery_service.deliver``, so this flag cannot
    # switch them off — see the module docstring there.
    #
    # A FLAG RATHER THAN A DELETION. The M5 delivery machinery — per-merchant
    # opt-out, msg_logs recording every attempt, the failed-send screen — is
    # intact and correct; what changed is the business's answer to "should we
    # mail this?". Setting LIFECYCLE_EMAILS_ENABLED=true restores the previous
    # behaviour in full, which is also how the verification suite exercises the
    # send path without mailing anyone during an ordinary run.
    lifecycle_emails_enabled: bool = False

    # -----------------------------------------------------------------------
    # Group booking size.
    # -----------------------------------------------------------------------
    # The largest party a GROUP booking may carry, and the only place that
    # number is written. Groups are corporate, tour, pilgrimage, educational and
    # event travel, so the 99 that bounds an ordinary booking is not a ceiling
    # they should inherit.
    #
    # ONE SETTING, TWO GATES, DELIBERATELY. It bounds both the "Number of
    # Passengers" a group enquiry may state and the row count an uploaded
    # manifest may carry (``group_booking_service.MAX_ROWS``). Two numbers here
    # is how a merchant enquires for 400 seats and is then refused the sheet
    # that lists them — the contradiction has to be unrepresentable, not merely
    # avoided by keeping two constants in step.
    #
    # ONE WAY AND ROUND TRIP ARE UNAFFECTED. Their 99 is enforced in
    # ``EnquiryCreate._check`` against ``trip_type``, not by this setting.
    group_booking_max_passengers: int = 1000

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

    # -----------------------------------------------------------------------
    # Partner Assistant (services/assistant).
    # -----------------------------------------------------------------------
    # The merchant-facing assistant in the Classic portal. Same provider shape
    # as passport OCR: a name here, a deterministic default that needs no
    # vendor, and no vendor string outside services/assistant/.
    #
    #   none        the built-in keyword matcher. THE DEFAULT, and a complete
    #               feature — every capability works, no key, no network call.
    #   anthropic   Claude classifies the merchant's phrasing instead. Needs
    #               ASSISTANT_API_KEY and the 'anthropic' package.
    #
    # WHAT THE MODEL IS FOR, AND WHY THIS IS SAFE TO TURN ON. It decides *what
    # was asked*, never *what the answer is*: its whole output is one member of
    # a Python enum plus, at most, a reference copied out of the merchant's own
    # sentence. It is never shown a balance, a booking, a fare or a passenger,
    # so it cannot state one wrongly. Every figure a merchant sees is fetched
    # afterwards by the browser, under that merchant's own token, from the same
    # endpoints the rest of the portal reads. Switching the provider off
    # therefore costs some tolerance for unusual phrasing and cannot change a
    # number on any screen.
    assistant_enabled: bool = True
    assistant_provider: str = "none"
    assistant_api_key: str | None = None
    #: Only consulted when the provider is 'anthropic'.
    assistant_model: str = "claude-opus-5"
    #: Kept short deliberately: this sits in front of a chat box, and falling
    #: back to the keyword matcher is a better answer than a spinner.
    assistant_timeout_seconds: float = 12.0
    #: Messages per IP per minute. Low enough that a stuck client cannot bill an
    #: afternoon of classifications, high enough for the way the panel is
    #: actually used: the quick-action chips each cost a call, so a merchant who
    #: opens the assistant and taps through half of them before typing anything
    #: is already at a dozen inside a few seconds. 20 left almost no headroom
    #: over that; 30 keeps two clear bursts and is still nowhere near a script.
    assistant_rate_per_minute: int = 30

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
