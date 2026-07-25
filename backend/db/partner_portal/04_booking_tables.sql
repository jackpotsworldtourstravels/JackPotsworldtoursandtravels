-- Partner Portal — 04: Booking + passenger tables
-- Depends on: 01_types.sql, 02_reference_tables.sql (countries), 03_partner_tables.sql
-- References existing tables: flights, hotels, cruises, users

CREATE TABLE booking_reference_counters (
    partner_id  INTEGER NOT NULL REFERENCES partners (partner_id) ON DELETE CASCADE,
    year        SMALLINT NOT NULL,
    last_value  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (partner_id, year)
);

CREATE TABLE partner_bookings (
    booking_id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reference_number  VARCHAR(20) NOT NULL,
    partner_id        INTEGER NOT NULL REFERENCES partners (partner_id),
    partner_user_id   INTEGER NOT NULL REFERENCES partner_users (partner_user_id),
    travel_type       travel_type_enum NOT NULL,
    -- Nullable: set only when the request matches a real row in the existing
    -- live catalog. Partner requests may be for routes/dates outside today's
    -- public inventory, so the descriptive columns below are always captured
    -- regardless of whether a catalog match exists.
    flight_id         INTEGER REFERENCES flights (id),
    hotel_id          INTEGER REFERENCES hotels (id),
    cruise_id         INTEGER REFERENCES cruises (id),
    airline_name      VARCHAR(100),
    flight_number     VARCHAR(20),
    trip_type         trip_type_enum,
    departure         VARCHAR(150) NOT NULL,
    arrival           VARCHAR(150) NOT NULL,
    departure_date    DATE NOT NULL,
    return_date       DATE,
    cabin_class       cabin_class_enum,
    status            booking_status_enum NOT NULL DEFAULT 'draft',
    total_amount      NUMERIC(10, 2),
    approved_by       INTEGER REFERENCES users (id),
    rejected_by       INTEGER REFERENCES users (id),
    approved_at       TIMESTAMPTZ,
    rejected_at       TIMESTAMPTZ,
    rejection_reason  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_partner_bookings_reference_number UNIQUE (reference_number),
    CONSTRAINT ck_partner_bookings_catalog_match CHECK (
        (travel_type = 'flight' AND hotel_id IS NULL AND cruise_id IS NULL) OR
        (travel_type = 'hotel' AND flight_id IS NULL AND cruise_id IS NULL) OR
        (travel_type = 'cruise' AND flight_id IS NULL AND hotel_id IS NULL)
    ),
    CONSTRAINT ck_partner_bookings_return_after_departure CHECK (
        return_date IS NULL OR return_date >= departure_date
    )
);

CREATE INDEX idx_partner_bookings_partner_id ON partner_bookings (partner_id);
CREATE INDEX idx_partner_bookings_partner_user_id ON partner_bookings (partner_user_id);
CREATE INDEX idx_partner_bookings_status ON partner_bookings (status);
CREATE INDEX idx_partner_bookings_created_at ON partner_bookings (created_at);

CREATE TABLE partner_booking_passengers (
    passenger_id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id                   INTEGER NOT NULL REFERENCES partner_bookings (booking_id) ON DELETE CASCADE,
    full_name                    VARCHAR(150) NOT NULL,
    id_type                      VARCHAR(30) NOT NULL DEFAULT 'passport',
    gender                       gender_enum NOT NULL,
    passenger_type               passenger_type_enum NOT NULL,
    passport_issuing_country_id  INTEGER NOT NULL REFERENCES countries (country_id),
    passport_number              VARCHAR(30) NOT NULL,
    passport_issue_date          DATE NOT NULL,
    passport_expiry_date         DATE NOT NULL,
    date_of_birth                DATE NOT NULL,
    nationality_country_id       INTEGER NOT NULL REFERENCES countries (country_id),
    meal_preference               VARCHAR(80),
    special_assistance            TEXT,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- VARCHAR + CHECK instead of an ENUM: id_type is the one passenger field
    -- likely to grow (e.g. a national ID card option later), and extending a
    -- CHECK constraint is a plain ALTER TABLE rather than an ALTER TYPE.
    CONSTRAINT ck_partner_booking_passengers_id_type CHECK (id_type IN ('passport')),
    CONSTRAINT ck_partner_booking_passengers_expiry_after_issue CHECK (passport_expiry_date > passport_issue_date)
);

CREATE INDEX idx_partner_booking_passengers_booking_id ON partner_booking_passengers (booking_id);
