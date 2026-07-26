from pydantic import BaseModel


class CountryOut(BaseModel):
    country_id: int
    name: str
    iso2: str

    model_config = {"from_attributes": True}


class AncillaryCatalogItemOut(BaseModel):
    catalog_id: int
    category: str
    code: str
    label: str
    additional_charge: float

    model_config = {"from_attributes": True}
