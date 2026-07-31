"""Admin Portal operations — Approval Queue, Payment Management, Active Users, Communication
(API_CONTRACT.md §4.1-§4.4). Grouped in one schema module since they're all small,
Admin-only, cross-cutting screens rather than a single domain like tickets or merchants.
"""
import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field


class ApprovalQueueItemResponse(BaseModel):
    """One row in the merged merchant + ticket approval queue (§4.2)."""

    id: int
    kind: Literal["merchant", "request"]
    status: str
    status_label: str
    priority: str | None = None
    merchant_id: int | None = None
    merchant_name: str | None = None
    request_type: str | None = None
    title: str
    submitted_at: datetime.datetime


class RefundRequest(BaseModel):
    amount: Decimal = Field(gt=0)
    reason: str = Field(min_length=1, max_length=500)


class CommunicationSettingsResponse(BaseModel):
    merchant_id: int
    email_enabled: bool
    sms_enabled: bool
    whatsapp_enabled: bool
    otp_enabled: bool
    notification_enabled: bool
    preferred_language: str

    @classmethod
    def of(cls, s) -> "CommunicationSettingsResponse":
        return cls(
            merchant_id=s.merchant_id, email_enabled=s.email_enabled, sms_enabled=s.sms_enabled,
            whatsapp_enabled=s.whatsapp_enabled, otp_enabled=s.otp_enabled,
            notification_enabled=s.notification_enabled, preferred_language=s.preferred_language,
        )


class UpdateCommunicationSettingsRequest(BaseModel):
    email_enabled: bool | None = None
    sms_enabled: bool | None = None
    whatsapp_enabled: bool | None = None
    otp_enabled: bool | None = None
    notification_enabled: bool | None = None
    preferred_language: str | None = Field(default=None, max_length=10)


class BroadcastRequest(BaseModel):
    #: Omit or leave empty to broadcast to every active merchant.
    merchant_ids: list[int] | None = None
    title: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=2000)


class BroadcastResponse(BaseModel):
    sent: int
    skipped: int
    message: str = "Broadcast queued."
