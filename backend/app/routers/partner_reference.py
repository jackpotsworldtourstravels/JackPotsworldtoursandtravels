from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.partner_deps import get_current_partner_user
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.models.reference import AncillaryServiceCatalog, Country
from app.schemas.partner_reference import AncillaryCatalogItemOut, CountryOut

router = APIRouter(prefix="/api/partner", tags=["partner-reference"])


@router.get("/countries", response_model=list[CountryOut], summary="Countries for passport/nationality dropdowns")
def list_countries(db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)):
    return db.scalars(select(Country).order_by(Country.name)).all()


@router.get(
    "/ancillary-catalog",
    response_model=list[AncillaryCatalogItemOut],
    summary="Baggage/meal/special-service options and prices for Request Ticket",
)
def list_ancillary_catalog(db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)):
    return db.scalars(
        select(AncillaryServiceCatalog)
        .where(AncillaryServiceCatalog.is_active.is_(True))
        .order_by(AncillaryServiceCatalog.category, AncillaryServiceCatalog.display_order)
    ).all()
