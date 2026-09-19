"""Famous places to visit — the landmarks a destination page lists.

The destination page showed ``customer_locations``, which are AREAS: Banjara
Hills, HITEC City, Dubai Marina. Those are how hotels are filed (0072) and the
zones the Hotelbeds sync maps onto, so they stay exactly as they are. But nobody
travels to Hyderabad to see Banjara Hills; they go to see Charminar. The owner
asked for the places people visit and photograph instead.

So this adds ``customer_attractions``: one row per landmark, owned by a
destination, with a description and an optional image key.

HOTELS STILL COME FROM AREAS. A hotel is filed under an area by foreign key,
never under a landmark, so each attraction carries ``area_location_id`` — the
nearest area this catalogue lists — and "View Hotels" shows that area's hotels,
saying so on the page ("hotels in Tank Bund, the nearest area we list"). Where
no listed area is close enough to honestly call nearby (Dudhsagar Falls, 60 km
from any Goa area), it is null and the page says there are no hotels nearby
yet rather than borrowing a distant area's.

THE ROWS ARE DATA, keyed by (destination slug, area slug) exactly as 0070
seeded them — no display name is matched. A destination or area that no longer
exists skips its rows rather than failing the migration.
"""
from typing import Sequence, Union

import re

import sqlalchemy as sa
from alembic import op

revision: str = "0075_customer_attractions"
down_revision: Union[str, None] = "0074_location_descriptions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


