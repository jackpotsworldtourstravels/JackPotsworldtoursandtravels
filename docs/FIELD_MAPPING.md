# Field Mapping — Frontend to PostgreSQL (v2 Schema)

Every row below was verified directly against the live frontend source
(`index.html`, `admin.html`, `partner-portal.html`, plus their JS files) —
not reconstructed from memory. Database Table/Column names reflect the v2
domain-separated schema in [`database/`](../database/README.md); see
[`DATABASE_STRUCTURE.md`](DATABASE_STRUCTURE.md) for the full rationale.

A separate **§6 Provisioned** section lists tables/columns in the new
schema that have **no current frontend field** — included per your request
for a production-ready design, not because a form exists for them today.

---

## 1. User (Customer) Portal — `index.html`

### 1.1 Sign Up (modal)

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Landing / Sign Up modal | `#signupForm` (`suName` etc.) | Full Name (`suName`) | `users` | `full_name` | — |
| Landing / Sign Up modal | same | Email Address (`suEmail`) | `users` | `email` | — |
| Landing / Sign Up modal | same | Password (`suPass`) | `users` | `hashed_password` (hashed before storage) | — |
| Landing / Sign Up modal | same | Confirm Password (`suPass2`) | *(validation only — not persisted)* | — | — |

### 1.2 Login (modal)

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Landing / Login modal | `#loginForm` | Email Address or Username (`liUser`) | `users` | `email` | — |
| Landing / Login modal | same | Password (`liPass`) | `users` | `hashed_password` (compared, not stored) | — |

*Note: this same modal currently also authenticates Admin Portal users
(role-based redirect after login), because Admin accounts still live in
`users` today. Under the v2 target design, an admin login would resolve
against `admins.email`/`admins.hashed_password` instead — a backend change,
not just a database one. See DATABASE_STRUCTURE.md §9.*

### 1.3 Forgot Password

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Landing / Forgot Password modal | forgot-password form | Email Address | `users` | `email` (looked up), writes `reset_token_hash`/`reset_token_expires_at` | — |

### 1.4 Contact Us (modal)

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Landing / Contact modal | contact form | Full Name (`cName`) | `contact_us` | `name` | — |
| same | same | Email Address (`cEmail`) | `contact_us` | `email` | — |
| same | same | Subject (`cSubject`) | `contact_us` | `subject` | — |
| same | same | Message (`cMessage`) | `contact_us` | `message` | — |

### 1.5 Newsletter (footer)

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Landing / Newsletter section | `#newsletterForm` | Email (`newsEmail`) | `newsletter` | `email` | — |

### 1.6 Account — Profile

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Account / Profile tab | `#acctProfileForm` | Full Name (`acctProfileName`) | `users` | `full_name` | — |
| same | same | Email (`acctProfileEmail`, disabled) | `users` | `email` (read-only display) | — |
| same | same | Mobile (`acctProfileMobile`) | `user_profiles` | `mobile` | — |
| same | same | Gender (`acctProfileGender`) | `user_profiles` | `gender` | — |
| same | same | Date of Birth (`acctProfileDob`) | `user_profiles` | `dob` | — |
| same | same | Country (`acctProfileCountry`) | `user_profiles` | `country` | — |
| same | same | State (`acctProfileState`) | `user_profiles` | `state` | — |
| same | same | City (`acctProfileCity`) | `user_profiles` | `city` | — |
| same | same | Address (`acctProfileAddress`) | `user_profiles` | `address` | — |

### 1.7 Account — Change Password

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Account / Profile tab | password change form | Current Password (`acctCurrentPassword`) | `users` | `hashed_password` (verified, not stored) | — |
| same | same | New Password (`acctNewPassword`) | `users` | `hashed_password` (hashed, overwrites) | — |

### 1.8 Booking checkout (item details modal)

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Item details modal | booking checkout | Travel Date (`detailsDate`) | `user_bookings` | `travel_date` | — |
| same | same | Quantity (`detailsQty`) | `user_bookings` | `quantity` | — |
| same | same | Coupon Code (`detailsCoupon`) | `user_bookings` | `coupon_code` (validated against `coupons.code`) | `coupons.code` (soft, not an FK constraint) |
| *(implicit)* | booking creation | Item selected (flight/hotel/cruise/package) | `user_bookings` | `booking_type`, `item_id` | `flights.id` / `hotels.id` / `cruises.id` / `tour_packages.id` (polymorphic, not a DB-level FK) |
| *(implicit)* | payment (mock) | Payment method | `user_payments` | `method` | — |

### 1.9 Reviews (modal)

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Reviews modal | `#reviewForm` | Star rating (`reviewStarInput`) | `user_reviews` | `rating` | — |
| same | same | Your review (`reviewComment`) | `user_reviews` | `comment` | — |

