"""customer portal (V1) — an independent B2C identity, sharing nothing with the merchant side

Revision ID: 0044_customer_portal
Revises: 0052_soft_delete_email_reuse
Create Date: 2026-08-07

WHAT THIS IS
The B2C Customer Portal. A customer is a member of the public who books for
themselves. A merchant is a travel business that books on behalf of its own
clients, owes us money, and has staff, roles, wallets and an approval chain.
They are different products that happen to share a codebase.

WHY NEW TABLES INSTEAD OF ``users.role = 'customer'``
``user_role`` already has a ``customer`` member, left over from the pre-v2 B2C
site. It has **zero rows** and no endpoint issues it: the B2C login page still
posts to ``/api/auth/user/login``, which was deleted with the 17 legacy routers
in 1a75e47. So there is no migration of existing data to do here — the customer
surface is being built, not moved.

Reusing that role would have put customers inside ``users``, and ``users`` is
the table every merchant-scoped query in the platform filters on. Every
"list the staff", "who is online", "who approved this" and RBAC lookup would
have grown a `role != 'customer'` clause, and the day one of them was forgotten
a customer would appear in a merchant's Active Users. Isolation stated once in
the schema is cheaper and safer than isolation restated in forty queries.

THE ISOLATION RULE, STATED AS SCHEMA
**No table created here carries a foreign key to ``users``, ``merchants``, or
any other merchant-side table, and no merchant-side table gains a column
pointing here.** Compare 0039, where ``providers`` deliberately has no login;
this is the same kind of statement in the other direction — a complete identity
with no business relationship. ``tests/verify_customer_portal.py`` asserts this
against ``information_schema`` rather than trusting review, so the guarantee
survives someone adding a "convenient" link later.

The one thing the two sides share is the Postgres database itself. That is a
deployment fact, not a data relationship: nothing joins across the boundary,
and moving these seven tables to their own database later requires no schema
change on either side.

WHY ``customer_code`` COMES FROM A SEQUENCE
Same reasoning as ``seq_provider_code`` in 0039 and ``seq_wallet_txn_number`` in
0036: ``nextval`` is non-transactional on purpose, so a rolled-back signup
leaves a gap in the series rather than handing CUS-000007 to two people. A code
built in Python from ``COUNT(*) + 1`` is a check-then-act that two concurrent
signups both pass.

WHY IDENTITY, CREDENTIALS AND PROFILE ARE THREE TABLES
``customers`` is who someone is, ``customer_auth`` is how they prove it, and
``customer_profiles`` is what they told us about themselves. Splitting them
means the ordinary reads — a booking listing a customer's name — never load a
password hash into memory, and the profile can grow columns without touching
the row that authentication locks on.

WHY OTPs AND RESET TOKENS ARE ROWS, NOT COLUMNS
The merchant side keeps the in-flight OTP in five columns on ``users``, which
holds exactly one code per person and keeps no history. Rows instead: a code
issued for a signup and a code issued for a password reset can be outstanding
at once, each is consumed independently, and the delivery history survives.
Both tables are pruned by ``expires_at``, so they do not grow without bound.

NO DATA IS WRITTEN OR REWRITTEN BY THIS MIGRATION. It creates seven empty
tables, three enum types and one sequence. Nothing on the merchant side is
touched, so `downgrade()` is a clean drop.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0044_customer_portal"
# Parented on the last revision that is actually IN PRODUCTION, not on whatever
# happened to precede this file locally.
#
# It first pointed at `0043_passport_details`, which chains through
# `0042_passport_ocr` — both CR-8, both deliberately held back from production
# three releases running. Shipping the Customer Portal behind them would have
# dragged the OCR schema in as a side effect of deploying something unrelated.
#
# Nothing here depends on either: all seven tables are rooted at `customers`
# and every foreign key points inside this migration. The chain pointer was the
# only link, so re-parenting costs nothing and makes prod a single linear step
# (0042_group_booking_import -> 0044_customer_portal).
#
# CONSEQUENCE, LOCALLY: with the CR-8 files still on disk the graph now has two
# heads (0043_passport_details and this one). That is correct and expected —
# they are genuinely parallel branches. Whichever ships second re-parents onto
# the other, or a merge revision joins them.
down_revision: Union[str, None] = "0052_soft_delete_email_reuse"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CODE_SEQ = "seq_customer_code"

# Every type here is prefixed `customer_`, so none of them can ever be confused
# with (or accidentally reused by) the merchant-side types of the same shape.
# `user_status` and `customer_status_enum` list the same four words and are
# deliberately two different types: widening one must not widen the other.
_CUSTOMER_STATUS = postgresql.ENUM(
    "active", "inactive", "blocked", "suspended",
    name="customer_status_enum", create_type=False,
)
_OTP_PURPOSE = postgresql.ENUM(
    "signup", "login", "password_reset", "email_verify", "mobile_verify",
    name="customer_otp_purpose_enum", create_type=False,
)
_AUDIT_STATUS = postgresql.ENUM(
    "success", "failed",
    name="customer_audit_status_enum", create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()

    # Brand-new types, so they may be created and used in the same transaction —
    # the ALTER TYPE ... ADD VALUE restriction 0038 works around applies only to
    # types that already exist.
    _CUSTOMER_STATUS.create(bind, checkfirst=True)
    _OTP_PURPOSE.create(bind, checkfirst=True)
    _AUDIT_STATUS.create(bind, checkfirst=True)

    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {CODE_SEQ} START WITH 1 INCREMENT BY 1")

    # ------------------------------------------------------------------ 1/7 --
    # WHO. Identity only: no password, no address, no session state.
    op.create_table(
        "customers",
        sa.Column("customer_id", sa.BigInteger(), primary_key=True),
        sa.Column("customer_code", sa.String(length=20), nullable=False),
        sa.Column("full_name", sa.String(length=150), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("mobile", sa.String(length=30), nullable=False),
        # Optional at signup per the spec. NULL means "not told us", which is
        # not the same as any date we could invent.
        sa.Column("date_of_birth", sa.Date(), nullable=True),
        sa.Column(
            "status", _CUSTOMER_STATUS, nullable=False, server_default=sa.text("'active'"),
        ),
        # Signup issues an OTP; until it is spent these stay false. Nothing
        # gates on them yet — they are here so that turning on "verify your
        # email before booking" later is a service change, not a migration.
        sa.Column(
            "email_verified", sa.Boolean(), nullable=False, server_default=sa.text("false"),
        ),
        sa.Column(
            "mobile_verified", sa.Boolean(), nullable=False, server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("uq_customers_code", "customers", ["customer_code"], unique=True)
    # Case-insensitive, because "Ravi@x.com" and "ravi@x.com" are one mailbox.
    # A plain unique index on the raw column would let both register and then
    # make "email or mobile" login ambiguous. The service lowercases on write;
    # this is the guarantee that holds even when it doesn't.
    op.create_index(
        "uq_customers_email_lower", "customers", [sa.text("lower(email)")], unique=True,
    )
    op.create_index("uq_customers_mobile", "customers", ["mobile"], unique=True)
    op.create_index("ix_customers_status", "customers", ["status"])

    # ------------------------------------------------------------------ 2/7 --
    # HOW THEY PROVE IT. One row per customer, enforced by the unique index —
    # a second credential row for one person is a security bug, not a feature.
    op.create_table(
        "customer_auth",
        sa.Column("customer_auth_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column(
            "password_changed_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "failed_login_attempts", sa.Integer(), nullable=False, server_default=sa.text("0"),
        ),
        sa.Column("last_login", sa.DateTime(timezone=True), nullable=True),
        sa.Column("login_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        # JWTs are stateless, so logout moves this forward and every dependency
        # rejects tokens issued before it. Same mechanism as users.force_logout_at
        # — see customer_auth_service.is_token_revoked.
        sa.Column("force_logout_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "uq_customer_auth_customer", "customer_auth", ["customer_id"], unique=True,
    )

    # ------------------------------------------------------------------ 3/7 --
    # WHAT THEY TOLD US. Real columns rather than the JSONB blob `users.profile`
    # uses: this side has one fixed shape and no per-role variation, so typed
    # columns cost nothing and can be indexed if the address is ever searched.
    op.create_table(
        "customer_profiles",
        sa.Column("customer_profile_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("gender", sa.String(length=20), nullable=True),
        sa.Column("address_line1", sa.String(length=255), nullable=True),
        sa.Column("address_line2", sa.String(length=255), nullable=True),
        sa.Column("city", sa.String(length=100), nullable=True),
        sa.Column("state", sa.String(length=100), nullable=True),
        sa.Column("country", sa.String(length=100), nullable=True),
        sa.Column("postal_code", sa.String(length=20), nullable=True),
        # A storage key, never a URL and never the bytes. Matches how the
        # merchant side stores documents (app/services/storage.py).
        sa.Column("profile_photo", sa.String(length=500), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "uq_customer_profiles_customer", "customer_profiles", ["customer_id"], unique=True,
    )

    # ------------------------------------------------------------------ 4/7 --
    # WHERE THEY ARE SIGNED IN. Deliberately NOT `system_logs`, which is the
    # merchant side's session store and feeds Admin > Active Users. A customer
    # appearing in that screen is precisely the leak this module exists to
    # prevent, and the cleanest way to guarantee it is to have nowhere to write.
    op.create_table(
        "customer_sessions",
        sa.Column("customer_session_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("browser", sa.String(length=120), nullable=True),
        sa.Column("device", sa.String(length=120), nullable=True),
        sa.Column("user_agent", sa.String(length=400), nullable=True),
        sa.Column(
            "login_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("logout_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true"),
        ),
    )
    # Partial: "this customer's live sessions" is the only hot query, and the
    # closed ones are the overwhelming majority of the table over time.
    op.create_index(
        "ix_customer_sessions_live", "customer_sessions", ["customer_id"],
        postgresql_where=sa.text("is_active"),
    )
    op.create_index("ix_customer_sessions_login_at", "customer_sessions", ["login_at"])

    # ------------------------------------------------------------------ 5/7 --
    # IN-FLIGHT CODES. Rows, not columns — see the header.
    op.create_table(
        "customer_otps",
        sa.Column("customer_otp_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        # SHA-256 of the code. Short enough to brute force offline if it ever
        # leaked, which is why it also expires in minutes and burns on attempts.
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("purpose", _OTP_PURPOSE, nullable=False),
        sa.Column("delivery_channel", sa.String(length=20), nullable=False),
        sa.Column("recipient", sa.String(length=255), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    # The verify path asks for "this customer's newest unconsumed code for this
    # purpose", so the index carries the purpose and excludes spent rows.
    op.create_index(
        "ix_customer_otps_live", "customer_otps", ["customer_id", "purpose", "created_at"],
        postgresql_where=sa.text("consumed_at IS NULL"),
    )
    op.create_index("ix_customer_otps_expires", "customer_otps", ["expires_at"])

    # ------------------------------------------------------------------ 6/7 --
    op.create_table(
        "customer_password_resets",
        sa.Column("customer_password_reset_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        # The raw token is emailed and never stored; this is its SHA-256. Unique
        # because the lookup is by token and two rows answering to one token
        # would make "which reset is this" undecidable.
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("requested_ip", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "uq_customer_password_resets_token", "customer_password_resets",
        ["token_hash"], unique=True,
    )
    op.create_index(
        "ix_customer_password_resets_customer", "customer_password_resets", ["customer_id"],
    )

    # ------------------------------------------------------------------ 7/7 --
    # Separate from `audit_logs`, which is trigger-written and read by the Admin
    # and Super Admin portals. Customer activity must not appear there.
    op.create_table(
        "customer_audit_logs",
        sa.Column("customer_audit_log_id", sa.BigInteger(), primary_key=True),
        # SET NULL, not CASCADE: the record that an account was deleted is the
        # one entry you least want deleted along with it. `customer_code` is
        # copied in so the trail still names who it was afterwards.
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("customer_code", sa.String(length=20), nullable=True),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("module", sa.String(length=60), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("browser", sa.String(length=120), nullable=True),
        sa.Column("device", sa.String(length=120), nullable=True),
        sa.Column(
            "status", _AUDIT_STATUS, nullable=False, server_default=sa.text("'success'"),
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_customer_audit_logs_customer", "customer_audit_logs", ["customer_id", "created_at"],
    )
    op.create_index("ix_customer_audit_logs_created", "customer_audit_logs", ["created_at"])


def downgrade() -> None:
    # Children first: every one of these cascades from `customers`, so the drop
    # order is the insert order reversed.
    op.drop_table("customer_audit_logs")
    op.drop_table("customer_password_resets")
    op.drop_table("customer_otps")
    op.drop_table("customer_sessions")
    op.drop_table("customer_profiles")
    op.drop_table("customer_auth")
    op.drop_table("customers")

    op.execute(f"DROP SEQUENCE IF EXISTS {CODE_SEQ}")

    bind = op.get_bind()
    _AUDIT_STATUS.drop(bind, checkfirst=True)
    _OTP_PURPOSE.drop(bind, checkfirst=True)
    _CUSTOMER_STATUS.drop(bind, checkfirst=True)
