-- Partner Portal — 07: Sequences
--
-- The global, non-partner-scoped counter behind service request numbers
-- ("SR000001"). Booking references are NOT here — they use the row-locked
-- booking_reference_counters table (04_booking_tables.sql) instead, because
-- they need per-partner-per-year resets that a plain SEQUENCE can't express.

CREATE SEQUENCE service_request_number_seq
    AS INTEGER
    START WITH 1
    INCREMENT BY 1
    NO CYCLE;
