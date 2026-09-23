"""Four Goa tour packages, exactly as the brief specifies them — and no departure dates, because those were not specified.

WHAT THE BRIEF SUPPLIED, AND IS WRITTEN HERE VERBATIM. A design for the Goa
page named four packages and gave, for each, a duration, a from-price and the
three things it includes:

    Goa Beach Escape        5 Days / 4 Nights   Rs 25,000
                            Hotel stay, Sightseeing, Airport transfers
    Goa Cruise Experience   4 Days / 3 Nights   Rs 28,500
                            Cruise dinner, Sightseeing, Hotel stay
    North Goa Heritage Tour 4 Days / 3 Nights   Rs 22,000
                            Church visits, Fort sightseeing, Hotel stay
    Goa Adventure Tour      5 Days / 4 Nights   Rs 27,500
                            Water sports, Sightseeing, Hotel stay

Those are product decisions from the business that sells them, so they go in
as given. Nothing is rounded, renamed or "improved".

WHAT THE BRIEF DID NOT SUPPLY, AND IS THEREFORE ABSENT.

  departure dates   A package with no departures cannot be booked: the
                    booking flow opens by choosing one. These four are
                    created WITHOUT any, which the pages state plainly - the
                    card reads "Dates on request" and the detail page offers
                    an enquiry instead of a Book now that would lead to an
                    empty list. Add dates and both turn into a live booking
                    with no further code.
  ratings           The design shows "4.8 (120 reviews)". Nothing in this
                    database has reviewed a package, and 0083's rule is that
                    a score is served only with its source. A number typed in
                    from a mockup is a review nobody wrote.
  descriptions      `blurb` restates the duration and the inclusions, which
                    are facts from the brief. No adjectives about the trip
                    have been invented.

THE PHOTOGRAPHS ARE REAL AND ALREADY SHIPPED. Each `image_key` names one of
the Goa photographs vendored from Wikimedia Commons by
scripts/fetch_attraction_images.py (frontend/assets/locations, credits in
CREDITS.md there), chosen so the picture shows what the package is about: a
beach for the beach trip, a fort for the heritage tour. The design asked for
generated photography; this uses licensed photographs of the actual places,
which is the only kind this site ships.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision: str = "0084_goa_packages"
down_revision: Union[str, None] = "0083_package_catalogue"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: name, days, nights, price, inclusions, image key, one-line blurb.
#: The image keys are files that exist in frontend/assets/locations.
_PACKAGES = (
    (
        "Goa Beach Escape", 5, 4, 25000,
        ["Hotel stay", "Sightseeing", "Airport transfers"],
        "goa__palolem-beach",
        "Five days on the Goa coast with hotel, sightseeing and airport transfers.",
    ),
    (
        "Goa Cruise Experience", 4, 3, 28500,
        ["Cruise dinner", "Sightseeing", "Hotel stay"],
        "goa__calangute-beach",
        "Four days in Goa with a dinner cruise, sightseeing and a hotel stay.",
    ),
    (
        "North Goa Heritage Tour", 4, 3, 22000,
        ["Church visits", "Fort sightseeing", "Hotel stay"],
        "goa__fort-aguada",
        "Four days around North Goa's churches and forts, with a hotel stay.",
    ),
    (
        "Goa Adventure Tour", 5, 4, 27500,
        ["Water sports", "Sightseeing", "Hotel stay"],
        "goa__dudhsagar-falls",
        "Five days in Goa built around water sports, with sightseeing and a hotel stay.",
    ),
)

_SQL = sa.text(
    """
    INSERT INTO customer_packages
        (name, blurb, description, days, nights, price_from, is_international,
         category, trip_type, destination, inclusions, highlights, image_key, is_active)
    VALUES
        (:name, :blurb, NULL, :days, :nights, :price, false,
         'holiday', 'domestic', 'Goa', :inclusions, :highlights, :image_key, true)
    """
).bindparams(
    sa.bindparam("inclusions", type_=ARRAY(sa.String())),
    sa.bindparam("highlights", type_=ARRAY(sa.String())),
)


def upgrade() -> None:
    for name, days, nights, price, includes, image_key, blurb in _PACKAGES:
        # Idempotent by name: re-running must not create a second "Goa Beach
        # Escape" for somebody to book by accident.
        exists = op.get_bind().execute(
            sa.text("SELECT 1 FROM customer_packages WHERE name = :n"), {"n": name}
        ).first()
        if exists:
            continue
        op.get_bind().execute(_SQL, {
            "name": name, "blurb": blurb, "days": days, "nights": nights,
            "price": price, "inclusions": includes, "highlights": includes,
            "image_key": image_key,
        })


def downgrade() -> None:
    # Only the four this migration created, and only while nothing has been
    # booked against them - a package with a booking is a record of a sale and
    # is deactivated rather than deleted.
    for name, *_rest in _PACKAGES:
        op.get_bind().execute(
            sa.text(
                """
                UPDATE customer_packages SET is_active = false WHERE name = :n
                  AND EXISTS (SELECT 1 FROM customer_package_bookings b
                              WHERE b.package_id = customer_packages.customer_package_id)
                """
            ), {"n": name},
        )
        op.get_bind().execute(
            sa.text(
                """
                DELETE FROM customer_packages WHERE name = :n
                  AND NOT EXISTS (SELECT 1 FROM customer_package_bookings b
                                  WHERE b.package_id = customer_packages.customer_package_id)
                """
            ), {"n": name},
        )
