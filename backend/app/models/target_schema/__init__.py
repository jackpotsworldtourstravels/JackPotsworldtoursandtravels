# Target 9-table schema — see docs/DATABASE_REDESIGN_9TABLE.md.
#
# Staged deliberately outside the live model graph: nothing here is imported
# by app/models/__init__.py, so the running application (still on the legacy
# 41-table schema) is unaffected until an explicit cutover. Import from this
# package only in migration/backfill tooling or once cutover begins.

from app.models.target_schema.users import User
from app.models.target_schema.merchants import Merchant
from app.models.target_schema.service_requests import ServiceRequest
from app.models.target_schema.payments import Payment
from app.models.target_schema.passenger_data import PassengerData
from app.models.target_schema.communication_settings import CommunicationSettings
from app.models.target_schema.msg_logs import MsgLog
from app.models.target_schema.system_logs import SystemLog
from app.models.target_schema.audit_logs import AuditLog

__all__ = [
    "User",
    "Merchant",
    "ServiceRequest",
    "Payment",
    "PassengerData",
    "CommunicationSettings",
    "MsgLog",
    "SystemLog",
    "AuditLog",
]
