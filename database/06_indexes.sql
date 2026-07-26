-- =========================================================================
-- 06_indexes.sql
-- All non-constraint indexes, grouped by domain.
-- =========================================================================

-- ---- SHARED ----
CREATE INDEX IF NOT EXISTS ix_states_country_id ON public.states USING btree (country_id);
CREATE INDEX IF NOT EXISTS ix_cities_state_id ON public.cities USING btree (state_id);
CREATE INDEX IF NOT EXISTS ix_package_images_package_id ON public.package_images USING btree (package_id);
CREATE INDEX IF NOT EXISTS ix_seasonal_prices_item ON public.seasonal_prices USING btree (item_type, item_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_coupons_code ON public.coupons USING btree (code);
CREATE INDEX IF NOT EXISTS ix_audit_logs_entity ON public.audit_logs USING btree (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_logs_admin_id ON public.audit_logs USING btree (changed_by_admin_id);

-- ---- ADMIN ----
CREATE INDEX IF NOT EXISTS ix_admins_role_id ON public.admins USING btree (role_id);
CREATE INDEX IF NOT EXISTS ix_admin_sessions_admin_id ON public.admin_sessions USING btree (admin_id);
CREATE INDEX IF NOT EXISTS ix_admin_activity_logs_admin_id ON public.admin_activity_logs USING btree (admin_id);
CREATE INDEX IF NOT EXISTS ix_admin_activity_logs_created_at ON public.admin_activity_logs USING btree (created_at);
CREATE INDEX IF NOT EXISTS ix_admin_notifications_admin_id ON public.admin_notifications USING btree (admin_id, is_read);

-- ---- MERCHANT ----
CREATE INDEX IF NOT EXISTS ix_partner_staff_partner_id ON public.partner_staff USING btree (partner_id);
CREATE INDEX IF NOT EXISTS ix_partner_sessions_staff_id ON public.partner_sessions USING btree (staff_id);
CREATE INDEX IF NOT EXISTS ix_partner_otp_requests_staff_purpose ON public.partner_otp_requests USING btree (staff_id, purpose, verified_at);
CREATE INDEX IF NOT EXISTS ix_partner_bookings_created_at ON public.partner_bookings USING btree (created_at);
CREATE INDEX IF NOT EXISTS ix_partner_bookings_partner_id ON public.partner_bookings USING btree (partner_id);
CREATE INDEX IF NOT EXISTS ix_partner_bookings_staff_id ON public.partner_bookings USING btree (staff_id);
CREATE INDEX IF NOT EXISTS ix_partner_bookings_status ON public.partner_bookings USING btree (status);
CREATE INDEX IF NOT EXISTS ix_partner_booking_passengers_booking_id ON public.partner_booking_passengers USING btree (booking_id);
CREATE INDEX IF NOT EXISTS ix_passenger_special_services_passenger ON public.passenger_special_services USING btree (passenger_id);
CREATE INDEX IF NOT EXISTS ix_service_requests_booking_id ON public.service_requests USING btree (booking_id);
CREATE INDEX IF NOT EXISTS ix_service_requests_staff_id ON public.service_requests USING btree (staff_id);
CREATE INDEX IF NOT EXISTS ix_service_requests_status ON public.service_requests USING btree (status);
CREATE INDEX IF NOT EXISTS ix_partner_payments_booking_id ON public.partner_payments USING btree (booking_id);
CREATE INDEX IF NOT EXISTS ix_report_generation_log_partner_id ON public.report_generation_log USING btree (partner_id);
CREATE INDEX IF NOT EXISTS ix_partner_notifications_staff_id ON public.partner_notifications USING btree (staff_id, is_read);
CREATE INDEX IF NOT EXISTS ix_partner_activity_logs_partner_id ON public.partner_activity_logs USING btree (partner_id, created_at);
CREATE INDEX IF NOT EXISTS ix_pbsh_booking_id ON public.partner_booking_status_history USING btree (booking_id, changed_at);
CREATE INDEX IF NOT EXISTS ix_srsh_service_request_id ON public.service_request_status_history USING btree (service_request_id, changed_at);
CREATE INDEX IF NOT EXISTS ix_partner_bank_accounts_partner_id ON public.partner_bank_accounts USING btree (partner_id);
CREATE INDEX IF NOT EXISTS ix_partner_documents_partner_id ON public.partner_documents USING btree (partner_id);
CREATE INDEX IF NOT EXISTS ix_partner_wallet_transactions_partner_id ON public.partner_wallet_transactions USING btree (partner_id, created_at);
CREATE INDEX IF NOT EXISTS ix_partner_commissions_partner_id ON public.partner_commissions USING btree (partner_id);
CREATE INDEX IF NOT EXISTS ix_partner_invoices_partner_id ON public.partner_invoices USING btree (partner_id);
CREATE INDEX IF NOT EXISTS ix_partner_invoices_status ON public.partner_invoices USING btree (status);

-- ---- USER ----
CREATE INDEX IF NOT EXISTS ix_users_email ON public.users USING btree (email);
CREATE INDEX IF NOT EXISTS ix_users_is_deleted ON public.users USING btree (is_deleted);
CREATE INDEX IF NOT EXISTS ix_user_addresses_user_id ON public.user_addresses USING btree (user_id);
CREATE INDEX IF NOT EXISTS ix_user_bookings_status ON public.user_bookings USING btree (status);
CREATE INDEX IF NOT EXISTS ix_user_bookings_user_id ON public.user_bookings USING btree (user_id);
CREATE INDEX IF NOT EXISTS ix_booking_passengers_booking_id ON public.booking_passengers USING btree (booking_id);
CREATE INDEX IF NOT EXISTS ix_user_payments_booking_id ON public.user_payments USING btree (booking_id);
CREATE INDEX IF NOT EXISTS ix_user_payments_user_id ON public.user_payments USING btree (user_id);
CREATE INDEX IF NOT EXISTS ix_user_reviews_item_type_item_id ON public.user_reviews USING btree (item_type, item_id);
CREATE INDEX IF NOT EXISTS ix_user_support_tickets_user_id ON public.user_support_tickets USING btree (user_id);
CREATE INDEX IF NOT EXISTS ix_user_notifications_user_id ON public.user_notifications USING btree (user_id);
CREATE INDEX IF NOT EXISTS ix_user_activity_logs_activity_type ON public.user_activity_logs USING btree (activity_type);
CREATE INDEX IF NOT EXISTS ix_user_activity_logs_module ON public.user_activity_logs USING btree (module);
CREATE INDEX IF NOT EXISTS ix_user_activity_logs_user_id ON public.user_activity_logs USING btree (user_id);
CREATE INDEX IF NOT EXISTS ix_user_sessions_is_active ON public.user_sessions USING btree (is_active);
CREATE INDEX IF NOT EXISTS ix_user_sessions_user_id ON public.user_sessions USING btree (user_id);
