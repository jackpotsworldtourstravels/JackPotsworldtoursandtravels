-- Core schema — updated_at triggers
--
-- Reuses fn_set_updated_at(), already defined for the Partner Portal
-- (backend/db/partner_portal/09_triggers.sql). Re-declaring it here with
-- CREATE OR REPLACE is idempotent and keeps this file runnable standalone
-- against a scratch database, without duplicating trigger-function logic.
--
-- Scope, verified against backend/app/models/*.py before writing this file:
--   - users, bookings already HAVE an updated_at column, set only at the
--     application layer (SQLAlchemy onupdate=). A DB trigger closes the gap
--     for any row touched outside the ORM (psql, a future script, etc.).
--   - flights, hotels, cruises, tour_packages are admin-edited inventory
--     (price, availability, ratings) but have NO updated_at column at all —
--     there is currently no way to tell when an admin last changed a price
--     or stock level. The column is added here (NOT NULL DEFAULT now(),
--     so existing rows backfill automatically) alongside its trigger.
--   - Every other core table (payments, reviews, coupons, discount_campaigns,
--     support_tickets, contact_us, newsletter, notifications, activity_logs,
--     wishlist, user_sessions) is append-only or already tracks its own
--     lifecycle timestamp (e.g. support_tickets.resolved_at) — adding
--     updated_at there would not correspond to any real update path today,
--     so it is deliberately left out. See docs/DATABASE_REVIEW_2026.md.

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Already-existing updated_at columns: users, bookings
DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;
CREATE TRIGGER trg_bookings_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- New updated_at column + trigger: admin-edited catalog/inventory tables
ALTER TABLE flights ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS trg_flights_updated_at ON flights;
CREATE TRIGGER trg_flights_updated_at
    BEFORE UPDATE ON flights
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE hotels ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS trg_hotels_updated_at ON hotels;
CREATE TRIGGER trg_hotels_updated_at
    BEFORE UPDATE ON hotels
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE cruises ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS trg_cruises_updated_at ON cruises;
CREATE TRIGGER trg_cruises_updated_at
    BEFORE UPDATE ON cruises
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE tour_packages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS trg_tour_packages_updated_at ON tour_packages;
CREATE TRIGGER trg_tour_packages_updated_at
    BEFORE UPDATE ON tour_packages
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
