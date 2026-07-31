-- Target 9-table schema — ENUM types
--
-- All types are prefixed ts_ (target schema) to avoid colliding with the 13
-- legacy enum types (partner_status_enum, etc.) that stay live until cutover
-- retires the old tables. Idempotent: each type is only created if it
-- doesn't already exist, so this file is safe to re-run.

DO $$ BEGIN
    CREATE TYPE ts_user_type_enum AS ENUM ('customer', 'admin', 'super_admin', 'merchant_staff');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_user_status_enum AS ENUM ('active', 'inactive', 'blocked', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_merchant_role_type_enum AS ENUM ('admin', 'user', 'maker', 'checker');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_merchant_member_role_enum AS ENUM (
        'admin', 'user', 'data_operator', 'request_ticket', 'cancellation_ticket', 'supervisor', 'manager'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_otp_purpose_enum AS ENUM ('login', 'password_reset');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_merchant_status_enum AS ENUM ('active', 'inactive', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_request_type_enum AS ENUM (
        'booking', 'ticket_enquiry', 'cancellation', 'refund', 'date_change',
        'passenger_modification', 'support_ticket'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_channel_enum AS ENUM ('customer', 'merchant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_item_type_enum AS ENUM ('flight', 'hotel', 'cruise', 'tour_package');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_trip_type_enum AS ENUM ('one_way', 'round_trip');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_cabin_class_enum AS ENUM ('economy', 'premium_economy', 'business', 'first_class');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_request_status_enum AS ENUM (
        'draft', 'pending', 'approved', 'rejected', 'confirmed', 'cancelled', 'resolved', 'completed'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_priority_enum AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_payment_record_type_enum AS ENUM ('transaction', 'coupon', 'discount_campaign');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_payment_status_enum AS ENUM ('pending', 'success', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_discount_type_enum AS ENUM ('percent', 'flat');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_gender_enum AS ENUM ('male', 'female');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_passenger_type_enum AS ENUM ('adult', 'child', 'infant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Placeholder sets replacing the removed ancillary_service_catalog table —
-- verify against live catalog rows before cutover (see passenger_data.py).
DO $$ BEGIN
    CREATE TYPE ts_baggage_option_enum AS ENUM ('none', 'extra_15kg', 'extra_20kg', 'extra_30kg');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_meal_option_enum AS ENUM ('none', 'veg', 'non_veg', 'vegan', 'jain', 'kosher', 'halal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_msg_channel_enum AS ENUM (
        'notification', 'email', 'sms', 'whatsapp', 'live_chat', 'newsletter', 'contact_form', 'otp'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_msg_direction_enum AS ENUM ('outbound', 'inbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_msg_status_enum AS ENUM ('sent', 'delivered', 'failed', 'read');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_log_type_enum AS ENUM ('activity', 'session', 'report_generation', 'status_change');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ts_audit_action_enum AS ENUM ('insert', 'update', 'delete');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
