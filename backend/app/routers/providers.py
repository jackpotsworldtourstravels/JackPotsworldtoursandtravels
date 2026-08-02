"""Provider Management — Admin endpoints (0039).

Every route is gated on ``provider.view`` (reads) or ``provider.manage``
(writes), both held only by Admin. Nothing here is merchant-facing: a merchant
never sees who we buy from, and there is no merchant-scoped variant of any of
these paths.

**There is no DELETE route on this router, and that is the design.** A provider
with bookings against it is a purchase record; it is retired by PATCHing its
status to ``inactive``, which removes it from the issuance dropdown while every
historical booking stays attributable. The database backs the same rule with
``ON DELETE RESTRICT`` from ``service_requests``.
"""
import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import SystemLog, User
from app.schemas.provider import (
    CreateProvider,
    CreateProviderUser,
    ProviderDetailResponse,
    ProviderListResponse,
    ProviderOptionsResponse,
    ProviderOut,
    ProviderUserOut,
    UpdateProvider,
    UpdateProviderUser,
)
from app.services import export_service, provider_service

router = APIRouter(prefix="/api/admin", tags=["admin · providers"])


@router.get(
    "/providers",
    response_model=ProviderListResponse,
    summary="List providers",
    description=(
        "Requires `provider.view`. Totals are derived from bookings on every read — there is no "
        "stored counter. `search` matches the provider code, the provider name **and** the names "
        "and emails of the people listed against it."
    ),
)
def list_providers(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    search: str | None = None,
    status: Literal["active", "inactive"] | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    sort: Literal["provider_code", "provider_name", "status", "created_at"] = "provider_code",
    direction: Literal["asc", "desc"] = "asc",
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PROVIDER_VIEW)),
):
    items, total = provider_service.list_providers(
        db, page=page, page_size=page_size, search=search, status=status,
        date_from=date_from, date_to=date_to, sort=sort, direction=direction,
    )
    return ProviderListResponse(items=items, total=total, page=page, page_size=page_size)


@router.get(
    "/providers/options",
    response_model=ProviderOptionsResponse,
    summary="Active providers and their people, for the issuance dropdown",
    description=(
        "Requires `provider.view`. Active providers only, each with its **active** people already "
        "attached — so the Booking Operations dependent dropdown needs no second request when a "
        "provider is picked. Declared before `/providers/{provider_id}` so the literal path is "
        "not captured as an id."
    ),
)
def provider_options(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PROVIDER_VIEW)),
):
    return ProviderOptionsResponse(items=provider_service.provider_options(db))


@router.get(
    "/providers/export",
    summary="Export providers, provider users or a booking summary",
    description=(
        "Requires `provider.view` + `report.export`. `kind` selects the dataset; `provider_id` "
        "narrows the two per-provider ones. Figures come from the same derivation the screens "
        "read, so an export cannot disagree with the page it was taken from."
    ),
)
def export_providers(
    kind: Literal["providers", "provider_users", "booking_summary"] = "providers",
    format: Literal["csv", "xlsx"] = "csv",
    provider_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(
        require(P.PROVIDER_VIEW, P.REPORT_EXPORT, require_all=True)
    ),
):
    rows = provider_service.export_rows(db, kind, provider_id=provider_id)
    columns = provider_service.EXPORT_COLUMNS[kind]
    title = kind.replace("_", " ").title()
    content, media_type = export_service.build_export(format, columns, rows, title)

    db.add(SystemLog(
        user_id=current_user.user_id, merchant_id=current_user.merchant_id,
        module="providers", action="export",
        description=f"{current_user.full_name} exported {kind} as {format}",
    ))
    db.commit()

    filename = f"{kind}-{datetime.date.today().isoformat()}.{format}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get(
    "/providers/{provider_id}",
    response_model=ProviderDetailResponse,
    summary="One provider in full",
    description=(
        "Requires `provider.view`. Provider information, derived statistics, every person listed "
        "against it with their own derived totals, and the most recent bookings bought through it."
    ),
)
def get_provider(
    provider_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PROVIDER_VIEW)),
):
    return ProviderDetailResponse(**provider_service.get_provider_detail(db, provider_id))


@router.post(
    "/providers",
    response_model=ProviderOut,
    status_code=201,
    summary="Add a provider",
    description=(
        "Requires `provider.manage`. Only the name is accepted — `provider_code` is allocated "
        "from `seq_provider_code` (PRD001, PRD002, …) and can never be supplied by a client. "
        "The name is unique case-insensitively."
    ),
)
def create_provider(
    payload: CreateProvider,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PROVIDER_MANAGE)),
):
    provider = provider_service.create_provider(
        db, current_user, provider_name=payload.provider_name
    )
    return ProviderOut(**provider_service.provider_out(provider))


@router.patch(
    "/providers/{provider_id}",
    response_model=ProviderOut,
    summary="Rename a provider, or activate / deactivate it",
    description=(
        "Requires `provider.manage`. **There is no delete.** A provider with bookings against it "
        "is a purchase record; set `status` to `inactive` to retire it, which removes it from the "
        "issuance dropdown and leaves every historical booking attributable. `provider_code` is "
        "not editable by any payload."
    ),
)
def update_provider(
    provider_id: int,
    payload: UpdateProvider,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PROVIDER_MANAGE)),
):
    provider = provider_service.update_provider(
        db, current_user, provider_id,
        provider_name=payload.provider_name, status=payload.status,
    )
    detail = provider_service.get_provider_detail(db, provider.provider_id)
    return ProviderOut(**detail["provider"])


@router.post(
    "/providers/{provider_id}/users",
    response_model=ProviderUserOut,
    status_code=201,
    summary="Add a person at this provider",
    description=(
        "Requires `provider.manage`. Name and email are required, phone optional. Both are unique "
        "**within this provider** — two suppliers may each employ a John.\n\n"
        "This creates **no login of any kind**: no password, username, role, permission or "
        "session. A provider user exists so a booking can record who handled it."
    ),
)
def add_provider_user(
    provider_id: int,
    payload: CreateProviderUser,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PROVIDER_MANAGE)),
):
    person = provider_service.add_provider_user(
        db, current_user, provider_id,
        user_name=payload.user_name, email=str(payload.email),
        phone_number=payload.phone_number,
    )
    return ProviderUserOut(**provider_service.provider_user_out(person))


@router.patch(
    "/provider-users/{provider_user_id}",
    response_model=ProviderUserOut,
    summary="Edit a person, or activate / deactivate them",
    description=(
        "Requires `provider.manage`. A person cannot be moved between providers — that would "
        "re-attribute every booking they have ever handled. Deactivate them here and add them "
        "under the other provider instead."
    ),
)
def update_provider_user(
    provider_user_id: int,
    payload: UpdateProviderUser,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PROVIDER_MANAGE)),
):
    person = provider_service.update_provider_user(
        db, current_user, provider_user_id,
        user_name=payload.user_name,
        email=str(payload.email) if payload.email else None,
        phone_number=payload.phone_number, status=payload.status,
    )
    return ProviderUserOut(**provider_service.provider_user_out(person))
