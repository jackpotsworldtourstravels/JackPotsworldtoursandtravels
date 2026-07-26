import re
import secrets

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.auth.security import hash_password
from app.schemas.admin_merchant import (
    ROLE_TYPE_MEMBER_ROLES,
    MerchantCreateRequest,
    MerchantUpdateRequest,
    MerchantUserCreateRequest,
    MerchantUserUpdateRequest,
)


def _generate_company_code(db: Session, company_name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]", "", company_name).upper()[:8] or "MERCHANT"
    for i in range(1, 100):
        candidate = f"{base}{i:02d}"
        if not db.execute(text("SELECT 1 FROM partners WHERE company_code = :c"), {"c": candidate}).first():
            return candidate
    return f"{base}{secrets.token_hex(3).upper()}"


def _generate_reference_prefix(db: Session, company_name: str) -> str:
    words = re.findall(r"[A-Za-z]+", company_name)
    base = "".join(w[0] for w in words[:2]).upper() or "MC"
    if len(base) < 2:
        base = (base + "XX")[:2]
    candidate = base
    suffix = 0
    while db.execute(text("SELECT 1 FROM partners WHERE reference_prefix = :p"), {"p": candidate}).first():
        suffix += 1
        candidate = (base + str(suffix))[:6]
    return candidate


def list_merchants(db: Session) -> list[dict]:
    rows = db.execute(
        text("""
            SELECT partner_id, company_name, company_type, contact_person, email, phone_number, status, created_at
            FROM partners ORDER BY created_at DESC
        """)
    ).mappings().all()
    return [dict(r) for r in rows]


def create_merchant(db: Session, payload: MerchantCreateRequest) -> dict:
    existing = db.execute(text("SELECT 1 FROM partners WHERE email = :e"), {"e": payload.email}).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A merchant with this email already exists")

    company_code = _generate_company_code(db, payload.company_name)
    reference_prefix = _generate_reference_prefix(db, payload.company_name)
    row = db.execute(
        text("""
            INSERT INTO partners (
                company_name, company_code, reference_prefix, email, phone_number, status,
                company_type, contact_person, address, city, state, country, gst_number, pan_number,
                created_at, updated_at
            ) VALUES (
                :company_name, :company_code, :reference_prefix, :email, :phone_number, :status,
                :company_type, :contact_person, :address, :city, :state, :country, :gst_number, :pan_number,
                now(), now()
            ) RETURNING partner_id
        """),
        {
            "company_name": payload.company_name, "company_code": company_code, "reference_prefix": reference_prefix,
            "email": payload.email, "phone_number": payload.phone_number, "status": payload.status,
            "company_type": payload.company_type, "contact_person": payload.contact_person,
            "address": payload.address, "city": payload.city, "state": payload.state, "country": payload.country,
            "gst_number": payload.gst_number, "pan_number": payload.pan_number,
        },
    ).mappings().first()
    db.commit()
    return get_merchant_detail(db, row["partner_id"])


def get_merchant_detail(db: Session, partner_id: int) -> dict:
    merchant = db.execute(text("SELECT * FROM partners WHERE partner_id = :id"), {"id": partner_id}).mappings().first()
    if not merchant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Merchant not found")
    user_count = db.scalar(text("SELECT count(*) FROM partner_users WHERE partner_id = :id"), {"id": partner_id}) or 0
    booking_count = db.scalar(
        text("SELECT count(*) FROM partner_bookings WHERE partner_id = :id"), {"id": partner_id}
    ) or 0
    request_count = db.scalar(
        text("""
            SELECT count(*) FROM service_requests sr
            JOIN partner_bookings pb ON pb.booking_id = sr.booking_id
            WHERE pb.partner_id = :id
        """),
        {"id": partner_id},
    ) or 0
    result = dict(merchant)
    result["user_count"] = user_count
    result["booking_count"] = booking_count
    result["request_count"] = request_count
    return result


def update_merchant(db: Session, partner_id: int, payload: MerchantUpdateRequest) -> dict:
    _require_merchant(db, partner_id)
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        return get_merchant_detail(db, partner_id)
    if "email" in fields:
        dupe = db.execute(
            text("SELECT 1 FROM partners WHERE email = :e AND partner_id != :id"),
            {"e": fields["email"], "id": partner_id},
        ).first()
        if dupe:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Another merchant already uses this email")
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    db.execute(text(f"UPDATE partners SET {set_clause}, updated_at = now() WHERE partner_id = :id"), {**fields, "id": partner_id})
    db.commit()
    return get_merchant_detail(db, partner_id)


