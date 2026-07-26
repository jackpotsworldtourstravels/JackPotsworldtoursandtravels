-- =========================================================================
-- 07_constraints.sql
-- Foreign keys, unique constraints, and check constraints, grouped by
-- domain.
--
-- v2 note: every FK that used to point at partner_users(partner_user_id)
-- now points at partner_staff(staff_id); every FK that used to point at
-- users(id) for an admin actor (approved_by/rejected_by/resolved_by/
-- changed_by_admin_id) points at admins(id); the retired shared
-- roles/permissions/role_permissions constraints are gone, replaced by
-- each domain's own equivalent.
-- =========================================================================

-- ---- SHARED ----
ALTER TABLE countries ADD CONSTRAINT uq_countries_iso2 UNIQUE (iso2);
ALTER TABLE countries ADD CONSTRAINT uq_countries_iso3 UNIQUE (iso3);
ALTER TABLE countries ADD CONSTRAINT uq_countries_name UNIQUE (name);
ALTER TABLE states ADD CONSTRAINT fk_states_country FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE CASCADE;
ALTER TABLE cities ADD CONSTRAINT fk_cities_state FOREIGN KEY (state_id) REFERENCES states(id) ON DELETE CASCADE;
ALTER TABLE currencies ADD CONSTRAINT uq_currencies_code UNIQUE (code);
ALTER TABLE languages ADD CONSTRAINT uq_languages_code UNIQUE (code);
ALTER TABLE airports ADD CONSTRAINT uq_airports_iata_code UNIQUE (iata_code);
ALTER TABLE airports ADD CONSTRAINT fk_airports_city FOREIGN KEY (city_id) REFERENCES cities(id);
ALTER TABLE airports ADD CONSTRAINT fk_airports_country FOREIGN KEY (country_id) REFERENCES countries(country_id);
ALTER TABLE airlines ADD CONSTRAINT uq_airlines_iata_code UNIQUE (iata_code);
ALTER TABLE hotel_chains ADD CONSTRAINT uq_hotel_chains_name UNIQUE (name);
ALTER TABLE cruise_lines ADD CONSTRAINT uq_cruise_lines_name UNIQUE (name);
ALTER TABLE package_images ADD CONSTRAINT fk_package_images_package FOREIGN KEY (package_id) REFERENCES tour_packages(id) ON DELETE CASCADE;
ALTER TABLE coupons ADD CONSTRAINT uq_coupons_code UNIQUE (code);
ALTER TABLE payment_methods ADD CONSTRAINT uq_payment_methods_code UNIQUE (code);
ALTER TABLE system_settings ADD CONSTRAINT uq_system_settings_key UNIQUE (setting_key);
ALTER TABLE audit_logs ADD CONSTRAINT fk_audit_logs_admin FOREIGN KEY (changed_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE newsletter ADD CONSTRAINT uq_newsletter_email UNIQUE (email);

-- ---- ADMIN ----
ALTER TABLE admin_roles ADD CONSTRAINT uq_admin_roles_name UNIQUE (name);
ALTER TABLE admin_permissions ADD CONSTRAINT uq_admin_permissions_key UNIQUE (permission_key);
ALTER TABLE admin_role_permissions ADD CONSTRAINT fk_arp_role FOREIGN KEY (admin_role_id) REFERENCES admin_roles(id) ON DELETE CASCADE;
ALTER TABLE admin_role_permissions ADD CONSTRAINT fk_arp_permission FOREIGN KEY (admin_permission_id) REFERENCES admin_permissions(id) ON DELETE CASCADE;
ALTER TABLE admins ADD CONSTRAINT fk_admins_role FOREIGN KEY (role_id) REFERENCES admin_roles(id);
ALTER TABLE admins ADD CONSTRAINT uq_admins_email UNIQUE (email);
ALTER TABLE admin_profiles ADD CONSTRAINT fk_admin_profiles_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE;
ALTER TABLE admin_sessions ADD CONSTRAINT fk_admin_sessions_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE;
ALTER TABLE admin_activity_logs ADD CONSTRAINT fk_admin_activity_logs_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE admin_notifications ADD CONSTRAINT fk_admin_notifications_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE;

-- ---- MERCHANT ----
ALTER TABLE partners ADD CONSTRAINT ck_partners_reference_prefix_format CHECK (reference_prefix ~ '^[A-Z0-9]{2,6}$');
ALTER TABLE partners ADD CONSTRAINT uq_partners_company_code UNIQUE (company_code);
ALTER TABLE partners ADD CONSTRAINT uq_partners_email UNIQUE (email);
ALTER TABLE partners ADD CONSTRAINT uq_partners_reference_prefix UNIQUE (reference_prefix);
ALTER TABLE partner_profiles ADD CONSTRAINT fk_partner_profiles_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id) ON DELETE CASCADE;
ALTER TABLE partner_staff ADD CONSTRAINT fk_partner_staff_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id) ON DELETE CASCADE;
ALTER TABLE partner_staff ADD CONSTRAINT uq_partner_staff_email UNIQUE (email);
ALTER TABLE partner_staff ADD CONSTRAINT uq_partner_staff_phone_number UNIQUE (phone_number);
ALTER TABLE partner_staff ADD CONSTRAINT uq_partner_staff_username UNIQUE (username);
ALTER TABLE partner_sessions ADD CONSTRAINT fk_partner_sessions_staff FOREIGN KEY (staff_id) REFERENCES partner_staff(staff_id) ON DELETE CASCADE;
ALTER TABLE partner_otp_requests ADD CONSTRAINT ck_partner_otp_attempt_count CHECK (attempt_count >= 0);
ALTER TABLE partner_otp_requests ADD CONSTRAINT fk_partner_otp_requests_staff FOREIGN KEY (staff_id) REFERENCES partner_staff(staff_id) ON DELETE CASCADE;
ALTER TABLE booking_reference_counters ADD CONSTRAINT fk_brc_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id) ON DELETE CASCADE;
ALTER TABLE partner_bookings ADD CONSTRAINT ck_partner_bookings_catalog_match CHECK (
    (travel_type = 'flight' AND hotel_id IS NULL AND cruise_id IS NULL) OR
    (travel_type = 'hotel' AND flight_id IS NULL AND cruise_id IS NULL) OR
    (travel_type = 'cruise' AND flight_id IS NULL AND hotel_id IS NULL)
);
ALTER TABLE partner_bookings ADD CONSTRAINT ck_partner_bookings_return_after_departure CHECK (return_date IS NULL OR return_date >= departure_date);
ALTER TABLE partner_bookings ADD CONSTRAINT fk_partner_bookings_approved_by FOREIGN KEY (approved_by) REFERENCES admins(id);
ALTER TABLE partner_bookings ADD CONSTRAINT fk_partner_bookings_rejected_by FOREIGN KEY (rejected_by) REFERENCES admins(id);
ALTER TABLE partner_bookings ADD CONSTRAINT fk_partner_bookings_cruise FOREIGN KEY (cruise_id) REFERENCES cruises(id);
ALTER TABLE partner_bookings ADD CONSTRAINT fk_partner_bookings_flight FOREIGN KEY (flight_id) REFERENCES flights(id);
ALTER TABLE partner_bookings ADD CONSTRAINT fk_partner_bookings_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id);
ALTER TABLE partner_bookings ADD CONSTRAINT fk_partner_bookings_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id);
ALTER TABLE partner_bookings ADD CONSTRAINT fk_partner_bookings_staff FOREIGN KEY (staff_id) REFERENCES partner_staff(staff_id);
ALTER TABLE partner_bookings ADD CONSTRAINT uq_partner_bookings_reference_number UNIQUE (reference_number);
ALTER TABLE partner_booking_passengers ADD CONSTRAINT ck_pbp_expiry_after_issue CHECK (passport_expiry_date > passport_issue_date);
ALTER TABLE partner_booking_passengers ADD CONSTRAINT ck_pbp_id_type CHECK (id_type = 'passport');
ALTER TABLE partner_booking_passengers ADD CONSTRAINT fk_pbp_baggage_catalog FOREIGN KEY (baggage_catalog_id) REFERENCES ancillary_service_catalog(catalog_id);
ALTER TABLE partner_booking_passengers ADD CONSTRAINT fk_pbp_booking FOREIGN KEY (booking_id) REFERENCES partner_bookings(booking_id) ON DELETE CASCADE;
ALTER TABLE partner_booking_passengers ADD CONSTRAINT fk_pbp_meal_catalog FOREIGN KEY (meal_catalog_id) REFERENCES ancillary_service_catalog(catalog_id);
ALTER TABLE partner_booking_passengers ADD CONSTRAINT fk_pbp_nationality_country FOREIGN KEY (nationality_country_id) REFERENCES countries(country_id);
ALTER TABLE partner_booking_passengers ADD CONSTRAINT fk_pbp_passport_issuing_country FOREIGN KEY (passport_issuing_country_id) REFERENCES countries(country_id);
ALTER TABLE ancillary_service_catalog ADD CONSTRAINT ck_asc_charge_nonneg CHECK (additional_charge >= 0);
ALTER TABLE ancillary_service_catalog ADD CONSTRAINT uq_asc_category_code UNIQUE (category, code);
ALTER TABLE passenger_special_services ADD CONSTRAINT fk_pss_catalog FOREIGN KEY (catalog_id) REFERENCES ancillary_service_catalog(catalog_id);
ALTER TABLE passenger_special_services ADD CONSTRAINT fk_pss_passenger FOREIGN KEY (passenger_id) REFERENCES partner_booking_passengers(passenger_id) ON DELETE CASCADE;
ALTER TABLE passenger_special_services ADD CONSTRAINT uq_pss_passenger_catalog UNIQUE (passenger_id, catalog_id);
ALTER TABLE service_requests ADD CONSTRAINT fk_sr_booking FOREIGN KEY (booking_id) REFERENCES partner_bookings(booking_id);
ALTER TABLE service_requests ADD CONSTRAINT fk_sr_staff FOREIGN KEY (staff_id) REFERENCES partner_staff(staff_id);
ALTER TABLE service_requests ADD CONSTRAINT fk_sr_resolved_by FOREIGN KEY (resolved_by) REFERENCES admins(id);
ALTER TABLE service_requests ADD CONSTRAINT uq_sr_number UNIQUE (service_request_number);
ALTER TABLE cancellation_requests ADD CONSTRAINT fk_cr_service_request FOREIGN KEY (service_request_id) REFERENCES service_requests(service_request_id) ON DELETE CASCADE;
ALTER TABLE cancellation_request_passengers ADD CONSTRAINT fk_crp_passenger FOREIGN KEY (passenger_id) REFERENCES partner_booking_passengers(passenger_id);
ALTER TABLE cancellation_request_passengers ADD CONSTRAINT fk_crp_service_request FOREIGN KEY (service_request_id) REFERENCES cancellation_requests(service_request_id) ON DELETE CASCADE;
ALTER TABLE date_change_requests ADD CONSTRAINT ck_dcr_dates_differ CHECK (old_travel_date <> new_travel_date);
ALTER TABLE date_change_requests ADD CONSTRAINT fk_dcr_passenger FOREIGN KEY (passenger_id) REFERENCES partner_booking_passengers(passenger_id);
ALTER TABLE date_change_requests ADD CONSTRAINT fk_dcr_service_request FOREIGN KEY (service_request_id) REFERENCES service_requests(service_request_id) ON DELETE CASCADE;
ALTER TABLE refund_requests ADD CONSTRAINT ck_rr_amount_positive CHECK (amount_requested > 0);
ALTER TABLE refund_requests ADD CONSTRAINT fk_rr_payment FOREIGN KEY (payment_id) REFERENCES partner_payments(payment_id);
ALTER TABLE refund_requests ADD CONSTRAINT fk_rr_service_request FOREIGN KEY (service_request_id) REFERENCES service_requests(service_request_id) ON DELETE CASCADE;
ALTER TABLE passenger_modification_requests ADD CONSTRAINT fk_pmr_passenger FOREIGN KEY (passenger_id) REFERENCES partner_booking_passengers(passenger_id);
ALTER TABLE passenger_modification_requests ADD CONSTRAINT fk_pmr_service_request FOREIGN KEY (service_request_id) REFERENCES service_requests(service_request_id) ON DELETE CASCADE;
ALTER TABLE partner_payments ADD CONSTRAINT ck_partner_payments_status CHECK (status IN ('success','failed','refunded','pending'));
ALTER TABLE partner_payments ADD CONSTRAINT fk_partner_payments_booking FOREIGN KEY (booking_id) REFERENCES partner_bookings(booking_id);
ALTER TABLE partner_payments ADD CONSTRAINT uq_partner_payments_transaction_ref UNIQUE (transaction_ref);
ALTER TABLE report_generation_log ADD CONSTRAINT fk_rgl_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id);
ALTER TABLE report_generation_log ADD CONSTRAINT fk_rgl_staff FOREIGN KEY (staff_id) REFERENCES partner_staff(staff_id);
ALTER TABLE partner_notifications ADD CONSTRAINT fk_partner_notifications_staff FOREIGN KEY (staff_id) REFERENCES partner_staff(staff_id) ON DELETE CASCADE;
ALTER TABLE partner_activity_logs ADD CONSTRAINT fk_pal_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id);
ALTER TABLE partner_activity_logs ADD CONSTRAINT fk_pal_staff FOREIGN KEY (staff_id) REFERENCES partner_staff(staff_id) ON DELETE SET NULL;
ALTER TABLE partner_booking_status_history ADD CONSTRAINT ck_pbsh_status_actually_changed CHECK (old_status IS NULL OR old_status <> new_status);
ALTER TABLE partner_booking_status_history ADD CONSTRAINT fk_pbsh_booking FOREIGN KEY (booking_id) REFERENCES partner_bookings(booking_id) ON DELETE CASCADE;
ALTER TABLE partner_booking_status_history ADD CONSTRAINT fk_pbsh_admin FOREIGN KEY (changed_by_admin_id) REFERENCES admins(id);
ALTER TABLE partner_booking_status_history ADD CONSTRAINT fk_pbsh_staff FOREIGN KEY (changed_by_staff_id) REFERENCES partner_staff(staff_id);
ALTER TABLE service_request_status_history ADD CONSTRAINT ck_srsh_status_actually_changed CHECK (old_status IS NULL OR old_status <> new_status);
ALTER TABLE service_request_status_history ADD CONSTRAINT fk_srsh_admin FOREIGN KEY (changed_by_admin_id) REFERENCES admins(id);
ALTER TABLE service_request_status_history ADD CONSTRAINT fk_srsh_staff FOREIGN KEY (changed_by_staff_id) REFERENCES partner_staff(staff_id);
ALTER TABLE service_request_status_history ADD CONSTRAINT fk_srsh_service_request FOREIGN KEY (service_request_id) REFERENCES service_requests(service_request_id) ON DELETE CASCADE;
ALTER TABLE partner_bank_accounts ADD CONSTRAINT fk_pba_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id) ON DELETE CASCADE;
ALTER TABLE partner_documents ADD CONSTRAINT fk_pd_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id) ON DELETE CASCADE;
ALTER TABLE partner_wallet ADD CONSTRAINT fk_pw_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id) ON DELETE CASCADE;
ALTER TABLE partner_wallet_transactions ADD CONSTRAINT fk_pwt_wallet FOREIGN KEY (partner_id) REFERENCES partner_wallet(partner_id) ON DELETE CASCADE;
ALTER TABLE partner_commissions ADD CONSTRAINT fk_pc_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id) ON DELETE CASCADE;
ALTER TABLE partner_commissions ADD CONSTRAINT fk_pc_booking FOREIGN KEY (booking_id) REFERENCES partner_bookings(booking_id);
ALTER TABLE partner_invoices ADD CONSTRAINT fk_pi_partner FOREIGN KEY (partner_id) REFERENCES partners(partner_id) ON DELETE CASCADE;
ALTER TABLE partner_invoices ADD CONSTRAINT fk_pi_booking FOREIGN KEY (booking_id) REFERENCES partner_bookings(booking_id);
ALTER TABLE partner_invoices ADD CONSTRAINT uq_pi_invoice_number UNIQUE (invoice_number);

-- ---- USER ----
ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE (email);
ALTER TABLE user_profiles ADD CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_addresses ADD CONSTRAINT fk_user_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_sessions ADD CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_activity_logs ADD CONSTRAINT fk_user_activity_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE user_bookings ADD CONSTRAINT fk_user_bookings_user FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE booking_passengers ADD CONSTRAINT fk_booking_passengers_booking FOREIGN KEY (booking_id) REFERENCES user_bookings(id) ON DELETE CASCADE;
ALTER TABLE user_payments ADD CONSTRAINT fk_user_payments_booking FOREIGN KEY (booking_id) REFERENCES user_bookings(id);
ALTER TABLE user_payments ADD CONSTRAINT fk_user_payments_user FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE user_reviews ADD CONSTRAINT fk_user_reviews_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_reviews ADD CONSTRAINT uq_user_reviews_user_item UNIQUE (user_id, item_type, item_id);
ALTER TABLE user_wishlist ADD CONSTRAINT fk_user_wishlist_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_wishlist ADD CONSTRAINT uq_user_wishlist_user_item UNIQUE (user_id, item_type, item_id);
ALTER TABLE user_support_tickets ADD CONSTRAINT fk_user_support_tickets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_notifications ADD CONSTRAINT fk_user_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
