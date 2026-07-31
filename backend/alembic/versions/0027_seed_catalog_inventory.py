"""seed catalog inventory for Ticket Enquiry

Revision ID: 0027_seed_catalog
Revises: 0026_clear_legacy_permissions
Create Date: 2026-07-29

Migration 0023 dropped the legacy flights/hotels/cruises/tour_packages
tables without re-seeding, because catalog rows now live in
``service_requests`` and re-seeding belonged with the application code that
reads them. That code exists now, so this restores searchable inventory.

Each row is ``request_type='catalog_item'`` with ``status='approved'``
(the marker for "live and sellable") and no owner — ``ck_sr_catalog_has_no_owner``
enforces that catalog inventory is platform-owned, never merchant-owned.

Dates are generated relative to the migration run so the demo never shows
inventory in the past.
"""
import datetime
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0027_seed_catalog"
down_revision: Union[str, None] = "0026_clear_legacy_permissions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


FLIGHTS = [
    # (airline, no, from, from_city, to, to_city, dep, dur_min, cabin, fare, tax, seats, day_offset)
    ("Air India", "AI-202", "BLR", "Bengaluru", "DXB", "Dubai", "02:30", 225, "economy", 18500, 3200, 180, 14),
    ("Air India", "AI-204", "BLR", "Bengaluru", "DXB", "Dubai", "14:10", 230, "business", 62000, 8400, 24, 14),
    ("IndiGo", "6E-1423", "DEL", "New Delhi", "BOM", "Mumbai", "06:45", 135, "economy", 5400, 980, 186, 7),
    ("IndiGo", "6E-987", "BOM", "Mumbai", "SIN", "Singapore", "23:15", 330, "economy", 21800, 4100, 180, 21),
    ("Emirates", "EK-565", "DXB", "Dubai", "LHR", "London", "08:05", 445, "economy", 34500, 7200, 300, 30),
    ("Emirates", "EK-501", "DXB", "Dubai", "BOM", "Mumbai", "03:40", 185, "business", 78000, 11500, 20, 10),
    ("Qatar Airways", "QR-579", "HYD", "Hyderabad", "DOH", "Doha", "04:20", 260, "economy", 19900, 3600, 220, 18),
    ("Singapore Airlines", "SQ-423", "MAA", "Chennai", "SIN", "Singapore", "22:50", 265, "premium_economy", 41200, 6800, 60, 25),
    ("Lufthansa", "LH-763", "DEL", "New Delhi", "FRA", "Frankfurt", "01:55", 520, "economy", 46800, 9100, 280, 35),
    ("British Airways", "BA-138", "BOM", "Mumbai", "LHR", "London", "13:25", 585, "business", 142000, 18600, 16, 40),
    ("Etihad", "EY-217", "COK", "Kochi", "AUH", "Abu Dhabi", "09:10", 245, "economy", 17600, 3100, 190, 12),
    ("Thai Airways", "TG-338", "CCU", "Kolkata", "BKK", "Bangkok", "11:30", 155, "economy", 14300, 2700, 200, 9),
]

HOTELS = [
    # (name, city, country, stars, room, rate, tax, rooms, offset, nights)
    ("Taj Coromandel", "Chennai", "India", 5, "Deluxe King", 12500, 2250, 40, 14, 3),
    ("The Oberoi", "New Delhi", "India", 5, "Premier Room", 18900, 3400, 25, 21, 2),
    ("Atlantis The Palm", "Dubai", "UAE", 5, "Ocean Deluxe", 32000, 5760, 60, 30, 4),
    ("Marina Bay Sands", "Singapore", "Singapore", 5, "Deluxe City View", 28500, 5130, 80, 25, 3),
    ("Novotel Bengaluru", "Bengaluru", "India", 4, "Superior Twin", 7200, 1300, 55, 10, 2),
]

CRUISES = [
    # (name, line, from, to, nights, cabin, fare, tax, cabins, offset)
    ("Arabian Gulf Explorer", "Costa Cruises", "Dubai", "Doha", 5, "Balcony", 62000, 9300, 120, 45),
    ("Andaman Discovery", "Cordelia Cruises", "Chennai", "Port Blair", 4, "Sea View", 38500, 5800, 150, 28),
    ("Mediterranean Classics", "MSC Cruises", "Barcelona", "Rome", 7, "Suite", 148000, 22200, 40, 60),
]