### 1.10 Wishlist (button, no form)

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Result/package cards | wishlist toggle button | item_type / item_id (implicit) | `user_wishlist` | `item_type`, `item_id` | polymorphic, not DB-level FK |

### 1.11 Account — Support Tickets

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Account / Support tab | ticket form | Subject (`acctTicketSubject`) | `user_support_tickets` | `subject` | — |
| same | same | Description (`acctTicketDescription`) | `user_support_tickets` | `description` | — |
| same | same | Priority (`acctTicketPriority`) | `user_support_tickets` | `priority` | — |

---

## 2. Admin Portal — `admin.html`

### 2.1 Login

Reuses the User Portal's Login modal (§1.2) against the same `/api/auth/login`
endpoint — see the note under §1.2.

### 2.2 My Profile

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Profile section | `#adminProfileForm` | Full Name (`adminProfileName`) | `admins` | `full_name` | — |
| same | same | Email (`adminProfileEmail`, disabled) | `admins` | `email` (read-only display) | — |

### 2.3 Change Password

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Profile section | `#adminPasswordForm` | Current Password (`adminCurrentPassword`) | `admins` | `hashed_password` (verified) | — |
| same | same | New Password (`adminNewPassword`) | `admins` | `hashed_password` (overwrites) | — |

### 2.4 Merchant Management — Onboard / Edit Merchant

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Merchant Management | `#onboardMerchantForm` | Merchant Name (`company_name`) | `partners` | `company_name` | — |
| same | same | Company Type (`company_type`) | `partner_profiles` | `company_type` | — |
| same | same | Contact Person (`contact_person`) | `partner_profiles` | `contact_person` | — |
| same | same | Email (`email`) | `partners` | `email` | — |
| same | same | Phone Number (`phone_number`) | `partners` | `phone_number` | — |
| same | same | Address (`address`) | `partner_profiles` | `address` | — |
| same | same | City (`city`) | `partner_profiles` | `city` | — |
| same | same | State (`state`) | `partner_profiles` | `state` | — |
| same | same | Country (`country`) | `partner_profiles` | `country` | — |
| same | same | GST Number (`gst_number`) | `partner_profiles` | `gst_number` | — |
| same | same | PAN Number (`pan_number`) | `partner_profiles` | `pan_number` | — |
| same | same | Status (`status`, create only) | `partners` | `status` | — |

### 2.5 Merchant Details — Create Merchant User

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Merchant Details | `#createMerchantUserForm` | User Full Name (`full_name`) | `partner_staff` | `full_name` | — |
| same | same | Username (`username`) | `partner_staff` | `username` | — |
| same | same | Email ID (`email`) | `partner_staff` | `email` | — |
| same | same | Phone Number (`phone_number`) | `partner_staff` | `phone_number` | — |
| same | same | Password (`password`) | `partner_staff` | `password_hash` (hashed) | — |
| same | same | Confirm Password (`confirm_password`) | *(validation only)* | — | — |
| same | same | Role Type (`role_type`) | `partner_staff` | `role_type` | — |
| same | same | Member Role (`member_role`) | `partner_staff` | `member_role` | — |
| *(implicit)* | — | Merchant (context) | `partner_staff` | `partner_id` | `partners.partner_id` |

### 2.6 Inventory — Flights / Hotels / Cruises / Packages CRUD

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Inventory / Flights | flight editor | Airline, From Airport, To Airport, Departure, Arrival, Cabin Class, Price, Seats Available | `flights` | `airline`, `from_airport`, `to_airport`, `departure_time`, `arrival_time`, `cabin_class`, `price`, `seats_available` | — |
| Inventory / Hotels | hotel editor | Name, Location, Price/night, Rating, Amenities, Rooms Available | `hotels` | `name`, `location`, `price_per_night`, `rating`, `amenities`, `rooms_available` | — |
| Inventory / Cruises | cruise editor | Name, Cruise Type, Departure Port, Duration, Price, Departure Month, Cabins Available | `cruises` | `name`, `cruise_type`, `departure_port`, `duration_days`, `price`, `departure_month`, `cabins_available` | — |
| Inventory / Packages | package editor | Title, Package Type, Duration, Price, Description, Available Month, Capacity | `tour_packages` | `title`, `package_type`, `duration_days`, `price`, `description`, `available_month`, `capacity` | — |

### 2.7 Partner Requests — Approve / Reject

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Partner Requests | approve action | Total Amount (optional override) | `partner_bookings` | `total_amount` | — |
| same | approve action | *(implicit: which admin)* | `partner_bookings` | `approved_by` | `admins.id` |
| same | reject action | Rejection Reason | `partner_bookings` | `rejection_reason` | — |
| same | reject action | *(implicit: which admin)* | `partner_bookings` | `rejected_by` | `admins.id` |

