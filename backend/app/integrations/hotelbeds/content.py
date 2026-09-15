"""The Content API adapter: fetch static hotel catalogue, hand back JackPots shapes.

Endpoints used (all verified in OpenAPI-Hotel-ContentAPI-3.0.yaml):

    GET /locations/countries
    GET /locations/destinations?countryCodes=IN
    GET /hotels?destinationCode=…&countryCode=…&fields=all&from=N&to=M

PAGINATION IS ``from``/``to``, ONE-BASED AND INCLUSIVE. Not offset/limit — a
detail worth stating because getting it wrong silently skips or repeats rows
rather than erroring. The response carries ``total``, which is the count of
records matching the filter regardless of the page, so the number of hotels in
a destination is knowable from a single one-row request. ``count_hotels`` does
exactly that, and it is the cheapest call in this module — which matters when
a sandbox key allows fifty calls a day.

EVERYTHING HERE IS A READ. There is no write path to Hotelbeds in this file and
there should never be one: content is theirs, the catalogue copy is ours.
"""
from __future__ import annotations

import logging
import re
from typing import Iterator

from app.config import settings
from app.integrations.hotelbeds.client import HotelbedsClient, content_client
from app.integrations.hotelbeds.schemas import HbDestination, HbHotel, HbRoom, HbZone

logger = logging.getLogger(__name__)

#: Hotelbeds serves photographs from one host, with the size as a path segment.
#: Documented at /documentation/hotels/content-api/use-images/. The API returns
#: only the tail of the path, so a base must be prepended by the client.
IMAGE_HOST = "https://photos.hotelbeds.com/giata/"
IMAGE_SIZES = {
    "thumb": "small/",      # 74px
    "small": "medium/",     # 117px
    "standard": "",         # 320px — the bare base
    "large": "bigger/",     # 800px
    "xl": "xl/",            # 1024px
    "xxl": "xxl/",          # 2048px
    "original": "original/",
}


def image_url(path: str, size: str = "large") -> str:
    """Build a displayable URL from the relative path Hotelbeds returns.

    Kept as a function rather than stored on the row because the size is a
    presentation decision: the same stored path serves a thumbnail and a hero.
    An unknown size falls back to the 320px base rather than raising — a
    slightly small photograph beats a 500.
    """
    prefix = IMAGE_SIZES.get(size, "")
    return f"{IMAGE_HOST}{prefix}{path.lstrip('/')}"


def _content(node: object) -> str | None:
    """Unwrap Hotelbeds' ``ApiContent`` ({content, languageCode}) to plain text.

    Most descriptive fields — name, description, address, city — arrive wrapped
    this way. Some arrive as bare strings depending on the operation, so both
    are accepted rather than assumed.
    """
    if node is None:
        return None
    if isinstance(node, str):
        return node.strip() or None
    if isinstance(node, dict):
        text = node.get("content")
        if isinstance(text, str):
            return text.strip() or None
    return None


def parse_star_rating(category_code: str | None) -> int | None:
    """"4EST" / "5LL" / "3" -> an integer 1-5, or None.

    Hotelbeds encodes category as a short code whose leading digit is the star
    count for the ordinary star scales. Codes that carry no leading digit are
    real — apartment and boutique scales among them — and for those this
    returns None. That is on purpose: our ``star_rating`` column defaults to 3,
    and quietly stamping 3 on a property whose category we could not read would
    invent a rating rather than admit we lack one.
    """
    if not category_code:
        return None
    m = re.match(r"^\s*(\d)", str(category_code))
    if not m:
        return None
    stars = int(m.group(1))
    return stars if 1 <= stars <= 5 else None


def _facility_names(raw_facilities: object) -> tuple[str, ...]:
    """Flatten ``facilities[]`` to distinct names that fit our column.

    Our ``customer_hotels.amenities`` is ``ARRAY(String(60))``, so anything
    longer is dropped rather than truncated — a half-sentence amenity reads as
    a bug to a customer, while a missing one reads as nothing at all.

    Only facilities the hotel actually HAS are kept: ``indLogic`` false means
    the API is reporting the facility's absence, and storing that as an amenity
    would advertise the opposite of the truth.
    """
    if not isinstance(raw_facilities, list):
        return ()
    names: list[str] = []
    for f in raw_facilities:
        if not isinstance(f, dict):
            continue
        if f.get("indLogic") is False or f.get("indYesOrNo") is False:
            continue
        name = f.get("facilityName") or _content(f.get("description"))
        if not name:
            continue
        name = str(name).strip()
        if not name or len(name) > 60 or name in names:
            continue
        names.append(name)
    return tuple(names)


def _rooms(raw_rooms: object) -> tuple[HbRoom, ...]:
    """Room TYPES offered. Not rates — those do not exist in the Content API."""
    if not isinstance(raw_rooms, list):
        return ()
    out: list[HbRoom] = []
    for r in raw_rooms:
        if not isinstance(r, dict):
            continue
        code = r.get("roomCode")
        if not code:
            continue
        out.append(HbRoom(
            room_code=str(code),
            description=str(r.get("description") or "").strip(),
            min_pax=r.get("minPax"),
            max_pax=r.get("maxPax"),
            max_adults=r.get("maxAdults"),
            max_children=r.get("maxChildren"),
        ))
    return tuple(out)