def _catalog_row(
    number: str, travel_type: str, title: str, details: dict, fare: float, tax: float,
    units: int, travel_date, return_date=None,
) -> dict:
    return {
        "request_number": number,
        "request_type": "catalog_item",
        "travel_type": travel_type,
        "status": "approved",
        "title": title,
        "travel_details": json.dumps(details),
        "pricing": json.dumps(
            {"base_fare": fare, "taxes": tax, "currency": "INR", "total": fare + tax}
        ),
        "total_amount": fare + tax,
        "available_units": units,
        "travel_date": travel_date,
        "return_date": return_date,
        "status_history": json.dumps([]),
    }


def upgrade() -> None:
    today = datetime.date.today()
    rows: list[dict] = []
    seq = 0

    for (airline, no, org, org_city, dst, dst_city, dep, dur, cabin, fare, tax, seats, offset) in FLIGHTS:
        seq += 1
        date = today + datetime.timedelta(days=offset)
        hour, minute = (int(x) for x in dep.split(":"))
        departure = datetime.datetime.combine(date, datetime.time(hour, minute))
        rows.append(
            _catalog_row(
                f"CAT-FL-{seq:04d}", "flight", f"{airline} {no} · {org} → {dst}",
                {
                    "airline": airline, "flight_number": no,
                    "origin": org, "origin_city": org_city,
                    "destination": dst, "destination_city": dst_city,
                    "departure_time": departure.isoformat(),
                    "arrival_time": (departure + datetime.timedelta(minutes=dur)).isoformat(),
                    "duration_minutes": dur, "cabin_class": cabin,
                    "trip_type": "one_way", "stops": 0, "baggage_kg": 30 if cabin == "economy" else 40,
                },
                fare, tax, seats, date,
            )
        )

    for (name, city, country, stars, room, rate, tax, count, offset, nights) in HOTELS:
        seq += 1
        check_in = today + datetime.timedelta(days=offset)
        rows.append(
            _catalog_row(
                f"CAT-HT-{seq:04d}", "hotel", f"{name} · {city}",
                {
                    "hotel_name": name, "destination": city, "destination_city": city,
                    "origin": city, "origin_city": city, "country": country,
                    "star_rating": stars, "room_type": room, "nights": nights,
                    "amenities": ["wifi", "breakfast", "pool", "gym"],
                },
                rate * nights, tax * nights, count, check_in,
                check_in + datetime.timedelta(days=nights),
            )
        )

    for (name, line, org, dst, nights, cabin, fare, tax, cabins, offset) in CRUISES:
        seq += 1
        depart = today + datetime.timedelta(days=offset)
        rows.append(
            _catalog_row(
                f"CAT-CR-{seq:04d}", "cruise", f"{name} · {org} → {dst}",
                {
                    "cruise_name": name, "cruise_line": line,
                    "origin": org, "origin_city": org, "destination": dst, "destination_city": dst,
                    "nights": nights, "cabin_class": cabin,
                    "ports_of_call": [org, dst],
                },
                fare, tax, cabins, depart, depart + datetime.timedelta(days=nights),
            )
        )

    op.get_bind().execute(
        sa.text(
            """
            INSERT INTO service_requests (
                request_number, request_type, travel_type, status, title,
                travel_details, pricing, total_amount, available_units,
                travel_date, return_date, status_history
            ) VALUES (
                :request_number, CAST(:request_type AS request_type_enum),
                CAST(:travel_type AS travel_type_enum),
                CAST(:status AS request_status_enum), :title,
                CAST(:travel_details AS jsonb), CAST(:pricing AS jsonb),
                :total_amount, :available_units, :travel_date, :return_date,
                CAST(:status_history AS jsonb)
            )
            """
        ),
        rows,
    )


def downgrade() -> None:
    op.execute("DELETE FROM service_requests WHERE request_type = 'catalog_item'")