### 2.8 Back Office — Service Request Resolution

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Back Office | resolve action | Status decision | `service_requests` | `status` | — |
| same | resolve action | *(implicit: which admin)* | `service_requests` | `resolved_by` | `admins.id` |

---

## 3. Merchant ("My Partner") Portal — `partner-portal.html`

### 3.1 Sign In (3-step OTP flow)

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Sign In / Step 1 | `authStep1` | Username / Email (`authEmail`) | `partner_staff` | `email` (looked up) | — |
| Sign In / Step 2 | `authStep2` | OTP (`authOtp`) | `partner_otp_requests` | `otp_hash` (compared, not stored plain) | `partner_otp_requests.staff_id` → `partner_staff.staff_id` |
| Sign In / Step 3 | `authStep3` | Password (`authPassword`) | `partner_staff` | `password_hash` (compared) | — |

### 3.2 Forgot Password

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Forgot Password / Step 1 | `authForgotStep1` | Email Address (`forgotEmail`) | `partner_staff` | `email` (looked up) | — |
| Forgot Password / Step 2 | `authForgotStep2` | OTP (`forgotOtp`) | `partner_otp_requests` | `otp_hash` | `partner_otp_requests.staff_id` → `partner_staff.staff_id` |
| same | same | New Password (`forgotNewPassword`) | `partner_staff` | `password_hash` (hashed, overwrites) | — |

### 3.3 Profile

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Profile section | `#profileForm` | Company Name (`profCompanyName`, disabled) | `partners` | `company_name` (read-only display) | — |
| same | same | Company Code (`profCompanyCode`, disabled) | `partners` | `company_code` (read-only display) | — |
| same | same | Partner ID (`profPartnerId`, disabled) | `partners` | `partner_id` (read-only display) | — |
| same | same | Full Name (`profFullName`) | `partner_staff` | `full_name` | — |
| same | same | Email (`profEmail`, disabled) | `partner_staff` | `email` (read-only display) | — |
| same | same | Phone (`profPhone`) | `partner_staff` | `phone_number` | — |

### 3.4 Change Password

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Profile section | `#passwordForm` | Current Password (`pwdCurrent`) | `partner_staff` | `password_hash` (verified) | — |
| same | same | New Password (`pwdNew`) | `partner_staff` | `password_hash` (overwrites) | — |

### 3.5 Ticket Enquiry / Request Ticket — search & booking

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Request Ticket | trip search | Trip Type (`rtTripType`) | `partner_bookings` | `trip_type` | — |
| same | same | Cabin Class (`rtCabinClass`) | `partner_bookings` | `cabin_class` | — |
| same | same | Departure (`rtDeparture`) | `partner_bookings` | `departure` | — |
| same | same | Arrival (`rtArrival`) | `partner_bookings` | `arrival` | — |
| same | same | Departure Date (`rtDepartureDate`) | `partner_bookings` | `departure_date` | — |
| same | same | Return Date | `partner_bookings` | `return_date` | — |
| *(implicit)* | selected catalog item | Flight/Hotel/Cruise | `partner_bookings` | `flight_id` / `hotel_id` / `cruise_id` | `flights.id` / `hotels.id` / `cruises.id` |

### 3.6 Request Ticket — Passenger card

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Request Ticket / passenger card | passenger form | Full Name (`data-field="full_name"`) | `partner_booking_passengers` | `full_name` | — |
| same | same | Gender (`gender`) | `partner_booking_passengers` | `gender` | — |
| same | same | Passenger Type (`passenger_type`) | `partner_booking_passengers` | `passenger_type` | — |
| same | same | Passport Issuing Country (`passport_issuing_country_id`) | `partner_booking_passengers` | `passport_issuing_country_id` | `countries.country_id` |
| same | same | Passport Number (`passport_number`) | `partner_booking_passengers` | `passport_number` | — |
| same | same | Passport Issue Date (`passport_issue_date`) | `partner_booking_passengers` | `passport_issue_date` | — |
| same | same | Passport Expiry Date (`passport_expiry_date`) | `partner_booking_passengers` | `passport_expiry_date` | — |
| same | same | Date of Birth (`date_of_birth`) | `partner_booking_passengers` | `date_of_birth` | — |
| same | same | Nationality (`nationality_country_id`) | `partner_booking_passengers` | `nationality_country_id` | `countries.country_id` |

### 3.7 Request Ticket — Travel Preferences & Additional Services

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Request Ticket / passenger card | ancillary section | Baggage (`baggage_catalog_id`) | `partner_booking_passengers` | `baggage_catalog_id` | `ancillary_service_catalog.catalog_id` |
| same | same | Meal Preference (`meal_catalog_id`) | `partner_booking_passengers` | `meal_catalog_id` | `ancillary_service_catalog.catalog_id` |
| same | same | Seat Preference (button-selected, `seat_preference`) | `partner_booking_passengers` | `seat_preference` | — |
| same | same | Special Services (checkboxes, `data-special-service`) | `passenger_special_services` | `catalog_id` (one row per checked service) | `ancillary_service_catalog.catalog_id`, `passenger_special_services.passenger_id` → `partner_booking_passengers.passenger_id` |
| same | same | Special Request (`special_assistance`) | `partner_booking_passengers` | `special_assistance` | — |

