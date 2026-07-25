from pydantic import BaseModel


class CountryOut(BaseModel):
    country_id: int
    name: str
    iso2: str

    model_config = {"from_attributes": True}
