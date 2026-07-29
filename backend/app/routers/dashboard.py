"""Dashboard KPIs — one endpoint per portal (API_CONTRACT.md §6.1)."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.dashboard import AdminDashboardResponse, MerchantDashboardResponse
from app.schemas.ticket import RequestResponse
from app.services import dashboard_service

router = APIRouter(tags=["dashboard"])


@router.get(
    "/api/merchant/dashboard",
    response_model=MerchantDashboardResponse,
    summary="Merchant Dashboard KPIs",
    description=(
        "Requires `ticket.view` — the floor permission every merchant role holds. Wallet "
        "balance, request counts by status, payments awaiting verification, unread "
        "notifications, open chat threads, and the 5 most recent requests."
    ),
)
def merchant_dashboard(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    data = dashboard_service.merchant_dashboard(db, current_user)
    data["recent_requests"] = [RequestResponse.of(r, include_passengers=False) for r in data["recent_requests"]]
    return MerchantDashboardResponse(**data)


@router.get(
    "/api/admin/dashboard",
    response_model=AdminDashboardResponse,
    summary="Admin Dashboard KPIs",
    description=(
        "Requires `merchant.view`. Platform-wide merchant counts, request counts by status, "
        "payments awaiting verification, payments verified today, open support tickets, open "
        "chat threads, and the 5 most recent system activity entries."
    ),
)
def admin_dashboard(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_VIEW)),
):
    data = dashboard_service.admin_dashboard(db, current_user)
    return AdminDashboardResponse(**data)