### 3.8 Service Requests — Cancellation

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Request History / Cancel | passenger checkboxes | Selected passenger(s) | `cancellation_request_passengers` | `passenger_id` | `partner_booking_passengers.passenger_id` |
| same | `srCancelReason` | Reason | `service_requests` | `reason` | — |

### 3.9 Service Requests — Date Change

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Request History / Date Change | `srDcPassenger` | Passenger | `date_change_requests` | `passenger_id` | `partner_booking_passengers.passenger_id` |
| same | `srDcNewDate` | New Travel Date | `date_change_requests` | `new_travel_date` | — |

### 3.10 Service Requests — Refund

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Request History / Refund | `srRefundAmount` | Amount (₹) | `refund_requests` | `amount_requested` | — |

### 3.11 Service Requests — Passenger Modification

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Request History / Modify Passenger | `srPmPassenger` | Passenger | `passenger_modification_requests` | `passenger_id` | `partner_booking_passengers.passenger_id` |
| same | `srPmField` | Field to Change | `passenger_modification_requests` | `field_changed` | — |
| same | `srPmOldValue` | Old Value (auto-filled, disabled) | `passenger_modification_requests` | `old_value` | — |
| same | `srPmNewValue` | New Value | `passenger_modification_requests` | `new_value` | — |

### 3.12 Notifications (bell dropdown, read-only + mark-read action)

| Page | Form | Field Name | Database Table | Database Column | Foreign Key |
|---|---|---|---|---|---|
| Topbar / notification bell | mark-read click | *(implicit: notification id)* | `partner_notifications` | `is_read` | — |

---

## 4. Super Admin Portal — `super-admin.html`

**No rows here.** Per your explicit prior instruction, the Super Admin
Portal's PostgreSQL objects are being designed and written by you directly
— the backend currently uses an in-memory mock store
(`super_admin_service.py`), not a real table. Its login (demo credentials),
Dashboard, Admin Management (Add Admin), and Profile forms all exist in the
frontend today, but map to **no database column** until you build that
schema. This section is listed for completeness only, so nothing is hidden
from your superior.

---

## 5. Summary counts

| Portal | Real forms mapped | Real fields mapped |
|---|---|---|
| User (Customer) | 11 | 33 |
| Admin | 8 | 33 |
| Merchant (My Partner) | 12 | 44 |
| Super Admin | 0 (no DB per your instruction) | 0 |

---

## 6. Provisioned tables/columns (no current frontend)

These exist in the v2 schema as production-ready scaffolding per your
target architecture, but **no page today reads or writes them**. Listed
here so your superior sees exactly what's real vs. forward-provisioned —
nothing in this section should be read as "already wired up."

| Domain | Table | Reason provisioned |
|---|---|---|
| Shared | `states`, `cities` | Address fields are free text everywhere, not dropdowns |
| Shared | `currencies` | No currency switcher in the app |
| Shared | `languages` | No language switcher in the app |
| Shared | `airports`, `airlines` | `flights.from_airport`/`to_airport`/`airline` remain free text |
| Shared | `hotel_chains`, `cruise_lines` | `hotels`/`cruises` have no chain concept live |
| Shared | `package_images` | `tour_packages.image_url` (single field) is the only image field live |
| Shared | `payment_methods` | `method` columns remain free text everywhere |
| Shared | `system_settings` | No settings screen in any portal yet |
| Shared | `audit_logs` | No catalog-change audit UI yet (narrowly scoped — see DATABASE_STRUCTURE.md §5) |
| Admin | `admin_profiles` (phone/designation/photo) | admin.html's Profile tab only edits full_name/password today |
| Admin | `admin_roles`, `admin_permissions`, `admin_role_permissions` | No role/permission management UI; bootstrapped with a single row, not sample data |
| Merchant | `partner_sessions` | No dedicated session UI; login events are tracked in `partner_activity_logs` |
| Merchant | `partner_bank_accounts`, `partner_documents` | No bank-detail or document-upload UI |
| Merchant | `partner_wallet`, `partner_wallet_transactions` | No wallet UI |
| Merchant | `partner_commissions` | No commission UI |
| Merchant | `partner_invoices` | No invoice UI (distinct from `partner_payments`, which is real) |
| User | `user_addresses` | Only one free-text Address field exists (`user_profiles.address`, real) |
| User | `booking_passengers` | Core booking flow only has a passenger-count dropdown, not named passengers |
