-- Partner Portal — Back Office — 01: Stored procedures
-- ADDITIVE ONLY. Depends on Phase 2 (../*.sql) and gap_completion (../gap_completion/*.sql),
-- already applied. Fills the one remaining real gap: an admin-facing queue to actually
-- act on sp_approve_request/sp_reject_request (Phase 2) and to resolve service requests
-- (no resolve procedure existed before this — service_requests.status could only ever
-- be set by INSERT, at 'submitted').

-- Admin queue listing — joins in company/requester name, which no existing
-- partner-scoped view does (those are all correctly scoped to one partner_id
-- and have no reason to expose company_name).
CREATE OR REPLACE FUNCTION sp_admin_list_partner_bookings(
    p_status  booking_status_enum DEFAULT 'pending_approval',
    p_search   VARCHAR DEFAULT NULL
)
RETURNS TABLE (
    booking_id        INTEGER,
    reference_number  VARCHAR,
    partner_id        INTEGER,
    company_name      VARCHAR,
    requester_name    VARCHAR,
    travel_type       travel_type_enum,
    departure         VARCHAR,
    arrival            VARCHAR,
    departure_date      DATE,
    passenger_count       BIGINT,
    total_amount            NUMERIC,
    status                    booking_status_enum,
    created_at                  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        pb.booking_id, pb.reference_number, pb.partner_id, p.company_name, pu.full_name,
        pb.travel_type, pb.departure, pb.arrival, pb.departure_date,
        (SELECT COUNT(*) FROM partner_booking_passengers pbp WHERE pbp.booking_id = pb.booking_id),
        pb.total_amount, pb.status, pb.created_at
    FROM partner_bookings pb
    JOIN partners p ON p.partner_id = pb.partner_id
    JOIN partner_users pu ON pu.partner_user_id = pb.partner_user_id
    WHERE (p_status IS NULL OR pb.status = p_status)
      AND (p_search IS NULL OR pb.reference_number ILIKE '%' || p_search || '%' OR p.company_name ILIKE '%' || p_search || '%')
    ORDER BY pb.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE;


-- The one status transition service_requests never had a procedure for —
-- sp_cancel_selected_passengers/sp_create_date_change_request/etc. (Phase 2)
-- only ever INSERT a service_request at status='submitted'; nothing before
-- this could move it forward.
CREATE OR REPLACE FUNCTION sp_resolve_service_request(
    p_service_request_id  INTEGER,
    p_status                service_request_status_enum,
    p_resolved_by             INTEGER
)
RETURNS VOID AS $$
BEGIN
    IF p_status NOT IN ('approved', 'rejected', 'completed') THEN
        RAISE EXCEPTION 'Cannot resolve a service request to status %', p_status;
    END IF;

    UPDATE service_requests
    SET status = p_status, resolved_by = p_resolved_by, resolved_at = now()
    WHERE service_request_id = p_service_request_id AND status IN ('submitted', 'in_review');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Service request % not found or already resolved', p_service_request_id;
    END IF;
END;
$$ LANGUAGE plpgsql;
