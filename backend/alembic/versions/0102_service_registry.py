"""customer-facing service registry

Revision ID: 0102_service_registry
Revises: 0101_customer_notif_prefs
Create Date: 2026-11-26

The one global catalogue of travel services the public storefront offers, with
per-service admin controls: enable/disable (master switch), navigation + home
visibility, ordering, maintenance mode, and honest supplier/integration status.

This is NOT ``merchant_service_access`` (migration 0045): that table is a
per-merchant B2B entitlement limited to flights/hotels/visa/holidays. This is a
single global row per customer-facing service, independent of any merchant. Both
are preserved on purpose.

The table ships SEEDED with every current service ENABLED, so the storefront's
behaviour is unchanged the moment the migration runs — nav still shows every
service, and the three bookable services (flights/hotels/packages) keep working.
Supplier readiness is recorded honestly in ``integration_status`` (live for the
three real engines, preview/enquiry for the rest) without changing any booking
behaviour.

HAND-WRITTEN: ``alembic/env.py`` autogenerate does not see ``models_customer``,
so this DDL must track ``ServiceRegistry`` exactly.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0102_service_registry"
down_revision: Union[str, None] = "0101_customer_notif_prefs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (code, name, href, icon, nav_order, home_visible, integration_status, provider, description)
_SEED = [
    ("flights",   "Flights",               "/flights",    "flights",    10,  True,  "live",       "TBO",             "Search and book domestic and international flights."),
    ("hotels",    "Hotels",                "/hotels",     "hotels",     20,  True,  "live",       "TBO",             "Find and book hotels and resorts."),
    ("villas",    "Villas & Homestays",    "/villas",     "home",       30,  False, "preview",    None,              "Villas, apartments, resorts and homestays."),
    ("packages",  "Holiday Packages",      "/packages",   "packages",   40,  True,  "live",       "JackPots World",  "Curated holiday packages with departures and inclusions."),
    ("trains",    "Trains",                "/trains",     "trains",     50,  False, "preview",    None,              "Compare trains by class, timing and station."),
    ("buses",     "Buses",                 "/buses",      "buses",      60,  False, "preview",    None,              "Compare bus operators, types and boarding points."),
    ("cabs",      "Cabs",                  "/cabs",       "cabs",       70,  False, "preview",    None,              "Airport transfers, local rentals and outstation trips."),
    ("activities","Tours & Attractions",   "/activities", "activities", 80,  False, "preview",    None,              "City tours, guided experiences and attraction tickets."),
    ("visa",      "Visa",                  "/visa",       "visa",       90,  False, "enquiry",    None,              "Destination visa requirements and application support."),
    ("forex",     "Forex Card & Currency", "/forex",      "forex",      100, False, "enquiry",    None,              "Foreign currency and travel cards via authorised providers."),
    ("insurance", "Travel Insurance",      "/insurance",  "insurance",  110, False, "enquiry",    None,              "Travel protection via authorised insurers."),
]


def upgrade() -> None:
    table = op.create_table(
        "service_registry",
        sa.Column("service_registry_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("code", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("description", sa.String(length=300), nullable=True),
        sa.Column("href", sa.String(length=120), nullable=False),
        sa.Column("icon", sa.String(length=40), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("nav_visible", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("home_visible", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("nav_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("maintenance_mode", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("maintenance_message", sa.String(length=300), nullable=True),
        sa.Column("integration_status", sa.String(length=20), nullable=False, server_default=sa.text("'preview'")),
        sa.Column("provider", sa.String(length=80), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("code", name="uq_service_registry_code"),
    )
    op.create_index("ix_service_registry_order", "service_registry", ["nav_order"])

    op.bulk_insert(
        table,
        [
            {
                "code": code, "name": name, "href": href, "icon": icon,
                "nav_order": order, "home_visible": home, "nav_visible": True,
                "enabled": True, "maintenance_mode": False,
                "integration_status": status, "provider": provider,
                "description": desc,
            }
            for (code, name, href, icon, order, home, status, provider, desc) in _SEED
        ],
    )


def downgrade() -> None:
    op.drop_index("ix_service_registry_order", table_name="service_registry")
    op.drop_table("service_registry")
