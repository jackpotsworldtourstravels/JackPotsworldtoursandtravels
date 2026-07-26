-- =========================================================================
-- 02_shared_tables.sql
-- Shared domain: catalog, reference, and public/anonymous business data
-- ONLY. Per the v2 architecture, no authentication, profile, session, or
-- activity-log table may live here -- those are now fully owned by their
-- respective Admin / Merchant / User domain files.
--
-- v2 changes from v1:
--   - `roles`, `permissions`, `role_permissions` are RETIRED. They existed
--     only to let `users` and `partner_users` share one RBAC mechanism --
--     exactly the cross-domain coupling this redesign eliminates. Each
--     domain now owns its own equivalent: see 03_admin_tables.sql
--     (admin_roles/admin_permissions) and 04_partner_tables.sql
--     (partner_staff.role_type/member_role enums, already the real
--     mechanism the UI uses today).
--   - 8 new lookup tables added per your target list: states, cities,
--     currencies, languages, airports, airlines, hotel_chains, cruise_lines.
--     None are wired as foreign keys into flights/hotels/cruises/
--     partner_bookings yet -- those tables still store airline/airport/
--     location names as free text, exactly as the live app does today.
--     Retrofitting them to FK these new lookups would change existing
--     booking behavior (dropdown vs free text) beyond a database change,
--     so they are provisioned standalone for now. See DATABASE_STRUCTURE.md.
--   - package_images, payment_methods, system_settings, audit_logs are new,
--     also provisioned (no current frontend uses them yet).
--   - seasonal_prices, coupons, discount_campaigns, contact_us, newsletter
--     are kept even though not named in your list -- they are genuinely
--     catalog/business/public data (satisfies rule 6) and existing live
--     functionality depends on them (contact form, newsletter signup,
--     coupon codes at checkout).
-- =========================================================================

CREATE TABLE countries (
    country_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    iso2 CHAR(2) NOT NULL,
    iso3 CHAR(3) NOT NULL,
    phone_code VARCHAR(6)
);

-- NEW -- provisioned, no current UI (customer/merchant address fields are
-- free-text state/city inputs, not dropdowns backed by lookup tables).
CREATE TABLE states (
    id SERIAL PRIMARY KEY,
    country_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(10)
);

-- NEW -- provisioned, same reasoning as `states`.
CREATE TABLE cities (
    id SERIAL PRIMARY KEY,
    state_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL
);

-- NEW -- provisioned, no currency switcher exists anywhere in the app
-- (all prices are NUMERIC with an implicit single currency today).
CREATE TABLE currencies (
    id SERIAL PRIMARY KEY,
    code CHAR(3) NOT NULL,
    name VARCHAR(50) NOT NULL,
    symbol VARCHAR(5)
);

-- NEW -- provisioned, no language switcher exists anywhere in the app.
CREATE TABLE languages (
    id SERIAL PRIMARY KEY,
    code VARCHAR(10) NOT NULL,
    name VARCHAR(50) NOT NULL
);

-- NEW -- provisioned. `flights.from_airport`/`to_airport` remain free text
-- (see file header) -- not yet FK'd to this table.
CREATE TABLE airports (
    id SERIAL PRIMARY KEY,
    iata_code CHAR(3) NOT NULL,
    name VARCHAR(150) NOT NULL,
    city_id INTEGER,
    country_id INTEGER
);

-- NEW -- provisioned. `flights.airline` remains free text.
CREATE TABLE airlines (
    id SERIAL PRIMARY KEY,
    iata_code VARCHAR(3),
    name VARCHAR(100) NOT NULL
);

-- KEPT (real, unchanged) -- core sellable catalog, searched by both the
-- customer portal and the Merchant Portal's Ticket Enquiry. Not in your
-- literal list, but load-bearing: partner_bookings.flight_id and
-- vw_ticket_enquiry both depend on it, and dropping it would break the
-- flight-booking flow entirely.
CREATE TABLE flights (
    id SERIAL PRIMARY KEY,
    airline VARCHAR(100) NOT NULL,
    from_airport VARCHAR(100) NOT NULL,
    to_airport VARCHAR(100) NOT NULL,
    departure_time TIMESTAMP NOT NULL,
    arrival_time TIMESTAMP NOT NULL,
    cabin_class VARCHAR(30) NOT NULL DEFAULT 'Economy',
    price NUMERIC(10,2) NOT NULL,
    seats_available INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    low_stock_threshold INTEGER NOT NULL DEFAULT 5
);

