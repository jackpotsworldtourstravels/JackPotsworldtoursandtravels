"""wallet ledger — a real transaction table, and a wallet that may go negative

Revision ID: 0036_wallet_ledger
Revises: 0035_manager_queue_index
Create Date: 2026-08-01

CR-4a. See docs/CR-4_MERCHANT_WALLET.md.

WHY THE NON-NEGATIVE CONSTRAINT GOES
``ck_merchants_wallet_non_negative`` encoded a prepaid model: a merchant could
only spend money it had already sent. CR-4 replaces that with a running account
— the merchant books now and settles later, and a negative wallet *is* the
outstanding balance. Under the old constraint the central case of the new design
(wallet 0, book 15,000, wallet -15,000) is illegal at the database level, so the
constraint is not a safety net here, it is the thing being changed.

What replaces it is not "nothing": exposure is bounded by ``merchants.credit_limit``
in the service layer, which is a *business* limit an admin sets per merchant,
rather than a hard floor at zero identical for everyone.

WHY A TABLE AND NOT MORE JSONB
The wallet ledger has, until now, been improvised inside ``payments``: wallet
rows carry ``request_id IS NULL``, their direction in
``discount_meta->>'wallet_direction'`` and their after-balance as a *string*
under ``discount_meta->>'wallet_balance_after'``. Nothing could query "every
debit in July" without parsing JSON, and no constraint could stop the two
disagreeing. A ledger has a type, two signed columns, a before and an after, an
actor and a reason — that is a row. Same reasoning as 0031 and 0032.

THE INVARIANT IS IN THE DATABASE
``ck_wallet_transactions_balance_math`` asserts
``balance_after = balance_before + credit - debit`` on every row. A ledger whose
own arithmetic can be wrong is decoration. Combined with the backfill below,
``SUM(credit) - SUM(debit)`` per merchant equals ``merchants.wallet_balance``,
and the verification script asserts exactly that.

WHY THE BOOKING-DEBIT INDEX EXISTS BEFORE THE BOOKING DEBIT DOES
``uq_wallet_transactions_booking_debit`` is a partial unique index on
``request_id`` for ``booking_debit`` rows only. CR-4b will debit the wallet when
a booking reaches Ticket Issued, and a retried or replayed transition must not
bill the merchant twice. Idempotency belongs in the schema, not in a service's
good intentions, and the index is cheap to ship with the table it constrains.

WHY ``ON DELETE RESTRICT`` ON THE MERCHANT
Every other child table in this schema cascades. A financial ledger must not:
deleting a company should fail loudly while it still has a balance history, not
silently erase the record of money that moved. Nothing in the codebase deletes a
merchant today (checked), so this costs nothing and closes a door.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0036_wallet_ledger"
down_revision: Union[str, None] = "0035_manager_queue_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TXN_SEQ = "seq_wallet_txn_number"
TOPUP_SEQ = "seq_wallet_topup_number"

_TXN_TYPE = postgresql.ENUM(
    "booking_debit",
    "wallet_recharge",
    "refund_credit",
    "manual_adjustment",
    "credit_note",
    "cancellation_charge",
    name="wallet_txn_type_enum",
    create_type=False,
)
_TOPUP_STATUS = postgresql.ENUM(
    "submitted", "verified", "rejected",
    name="wallet_topup_status_enum",
    create_type=False,
)
_TOPUP_METHOD = postgresql.ENUM(
    "bank_transfer", "upi", "qr", "cash", "other",
    name="wallet_topup_method_enum",
    create_type=False,
)
_ACCOUNT_TYPE = postgresql.ENUM(
    "bank", "upi", "qr",
    name="payment_account_type_enum",
    create_type=False,
)


def upgrade() -> None:
    # -- the constraint this change request exists to remove -----------------
    op.drop_constraint(
        "ck_merchants_wallet_non_negative", "merchants", type_="check"
    )

    # -- enum types ----------------------------------------------------------
    # Created here rather than inline on the columns so the down-migration can
    # drop them explicitly. A *new* type may be used in the transaction that
    # creates it — the restriction CR-2's 0033/0034 split works around applies
    # only to ALTER TYPE ... ADD VALUE on an existing type.
    for enum_type in (_TXN_TYPE, _TOPUP_STATUS, _TOPUP_METHOD, _ACCOUNT_TYPE):
        enum_type.create(op.get_bind(), checkfirst=True)

    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {TXN_SEQ} START WITH 1 INCREMENT BY 1")
    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {TOPUP_SEQ} START WITH 1 INCREMENT BY 1")

    # -- where a merchant sends money ---------------------------------------
    op.create_table(
        "payment_accounts",
        sa.Column("account_id", sa.BigInteger, primary_key=True),
        sa.Column("account_type", _ACCOUNT_TYPE, nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        # Type-specific fields (account number, IFSC, holder, UPI id, ...) as
        # JSONB rather than fifteen mostly-NULL columns: a UPI account and a
        # bank account share almost nothing, and the set grows per payment rail.
        sa.Column(
            "details", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        # Storage key, never a URL. Served through an authenticated endpoint the
        # same way request_documents are — a QR pointing at platform funds is
        # not something to leave statically mounted.
        sa.Column("qr_image_path", sa.String(500), nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("display_order", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column(
            "created_by", sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("length(btrim(label)) > 0", name="ck_payment_accounts_label_not_blank"),
    )
    op.create_index(
        "ix_payment_accounts_active", "payment_accounts", ["is_active", "display_order"]
    )

    # -- what the merchant says it sent -------------------------------------
    op.create_table(
        "wallet_topups",
        sa.Column("topup_id", sa.BigInteger, primary_key=True),
        sa.Column("topup_number", sa.String(32), nullable=False),
        sa.Column(
            "merchant_id", sa.BigInteger,
            sa.ForeignKey("merchants.merchant_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("method", _TOPUP_METHOD, nullable=False),
        # Which of the platform's accounts the money was sent to. SET NULL, not
        # CASCADE: retiring a bank account must not erase the top-ups paid into
        # it. The label is denormalised for exactly that reason.
        sa.Column(
            "payment_account_id", sa.BigInteger,
            sa.ForeignKey("payment_accounts.account_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("payment_account_label", sa.String(120), nullable=True),
        sa.Column("utr", sa.String(64), nullable=True),
        sa.Column("proof_path", sa.String(500), nullable=True),
        sa.Column("proof_filename", sa.String(255), nullable=True),
        sa.Column("proof_content_type", sa.String(100), nullable=True),
        sa.Column("proof_size_bytes", sa.BigInteger, nullable=True),
        sa.Column(
            "status", _TOPUP_STATUS, nullable=False, server_default=sa.text("'submitted'")
        ),
        sa.Column(
            "submitted_by", sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column(
            "reviewed_by", sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_remarks", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("amount > 0", name="ck_wallet_topups_amount_positive"),
        sa.UniqueConstraint("topup_number", name="uq_wallet_topups_number"),
    )
    op.create_index(
        "ix_wallet_topups_merchant", "wallet_topups", ["merchant_id", "topup_id"]
    )
    # The verification queue: submitted first, oldest first. Partial, because
    # verified and rejected rows are history and never queried this way.
    op.create_index(
        "ix_wallet_topups_queue", "wallet_topups", ["submitted_at"],
        postgresql_where=sa.text("status = 'submitted'"),
    )
    # A bank reference identifies one real transfer. Letting two merchants — or
    # one merchant twice — claim the same UTR is how a single payment gets
    # credited twice, which is the fraud this table exists to make auditable.
    op.create_index(
        "uq_wallet_topups_utr", "wallet_topups", ["utr"], unique=True,
        postgresql_where=sa.text("utr IS NOT NULL AND status <> 'rejected'"),
    )

    # -- the ledger itself ---------------------------------------------------
    op.create_table(
        "wallet_transactions",
        sa.Column("txn_id", sa.BigInteger, primary_key=True),
        sa.Column("txn_number", sa.String(32), nullable=False),
        sa.Column(
            "merchant_id", sa.BigInteger,
            sa.ForeignKey("merchants.merchant_id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column("txn_type", _TXN_TYPE, nullable=False),
        sa.Column("debit", sa.Numeric(14, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("credit", sa.Numeric(14, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("balance_before", sa.Numeric(14, 2), nullable=False),
        sa.Column("balance_after", sa.Numeric(14, 2), nullable=False),
        # What caused it. All nullable and all SET NULL: a manual adjustment has
        # no booking, a booking debit has no top-up, and losing the cause must
        # never delete the money movement.
        sa.Column(
            "request_id", sa.BigInteger,
            sa.ForeignKey("service_requests.request_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "payment_id", sa.BigInteger,
            sa.ForeignKey("payments.payment_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "topup_id", sa.BigInteger,
            sa.ForeignKey("wallet_topups.topup_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("reason", sa.Text, nullable=True),
        sa.Column(
            "created_by", sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("debit >= 0", name="ck_wallet_transactions_debit_non_negative"),
        sa.CheckConstraint("credit >= 0", name="ck_wallet_transactions_credit_non_negative"),
        # Exactly one direction per row. A row that is both is unreadable on a
        # statement, and a row that is neither moved nothing and should not exist.
        sa.CheckConstraint(
            "(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)",
            name="ck_wallet_transactions_one_direction",
        ),
        sa.CheckConstraint(
            "balance_after = balance_before + credit - debit",
            name="ck_wallet_transactions_balance_math",
        ),
        sa.UniqueConstraint("txn_number", name="uq_wallet_transactions_number"),
    )
    # A statement is read oldest-first for one merchant; this covers it whole.
    #
    # ORDERED BY txn_id, NOT created_at. ``created_at`` defaults to ``now()``,
    # which in PostgreSQL is the *transaction start* time — so two concurrent
    # movements can carry timestamps in the opposite order to the one in which
    # they actually took the merchant's row lock and moved the balance. Ordering
    # a statement that way renders a running balance that appears to jump
    # backwards. ``txn_id`` is allocated at INSERT, which is always after the
    # lock is granted, so it is the only key that matches the balance chain.
    # Found by tests/verify_cr4a.py, not reasoned about.
    op.create_index(
        "ix_wallet_transactions_merchant",
        "wallet_transactions", ["merchant_id", "txn_id"],
    )
    # created_at is still filtered on ("show me July"), just never ordered by.
    op.create_index(
        "ix_wallet_transactions_merchant_date",
        "wallet_transactions", ["merchant_id", "created_at"],
    )
    op.create_index("ix_wallet_transactions_request", "wallet_transactions", ["request_id"])
    op.create_index("ix_wallet_transactions_topup", "wallet_transactions", ["topup_id"])
    # See the module docstring: CR-4b's auto-debit must be replay-safe.
    op.create_index(
        "uq_wallet_transactions_booking_debit",
        "wallet_transactions", ["request_id"], unique=True,
        postgresql_where=sa.text("txn_type = 'booking_debit' AND request_id IS NOT NULL"),
    )

    # Mutable rows, so their history is worth auditing. wallet_transactions is
    # deliberately NOT audited: it is append-only and already carries created_by,
    # created_at and a reason, so a trigger would duplicate the ledger into
    # audit_logs and double the write cost of every money movement.
    for table, pk in (("wallet_topups", "topup_id"), ("payment_accounts", "account_id")):
        op.execute(
            f"""
            CREATE TRIGGER trg_audit_{table}
            AFTER INSERT OR UPDATE OR DELETE ON {table}
            FOR EACH ROW EXECUTE FUNCTION fn_write_audit_log('{pk}')
            """
        )

    _backfill()


def _backfill() -> None:
    """Reconstruct the ledger from the wallet rows already in ``payments``.

    Every wallet movement the platform has ever made went through
    ``finance_service.adjust_wallet``, which always wrote a ``payments`` row
    carrying ``discount_meta->>'wallet_direction'``. That is the whole history
    and it is exactly identifiable.

    The running balance is reconstructed **backwards from the current balance**,
    not forwards from zero: ``merchants.wallet_balance`` is what the platform
    actually owes and shows today, and a backfill that disagreed with it would
    be introducing the drift this table exists to prevent. So each merchant gets
    a synthetic opening row for ``wallet_balance - SUM(movements)`` whenever that
    is non-zero — which is honest about the fact that some balances predate any
    ledger row rather than silently absorbing the difference.
    """
    op.execute(
        """
        INSERT INTO wallet_transactions (
            txn_number, merchant_id, txn_type, debit, credit,
            balance_before, balance_after, payment_id, reason, created_by, created_at
        )
        WITH moves AS (
            SELECT p.payment_id,
                   p.merchant_id,
                   COALESCE(p.paid_date, p.created_at)          AS at,
                   CASE WHEN p.discount_meta->>'wallet_direction' = 'credit'
                        THEN p.amount ELSE -p.amount END        AS delta,
                   p.payment_type::text                         AS ptype,
                   p.refund_reason                              AS reason,
                   p.user_id
            FROM payments p
            WHERE p.merchant_id IS NOT NULL
              AND p.discount_meta->>'wallet_direction' IS NOT NULL
        ),
        opening AS (
            SELECT m.merchant_id,
                   m.created_at AS at,
                   m.wallet_balance - COALESCE(
                       (SELECT SUM(x.delta) FROM moves x WHERE x.merchant_id = m.merchant_id), 0
                   ) AS delta
            FROM merchants m
        ),
        all_rows AS (
            SELECT merchant_id, at, delta,
                   NULL::bigint AS payment_id,
                   NULL::text   AS ptype,
                   'Opening balance carried into the wallet ledger (CR-4a backfill)' AS reason,
                   NULL::bigint AS user_id,
                   0 AS ord
            FROM opening WHERE delta <> 0
            UNION ALL
            SELECT merchant_id, at, delta, payment_id, ptype, reason, user_id, 1 AS ord
            FROM moves
        ),
        ordered AS (
            SELECT all_rows.*,
                   SUM(delta) OVER (
                       PARTITION BY merchant_id
                       ORDER BY ord, at, payment_id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   ) AS running,
                   ROW_NUMBER() OVER (ORDER BY merchant_id, ord, at, payment_id) AS rn
            FROM all_rows
        )
        SELECT 'WTX-' || to_char(at, 'YYYYMMDD') || '-' || lpad(rn::text, 6, '0'),
               merchant_id,
               (CASE
                   WHEN payment_id IS NULL                       THEN 'manual_adjustment'
                   WHEN delta > 0 AND ptype = 'wallet_topup'     THEN 'wallet_recharge'
                   WHEN delta > 0                                THEN 'refund_credit'
                   WHEN reason LIKE 'Paid against %'             THEN 'booking_debit'
                   ELSE 'manual_adjustment'
               END)::wallet_txn_type_enum,
               CASE WHEN delta < 0 THEN -delta ELSE 0 END,
               CASE WHEN delta > 0 THEN  delta ELSE 0 END,
               running - delta,
               running,
               payment_id,
               reason,
               user_id,
               at
        FROM ordered
        """
    )
    # Keep the sequence ahead of the numbers the backfill just issued, so the
    # first live transaction cannot collide with uq_wallet_transactions_number.
    op.execute(
        f"""
        SELECT setval(
            '{TXN_SEQ}',
            GREATEST(COALESCE((
                SELECT MAX(NULLIF(split_part(txn_number, '-', 3), '')::bigint)
                FROM wallet_transactions WHERE txn_number LIKE 'WTX-%'
            ), 0), 1)
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_audit_payment_accounts ON payment_accounts")
    op.execute("DROP TRIGGER IF EXISTS trg_audit_wallet_topups ON wallet_topups")

    op.drop_table("wallet_transactions")
    op.drop_table("wallet_topups")
    op.drop_table("payment_accounts")

    op.execute(f"DROP SEQUENCE IF EXISTS {TOPUP_SEQ}")
    op.execute(f"DROP SEQUENCE IF EXISTS {TXN_SEQ}")

    for enum_type in (_ACCOUNT_TYPE, _TOPUP_METHOD, _TOPUP_STATUS, _TXN_TYPE):
        enum_type.drop(op.get_bind(), checkfirst=True)

    # Restoring the constraint can fail — by design. If any merchant is running
    # a negative balance, that is real money owed under the new model and the
    # rollback must stop rather than silently pretend otherwise. Settle those
    # accounts first, then downgrade.
    op.create_check_constraint(
        "ck_merchants_wallet_non_negative", "merchants", "wallet_balance >= 0"
    )
