-- ============================================================================
-- Partner Portal — Passenger Ancillary Services (Baggage, Meal, Seat
-- Preference, Special Services, Special Request)
-- ============================================================================
-- Purely additive: new enums, one new catalog table, one new join table,
-- three new nullable columns on partner_booking_passengers, and a
-- CREATE OR REPLACE on sp_add_passenger that only appends new optional
-- trailing parameters (existing callers with the old argument count keep
-- working unchanged). No existing column, trigger, or workflow is touched.
-- ============================================================================

DO $$ BEGIN
    CREATE TYPE seat_preference_enum AS ENUM ('window', 'aisle', 'middle', 'front_row', 'exit_row');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ancillary_category_enum AS ENUM ('baggage', 'meal', 'special_service');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Catalog: every selectable baggage/meal/special-service option and its price
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ancillary_service_catalog (
    catalog_id       SERIAL PRIMARY KEY,
    category         ancillary_category_enum NOT NULL,
    code             VARCHAR(40) NOT NULL,
    label            VARCHAR(80) NOT NULL,
    additional_charge NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (additional_charge >= 0),
    display_order    SMALLINT NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (category, code)
);

ALTER TABLE partner_booking_passengers
    ADD COLUMN IF NOT EXISTS baggage_catalog_id INTEGER REFERENCES ancillary_service_catalog(catalog_id),
    ADD COLUMN IF NOT EXISTS meal_catalog_id     INTEGER REFERENCES ancillary_service_catalog(catalog_id),
    ADD COLUMN IF NOT EXISTS seat_preference      seat_preference_enum;

CREATE TABLE IF NOT EXISTS passenger_special_services (
    id            SERIAL PRIMARY KEY,
    passenger_id  INTEGER NOT NULL REFERENCES partner_booking_passengers(passenger_id) ON DELETE CASCADE,
    catalog_id    INTEGER NOT NULL REFERENCES ancillary_service_catalog(catalog_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (passenger_id, catalog_id)
);
CREATE INDEX IF NOT EXISTS idx_passenger_special_services_passenger ON passenger_special_services(passenger_id);

-- ---------------------------------------------------------------------------
-- Seed catalog (idempotent — safe to re-run)
-- ---------------------------------------------------------------------------
INSERT INTO ancillary_service_catalog (category, code, label, additional_charge, display_order) VALUES
    ('baggage', 'none',      'No Extra Baggage', 0,    0),
    ('baggage', 'plus_5kg',  '+5 KG',             500,  1),
    ('baggage', 'plus_10kg', '+10 KG',            800,  2),
    ('baggage', 'plus_15kg', '+15 KG',            1100, 3),
    ('baggage', 'plus_20kg', '+20 KG',            1400, 4),
    ('baggage', 'plus_25kg', '+25 KG',            1700, 5),
    ('baggage', 'plus_30kg', '+30 KG',            2000, 6)
ON CONFLICT (category, code) DO NOTHING;

INSERT INTO ancillary_service_catalog (category, code, label, additional_charge, display_order) VALUES
    ('meal', 'none',          'No Meal',          0,   0),
    ('meal', 'vegetarian',    'Vegetarian',        0,   1),
    ('meal', 'non_vegetarian','Non-Vegetarian',    0,   2),
    ('meal', 'vegan',         'Vegan',             150, 3),
    ('meal', 'jain',          'Jain Meal',         150, 4),
    ('meal', 'diabetic',      'Diabetic Meal',     200, 5),
    ('meal', 'child',         'Child Meal',        100, 6)
ON CONFLICT (category, code) DO NOTHING;

INSERT INTO ancillary_service_catalog (category, code, label, additional_charge, display_order) VALUES
    ('special_service', 'wheelchair_assistance',    'Wheelchair Assistance',       0,   0),
    ('special_service', 'senior_citizen_assistance', 'Senior Citizen Assistance',  0,   1),
    ('special_service', 'infant_assistance',        'Infant Assistance',           0,   2),
    ('special_service', 'medical_assistance',       'Medical Assistance',          0,   3),
    ('special_service', 'priority_boarding',        'Priority Boarding',           300, 4),
    ('special_service', 'priority_checkin',         'Priority Check-in',           300, 5),
    ('special_service', 'extra_legroom',            'Extra Legroom',               600, 6),
    ('special_service', 'meet_and_assist',          'Meet & Assist',               500, 7)
ON CONFLICT (category, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- sp_add_passenger — append 3 new optional trailing params (backward compatible)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sp_add_passenger(
    p_booking_id INTEGER,
    p_full_name VARCHAR,
    p_gender gender_enum,
    p_passenger_type passenger_type_enum,
    p_passport_issuing_country_id INTEGER,
    p_passport_number VARCHAR,
    p_passport_issue_date DATE,
    p_passport_expiry_date DATE,
    p_date_of_birth DATE,
    p_nationality_country_id INTEGER,
    p_meal_preference VARCHAR DEFAULT NULL,
    p_special_assistance TEXT DEFAULT NULL,
    p_baggage_catalog_id INTEGER DEFAULT NULL,
    p_meal_catalog_id INTEGER DEFAULT NULL,
    p_seat_preference seat_preference_enum DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    v_passenger_id INTEGER;
BEGIN
    INSERT INTO partner_booking_passengers (
        booking_id, full_name, gender, passenger_type,
        passport_issuing_country_id, passport_number, passport_issue_date, passport_expiry_date,
        date_of_birth, nationality_country_id, meal_preference, special_assistance,
        baggage_catalog_id, meal_catalog_id, seat_preference
    ) VALUES (
        p_booking_id, p_full_name, p_gender, p_passenger_type,
        p_passport_issuing_country_id, p_passport_number, p_passport_issue_date, p_passport_expiry_date,
        p_date_of_birth, p_nationality_country_id, p_meal_preference, p_special_assistance,
        p_baggage_catalog_id, p_meal_catalog_id, p_seat_preference
    )
    RETURNING passenger_id INTO v_passenger_id;

    RETURN v_passenger_id;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- sp_set_passenger_special_services — idempotent replace of the checkbox set
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sp_set_passenger_special_services(
    p_passenger_id INTEGER,
    p_catalog_ids INTEGER[]
)
RETURNS VOID AS $$
BEGIN
    DELETE FROM passenger_special_services WHERE passenger_id = p_passenger_id;

    IF p_catalog_ids IS NOT NULL AND array_length(p_catalog_ids, 1) > 0 THEN
        INSERT INTO passenger_special_services (passenger_id, catalog_id)
        SELECT p_passenger_id, unnest(p_catalog_ids);
    END IF;
END;
$$ LANGUAGE plpgsql;