def normalise_hotel(raw: dict) -> HbHotel | None:
    """One raw ``ApiHotel`` -> our ``HbHotel``. ``None`` if it lacks an identity.

    A record with no code or no name is unusable — it could not be stored,
    matched or displayed — so it is skipped and counted rather than stored as a
    row with a blank name.
    """
    code = raw.get("code")
    name = _content(raw.get("name"))
    if code is None or not name:
        return None

    coords = raw.get("coordinates") or {}
    images = tuple(
        str(i.get("path")).strip()
        for i in (raw.get("images") or [])
        if isinstance(i, dict) and i.get("path")
    )

    return HbHotel(
        code=int(code),
        name=name,
        description=_content(raw.get("description")),
        address=_content(raw.get("address")),
        postal_code=(str(raw["postalCode"]).strip() if raw.get("postalCode") else None),
        city=_content(raw.get("city")),
        country_code=raw.get("countryCode"),
        destination_code=raw.get("destinationCode"),
        zone_code=raw.get("zoneCode"),
        latitude=coords.get("latitude") if isinstance(coords, dict) else None,
        longitude=coords.get("longitude") if isinstance(coords, dict) else None,
        star_rating=parse_star_rating(raw.get("categoryCode")),
        category_code=raw.get("categoryCode"),
        accommodation_type_code=raw.get("accommodationTypeCode"),
        chain_code=raw.get("chainCode"),
        amenities=_facility_names(raw.get("facilities")),
        image_paths=images,
        rooms=_rooms(raw.get("rooms")),
        last_update=raw.get("lastUpdate"),
    )


class HotelbedsContent:
    """Read the Hotelbeds static catalogue."""

    def __init__(self, client: HotelbedsClient | None = None) -> None:
        self._client = client or content_client()

    @property
    def configured(self) -> bool:
        return self._client.configured

    # ------------------------------------------------------- destinations --
    def destinations(self, country_code: str | None = None) -> list[HbDestination]:
        """Every destination for a country, with its zones.

        One call. The API's default page is 100 rows, so the configured page
        size is sent explicitly — a country with more destinations than that
        would otherwise be silently truncated, which is the kind of bug that
        surfaces months later as "why is that city missing".
        """
        country = country_code or settings.hotelbeds_country_code
        body = self._client.get("/locations/destinations", {
            "countryCodes": country,
            "language": settings.hotelbeds_language,
            "from": 1,
            "to": settings.hotelbeds_page_size,
        })
        out: list[HbDestination] = []
        for d in body.get("destinations") or []:
            code = d.get("code")
            name = _content(d.get("name"))
            if not code or not name:
                continue
            zones = tuple(
                HbZone(zone_code=int(z["zoneCode"]), name=_content(z.get("name")) or str(z.get("name") or "").strip())
                for z in (d.get("zones") or [])
                if isinstance(z, dict) and z.get("zoneCode") is not None
                and (_content(z.get("name")) or z.get("name"))
            )
            out.append(HbDestination(
                code=str(code),
                name=name,
                country_code=str(d.get("countryCode") or country),
                zones=zones,
            ))
        return out

    # ------------------------------------------------------------- hotels --
    def count_hotels(self, destination_code: str | None = None,
                     country_code: str | None = None) -> int:
        """How many hotels match, without downloading them.

        Asks for a single row and reads ``total``, which the API documents as
        the count matching the filter irrespective of pagination. This is the
        call to reach for when deciding whether a sync is worth starting.
        """
        body = self._client.get("/hotels", {
            "destinationCode": destination_code,
            "countryCode": None if destination_code else (country_code or settings.hotelbeds_country_code),
            "fields": "code",
            "from": 1,
            "to": 1,
        })
        return int(body.get("total") or 0)

    def iter_hotels(
        self,
        destination_code: str | None = None,
        country_code: str | None = None,
        page_size: int | None = None,
        max_pages: int | None = None,
        last_update_time: str | None = None,
    ) -> Iterator[HbHotel]:
        """Yield every matching hotel, a page at a time.

        A generator so a large catalogue is never held in memory whole, and so
        the caller can commit per page and survive an interruption having kept
        what it already wrote.

        Args:
            destination_code: Restrict to one destination (e.g. Goa's code).
            country_code: Used only when no destination is given.
            page_size: Rows per request; defaults to the configured size.
            max_pages: Safety stop. Chiefly a quota guard — each page is a
                request, and a sandbox key has fifty of them per day.
            last_update_time: ``YYYY-MM-DD``. The API's own incremental hook:
                only records added or changed since this date are returned,
                which is what makes a nightly refresh cheap.
        """
        size = int(page_size or settings.hotelbeds_page_size)
        start = 1
        pages = 0
        skipped = 0

        while True:
            if max_pages is not None and pages >= max_pages:
                logger.info("Stopping at the %s-page limit.", max_pages)
                break

            body = self._client.get("/hotels", {
                "destinationCode": destination_code,
                "countryCode": None if destination_code else (country_code or settings.hotelbeds_country_code),
                "fields": "all",
                "language": settings.hotelbeds_language,
                "from": start,
                "to": start + size - 1,
                "lastUpdateTime": last_update_time,
            })
            pages += 1

            rows = body.get("hotels") or []
            if not rows:
                break

            for raw in rows:
                hotel = normalise_hotel(raw) if isinstance(raw, dict) else None
                if hotel is None:
                    skipped += 1
                    continue
                yield hotel

            total = int(body.get("total") or 0)
            start += len(rows)
            if total and start > total:
                break
            # A short page means the end, whatever `total` claimed.
            if len(rows) < size:
                break

        if skipped:
            logger.warning("Skipped %s hotel record(s) with no code or name.", skipped)
