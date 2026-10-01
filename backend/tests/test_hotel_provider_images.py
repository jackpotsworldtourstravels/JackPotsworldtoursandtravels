"""Provider-image wiring on the customer hotel responses.

These tests DO NOT touch Hotelbeds and need no credentials: they build the
response schemas from in-memory rows and assert how stored provider content is
turned into the fields the frontend reads. The one rule under test throughout:
a GIATA path becomes a displayable URL only for a row with a stable supplier
identity, and a raw path is never serialised.

Scenarios mirror the brief:

    A  source='hotelbeds' + images   -> provider image used
    B  hotelbeds_code + images       -> provider image used
    C  seed row, no identity         -> provider images NOT trusted
    D  provider row, no images       -> empty (client shows placeholder)
    plus: URLs are the public photo CDN at the expected sizes, carry no
          credential, and no raw provider path leaks into the response.
"""
from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from app.schemas.customer_hotel_booking import (
    HotelDetail,
    HotelSearchResult,
    _provider_images,
)

GIATA = "00/000112/000112a_hb_a_001.jpg"


def _row(**overrides):
    """A row shaped like CustomerHotel, enough for both response schemas."""
    base = dict(
        customer_hotel_id=1,
        name="Test Property",
        description="A property.",
        image_key="test-property",
        star_rating=5,
        guest_rating=Decimal("4.5"),
        location="Somewhere, Hyderabad",
        distance_km=Decimal("10"),
        price_per_night=Decimal("5000"),
        amenities=["Free Wi-Fi"],
        cancellation_policy=None,
        meal_plans=[],
        free_cancellation=False,
        source="seed",
        hotelbeds_code=None,
        images=[],
        rooms=[],
    )
    base.update(overrides)
    return SimpleNamespace(**base)


# --------------------------------------------------------------- the builder

def test_A_source_hotelbeds_with_images_builds_urls():
    imgs = _provider_images("hotelbeds", None, [GIATA])
    assert len(imgs) == 1
    img = imgs[0]
    assert img.is_primary is True
    assert img.source == "hotelbeds"
    assert img.room_code is None
    # complete URLs, on the public photo CDN, at the three expected sizes
    assert img.thumb == "https://photos.hotelbeds.com/giata/" + GIATA          # 320px (standard)
    assert img.url == "https://photos.hotelbeds.com/giata/bigger/" + GIATA     # 800px (large)
    assert img.large == "https://photos.hotelbeds.com/giata/xl/" + GIATA       # 1024px (xl)


def test_B_hotelbeds_code_alone_is_trusted():
    # source left as the default 'seed' on purpose: the code is identity enough.
    imgs = _provider_images("seed", 112, [GIATA])
    assert len(imgs) == 1
    assert imgs[0].url.startswith("https://photos.hotelbeds.com/")


def test_C_seed_without_identity_is_not_trusted():
    # A seed row's 'images' hold a curated slug, never a supplier path.
    assert _provider_images("seed", None, ["taj-palace"]) == []
    assert _provider_images(None, None, [GIATA]) == []


def test_D_provider_identity_without_images_is_empty():
    assert _provider_images("hotelbeds", 112, []) == []
    assert _provider_images("hotelbeds", 112, [""]) == []


def test_first_image_is_primary_rest_are_not():
    imgs = _provider_images("hotelbeds", 1, [GIATA, "01/000113/x.jpg", "02/000114/y.jpg"])
    assert [i.is_primary for i in imgs] == [True, False, False]


# ------------------------------------------------- the response integration

def test_search_result_exposes_provider_images_and_source():
    data = HotelSearchResult.model_validate(
        _row(source="hotelbeds", hotelbeds_code=112, images=[GIATA])
    ).model_dump()
    assert data["source"] == "hotelbeds"
    assert len(data["provider_images"]) == 1
    assert data["provider_images"][0]["url"].startswith("https://photos.hotelbeds.com/")


def test_detail_exposes_provider_images():
    data = HotelDetail.model_validate(
        _row(source="hotelbeds", hotelbeds_code=112, images=[GIATA])
    ).model_dump()
    assert len(data["provider_images"]) == 1


def test_seed_row_reports_empty_provider_images():
    data = HotelSearchResult.model_validate(
        _row(source="seed", hotelbeds_code=None, images=["test-property"])
    ).model_dump()
    assert data["provider_images"] == []
    assert data["source"] == "seed"


def test_raw_provider_paths_never_serialised():
    """The brief: do not expose raw provider paths when the client wants URLs."""
    for model in (HotelSearchResult, HotelDetail):
        data = model.model_validate(
            _row(source="hotelbeds", hotelbeds_code=112, images=[GIATA])
        ).model_dump()
        # no raw-path field under any of its names
        assert "images" not in data
        assert "images_raw" not in data
        # and the GIATA path only ever appears inside a full CDN URL
        for pi in data["provider_images"]:
            for url in (pi["url"], pi["thumb"], pi["large"]):
                assert url.startswith("https://photos.hotelbeds.com/")


def test_no_credential_or_secret_in_response():
    data = HotelDetail.model_validate(
        _row(source="hotelbeds", hotelbeds_code=112, images=[GIATA])
    ).model_dump()
    blob = repr(data).lower()
    for forbidden in ("api-key", "apikey", "secret", "signature", "x-signature"):
        assert forbidden not in blob
