"""Locations get a description and an image key, so a destination can show them.

The homepage used to send a destination card straight to that destination's
hotels. The new flow puts a step in between — Destination -> its famous
locations -> hotels around one location — and a location card needs something
to say beyond its name. 0070 seeded geography only (name, slug, order), so this
adds the two columns the card reads:

* ``description`` — one line about the place. Nullable: a location with none
  simply shows its name, and nothing on the card is invented to fill the gap.
* ``image_key`` — the same KEY convention ``customer_destinations.image_key``
  and ``customer_hotels.image_key`` use (a key the client resolves against
  artwork that shipped with the build, never a URL). Left null here: there is
  no location artwork yet, and a null key is a tinted card, not a broken image.

WHY THE DESCRIPTIONS ARE DATA AND NOT FRONTEND COPY. The requirement is that no
place name or place copy lives in the browser. These rows are the same master
data 0070 wrote, keyed by the (destination slug, location slug) pair 0070
created — never by display name — and written only where ``description`` is
still null, so a line edited in the database survives a re-run.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0074_location_descriptions"
down_revision: Union[str, None] = "0073_service_request_source"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


#: (destination slug, location slug) -> one factual line. Keyed exactly as 0070
#: seeded the rows. A pair with no row (a location since removed) updates
#: nothing, which is the correct outcome.
DESCRIPTIONS: dict[tuple[str, str], str] = {
    ("goa", "north-goa"): "Goa's liveliest beach belt, with markets, cafés and nightlife.",
    ("goa", "south-goa"): "Quieter, wider beaches and resorts in the south of the state.",
    ("goa", "panaji"): "Goa's riverside capital, known for its Latin Quarter streets.",
    ("goa", "calangute"): "One of Goa's biggest and busiest beaches.",
    ("goa", "candolim"): "A long, relaxed beach near Fort Aguada.",
    ("goa", "baga"): "Beach shacks, water sports and Goa's best-known night scene.",
    ("goa", "anjuna"): "Famous for its flea market and cliffside beach.",
    ("goa", "vagator"): "Red cliffs above small beaches, close to Chapora Fort.",

    ("hyderabad", "banjara-hills"): "Upscale neighbourhood of hotels, dining and shopping.",
    ("hyderabad", "jubilee-hills"): "Leafy, affluent area with cafés and Jubilee Hills Check Post.",
    ("hyderabad", "hitec-city"): "Hyderabad's IT hub, with business hotels and malls.",
    ("hyderabad", "gachibowli"): "Tech district near the financial centre and stadium.",
    ("hyderabad", "madhapur"): "Busy IT and dining area next to HITEC City.",
    ("hyderabad", "secunderabad"): "Hyderabad's twin city, home to the main railway station.",
    ("hyderabad", "tank-bund"): "The promenade along Hussain Sagar lake.",

    ("mumbai", "colaba"): "South Mumbai's heritage quarter by the Gateway of India.",
    ("mumbai", "bandra"): "Seaside suburb known for Bandstand and its cafés.",
    ("mumbai", "andheri"): "Well-connected suburb close to Mumbai airport.",
    ("mumbai", "juhu"): "Suburb famous for Juhu Beach.",
    ("mumbai", "powai"): "Lakeside business district in the north-east suburbs.",
    ("mumbai", "navi-mumbai"): "Planned city across the harbour from Mumbai.",

    ("delhi", "connaught-place"): "Central Delhi's colonnaded shopping and dining circle.",
    ("delhi", "aerocity"): "Hotel district beside Indira Gandhi International Airport.",
    ("delhi", "karol-bagh"): "Busy market area in central Delhi.",
    ("delhi", "saket"): "South Delhi district of malls, near the Qutub Minar.",
    ("delhi", "dwarka"): "Residential sub-city in south-west Delhi, near the airport.",
    ("delhi", "paharganj"): "Budget-stay area next to New Delhi railway station.",

    ("bengaluru", "mg-road"): "Central Bengaluru's shopping and business avenue.",
    ("bengaluru", "indiranagar"): "Popular area for restaurants, pubs and boutiques.",
    ("bengaluru", "koramangala"): "Lively neighbourhood of startups, cafés and dining.",
    ("bengaluru", "whitefield"): "Eastern IT corridor with business hotels.",
    ("bengaluru", "electronic-city"): "Southern technology park and industrial hub.",
    ("bengaluru", "outer-ring-road"): "Tech-park corridor circling the city.",

    ("kashmir", "srinagar"): "Kashmir's summer capital, on the shores of Dal Lake.",
    ("kashmir", "gulmarg"): "Meadow resort known for skiing and its gondola.",
    ("kashmir", "pahalgam"): "Riverside valley town on the Lidder river.",
    ("kashmir", "sonamarg"): "High meadow at the gateway to the Zojila pass.",
    ("kashmir", "dal-lake"): "Srinagar's lake of houseboats and shikara rides.",

    ("jaipur", "amer"): "Home of Amer Fort, on the hills north of the city.",
    ("jaipur", "civil-lines"): "Quiet, central residential area of Jaipur.",
    ("jaipur", "mi-road"): "Jaipur's main shopping street, near the old city.",
    ("jaipur", "bani-park"): "Residential area with heritage hotels.",
    ("jaipur", "vaishali-nagar"): "West Jaipur neighbourhood of malls and dining.",

    ("kolkata", "park-street"): "Kolkata's classic street of restaurants and nightlife.",
    ("kolkata", "salt-lake"): "Planned township and IT hub in east Kolkata.",
    ("kolkata", "new-town"): "Modern business district near the airport.",
    ("kolkata", "alipore"): "Leafy, upscale area in south Kolkata.",
    ("kolkata", "howrah"): "Across the Hooghly river, by Howrah Bridge and station.",

    ("vijayawada", "benz-circle"): "Vijayawada's busy commercial junction.",
    ("vijayawada", "governorpet"): "Central shopping and business area.",
    ("vijayawada", "labbipet"): "Commercial area with hotels and restaurants.",
    ("vijayawada", "gannavaram"): "Home of Vijayawada airport.",

    ("tirupati", "tirumala"): "Hill town of the Sri Venkateswara Temple.",
    ("tirupati", "alipiri"): "Foot of the Tirumala hills and start of the pilgrim path.",
    ("tirupati", "renigunta"): "Junction town near Tirupati airport.",

    ("dubai", "downtown-dubai"): "Home of the Burj Khalifa and The Dubai Mall.",
    ("dubai", "dubai-marina"): "Waterfront district of towers, yachts and dining.",
    ("dubai", "palm-jumeirah"): "The palm-shaped island of beach resorts.",
    ("dubai", "jumeirah"): "Beachfront area near the Burj Al Arab.",
    ("dubai", "deira"): "Old Dubai's trading quarter, with the gold and spice souks.",
    ("dubai", "bur-dubai"): "Historic district along Dubai Creek.",

    ("bali", "ubud"): "Bali's cultural heart among rice terraces and forest.",
    ("bali", "seminyak"): "Stylish beach area of villas, boutiques and dining.",
    ("bali", "kuta"): "Busy surf beach close to the airport.",
    ("bali", "nusa-dua"): "Enclave of large beachfront resorts.",
    ("bali", "canggu"): "Laid-back surf village with cafés.",
    ("bali", "uluwatu"): "Clifftop temple and surf breaks in the south.",

    ("maldives", "male"): "The Maldives' compact capital island.",
    ("maldives", "north-male-atoll"): "Resort islands a short boat ride from the airport.",
    ("maldives", "south-male-atoll"): "Quieter resort islands south of Malé.",
    ("maldives", "ari-atoll"): "Known for diving and whale-shark encounters.",
    ("maldives", "baa-atoll"): "A UNESCO biosphere reserve with Hanifaru Bay.",

    ("singapore", "marina-bay"): "Singapore's skyline, Marina Bay Sands and Gardens by the Bay.",
    ("singapore", "orchard"): "The city's main shopping boulevard.",
    ("singapore", "sentosa"): "Resort island of beaches and attractions.",
    ("singapore", "chinatown"): "Heritage quarter of temples, markets and food.",
    ("singapore", "clarke-quay"): "Riverside dining and nightlife.",

    ("thailand", "bangkok"): "Thailand's capital of temples, markets and street food.",
    ("thailand", "phuket"): "Thailand's largest island, known for its beaches.",
    ("thailand", "krabi"): "Limestone cliffs, islands and beaches on the Andaman coast.",
    ("thailand", "pattaya"): "Beach resort city south-east of Bangkok.",
    ("thailand", "chiang-mai"): "Northern city of old temples and mountains.",
    ("thailand", "koh-samui"): "Palm-fringed island in the Gulf of Thailand.",
}


def upgrade() -> None:
    op.add_column("customer_locations", sa.Column("description", sa.Text(), nullable=True))
    op.add_column("customer_locations", sa.Column("image_key", sa.String(60), nullable=True))

    stmt = sa.text(
        "UPDATE customer_locations AS l "
        "SET description = :text "
        "FROM customer_destinations AS d "
        "WHERE l.destination_id = d.customer_destination_id "
        "AND d.slug = :dest AND l.slug = :loc AND l.description IS NULL"
    )
    bind = op.get_bind()
    for (dest, loc), text in DESCRIPTIONS.items():
        bind.execute(stmt, {"text": text, "dest": dest, "loc": loc})


def downgrade() -> None:
    op.drop_column("customer_locations", "image_key")
    op.drop_column("customer_locations", "description")