def set_merchant_status(db: Session, partner_id: int, new_status: str) -> dict:
    _require_merchant(db, partner_id)
    db.execute(
        text("UPDATE partners SET status = :s, updated_at = now() WHERE partner_id = :id"),
        {"s": new_status, "id": partner_id},
    )
    db.commit()
    return get_merchant_detail(db, partner_id)


def _require_merchant(db: Session, partner_id: int) -> None:
    if not db.execute(text("SELECT 1 FROM partners WHERE partner_id = :id"), {"id": partner_id}).first():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Merchant not found")


def list_merchant_users(db: Session, partner_id: int) -> list[dict]:
    _require_merchant(db, partner_id)
    rows = db.execute(
        text("""
            SELECT partner_user_id, full_name, username, email, phone_number, role_type, member_role, status, created_at
            FROM partner_users WHERE partner_id = :id ORDER BY created_at DESC
        """),
        {"id": partner_id},
    ).mappings().all()
    return [dict(r) for r in rows]


def create_merchant_user(db: Session, partner_id: int, payload: MerchantUserCreateRequest) -> dict:
    _require_merchant(db, partner_id)
    if payload.password != payload.confirm_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password and Confirm Password do not match")
    allowed_member_roles = ROLE_TYPE_MEMBER_ROLES[payload.role_type]
    if payload.member_role not in allowed_member_roles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Member Role '{payload.member_role}' is not valid for Role Type '{payload.role_type}'",
        )
    for field, value in (("username", payload.username), ("email", payload.email), ("phone_number", payload.phone_number)):
        if db.execute(text(f"SELECT 1 FROM partner_users WHERE {field} = :v"), {"v": value}).first():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"This {field.replace('_', ' ')} is already in use")

    role_name = "partner_admin" if payload.role_type == "admin" else "partner_staff"
    role_id = db.scalar(text("SELECT id FROM roles WHERE name = :n"), {"n": role_name})

    row = db.execute(
        text("""
            INSERT INTO partner_users (
                partner_id, role_id, full_name, username, email, phone_number, password_hash,
                role_type, member_role, status, created_at, updated_at
            ) VALUES (
                :partner_id, :role_id, :full_name, :username, :email, :phone_number, :password_hash,
                :role_type, :member_role, 'active', now(), now()
            ) RETURNING partner_user_id
        """),
        {
            "partner_id": partner_id, "role_id": role_id, "full_name": payload.full_name,
            "username": payload.username, "email": payload.email, "phone_number": payload.phone_number,
            "password_hash": hash_password(payload.password),
            "role_type": payload.role_type, "member_role": payload.member_role,
        },
    ).mappings().first()
    db.commit()
    return get_merchant_user(db, row["partner_user_id"])


def get_merchant_user(db: Session, partner_user_id: int) -> dict:
    row = db.execute(
        text("""
            SELECT partner_user_id, partner_id, full_name, username, email, phone_number, role_type, member_role, status, created_at
            FROM partner_users WHERE partner_user_id = :id
        """),
        {"id": partner_user_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Merchant user not found")
    return dict(row)


def update_merchant_user(db: Session, partner_user_id: int, payload: MerchantUserUpdateRequest) -> dict:
    get_merchant_user(db, partner_user_id)
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        return get_merchant_user(db, partner_user_id)
    if ("role_type" in fields) != ("member_role" in fields):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Role Type and Member Role must be updated together"
        )
    if "role_type" in fields:
        allowed = ROLE_TYPE_MEMBER_ROLES[fields["role_type"]]
        if fields["member_role"] not in allowed:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Member Role '{fields['member_role']}' is not valid for Role Type '{fields['role_type']}'",
            )
        role_name = "partner_admin" if fields["role_type"] == "admin" else "partner_staff"
        fields["role_id"] = db.scalar(text("SELECT id FROM roles WHERE name = :n"), {"n": role_name})
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    db.execute(text(f"UPDATE partner_users SET {set_clause}, updated_at = now() WHERE partner_user_id = :id"), {**fields, "id": partner_user_id})
    db.commit()
    return get_merchant_user(db, partner_user_id)


def set_merchant_user_status(db: Session, partner_user_id: int, new_status: str) -> dict:
    get_merchant_user(db, partner_user_id)
    db.execute(
        text("UPDATE partner_users SET status = :s, updated_at = now() WHERE partner_user_id = :id"),
        {"s": new_status, "id": partner_user_id},
    )
    db.commit()
    return get_merchant_user(db, partner_user_id)


def reset_merchant_user_password(db: Session, partner_user_id: int) -> str:
    get_merchant_user(db, partner_user_id)
    new_password = secrets.token_urlsafe(9)
    db.execute(
        text("UPDATE partner_users SET password_hash = :h, updated_at = now() WHERE partner_user_id = :id"),
        {"h": hash_password(new_password), "id": partner_user_id},
    )
    db.commit()
    return new_password