#: destination slug -> [(name, nearest area slug or None, description)].
#: Listed in the order the page shows them: the defining sight first.
ATTRACTIONS: dict[str, list[tuple[str, str | None, str]]] = {
    "hyderabad": [
        ("Charminar", "tank-bund", "The 16th-century four-minaret monument at the heart of the old city."),
        ("Golconda Fort", "banjara-hills", "Hilltop fort of the Qutb Shahi kings, famous for its acoustics."),
        ("Birla Mandir", "tank-bund", "White-marble Venkateswara temple on a hill above Hussain Sagar."),
        ("Hussain Sagar Lake", "tank-bund", "Heart-shaped lake with the monolithic Buddha statue at its centre."),
        ("Chowmahalla Palace", "tank-bund", "The Nizams' 18th-century palace of courtyards and chandeliers."),
        ("Salar Jung Museum", "tank-bund", "One of India's largest art collections, on the Musi river."),
        ("Ramoji Film City", None, "A vast working film studio and theme park outside the city."),
    ],
    "goa": [
        ("Basilica of Bom Jesus", "panaji", "UNESCO-listed Old Goa church holding St Francis Xavier's remains."),
        ("Fort Aguada", "candolim", "17th-century Portuguese fort and lighthouse above the Arabian Sea."),
        ("Chapora Fort", "vagator", "Hilltop fort ruins with sweeping views over Vagator beach."),
        ("Baga Beach", "baga", "Goa's liveliest beach, known for shacks and water sports."),
        ("Calangute Beach", "calangute", "The 'Queen of Beaches' and the busiest stretch of North Goa."),
        ("Palolem Beach", "south-goa", "A crescent of palm-fringed sand in the south."),
        ("Dudhsagar Falls", None, "Four-tiered waterfall on the Mandovi river in the Western Ghats."),
    ],
    "mumbai": [
        ("Gateway of India", "colaba", "The 1924 basalt arch on the waterfront at Apollo Bunder."),
        ("Marine Drive", "colaba", "The curving seafront promenade called the Queen's Necklace."),
        ("Chhatrapati Shivaji Maharaj Terminus", "colaba", "UNESCO-listed Victorian Gothic railway station."),
        ("Bandra-Worli Sea Link", "bandra", "The cable-stayed bridge across Mahim Bay."),
        ("Siddhivinayak Temple", "bandra", "Mumbai's most visited Ganesha temple, in Prabhadevi."),
        ("Juhu Beach", "juhu", "The city's favourite beach for sunsets and street food."),
        ("Elephanta Caves", None, "Rock-cut Shiva cave temples on an island in the harbour."),
    ],
    "delhi": [
        ("India Gate", "connaught-place", "The war memorial arch at the end of Kartavya Path."),
        ("Red Fort", "paharganj", "The Mughal emperors' red sandstone fort in Old Delhi."),
        ("Qutub Minar", "saket", "The 73-metre 12th-century victory tower, a UNESCO site."),
        ("Humayun's Tomb", "connaught-place", "The garden tomb that inspired the Taj Mahal."),
        ("Lotus Temple", "saket", "The flower-shaped Bahá'í House of Worship."),
        ("Jama Masjid", "paharganj", "India's largest mosque, built by Shah Jahan."),
        ("Akshardham Temple", "connaught-place", "Vast carved-stone temple complex on the Yamuna."),
    ],
    "bengaluru": [
        ("Bangalore Palace", "mg-road", "Tudor-style palace of the Wodeyar family."),
        ("Lalbagh Botanical Garden", "mg-road", "Historic garden with a Victorian glasshouse."),
        ("Cubbon Park", "mg-road", "The city's green heart, beside the state legislature."),
        ("Vidhana Soudha", "mg-road", "The granite seat of Karnataka's legislature."),
        ("Tipu Sultan's Summer Palace", "mg-road", "Teak-pillared 18th-century palace in the old town."),
        ("ISKCON Temple", "mg-road", "Hilltop Krishna temple in Rajajinagar."),
    ],
    "kashmir": [
        ("Dal Lake", "dal-lake", "Srinagar's lake of houseboats, floating markets and shikaras."),
        ("Shalimar Bagh", "dal-lake", "Terraced Mughal garden on the shore of Dal Lake."),
        ("Nishat Bagh", "dal-lake", "The largest Mughal garden, facing the lake and mountains."),
        ("Gulmarg Gondola", "gulmarg", "One of the world's highest cable cars, up Mount Apharwat."),
        ("Betaab Valley", "pahalgam", "Meadow valley of pines and streams near Pahalgam."),
        ("Thajiwas Glacier", "sonamarg", "Snowfields reached by pony or on foot from Sonamarg."),
    ],
    "jaipur": [
        ("Amer Fort", "amer", "Hilltop palace-fort of honey-coloured stone and mirrored halls."),
        ("Hawa Mahal", "mi-road", "The Palace of Winds and its 953 latticed windows."),
        ("City Palace", "mi-road", "The royal family's palace complex in the old city."),
        ("Jantar Mantar", "mi-road", "UNESCO-listed 18th-century astronomical observatory."),
        ("Nahargarh Fort", "amer", "Ridge-top fort with views over the Pink City."),
        ("Jal Mahal", "amer", "The Water Palace, afloat in Man Sagar lake."),
    ],
    "kolkata": [
        ("Victoria Memorial", "park-street", "White-marble memorial hall and museum set in gardens."),
        ("Howrah Bridge", "howrah", "The cantilever bridge over the Hooghly, the city's icon."),
        ("Indian Museum", "park-street", "India's oldest museum, founded in 1814."),
        ("St Paul's Cathedral", "park-street", "Gothic Revival cathedral near the Maidan."),
        ("Eco Park", "new-town", "Large urban park with a lake and themed gardens."),
        ("Dakshineswar Kali Temple", None, "Riverside temple associated with Ramakrishna."),
    ],
    "vijayawada": [
        ("Kanaka Durga Temple", "governorpet", "Hilltop temple on Indrakeeladri above the Krishna river."),
        ("Prakasam Barrage", "governorpet", "The long barrage across the Krishna, lit up at night."),
        ("Bhavani Island", "governorpet", "One of the largest river islands on the Krishna."),
        ("Undavalli Caves", "governorpet", "Rock-cut cave temples across the river."),
    ],
    "tirupati": [
        ("Sri Venkateswara Temple", "tirumala", "The hill shrine of Lord Venkateswara at Tirumala."),
        ("Silathoranam", "tirumala", "A natural rock arch near the Tirumala temple."),
        ("Akasaganga Teertham", "tirumala", "Sacred waterfall in the Tirumala hills."),
        ("Sri Padmavathi Ammavari Temple", "alipiri", "The goddess Padmavathi's temple at Tiruchanur."),
        ("Talakona Waterfall", None, "The highest waterfall in Andhra Pradesh, in the forest."),
    ],
    "dubai": [
        ("Burj Khalifa", "downtown-dubai", "The world's tallest building and its observation decks."),
        ("The Dubai Mall", "downtown-dubai", "Vast mall with an aquarium and ice rink."),
        ("Dubai Fountain", "downtown-dubai", "The choreographed fountain show at the Burj's foot."),
        ("Burj Al Arab", "jumeirah", "The sail-shaped hotel on its own island."),
        ("Atlantis, The Palm", "palm-jumeirah", "The landmark resort at the tip of the Palm."),
        ("Al Fahidi Historical District", "bur-dubai", "Old Dubai's wind-tower houses along the creek."),
        ("Dubai Frame", "bur-dubai", "A 150-metre picture frame over old and new Dubai."),
        ("Gold Souk", "deira", "Deira's traditional market of gold and jewellery."),
    ],
    "bali": [
        ("Tanah Lot Temple", "canggu", "Sea temple on a rock off the coast, best at sunset."),
        ("Uluwatu Temple", "uluwatu", "Clifftop temple famous for its Kecak fire dance."),
        ("Tegallalang Rice Terraces", "ubud", "Stepped green rice terraces north of Ubud."),
        ("Sacred Monkey Forest Sanctuary", "ubud", "Temple forest home to long-tailed macaques."),
        ("Ubud Palace", "ubud", "The royal palace in the centre of Ubud."),
        ("Mount Batur", None, "Active volcano climbed for its sunrise views."),
    ],
    "maldives": [
        ("Hukuru Miskiy", "male", "Malé's 17th-century coral-stone Friday Mosque."),
        ("Artificial Beach", "male", "The capital's city beach on the east of Malé."),
        ("Banana Reef", "north-male-atoll", "One of the Maldives' first and best-known dive sites."),
        ("Maaya Thila", "ari-atoll", "Famous dive site for reef sharks and turtles."),
        ("Hanifaru Bay", "baa-atoll", "Where manta rays gather in the monsoon months."),
    ],
    "singapore": [
        ("Marina Bay Sands", "marina-bay", "The three-tower resort with its SkyPark on top."),
        ("Gardens by the Bay", "marina-bay", "Supertree Grove and the cooled conservatories."),
        ("Merlion Park", "marina-bay", "Singapore's half-lion, half-fish icon on the bay."),
        ("Universal Studios Singapore", "sentosa", "Theme park on Sentosa island."),
        ("Singapore Botanic Gardens", "orchard", "UNESCO-listed gardens with the National Orchid Garden."),
        ("Buddha Tooth Relic Temple", "chinatown", "Tang-style temple and museum in Chinatown."),
    ],
    "thailand": [
        ("Grand Palace", "bangkok", "Bangkok's royal palace and the Temple of the Emerald Buddha."),
        ("Wat Arun", "bangkok", "The Temple of Dawn on the Chao Phraya river."),
        ("Phi Phi Islands", "krabi", "Limestone islands with Maya Bay and turquoise water."),
        ("Railay Beach", "krabi", "Cliff-backed beach reachable only by boat."),
        ("Big Buddha Phuket", "phuket", "The 45-metre white marble Buddha above Chalong."),
        ("Sanctuary of Truth", "pattaya", "An all-wood temple-palace by the sea."),
        ("Doi Suthep", "chiang-mai", "Golden hilltop temple overlooking Chiang Mai."),
    ],
}


