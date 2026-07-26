from fastapi import APIRouter, Depends, HTTPException, status

from app.auth.security import create_super_admin_access_token, create_super_admin_refresh_token
from app.auth.super_admin_deps import CurrentSuperAdmin, get_current_super_admin
from app.schemas.super_admin import (
    AdminCreateRequest,
    AdminOut,
    ChangePasswordRequest,
    DashboardStatsOut,
    MessageResponse,
    ProfileOut,
    ProfileUpdateRequest,
    SuperAdminLoginRequest,
    SuperAdminTokenResponse,
)
from app.services import super_admin_service

router = APIRouter(prefix="/api/super-admin", tags=["super-admin"])


@router.post("/auth/login", response_model=SuperAdminTokenResponse, summary="Super Admin login")
def login(payload: SuperAdminLoginRequest):
    admin = super_admin_service.authenticate_super_admin(payload.username_or_email, payload.password)
    if not admin:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username/email or password")
    return SuperAdminTokenResponse(
        access_token=create_super_admin_access_token(admin["username"], admin["full_name"]),
        refresh_token=create_super_admin_refresh_token(admin["username"]),
        full_name=admin["full_name"],
    )


@router.post("/auth/logout", response_model=MessageResponse, summary="Super Admin logout")
def logout(_current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    return MessageResponse(message="Logged out.")


@router.get("/dashboard/stats", response_model=DashboardStatsOut, summary="Dashboard KPI cards")
def dashboard_stats(_current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    return super_admin_service.get_dashboard_stats()


@router.get("/admins", response_model=list[AdminOut], summary="List admins")
def list_admins(_current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    return super_admin_service.list_admins()


@router.post("/admins", response_model=AdminOut, summary="Create a new admin")
def create_admin(payload: AdminCreateRequest, _current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    return super_admin_service.create_admin(payload)


@router.get("/admins/{admin_id}", response_model=AdminOut, summary="Admin detail")
def get_admin(admin_id: str, _current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    return super_admin_service.get_admin(admin_id)


@router.post("/admins/{admin_id}/activate", response_model=AdminOut, summary="Activate an admin")
def activate_admin(admin_id: str, _current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    return super_admin_service.set_admin_status(admin_id, "active")


@router.post("/admins/{admin_id}/deactivate", response_model=AdminOut, summary="Deactivate an admin")
def deactivate_admin(admin_id: str, _current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    return super_admin_service.set_admin_status(admin_id, "inactive")


@router.get("/profile", response_model=ProfileOut, summary="Super Admin profile")
def get_profile(_current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    return super_admin_service.get_profile()


@router.patch("/profile", response_model=ProfileOut, summary="Edit profile")
def update_profile(payload: ProfileUpdateRequest, _current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    return super_admin_service.update_profile(payload)


@router.post("/change-password", response_model=MessageResponse, summary="Change password")
def change_password(payload: ChangePasswordRequest, _current: CurrentSuperAdmin = Depends(get_current_super_admin)):
    super_admin_service.change_password(payload.current_password, payload.new_password)
    return MessageResponse(message="Password changed.")
