from pydantic import BaseModel


class AncillaryOptionOut(BaseModel):
    """Baggage/meal options are now fixed enum values embedded on passenger_data
    (see DATABASE_REDESIGN_9TABLE.md §1) rather than a catalog table — this
    endpoint returns the fixed option list directly instead of querying one.
    additional_charge is omitted: the legacy ancillary_service_catalog's
    per-option pricing wasn't captured when these became fixed enum values;
    if per-option pricing is still needed, it has to be reintroduced as a
    small static price table or config, not reconstructed here without a
    verified source for the actual amounts.
    """
    value: str
    label: str


BAGGAGE_OPTIONS = [
    AncillaryOptionOut(value="none", label="No extra baggage"),
    AncillaryOptionOut(value="extra_15kg", label="+15kg"),
    AncillaryOptionOut(value="extra_20kg", label="+20kg"),
    AncillaryOptionOut(value="extra_30kg", label="+30kg"),
]

MEAL_OPTIONS = [
    AncillaryOptionOut(value="none", label="No preference"),
    AncillaryOptionOut(value="veg", label="Vegetarian"),
    AncillaryOptionOut(value="non_veg", label="Non-Vegetarian"),
    AncillaryOptionOut(value="vegan", label="Vegan"),
    AncillaryOptionOut(value="jain", label="Jain"),
    AncillaryOptionOut(value="kosher", label="Kosher"),
    AncillaryOptionOut(value="halal", label="Halal"),
]
