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

    # THIS IS A DEV/TEST HOST: never email login OTPs, return them in the API
    # response instead. Local and CI only.
    #
    # Whether SMTP exists and whether OTPs are emailed used to be the same
    # question: no SMTP meant dev delivery meant the code came back in
    # `dev_otp`. Configuring SMTP so the CONTACT FORM could send mail therefore
    # silently switched every login to email delivery as well, and the test
    # suite — which reads `dev_otp` from the login response — could no longer
    # sign in at all. Each failed attempt still spent one of the five OTP
    # requests an account gets per hour, so the suite locked itself out within
    # a single run.
    #
    # This flag separates the two. SMTP still carries the contact form, the
    # password-reset link and everything else; OTP delivery is forced to dev
    # mode here, so codes are logged and returned rather than mailed to the
    # fake addresses the fixtures use — which also keeps a suite run from
    # spending dozens of sends against the real mailbox's daily quota.
    #
    # It defaults to False, so a host that sets nothing behaves exactly as it
    # always did. NEVER set it on a deployed host: it hands anyone who knows a
    # password the second factor as well.
    otp_dev_echo: bool = False

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
    # Passport scanning (CR-8).
    # -----------------------------------------------------------------------
    # OFF by default, and "off" is a real answer rather than a fault: a
    # deployment that has never configured OCR renders no Scan button at all,
    # exactly as it does for SMTP. These settings went missing from this file
    # while the CR-8 branch sat untracked, which left get_provider() reading
    # attributes that did not exist -- an AttributeError on import rather than
    # the orderly "unavailable" the factory was written to give.
    #
    # WHICH PROVIDER READS THE DOCUMENT:
    #   "none"       -- no scanning offered (default)
    #   "local"      -- read on this server, no vendor, no credentials
    #   "azure"      -- Azure Document Intelligence
    #   "miniailive" -- MiniAiLive ID Document Recognition server
    # "simulated" is refused by name in the factory: it fabricated a passenger
    # from the checksum of the upload and never opened the image.
    ocr_provider: str = "none"
    #: How long any provider gets before the scan is abandoned as a timeout.
    ocr_timeout_seconds: float = 30.0
    #: How long the HTTP request itself waits for a result before handing back
    #: a job id for the form to poll. Keeps a slow read off the request thread
    #: without making the merchant wait on a spinner that may not resolve.
    ocr_inline_wait_seconds: float = 8.0

    #: Azure Document Intelligence. Both must be set for OCR_PROVIDER=azure;
    #: the provider refuses at construction rather than on the first scan.
    ocr_azure_endpoint: str | None = None
    ocr_azure_key: str | None = None
    ocr_azure_model: str = "prebuilt-idDocument"
    ocr_azure_api_version: str = "2024-11-30"

    #: Local extraction. dpi is the render resolution for PDF input; raising it
    #: costs time and helps only if the source is genuinely higher-resolution.
    ocr_local_dpi: int = 300
    ocr_local_max_pages: int = 2

    #: MiniAiLive ID Document Recognition. The BACKEND is the only component
    #: that may talk to it -- never the browser -- so none of this is ever
    #: serialised into a page or an API response.
    #:
    #: NOTE ON THE TIMEOUT NAME: the integration brief specifies
    #: MINIAILIVE_TIMEOUT=30000, i.e. milliseconds. Every other timeout in this
    #: codebase is seconds, and a 30000 dropped into a seconds field is an
    #: eight-hour hang rather than a visible misconfiguration, so the unit is
    #: in the name here and the value is seconds.
    miniailive_base_url: str = "http://127.0.0.1:8082"
    miniailive_id_endpoint: str = "/api/check_id"
    miniailive_timeout_seconds: float = 30.0
    #: Sent as the licence/API credential if the installed server requires one.
    miniailive_api_key: str | None = None

    #: The six-month rule. A passport must remain valid for this many months
    #: BEYOND the travel date or the passenger cannot be submitted. Applies to
    #: a scanned expiry exactly as it does to a typed one.
    passport_validity_months: int = 6


    # -----------------------------------------------------------------------
    # Taking money from a customer (B2C package/flight/hotel checkout).
    # -----------------------------------------------------------------------
    # OFF by default, and "off" is a real answer rather than a fault: a
    # deployment that has never configured payments shows the honest "no
    # payment is taken yet" notice the checkout already renders, exactly as it
    # does for SMTP and for OCR.
    #
    # THIS IS THE B2C SIDE ONLY. The merchant wallet, wallet_topups and the
    # payments table are the B2B side and are untouched by any of it -- a
    # merchant tops up by bank transfer and an admin verifies it by hand, which
    # is a different mechanism with different rules.
    #
    #   "none"     -- no online payment offered (default)
    #   "razorpay" -- Razorpay Payment Gateway, INR, UPI Intent/QR
    #   "mock"     -- takes no money, cannot report a success; local/CI only
    payment_provider: str = "none"

    #: "test" | "live". Guards two things: the mock provider refuses to be
    #: selected outside test, and a live host announces on every boot that it
    #: is taking real money. It does NOT choose the credentials -- the keys
    #: below do that, because Razorpay's test and live keys are simply
    #: different strings and a mismatch should fail at the provider rather than
    #: be second-guessed here.
    payment_environment: str = "test"

    #: How long the provider gets to answer before the attempt is abandoned.
    #: A timeout on order creation is reported distinctly from a refusal,
    #: because after one we do not know whether an order exists and the retry
    #: must reuse the same idempotency key.
    payment_timeout_seconds: float = 20.0

    #: Razorpay. Required for PAYMENT_PROVIDER=razorpay; the provider refuses
    #: at construction rather than on the first payment.
    #:
    #: ONLY ``razorpay_key_id`` MAY REACH A BROWSER. It is the publishable key
    #: Razorpay's own checkout script needs. The secret signs API calls and the
    #: webhook secret verifies deliveries; neither is ever serialised into a
    #: page, an API response, a log line or an error message.
    razorpay_key_id: str | None = None
    razorpay_key_secret: str | None = None
    razorpay_webhook_secret: str | None = None

    #: The deferred-event sweep. Phase 5 records a money-moving webhook and
    #: leaves it ``deferred``; Phase 6 verifies it against the provider. A
    #: delivery that arrived while the provider was unreachable, or while the
    #: payment was still in flight, stays deferred — this is what comes back
    #: for it. Without the sweep those events sit forever and a customer who
    #: paid never gets confirmed.
    payment_sweep_enabled: bool = True
    #: Minutes between passes. Short enough that a transient provider outage
    #: resolves within one booking session; long enough not to hammer the
    #: provider's API on a backlog that is waiting on something else.
    payment_sweep_interval_minutes: int = 5
    #: Events per pass. Bounded so one bad afternoon cannot turn a tick into an
    #: hour-long transaction.
    payment_sweep_batch_size: int = 100


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

    # ---------------------------------------------------------------- CR-9 --
    #: Live chat fan-out and WebSocket tickets.
    #:
    #: REQUIRED IN ANY DEPLOYMENT RUNNING MORE THAN ONE WORKER, and this one
    #: runs two (`WEB_CONCURRENCY=2`). Gunicorn forks independent processes, so
    #: a chat connection registry held in Python memory is per-process: a
    #: customer on worker 1 and an agent on worker 2 never see each other and
    #: roughly half of all messages vanish with no error anywhere.
    #:
    #: Left unset, the app falls back to an in-process broker that is correct
    #: ONLY for a single worker. chat_broker.py warns loudly at start-up rather
    #: than letting that go unnoticed — the same shape as storage_backend's
    #: local/S3 split.
    redis_url: str | None = None
    #: How long a WebSocket ticket is valid. Short because it is exchanged
    #: immediately: the browser WebSocket constructor cannot send an
    #: Authorization header, so a one-time ticket stands in for it.
    chat_ticket_ttl_seconds: int = 60
    #: Per-socket send ceiling. A fast typist does not reach 20 messages in
    #: 10 seconds; a script does.
    chat_rate_burst: int = 20
    chat_rate_window_seconds: int = 10

    # ----------------------------------------------------------------- CR-10
    # Voice calling (WebRTC). Signalling rides the chat socket; MEDIA NEVER
    # TOUCHES THIS SERVER. These settings only describe how two browsers should
    # find each other.
    #
    #: Whether the call buttons appear at all. A kill switch that does not need
    #: a deploy to pull: a call feature that is misbehaving should be
    #: switch-offable while chat keeps working, because chat is the thing
    #: customers actually depend on.
    voice_calls_enabled: bool = True
    #: Comma-separated STUN URLs. Google's public server is the default and is
    #: enough for most home and office networks: it tells a browser its own
    #: public address so the two peers can try to connect directly.
    stun_urls: str = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
    #: TURN — and this one is not optional in practice, whatever its default
    #: suggests.
    #:
    #: STUN only works when at least one side can accept an inbound packet.
    #: Behind symmetric NAT or carrier-grade NAT it cannot, and the call fails
    #: with no error a customer can act on. India's mobile networks run CGNAT
    #: as standard — Jio and Airtel both — so a meaningful share of this
    #: customer base is exactly the population STUN does not serve. TURN relays
    #: the audio when a direct path cannot be found; without it those calls do
    #: not degrade, they simply never connect.
    #:
    #: Left empty the app still runs and still places calls, and
    #: `/api/customer/chat/ice` logs a warning saying which calls will fail.
    #: See docs/CR-10_VOICE_CALLS.md for the coturn deployment.
    turn_urls: str = ""
    turn_username: str = ""
    turn_password: str = ""
    #: How long a browser may reuse an ICE config before asking again. Short,
    #: because TURN credentials are short-lived by design.
    ice_ttl_seconds: int = 3600

    @property
    def stun_url_list(self) -> list[str]:
        return [u.strip() for u in self.stun_urls.split(",") if u.strip()]

    @property
    def turn_url_list(self) -> list[str]:
        return [u.strip() for u in self.turn_urls.split(",") if u.strip()]

    @property
    def turn_configured(self) -> bool:
        return bool(self.turn_url_list and self.turn_username and self.turn_password)

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
