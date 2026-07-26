-- =========================================================================
-- 01_types.sql
-- Custom PostgreSQL enum types used across the Shared / Admin / Merchant /
-- User domains.
--
-- v2 change: partner_user_status_enum renamed to partner_staff_status_enum
-- (follows the partner_users -> partner_staff table rename). 3 new enums
-- added for the new provisioned Merchant tables (wallet, invoices,
-- commissions). Every other type is unchanged from the live database.
-- =========================================================================

-- ---- Pre-existing (14 unchanged) ----
CREATE TYPE ancillary_category_enum AS ENUM ('baggage', 'meal', 'special_service');
CREATE TYPE booking_status_enum AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'completed', 'cancelled');
CREATE TYPE cabin_class_enum AS ENUM ('economy', 'premium_economy', 'business', 'first_class');
CREATE TYPE export_format_enum AS ENUM ('pdf', 'excel');
CREATE TYPE gender_enum AS ENUM ('male', 'female');
CREATE TYPE merchant_company_type_enum AS ENUM ('gaming_company', 'corporate_company', 'travel_agency', 'business_partner');
CREATE TYPE merchant_member_role_enum AS ENUM ('admin', 'user', 'data_operator', 'request_ticket', 'cancellation_ticket', 'supervisor', 'manager');
CREATE TYPE merchant_role_type_enum AS ENUM ('admin', 'user', 'maker', 'checker');
CREATE TYPE otp_purpose_enum AS ENUM ('login', 'password_reset');
CREATE TYPE partner_status_enum AS ENUM ('active', 'inactive', 'suspended');
CREATE TYPE passenger_type_enum AS ENUM ('adult', 'child', 'infant');
CREATE TYPE seat_preference_enum AS ENUM ('window', 'aisle', 'middle', 'front_row', 'exit_row');
CREATE TYPE service_request_status_enum AS ENUM ('submitted', 'in_review', 'approved', 'rejected', 'completed');
CREATE TYPE service_request_type_enum AS ENUM ('cancellation', 'date_change', 'refund', 'passenger_modification');
CREATE TYPE travel_type_enum AS ENUM ('flight', 'hotel', 'cruise');
CREATE TYPE trip_type_enum AS ENUM ('one_way', 'round_trip');

-- ---- Renamed (was partner_user_status_enum) ----
CREATE TYPE partner_staff_status_enum AS ENUM ('active', 'inactive', 'blocked');

-- ---- New in v2 (backing the new provisioned Merchant tables) ----
CREATE TYPE wallet_transaction_type_enum AS ENUM ('credit', 'debit');
CREATE TYPE invoice_status_enum AS ENUM ('unpaid', 'paid', 'overdue', 'cancelled');
CREATE TYPE commission_status_enum AS ENUM ('pending', 'paid', 'cancelled');
