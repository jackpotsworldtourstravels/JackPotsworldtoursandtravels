"""customer_admin_audit_logs -- the B2C administrative audit trail (Stage 2).

The authoritative record of what a B2B administrator did to B2C data. SEPARATE
from ``customer_audit_logs`` (the customer's own trail) and from the B2B
``audit_logs``/``system_logs``; it lives on ``models_customer.Base`` in the ONE
shared database (logical separation, single Alembic history -- no second engine
or history).

HAND-WRITTEN on purpose: ``alembic/env.py`` targets the legacy ``app.models``
Base, so autogenerate sees neither ``models_v2`` nor ``models_customer``. This
file is the DDL for ``app.models_customer.CustomerAdminAuditLog`` and must track
that model exactly.

WHAT THIS CREATES
  1. the enum type ``customer_admin_audit_outcome_enum`` (the model declares the
     column with ``create_type=False``, so the migration owns ``CREATE TYPE``);
  2. the ``customer_admin_audit_logs`` table -- the actor is a value SNAPSHOT
     (``admin_user_id`` is a plain ``BigInteger``, NEVER a foreign key: the
     customer schema does not reach into B2B ``users`` -- same rule as 0089/0094);
  3. every index the model declares (see the index block for the 1:1 mapping);
  4. a PARTIAL UNIQUE index that makes a duplicate terminal financial-success row
     impossible (spec Section 13.5), belt-and-braces over the "one SUCCEEDED
     transition per attempt" guard in the refund service;
  5. an append-only trigger (spec D3): ``BEFORE UPDATE OR DELETE`` raises, so even
     a stray query cannot rewrite history.

NOT HERE, ON PURPOSE
  * No ``GRANT``/``REVOKE``. The privilege model (app login gets INSERT+SELECT
    only; UPDATE/DELETE/TRUNCATE revoked) is a DBA step issued out-of-band with
    this migration, not executed by it (spec D3).
  * Not executed by this change. Creating the file only (Stage 2B).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0095_customer_admin_audit_logs"
down_revision: Union[str, None] = "0094_customer_refund_attempts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "customer_admin_audit_logs"
OUTCOME_ENUM = "customer_admin_audit_outcome_enum"
#: Lowercase VALUES, matching ``AdminAuditOutcome`` + its ``values_callable``.
OUTCOME_VALUES = ("success", "failure", "denied", "partial")


def upgrade() -> None:
    op.execute(
        "CREATE TYPE " + OUTCOME_ENUM + " AS ENUM ("
        + ", ".join(f"'{v}'" for v in OUTCOME_VALUES) + ")"
    )

    op.create_table(
        TABLE,
        sa.Column("customer_admin_audit_log_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        # --- actor SNAPSHOT (no FK to B2B users). Nullable: the system / no-admin
        #     path (reconciliation, anonymous denial) writes a row with no id. ---
        sa.Column("admin_user_id", sa.BigInteger(), nullable=True),
        sa.Column("admin_email", sa.String(length=255), nullable=True),
        sa.Column("admin_name", sa.String(length=150), nullable=True),
        sa.Column("admin_role", sa.String(length=40), nullable=True),
        sa.Column("environment", sa.String(length=8), nullable=False, server_default=sa.text("'b2c'")),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("entity_type", sa.String(length=60), nullable=True),
        sa.Column("entity_id", sa.String(length=64), nullable=True),
        sa.Column("outcome", postgresql.ENUM(name=OUTCOME_ENUM, create_type=False), nullable=False),
        sa.Column("retention_class", sa.String(length=12), nullable=False, server_default=sa.text("'ordinary'")),
        # redacted business fields only -- never whole rows, never secrets
        sa.Column("previous_value", postgresql.JSONB(), nullable=True),
        sa.Column("new_value", postgresql.JSONB(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("browser", sa.String(length=120), nullable=True),
        sa.Column("device", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # --- Indexes: a 1:1 mapping of what CustomerAdminAuditLog declares. ---------
    # Column-level ``index=True`` on the model (SQLAlchemy's default name):
    op.create_index("ix_customer_admin_audit_logs_request_id", TABLE, ["request_id"])
    # Named __table_args__ indexes on the model. ix_cust_admin_audit_actor is the
    # ONLY index on admin_user_id (the column's index=True was removed as a
    # redundant duplicate, keeping model and migration consistent):
    op.create_index("ix_cust_admin_audit_actor", TABLE, ["admin_user_id"])
    op.create_index("ix_cust_admin_audit_entity", TABLE, ["entity_type", "entity_id"])
    op.create_index("ix_cust_admin_audit_action", TABLE, ["action"])
    op.create_index("ix_cust_admin_audit_outcome", TABLE, ["outcome"])
    op.create_index("ix_cust_admin_audit_retention", TABLE, ["retention_class"])
    # created_at DESC (matches Index("...created", text("created_at DESC"))):
    op.execute(
        "CREATE INDEX ix_cust_admin_audit_created "
        "ON " + TABLE + " (created_at DESC)"
    )

    # --- Belt-and-braces refund-success dedup (spec Section 13.5). -------------
    # Postgres-only partial UNIQUE index enforcing AT MOST ONE success row per
    # refund ATTEMPT. Every money-success event (sync execute/authorize AND the
    # reconciliation finalise) is written with entity_type='customer_refund_attempt'
    # and entity_id=refund_attempt_id, and apply_provider_refund fires exactly once
    # per attempt (the SUCCEEDED status guard). So:
    #   * legitimate SEPARATE attempts are never suppressed — each is a distinct
    #     refund_attempt_id, hence a distinct entity_id;
    #   * ``action`` is intentionally NOT in the key — whichever path drove the
    #     single SUCCEEDED transition (execute / authorize / reconcile_finalize),
    #     there is one success per attempt, so keying on the attempt is stricter
    #     and correct;
    #   * the predicate is scoped to entity_type='customer_refund_attempt' ONLY,
    #     so unrelated financial successes (e.g. a legitimate repeated
    #     report.export) are NOT caught by this uniqueness.
    # NULL entity_id rows are distinct under UNIQUE semantics. Deliberately NOT on
    # the model: a partial index's WHERE clause is not portable to the SQLite test
    # engine, where it would wrongly become a full unique index.
    op.create_index(
        "uq_cust_admin_audit_refund_success", TABLE,
        ["entity_type", "entity_id"], unique=True,
        postgresql_where=sa.text("outcome = 'success' AND entity_type = 'customer_refund_attempt'"),
    )

    # --- Append-only enforcement at the database (spec D3). --------------------
    op.execute(
        """
        CREATE OR REPLACE FUNCTION fn_block_customer_admin_audit_mutation()
        RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'customer_admin_audit_logs is append-only';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_block_customer_admin_audit_mutation
        BEFORE UPDATE OR DELETE ON customer_admin_audit_logs
        FOR EACH ROW EXECUTE FUNCTION fn_block_customer_admin_audit_mutation();
        """
    )


def downgrade() -> None:
    # Reverse order; each guarded with IF EXISTS. NOTE: this DESTROYS audit
    # history and is gated behind the same approval as any destructive op --
    # rolling back a bad deploy reverts code, not this migration.
    op.execute("DROP TRIGGER IF EXISTS trg_block_customer_admin_audit_mutation ON customer_admin_audit_logs")
    op.execute("DROP FUNCTION IF EXISTS fn_block_customer_admin_audit_mutation()")
    op.drop_table(TABLE)  # drops its indexes (incl. the partial unique) with it
    op.execute("DROP TYPE IF EXISTS " + OUTCOME_ENUM)
