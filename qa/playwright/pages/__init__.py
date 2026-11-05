"""Page objects for the JackPots World UI. Selector-first, role-based.

These wrap the SPA shells (admin/merchant/manager/super-admin/operations) and the
public B2C booking surfaces. They intentionally prefer get_by_role/get_by_label/
get_by_text and fall back to data-testid only where a stable hook is missing.
"""
from .base import BasePage
from .public import LandingPage, BookingCard, LoginPage, RegisterPage
from .portals import AdminShell, MerchantShell, ManagerShell, SuperAdminShell, OperationsShell

__all__ = [
    "BasePage", "LandingPage", "BookingCard", "LoginPage", "RegisterPage",
    "AdminShell", "MerchantShell", "ManagerShell", "SuperAdminShell", "OperationsShell",
]
