from pydantic import BaseModel, Field


class InventoryItemOut(BaseModel):
    item_type: str
    item_id: int
    name: str
    price: float
    available: int
    low_stock_threshold: int
    is_sold_out: bool
    is_low_stock: bool


class InventoryAdjustRequest(BaseModel):
    available: int = Field(ge=0, description="New absolute availability count (not a delta).")
    low_stock_threshold: int | None = Field(default=None, ge=0)
