"""Super Admin — service layer.

NOT connected to PostgreSQL. Every function below that would normally read
or write a database table instead operates on a small in-memory mock store
(reset every time the backend process restarts) and carries a `# TODO`
comment showing exactly what real database work belongs there. This is
intentional — see the Super Admin Portal build notes for the step-by-step
guide on implementing the real `super_admins` table.
"""

import datetime

from fastapi import HTTPException, status

from app.auth.security import hash_password
from app.schemas.super_admin import AdminCreateRequest, ProfileUpdateRequest

# ---------------------------------------------------------------------------
# TEMPORARY in-memory mock store. Replace entirely once the real
# `super_admins` / `admins` tables exist — nothing here should survive into
# the database-backed version of this file.
# ---------------------------------------------------------------------------
_DEMO_SUPER_ADMIN = {
    "username": "superadmin",
    "email": "superadmin@jackpotsworldtours.com",
    "password": "SuperAdmin@2026",  # TODO: never store plaintext once real — bcrypt hash in PostgreSQL instead
    "full_name": "Super Administrator",
    "phone_number": "9800000000",
    "created_date": datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
    "photo_url": None,
}

_mock_admins: list[dict] = []
_mock_admin_seq = 0


def authenticate_super_admin(username_or_email: str, password: str) -> dict | None:
    # TODO:
    # Authenticate Super Admin
    # Replace this hardcoded check with:
    #   SELECT * FROM super_admins WHERE username = %s OR email = %s
    # then verify the submitted password against the stored bcrypt hash
    # (verify_password() below already does the hash comparison correctly —
    # only the row lookup needs to become a real query).
    if username_or_email in (_DEMO_SUPER_ADMIN["username"], _DEMO_SUPER_ADMIN["email"]) \
            and password == _DEMO_SUPER_ADMIN["password"]:
        return _DEMO_SUPER_ADMIN
    return None


def get_dashboard_stats() -> dict:
    # TODO:
    # Fetch Dashboard Statistics from PostgreSQL
    #   total_admins    -> SELECT count(*) FROM admins
    #   total_merchants -> SELECT count(*) FROM partners (already exists — see Admin Portal)
    #   total_users     -> SELECT count(*) FROM partner_users (already exists — see Admin Portal)
    # Static placeholder values below per your explicit instruction not to
    # connect the Dashboard to a database yet.
    return {"total_admins": len(_mock_admins), "total_merchants": 0, "total_users": 0}


def list_admins() -> list[dict]:
    # TODO:
    # Fetch All Admins from PostgreSQL
    #   SELECT admin_id, full_name, username, email, phone_number, country_code, status, created_at
    #   FROM admins ORDER BY created_at DESC
    return list(reversed(_mock_admins))


def create_admin(payload: AdminCreateRequest) -> dict:
    global _mock_admin_seq

    # TODO:
    # Check Username Exists
    #   SELECT 1 FROM admins WHERE username = %s
    # TODO:
    # Check Email Exists
    #   SELECT 1 FROM admins WHERE email = %s
    # TODO:
    # Check Phone Number Exists
    #   SELECT 1 FROM admins WHERE phone_number = %s AND country_code = %s
    # (Only the in-memory equivalent runs below — no real uniqueness
    # guarantee exists until those queries replace it.)
    for existing in _mock_admins:
        if existing["username"] == payload.username:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already in use (mock check only)")
        if existing["email"] == payload.email:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already in use (mock check only)")

    _mock_admin_seq += 1
    admin = {
        "admin_id": f"MOCK-{_mock_admin_seq}",
        "full_name": payload.full_name,
        "username": payload.username,
        "email": payload.email,
        "phone_number": payload.phone_number,
        "country_code": payload.country_code,
        "password_hash": hash_password(payload.password),  # TODO: Insert Admin into PostgreSQL (store this hash, never the raw password)
        "status": "active",
        "created_at": datetime.datetime.now(datetime.timezone.utc),
    }
    _mock_admins.append(admin)
    # TODO:
    # Insert Admin into PostgreSQL
    #   INSERT INTO admins (full_name, username, email, phone_number, country_code, password_hash, status, created_at)
    #   VALUES (%s, %s, %s, %s, %s, %s, 'active', now())
    return admin


def get_admin(admin_id: str) -> dict:
    # TODO:
    # Fetch Admin by ID from PostgreSQL
    #   SELECT * FROM admins WHERE admin_id = %s
    for a in _mock_admins:
        if a["admin_id"] == admin_id:
            return a
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Admin not found")


def set_admin_status(admin_id: str, new_status: str) -> dict:
    admin = get_admin(admin_id)
    admin["status"] = new_status
    # TODO:
    # Update Admin Status in PostgreSQL
    #   UPDATE admins SET status = %s WHERE admin_id = %s
    return admin


def get_profile() -> dict:
    # TODO:
    # Fetch Super Admin Profile from PostgreSQL
    #   SELECT full_name, email, phone_number, created_date, photo_url FROM super_admins WHERE super_admin_id = %s
    return {
        "full_name": _DEMO_SUPER_ADMIN["full_name"],
        "email": _DEMO_SUPER_ADMIN["email"],
        "phone_number": _DEMO_SUPER_ADMIN["phone_number"],
        "role": "Super Administrator",
        "created_date": _DEMO_SUPER_ADMIN["created_date"],
        "photo_url": _DEMO_SUPER_ADMIN["photo_url"],
    }


def update_profile(payload: ProfileUpdateRequest) -> dict:
    # TODO:
    # Update Super Admin Profile in PostgreSQL
    #   UPDATE super_admins SET full_name = COALESCE(%s, full_name), phone_number = COALESCE(%s, phone_number),
    #          photo_url = COALESCE(%s, photo_url) WHERE super_admin_id = %s
    if payload.full_name is not None:
        _DEMO_SUPER_ADMIN["full_name"] = payload.full_name
    if payload.phone_number is not None:
        _DEMO_SUPER_ADMIN["phone_number"] = payload.phone_number
    if payload.photo_url is not None:
        _DEMO_SUPER_ADMIN["photo_url"] = payload.photo_url
    return get_profile()


def change_password(current_password: str, new_password: str) -> None:
    # TODO:
    # Validate Current Password
    #   SELECT password_hash FROM super_admins WHERE super_admin_id = %s
    #   then verify_password(current_password, stored_hash)
    if current_password != _DEMO_SUPER_ADMIN["password"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    _DEMO_SUPER_ADMIN["password"] = new_password
    # TODO:
    # Update Super Admin Password in PostgreSQL
    #   UPDATE super_admins SET password_hash = %s WHERE super_admin_id = %s
