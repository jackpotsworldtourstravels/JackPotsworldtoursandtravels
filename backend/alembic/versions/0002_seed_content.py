"""seed demo content — flights, hotels, cruises, tour packages

Revision ID: 0002_seed_content
Revises: 0001_initial
Create Date: 2026-07-10

"""
import datetime
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002_seed_content"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


flights_table = sa.table(
    "flights",
    sa.column("airline", sa.String),
    sa.column("from_airport", sa.String),
    sa.column("to_airport", sa.String),
    sa.column("departure_time", sa.DateTime),
    sa.column("arrival_time", sa.DateTime),
    sa.column("cabin_class", sa.String),
    sa.column("price", sa.Numeric),
    sa.column("seats_available", sa.Integer),
)

hotels_table = sa.table(
    "hotels",
    sa.column("name", sa.String),
    sa.column("location", sa.String),
    sa.column("price_per_night", sa.Numeric),
    sa.column("rating", sa.Float),
    sa.column("amenities", sa.String),
    sa.column("image_url", sa.String),
    sa.column("rooms_available", sa.Integer),
)

cruises_table = sa.table(
    "cruises",
    sa.column("name", sa.String),
    sa.column("cruise_type", sa.String),
    sa.column("departure_port", sa.String),
    sa.column("duration_days", sa.Integer),
    sa.column("price", sa.Numeric),
    sa.column("departure_month", sa.String),
)

packages_table = sa.table(
    "tour_packages",
    sa.column("title", sa.String),
    sa.column("package_type", sa.String),
    sa.column("duration_days", sa.Integer),
    sa.column("price", sa.Numeric),
    sa.column("rating", sa.Float),
    sa.column("description", sa.String),
    sa.column("image_url", sa.String),
)


def upgrade() -> None:
    op.bulk_insert(
        flights_table,
        [
            {
                "airline": "IndiGo",
                "from_airport": "Hyderabad (HYD)",
                "to_airport": "Delhi (DEL)",
                "departure_time": datetime.datetime(2026, 7, 18, 6, 30),
                "arrival_time": datetime.datetime(2026, 7, 18, 8, 55),
                "cabin_class": "Economy",
                "price": 2499,
                "seats_available": 42,
            },
            {
                "airline": "Air India",
                "from_airport": "Hyderabad (HYD)",
                "to_airport": "Delhi (DEL)",
                "departure_time": datetime.datetime(2026, 7, 18, 14, 10),
                "arrival_time": datetime.datetime(2026, 7, 18, 16, 40),
                "cabin_class": "Business",
                "price": 8999,
                "seats_available": 12,
            },
            {
                "airline": "Vistara",
                "from_airport": "Mumbai (BOM)",
                "to_airport": "Goa (GOI)",
                "departure_time": datetime.datetime(2026, 7, 20, 9, 0),
                "arrival_time": datetime.datetime(2026, 7, 20, 10, 15),
                "cabin_class": "Economy",
                "price": 3299,
                "seats_available": 30,
            },
            {
                "airline": "SpiceJet",
                "from_airport": "Delhi (DEL)",
                "to_airport": "Bangalore (BLR)",
                "departure_time": datetime.datetime(2026, 7, 22, 18, 45),
                "arrival_time": datetime.datetime(2026, 7, 22, 21, 30),
                "cabin_class": "Economy",
                "price": 4199,
                "seats_available": 25,
            },
        ],
    )

    op.bulk_insert(
        hotels_table,
        [
            {
                "name": "Beachfront Bliss Resort",
                "location": "Goa, India",
                "price_per_night": 1999,
                "rating": 4.6,
                "amenities": "Free WiFi, Pool, Breakfast included",
                "image_url": "https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?auto=format&fit=crop&w=600&q=80",
                "rooms_available": 18,
            },
            {
                "name": "Kashmir Valley Lodge",
                "location": "Kashmir, India",
                "price_per_night": 3499,
                "rating": 4.8,
                "amenities": "Mountain view, Free WiFi, Heating",
                "image_url": "https://images.unsplash.com/photo-1626621341517-bbf3d9990a23?auto=format&fit=crop&w=600&q=80",
                "rooms_available": 10,
            },
            {
                "name": "Backwater Houseboat Stay",
                "location": "Kerala, India",
                "price_per_night": 2799,
                "rating": 4.7,
                "amenities": "Houseboat, All meals included",
                "image_url": "https://images.unsplash.com/photo-1602216056096-3b40cc0c9944?auto=format&fit=crop&w=600&q=80",
                "rooms_available": 6,
            },
        ],
    )

    op.bulk_insert(
        cruises_table,
        [
            {
                "name": "Goa Coastal Cruise",
                "cruise_type": "Goa Cruise",
                "departure_port": "Mumbai",
                "duration_days": 3,
                "price": 4999,
                "departure_month": "July",
            },
            {
                "name": "Kerala Backwater Cruise",
                "cruise_type": "Kerala Backwater Cruise",
                "departure_port": "Kochi",
                "duration_days": 2,
                "price": 6499,
                "departure_month": "July",
            },
            {
                "name": "Singapore Getaway Cruise",
                "cruise_type": "Singapore Cruise",
                "departure_port": "Chennai",
                "duration_days": 5,
                "price": 18999,
                "departure_month": "August",
            },
            {
                "name": "Dubai Desert & Sea Cruise",
                "cruise_type": "Dubai Cruise",
                "departure_port": "Mumbai",
                "duration_days": 7,
                "price": 24999,
                "departure_month": "August",
            },
        ],
    )

    op.bulk_insert(
        packages_table,
        [
            {
                "title": "Goa Escape",
                "package_type": "Domestic Tour Package",
                "duration_days": 4,
                "price": 5999,
                "rating": 4.8,
                "description": "Beachfront stays, water sports, and sunset cruises along Goa's coastline.",
                "image_url": "https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?auto=format&fit=crop&w=500&q=80",
            },
            {
                "title": "Kashmir Valley Retreat",
                "package_type": "Domestic Tour Package",
                "duration_days": 6,
                "price": 16999,
                "rating": 4.9,
                "description": "Houseboats, Gulmarg gondola rides, and snow-capped valley views.",
                "image_url": "https://images.unsplash.com/photo-1626621341517-bbf3d9990a23?auto=format&fit=crop&w=500&q=80",
            },
            {
                "title": "Bali Honeymoon Special",
                "package_type": "Casino Tour Package",
                "duration_days": 5,
                "price": 31999,
                "rating": 4.9,
                "description": "Private villas, candlelight dinners, and couple spa experiences.",
                "image_url": "https://images.unsplash.com/photo-1537996194471-e657df975ab4?auto=format&fit=crop&w=500&q=80",
            },
            {
                "title": "Maldives Overwater Villa",
                "package_type": "Casino Tour Package",
                "duration_days": 4,
                "price": 52999,
                "rating": 5.0,
                "description": "Overwater villas, snorkeling reefs, and private beach dinners.",
                "image_url": "https://images.unsplash.com/photo-1573843981267-be1999ff37cd?auto=format&fit=crop&w=500&q=80",
            },
        ],
    )


def downgrade() -> None:
    op.execute("DELETE FROM tour_packages")
    op.execute("DELETE FROM cruises")
    op.execute("DELETE FROM hotels")
    op.execute("DELETE FROM flights")
