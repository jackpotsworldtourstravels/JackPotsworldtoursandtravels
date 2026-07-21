from app.models.travel import Cruise, Flight, Hotel, TourPackage

ITEM_MODELS = {
    "flight": Flight,
    "hotel": Hotel,
    "cruise": Cruise,
    "package": TourPackage,
}

ITEM_NAME_FN = {
    "flight": lambda item: f"{item.from_airport} → {item.to_airport}",
    "hotel": lambda item: item.name,
    "cruise": lambda item: item.name,
    "package": lambda item: item.title,
}

# The column that tracks remaining inventory for each catalog type — lets booking/
# inventory code decrement, restore, and read availability generically instead of
# branching per item_type.
AVAILABILITY_FIELD = {
    "flight": "seats_available",
    "hotel": "rooms_available",
    "cruise": "cabins_available",
    "package": "capacity",
}


def item_display_name(db, item_type: str, item_id: int) -> str:
    model = ITEM_MODELS.get(item_type)
    item = db.get(model, item_id) if model else None
    if not item:
        return f"{item_type} #{item_id} (removed)"
    return ITEM_NAME_FN[item_type](item)


def base_unit_price(booking_type: str, item) -> float:
    return float(item.price_per_night) if booking_type == "hotel" else float(item.price)


def get_availability(item) -> int:
    field = AVAILABILITY_FIELD[_item_type_of(item)]
    return getattr(item, field)


def _item_type_of(item) -> str:
    for item_type, model in ITEM_MODELS.items():
        if isinstance(item, model):
            return item_type
    raise ValueError(f"Unknown catalog item: {item!r}")
