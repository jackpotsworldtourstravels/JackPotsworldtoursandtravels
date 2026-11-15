"""Read schema for the B2C administrative audit trail (Stage 2C).

A safe projection of ``customer_admin_audit_logs``. The stored ``previous_value``
/ ``new_value`` are already redacted at write time; ``from_model`` redacts again
on the way out (defence in depth, reusing the B2B reader's key pattern), so a
secret-looking key can never leave the API even if one slipped into a payload.
There is no write/update/delete schema — the trail is read-only and append-only.
"""
from __future__ import annotations

import datetime as dt
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict

from app.services import audit_service


class B2cAuditEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    customer_admin_audit_log_id: int
    # actor snapshot (no secrets; identifies the B2B administrator)
    admin_user_id: Optional[int] = None
    admin_email: Optional[str] = None
    admin_name: Optional[str] = None
    admin_role: Optional[str] = None
    environment: str
    action: str
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    outcome: str
    retention_class: str
    previous_value: Optional[dict[str, Any]] = None
    new_value: Optional[dict[str, Any]] = None
    reason: Optional[str] = None
    request_id: Optional[str] = None
    ip_address: Optional[str] = None
    browser: Optional[str] = None
    device: Optional[str] = None
    created_at: dt.datetime

    @classmethod
    def from_model(cls, row: Any) -> "B2cAuditEntry":
        return cls(
            customer_admin_audit_log_id=row.customer_admin_audit_log_id,
            admin_user_id=row.admin_user_id,
            admin_email=row.admin_email,
            admin_name=row.admin_name,
            admin_role=row.admin_role,
            environment=row.environment,
            action=row.action,
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            outcome=getattr(row.outcome, "value", row.outcome),
            retention_class=row.retention_class,
            previous_value=audit_service.redact_values(row.previous_value),
            new_value=audit_service.redact_values(row.new_value),
            reason=row.reason,
            request_id=row.request_id,
            ip_address=row.ip_address,
            browser=row.browser,
            device=row.device,
            created_at=row.created_at,
        )