def _slug(value: str) -> str:
    """The same fold 0070 used: lower-case ASCII words joined by hyphens."""
    return re.sub(r"[^a-z0-9]+", "-", value.lower().replace("'", "")).strip("-")


def upgrade() -> None:
    op.create_table(
        "customer_attractions",
        sa.Column("customer_attraction_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "destination_id", sa.BigInteger(),
            sa.ForeignKey("customer_destinations.customer_destination_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "area_location_id", sa.BigInteger(),
            sa.ForeignKey("customer_locations.customer_location_id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(150), nullable=False),
        sa.Column("slug", sa.String(150), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("image_key", sa.String(60), nullable=True),
        sa.Column("sort_order", sa.SmallInteger(), nullable=False, server_default="100"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("destination_id", "slug", name="uq_customer_attraction_slug"),
    )
    op.create_index("ix_customer_attractions_destination_id", "customer_attractions", ["destination_id"])
    op.create_index("ix_customer_attractions_area_location_id", "customer_attractions", ["area_location_id"])

    bind = op.get_bind()
    for dest_slug, rows in ATTRACTIONS.items():
        dest_id = bind.execute(
            sa.text("SELECT customer_destination_id FROM customer_destinations WHERE slug = :s"),
            {"s": dest_slug},
        ).scalar()
        if dest_id is None:
            continue
        for order, (name, area_slug, description) in enumerate(rows, start=1):
            area_id = None
            if area_slug:
                area_id = bind.execute(
                    sa.text(
                        "SELECT customer_location_id FROM customer_locations "
                        "WHERE destination_id = :d AND slug = :s"
                    ),
                    {"d": dest_id, "s": area_slug},
                ).scalar()
            bind.execute(
                sa.text(
                    "INSERT INTO customer_attractions "
                    "(destination_id, area_location_id, name, slug, description, sort_order) "
                    "VALUES (:d, :a, :n, :s, :desc, :o) "
                    "ON CONFLICT ON CONSTRAINT uq_customer_attraction_slug DO NOTHING"
                ),
                {"d": dest_id, "a": area_id, "n": name, "s": _slug(name),
                 "desc": description, "o": order * 10},
            )


def downgrade() -> None:
    op.drop_index("ix_customer_attractions_area_location_id", table_name="customer_attractions")
    op.drop_index("ix_customer_attractions_destination_id", table_name="customer_attractions")
    op.drop_table("customer_attractions")
