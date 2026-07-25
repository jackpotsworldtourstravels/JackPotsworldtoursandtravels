-- Partner Portal — 02: Reference / lookup tables
-- Depends on: existing `roles` table (from the core schema, app/models/user.py)

CREATE TABLE countries (
    country_id  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    iso2        CHAR(2) NOT NULL,
    iso3        CHAR(3) NOT NULL,
    phone_code  VARCHAR(6),
    CONSTRAINT uq_countries_name UNIQUE (name),
    CONSTRAINT uq_countries_iso2 UNIQUE (iso2),
    CONSTRAINT uq_countries_iso3 UNIQUE (iso3)
);

CREATE TABLE permissions (
    permission_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    permission_key  VARCHAR(80) NOT NULL,
    description     VARCHAR(200),
    CONSTRAINT uq_permissions_key UNIQUE (permission_key)
);

-- Joins the EXISTING `roles` table (not duplicated here) to the new `permissions`
-- table. `roles.id` must already exist for the rows this schema expects —
-- see 14_seed_reference_data.sql for the two new partner-scoped role rows
-- ('partner_admin', 'partner_staff') inserted into that existing table.
CREATE TABLE role_permissions (
    role_id        INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    permission_id  INTEGER NOT NULL REFERENCES permissions (permission_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_role_permissions_permission_id ON role_permissions (permission_id);
