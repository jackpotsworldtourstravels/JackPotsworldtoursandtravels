"""partner portal — role_type/member_role become the real authorization mechanism, retire role_id

Revision ID: 0024_partner_role_type_authorization
Revises: 0023_core_schema_hardening
Create Date: 2026-07-27

Stage 1 of the domain-separation cutover (docs/DATABASE_STRUCTURE.md). Research
found the doc's assumption wrong: partner_users.role_id (a FK into the shared
roles table) was still the live authorization check in
get_current_partner_admin() — role_type/member_role existed in parallel, not
as a replacement. This migration re-applies the updated trigger/procedure
bodies (get_current_partner_admin, admin_merchant_service, and the raw SQL
here were already changed to stop reading/writing role_id in the same pass),
makes role_type/member_role NOT NULL (verified: no existing row has either
NULL), then drops the now-unused role_id column, its index, and its FK into
`roles`. Purely a cleanup of an already-decoupled dependency — no application
behavior depends on role_id after this point.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0024_partner_role_type_auth"
down_revision: Union[str, None] = "0023_core_schema_hardening"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Re-apply the updated function bodies (source of truth: 09_triggers.sql /
    # 10_stored_procedures_auth_and_reference.sql / gap_completion/05_stored_procedures.sql).
    # CREATE OR REPLACE FUNCTION is idempotent — safe to run standalone here
    # without re-running the CREATE TRIGGER statements in the same files
    # (those already exist and are not being changed).
    op.execute("""
        CREATE OR REPLACE FUNCTION fn_audit_partner_users()
        RETURNS TRIGGER AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
                VALUES (NEW.partner_id, NEW.partner_user_id, 'partner_user_created', 'partner_users', NEW.partner_user_id,
                        NEW.full_name || ' (' || NEW.email || ') added');
            ELSIF TG_OP = 'UPDATE' AND (
                NEW.status IS DISTINCT FROM OLD.status
                OR NEW.role_type IS DISTINCT FROM OLD.role_type
                OR NEW.member_role IS DISTINCT FROM OLD.member_role
            ) THEN
                INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
                VALUES (NEW.partner_id, NEW.partner_user_id, 'partner_user_updated', 'partner_users', NEW.partner_user_id,
                        'Status/role changed for ' || NEW.email);
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

    op.execute("""
        -- Return type (OUT params) changed from the original (role_id INTEGER)
        -- to (role_type merchant_role_type_enum) — Postgres requires DROP
        -- before CREATE for a signature change; CREATE OR REPLACE only
        -- covers body changes with the same return type.
        DROP FUNCTION IF EXISTS sp_partner_login_lookup(VARCHAR);

        CREATE FUNCTION sp_partner_login_lookup(p_email VARCHAR)
        RETURNS TABLE (
            partner_user_id  INTEGER,
            partner_id        INTEGER,
            password_hash      VARCHAR,
            status              partner_user_status_enum,
            role_type           merchant_role_type_enum,
            full_name           VARCHAR
        ) AS $$
        BEGIN
            RETURN QUERY
            SELECT pu.partner_user_id, pu.partner_id, pu.password_hash, pu.status, pu.role_type, pu.full_name
            FROM partner_users pu
            WHERE pu.email = p_email;
        END;
        $$ LANGUAGE plpgsql STABLE;
    """)

    op.execute("""
        -- Old signature's 9th parameter was VARCHAR (p_role_name); the new
        -- one is a different argument-type list (merchant_role_type_enum +
        -- an added 10th param), which Postgres would treat as a distinct
        -- overload rather than a replacement — drop the old one explicitly
        -- so no stale function referencing the dropped role_id path remains.
        DROP FUNCTION IF EXISTS sp_register_partner(
            VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR
        );

        CREATE FUNCTION sp_register_partner(
            p_company_name        VARCHAR,
            p_company_code         VARCHAR,
            p_reference_prefix      VARCHAR,
            p_partner_email           VARCHAR,
            p_phone_number              VARCHAR,
            p_admin_full_name             VARCHAR,
            p_admin_email                   VARCHAR,
            p_admin_password_hash             VARCHAR,
            p_role_type                         merchant_role_type_enum DEFAULT 'admin',
            p_member_role                        merchant_member_role_enum DEFAULT 'admin'
        )
        RETURNS TABLE (partner_id INTEGER, partner_user_id INTEGER) AS $$
        DECLARE
            v_partner_id       INTEGER;
            v_partner_user_id  INTEGER;
        BEGIN
            INSERT INTO partners (company_name, company_code, reference_prefix, email, phone_number, status)
            VALUES (p_company_name, p_company_code, p_reference_prefix, p_partner_email, p_phone_number, 'active')
            RETURNING partners.partner_id INTO v_partner_id;

            INSERT INTO partner_users (partner_id, full_name, email, password_hash, role_type, member_role, status)
            VALUES (v_partner_id, p_admin_full_name, p_admin_email, p_admin_password_hash, p_role_type, p_member_role, 'active')
            RETURNING partner_users.partner_user_id INTO v_partner_user_id;

            RETURN QUERY SELECT v_partner_id, v_partner_user_id;
        END;
        $$ LANGUAGE plpgsql;
    """)

    op.execute("""
        ALTER TABLE partner_users
            ALTER COLUMN role_type SET NOT NULL,
            ALTER COLUMN member_role SET NOT NULL;

        DROP INDEX IF EXISTS idx_partner_users_role_id;
        ALTER TABLE partner_users DROP COLUMN role_id;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE partner_users ADD COLUMN role_id INTEGER REFERENCES roles (id);
        UPDATE partner_users SET role_id = (
            SELECT id FROM roles WHERE name = CASE WHEN partner_users.role_type = 'admin' THEN 'partner_admin' ELSE 'partner_staff' END
        );
        ALTER TABLE partner_users ALTER COLUMN role_id SET NOT NULL;
        CREATE INDEX idx_partner_users_role_id ON partner_users (role_id);

        ALTER TABLE partner_users
            ALTER COLUMN role_type DROP NOT NULL,
            ALTER COLUMN member_role DROP NOT NULL;
    """)

    op.execute("""
        DROP FUNCTION IF EXISTS sp_partner_login_lookup(VARCHAR);

        CREATE FUNCTION sp_partner_login_lookup(p_email VARCHAR)
        RETURNS TABLE (
            partner_user_id  INTEGER,
            partner_id        INTEGER,
            password_hash      VARCHAR,
            status              partner_user_status_enum,
            role_id             INTEGER,
            full_name           VARCHAR
        ) AS $$
        BEGIN
            RETURN QUERY
            SELECT pu.partner_user_id, pu.partner_id, pu.password_hash, pu.status, pu.role_id, pu.full_name
            FROM partner_users pu
            WHERE pu.email = p_email;
        END;
        $$ LANGUAGE plpgsql STABLE;
    """)

    op.execute("""
        CREATE OR REPLACE FUNCTION fn_audit_partner_users()
        RETURNS TRIGGER AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
                VALUES (NEW.partner_id, NEW.partner_user_id, 'partner_user_created', 'partner_users', NEW.partner_user_id,
                        NEW.full_name || ' (' || NEW.email || ') added');
            ELSIF TG_OP = 'UPDATE' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.role_id IS DISTINCT FROM OLD.role_id) THEN
                INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
                VALUES (NEW.partner_id, NEW.partner_user_id, 'partner_user_updated', 'partner_users', NEW.partner_user_id,
                        'Status/role changed for ' || NEW.email);
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)
