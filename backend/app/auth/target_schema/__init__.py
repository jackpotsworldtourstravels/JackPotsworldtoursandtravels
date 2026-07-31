# Staged auth layer for the target 9-table schema — see
# docs/DATABASE_REDESIGN_9TABLE.md and docs/ROUTER_CUTOVER_CHECKLIST.md.
# Not imported by app/main.py yet; consolidates the legacy
# app/auth/security.py + deps.py + partner_deps.py + super_admin_deps.py into
# one module each, since ts_users now holds every actor type (customer,
# admin, super_admin, merchant_staff) with a user_type discriminator instead
# of three separate identity tables and three separate JWT scopes.
