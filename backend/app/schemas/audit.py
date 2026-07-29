"""Audit Logs — read-only view over the ``audit_logs`` table.

The table itself has been populated by the ``fn_write_audit_log`` trigger on
users/merchants/service_requests/payments since migration 0023; this is the
first endpoint to read it.
"""
import datetime
from typing import Any

from pydantic import BaseModel

from app.models_v2 import AuditOperation


class AuditLogEntry(BaseModel):
    id: int
    table_name: str
    record_id: int | None = None
    operation: AuditOperation
    old_value: dict[str, Any] | None = None
    new_value: dict[str, Any] | None = None
    changed_by: int | None = None
    changed_by_name: str | None = None
    changed_by_email: str | None = None
    changed_at: datetime.datetime
