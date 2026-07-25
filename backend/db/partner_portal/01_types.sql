-- Partner Portal — 01: Custom enumerated types
-- Run once, before any table that references these types.
-- Idempotent-ish: DROP TYPE IF EXISTS is intentionally omitted so re-running
-- against a partially-applied database fails loudly instead of silently
-- dropping types other objects may already depend on.

CREATE TYPE partner_status_enum AS ENUM ('active', 'inactive', 'suspended');
CREATE TYPE partner_user_status_enum AS ENUM ('active', 'inactive', 'blocked');
CREATE TYPE otp_purpose_enum AS ENUM ('login', 'password_reset');

CREATE TYPE travel_type_enum AS ENUM ('flight', 'hotel', 'cruise');
CREATE TYPE trip_type_enum AS ENUM ('one_way', 'round_trip');
CREATE TYPE cabin_class_enum AS ENUM ('economy', 'premium_economy', 'business', 'first_class');
CREATE TYPE gender_enum AS ENUM ('male', 'female');
CREATE TYPE passenger_type_enum AS ENUM ('adult', 'child', 'infant');
CREATE TYPE booking_status_enum AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'completed', 'cancelled');

CREATE TYPE service_request_type_enum AS ENUM ('cancellation', 'date_change', 'refund', 'passenger_modification');
CREATE TYPE service_request_status_enum AS ENUM ('submitted', 'in_review', 'approved', 'rejected', 'completed');

CREATE TYPE export_format_enum AS ENUM ('pdf', 'excel');
