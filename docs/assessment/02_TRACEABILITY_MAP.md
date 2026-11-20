# Admin Portal Assessment — 2. API → Router → Service → Model → Table Traceability

**Date:** 2026-11-13 · Read-only. Routers verified in `backend/app/main.py` (include_router block); services/models/tables from the router imports and `models_v2.py` / `models_customer.py`. Table layer: B2B = `models_v2.Base` (26 tables), B2C = `models_customer.Base` (47 tables: 46 `customer_*` + `payment_provider_events`), legacy = `app/models/` (39, dead/quarantined).

## B2B screens → stack
| Screen | API prefix | Router(s) | Service(s) | Table(s) |
|---|---|---|---|---|
| Dashboard (`reports`) | /api/dashboard | dashboard | dashboard_service | models_v2 aggregates (service_requests, payments, gaming counts) |
| Merchants (`users`) | /api/merchants, /api/merchant-team, /api/super-admin | merchants, merchant_team, super_admin | merchant_service, user_service | merchants, users, merchant_service_access |
| Active Users | /api/admin/* (sessions) | admin_ops / dashboard | session_service | system_logs |
| Booking Enquiries (`ticket-enquiries`) | /api/enquiries, /api/tickets, /api/hotel-enquiries, /api/tour-package-enquiries | enquiries, tickets, hotel_enquiries, tour_package_enquiries | enquiry/ticket services | service_requests, hotel_enquiries(+rooms,children), tour_package_enquiries, passenger_data |
| Approval Queue (`partner-requests`) | /api/merchant-approvals, /api/manager-approvals, /api/change-requests | merchant_approvals, manager_approvals, change_requests | manager_approval, change_request services | service_requests, request_notes |
| Booking Operations | /api/booking-ops | booking_ops | booking/ticket services | service_requests, passenger_data, request_documents, request_notes |
| Service Request Mgmt | /api/change-requests, /api/booking-ops | change_requests, booking_ops | change_request service | service_requests (date-change/cancellation/refund sub-types) |
| Providers | /api/providers | providers | provider service | providers, provider_users |
| Manual Booking | /api/tickets, /api/enquiries (ticket.manual) | tickets, enquiries | ticket service | service_requests, passenger_data |
| Payment Management (`payments`) | /api/payment-admin | payment_admin | payment_admin_service | payments |
| Wallet Desk | /api/wallet | wallet | wallet/finance service | payment_accounts, wallet_topups, wallet_transactions |
| Reports Export | /api/reports | reports | reports + export_service | payments, service_requests |
| Analytics | /api/analytics | analytics | analytics_service | models_v2 aggregates |
| Audit Logs | /api/super-admin/audit-logs | super_admin | audit_service (read-only) | audit_logs (trigger `fn_write_audit_log`) |
| System Logs | /api/admin/*, /api/super-admin/system-info | admin_ops, super_admin | activity_service, system_info_service | system_logs |
| Support (B2B) | /api/support-tickets, /api/messages | support_tickets, messages | ticket/message services | service_requests, msg_logs |
| Notifications | /api/notifications, /api/admin/messages/failed | notifications_v2, messages | notification, delivery services | msg_logs, communication_settings |
| Profile | /api/auth, /api/profile | auth, profile | auth_service, user_service | users |

## B2C screens → stack
| Screen | API prefix | Router(s) | Service(s) | Table(s) | Audit action (Stage 2) |
|---|---|---|---|---|---|
| Customers | /api/admin/customers | customer_admin | customer_admin_service | customers, customer_profiles, customer_identities | customer.view_detail |
| Bookings | /api/admin/customer-bookings | admin_customer_bookings | customer_booking_admin_service | customer_bookings/_hotel_bookings/_package_bookings | booking.view_detail, booking.update |
| Cancellations & Refunds | /api/admin/cancellations | admin_cancellations (+ customer_refund_service) | customer_cancellation_admin_service, customer_refund_service | customer_cancellation_requests, customer_refund_attempts, customer_*_payments | refund.execute/authorize/manual/resolve_failed/reconcile_finalize |
| Reviews & Ratings | /api/admin/reviews | admin_reviews | review admin service | customer_reviews | review.moderate |
| Live Chat / WiFi calling | /api/admin/chat (+ WS /ws) | admin_chat (+ chat_gateway, chat_broker, call_signaling) | customer_chat_service, call_service | customer_conversations, customer_chat_messages, customer_chat_attachments, customer_calls | chat.claim/transfer/set_status, chat.attachment_send, document.download |
| Communication | /api/admin/communication | admin_communication | communication admin service | customer_notifications, customer_support_tickets | (read-only; no mutate) |
| Customer Payments | /api/admin/customer-payments | customer_payment_admin | customer_payment_admin_service, payment_event_service | customer_*_payments, payment_provider_events | payment.view_detail |
| Reconciliation | /api/admin/reconciliation | admin_reconciliation | customer_payment_admin_service, supplier_guard | payment_provider_events, customer_*_payments | payment.verify, booking.supplier_reservation |
| User Activity | /api/admin/user-activity | admin_user_activity | customer_activity_admin_service | customer_activity | (read) |
| Catalogue — Flights | /api/admin/catalogue | admin_catalogue | catalogue_flight_admin_service, catalogue_images | (none stored; live Duffel search) | (status read) |
| Catalogue — Hotels | /api/admin/catalogue/hotels | admin_catalogue_hotels | catalogue_hotel_admin_service | customer_hotels, customer_hotel_rooms | catalogue.create/update |
| Catalogue — Packages | /api/admin/catalogue/packages | admin_catalogue_packages | catalogue_package_admin_service | customer_packages, _itinerary, _hotels, _departures | catalogue.create/update |
| Catalogue — Destinations | /api/admin/catalogue/destinations | admin_catalogue_destinations | catalogue_destination_admin_service | customer_destinations, customer_locations, customer_attractions | catalogue.create/update |
| B2C Reports | /api/admin/b2c-reports | admin_b2c_reports | reports + export_service | B2C aggregates | report.preview, report.export |
| B2C Analytics | /api/admin/b2c-analytics | admin_b2c_reports (analytics_router) | analytics | B2C aggregates | (read) |
| B2C Audit trail (Stage 2C) | /api/admin/b2c-audit | b2c_audit | customer_admin_audit_service | customer_admin_audit_logs | (reads the trail) |
| Gaming (hidden/disabled) | /api/admin/gaming-tour-enquiries | gaming_tour_enquiries | gaming_tour_enquiry_service | gaming_tour_enquiries | n/a (404 gate) |

## Payment-callback / shared (not a nav screen, but part of the portal's money path)
| Flow | Router | Service | Table |
|---|---|---|---|
| Provider webhooks | payment_webhooks | payment_event_service, trustbrick_provider | payment_provider_events, customer_*_payments |
| Provider return URLs | payment_returns | payment_event_service | payment_provider_events, customer_*_payments |

## Correlation / cross-cutting
- Request-id (`activity_service.request_context` → `_REQUEST_META` ContextVar, echoed `X-Request-ID`), background sweep run-ids, and a fresh WS UUID flow into both `system_logs` (B2B activity) and `customer_admin_audit_logs` (B2C admin).
- B2B audit = `audit_logs` (DB trigger) read-only; B2C admin audit = `customer_admin_audit_logs` (Stage 2, app-written, append-only by migration 0095 — **not yet deployed to a DB**).

Evidence basis: router registration (`main.py`), the per-router `from app.services import …` / `from app.models_* import …` imports, and the model table definitions traced across this engagement. Not runtime-verified (see doc 5).
