-- Partner Portal — Gap completion — 08: Seed data
-- Depends on: 05_stored_procedures.sql (sp_register_partner)
--
-- Only "Partner Companies" + their first login are seeded here. Countries,
-- Roles, and Permissions were already seeded in Phase 2
-- (../14_seed_reference_data.sql: 190 countries, partner_admin/partner_staff
-- roles, 12 permissions) — reseeding them here would just be a duplicate of
-- already-applied, already-tested data. "Airlines" is deliberately not
-- seeded — see this phase's README ("Airlines table" decision): Ticket
-- Enquiry reuses the existing flights table rather than a parallel catalog.
--
-- Passwords below are real bcrypt hashes (via the same passlib/bcrypt the
-- app already uses — generated with backend/app/auth/security.hash_password,
-- not fabricated inline) for the demo passwords noted in each comment.
--
-- Emails use real, deliverable addresses (not the reserved .example TLD)
-- so OTP/password-reset emails actually arrive during a demo. Both demo
-- accounts route to the same real inbox via Gmail "+" sub-addressing
-- (RFC 5233 — mail to local+tag@gmail.com delivers to local@gmail.com,
-- while remaining a distinct, unique string for the email UNIQUE
-- constraints on partners/partner_users). Swap in different real
-- addresses per company if you want separate inboxes.

-- Demo password: Aurora@2026
SELECT sp_register_partner(
    'Aurora Gaming Studios', 'AURORA01', 'AU', 'jackpotsworldtours.travels+aurora@gmail.com', '+91-9800011122',
    'Meera Iyer', 'jackpotsworldtours.travels@gmail.com',
    '$2b$12$KwIT.AUFzf0r.GsXinVSTu1kzUeiArBLUul9rRnwvEtCLd97hDpaC',
    'partner_admin'
);

-- Demo password: Blueline@2026
SELECT sp_register_partner(
    'Blueline Corporate Travel', 'BLUELINE01', 'BL', 'jackpotsworldtours.travels+blueline@gmail.com', '+91-9800033344',
    'Arjun Nair', 'jackpotsworldtours.travels+arjun@gmail.com',
    '$2b$12$ZxKoJzs.DL/NtS8LjLY8yOMcVAnB1/c7MgB.o3KAu9kiWkXSA9jM2',
    'partner_admin'
);