-- NEW -- provisioned. `hotels` has no chain concept in the live schema.
CREATE TABLE hotel_chains (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL
);

CREATE TABLE hotels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    location VARCHAR(150) NOT NULL,
    price_per_night NUMERIC(10,2) NOT NULL,
    rating DOUBLE PRECISION NOT NULL DEFAULT 0,
    amenities VARCHAR(500),
    image_url VARCHAR(500),
    rooms_available INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    low_stock_threshold INTEGER NOT NULL DEFAULT 5
);

-- NEW -- provisioned. `cruises` has no cruise-line concept in the live schema.
CREATE TABLE cruise_lines (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL
);

CREATE TABLE cruises (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    cruise_type VARCHAR(100) NOT NULL,
    departure_port VARCHAR(150) NOT NULL,
    duration_days INTEGER NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    departure_month VARCHAR(20) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    cabins_available INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE tour_packages (
    id SERIAL PRIMARY KEY,
    title VARCHAR(150) NOT NULL,
    package_type VARCHAR(100) NOT NULL,
    duration_days INTEGER NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    rating DOUBLE PRECISION NOT NULL DEFAULT 0,
    description VARCHAR(1000),
    image_url VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    available_month VARCHAR(20),
    capacity INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 5
);

-- NEW -- provisioned. `tour_packages.image_url` (single field) is the only
-- image the live UI reads/writes today; this table is for a future
-- multi-image gallery.
CREATE TABLE package_images (
    id SERIAL PRIMARY KEY,
    package_id INTEGER NOT NULL,
    image_url VARCHAR(500) NOT NULL,
    display_order SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE seasonal_prices (
    id SERIAL PRIMARY KEY,
    item_type VARCHAR(30) NOT NULL,
    item_id INTEGER NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    override_price NUMERIC(10,2) NOT NULL,
    label VARCHAR(150),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE coupons (
    id SERIAL PRIMARY KEY,
    code VARCHAR(40) NOT NULL,
    description VARCHAR(500),
    discount_type VARCHAR(10) NOT NULL,
    discount_value NUMERIC(10,2) NOT NULL,
    applicable_type VARCHAR(30),
    min_booking_amount NUMERIC(10,2),
    usage_limit INTEGER,
    times_used INTEGER NOT NULL DEFAULT 0,
    valid_from DATE NOT NULL,
    valid_until DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE discount_campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description VARCHAR(500),
    discount_type VARCHAR(10) NOT NULL,
    discount_value NUMERIC(10,2) NOT NULL,
    applicable_type VARCHAR(30),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- NEW -- provisioned. `bookings.method`/`payments.method` (now
-- user_bookings/user_payments) remain free text, exactly as the live app
-- stores them today -- not yet FK'd to this table.
CREATE TABLE payment_methods (
    id SERIAL PRIMARY KEY,
    code VARCHAR(30) NOT NULL,
    name VARCHAR(80) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
);

-- NEW -- provisioned. No settings screen exists in any portal yet.
CREATE TABLE system_settings (
    id SERIAL PRIMARY KEY,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    description VARCHAR(300),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- NEW -- narrowly scoped: a changelog for changes to THIS file's own
-- catalog/settings data (e.g. an admin editing a flight price or a
-- system_settings value), attributed to the admin who made the change.
-- This is NOT a cross-domain user/merchant/admin activity feed -- that
-- would violate rule 5 (no shared activity log). Each domain keeps its own
-- activity log (admin_activity_logs / partner_activity_logs /
-- user_activity_logs); this one exists only because Shared-domain data has
-- no natural "owning domain" activity log of its own.
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,
    entity_id INTEGER,
    action VARCHAR(100) NOT NULL,
    changed_by_admin_id INTEGER,
    old_value TEXT,
    new_value TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE contact_us (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(30),
    subject VARCHAR(200),
    message VARCHAR(2000) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE newsletter (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    subscribed_at TIMESTAMP NOT NULL DEFAULT now()
);
