-- =========================================================================
-- 05_user_tables.sql
-- User (Customer) Portal domain. Owns its OWN authentication, profile,
-- session, and activity data -- no table here is shared with Admin or
-- Merchant.
--
-- v2 changes from v1:
--   - `users.role_id` is DROPPED. It only ever existed to distinguish
--     admin rows (roles.name = 'admin') from customer rows within the same
--     shared table -- exactly the mixing this whole redesign eliminates.
--     Now that Admin is fully split into its own `admins` table, every row
--     in `users` is implicitly a customer; there is no other role a
--     customer account can have in this app, so the column (and the
--     shared `roles` table it pointed at) is retired rather than kept as
--     dead weight.
--   - activity_logs -> user_activity_logs, bookings -> user_bookings,
--     payments -> user_payments, reviews -> user_reviews,
--     wishlist -> user_wishlist, support_tickets -> user_support_tickets,
--     notifications -> user_notifications (renamed for domain-prefix
--     naming consistency with Admin/Merchant; columns unchanged).
--   - user_addresses (NEW): the live customer profile form has a single
--     free-text Address field, which stays on user_profiles.address
--     unchanged. This table is provisioned for a future multi-address
--     (billing/shipping) feature -- not wired to any form today.
--   - booking_passengers (NEW): the live core booking flow only has a
--     passenger-COUNT dropdown ("1 Passenger" / "2 Passengers" / ...),
--     not a named-passenger sub-form (unlike the Merchant Portal's
--     partner_booking_passengers). Provisioned, minimal columns, no
--     current UI.
-- =========================================================================

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    hashed_password VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    reset_token_hash VARCHAR(255),
    reset_token_expires_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now(),
    last_login_at TIMESTAMP,
    login_count INTEGER NOT NULL DEFAULT 0,
    is_blocked BOOLEAN NOT NULL DEFAULT false,
    is_verified BOOLEAN NOT NULL DEFAULT true,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMP,
    force_logout_at TIMESTAMP
);

CREATE TABLE user_profiles (
    user_id INTEGER PRIMARY KEY,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    mobile VARCHAR(20),
    gender gender_enum,
    dob DATE,
    country VARCHAR(100),
    state VARCHAR(100),
    city VARCHAR(100),
    address VARCHAR(300),
    profile_photo VARCHAR(500)
);

-- NEW -- provisioned. See file header.
CREATE TABLE user_addresses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    label VARCHAR(30) DEFAULT 'home',
    address_line VARCHAR(300) NOT NULL,
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100),
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE user_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    login_at TIMESTAMP NOT NULL DEFAULT now(),
    logout_at TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT now(),
    current_page VARCHAR(200),
    ip_address VARCHAR(50),
    browser VARCHAR(60),
    os VARCHAR(60),
    device VARCHAR(60),
    is_active BOOLEAN NOT NULL DEFAULT true
);

-- Renamed from activity_logs.
CREATE TABLE user_activity_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    action VARCHAR(200) NOT NULL,
    ip_address VARCHAR(50),
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    activity_type VARCHAR(60),
    module VARCHAR(40),
    description VARCHAR(500),
    reference_id INTEGER,
    browser VARCHAR(60),
    device VARCHAR(60),
    status VARCHAR(20) NOT NULL DEFAULT 'success'
);

-- Renamed from bookings.
CREATE TABLE user_bookings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    booking_type VARCHAR(30) NOT NULL,
    item_id INTEGER NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    total_price NUMERIC(10,2) NOT NULL,
    travel_date DATE,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    quantity INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT now(),
    coupon_code VARCHAR(40),
    discount_amount NUMERIC(10,2)
);

-- NEW -- provisioned. See file header. Mirrors partner_booking_passengers'
-- core identity fields only -- no passport/seat/meal columns, since no
-- current form collects them for a core-platform booking.
CREATE TABLE booking_passengers (
    id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    passenger_type passenger_type_enum,
    date_of_birth DATE
);

-- Renamed from payments.
CREATE TABLE user_payments (
    id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    method VARCHAR(30) NOT NULL DEFAULT 'mock',
    status VARCHAR(30) NOT NULL DEFAULT 'success',
    transaction_ref VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    refunded_at TIMESTAMP,
    refund_reference VARCHAR(100)
);

-- Renamed from reviews.
CREATE TABLE user_reviews (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    item_type VARCHAR(30) NOT NULL,
    item_id INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    comment VARCHAR(2000),
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Renamed from wishlist.
CREATE TABLE user_wishlist (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    item_type VARCHAR(30) NOT NULL,
    item_id INTEGER NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Renamed from support_tickets.
CREATE TABLE user_support_tickets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    subject VARCHAR(200) NOT NULL,
    description VARCHAR(4000) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    resolved_at TIMESTAMP
);

-- Renamed from notifications.
CREATE TABLE user_notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL,
    message VARCHAR(2000) NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);
