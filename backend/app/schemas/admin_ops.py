"""Admin Portal operations — Approval Queue, Payment Management, Active Users, Communication
(API_CONTRACT.md §4.1-§4.4). Grouped in one schema module since they're all small,
Admin-only, cross-cutting screens rather than a single domain like tickets or merchants.
"""
import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StrictBool, model_validator


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
    #: What the request is priced at. ``None`` on a merchant-onboarding row,
    #: which has no money. The queue renders it so an unpriced booking sitting in
    #: Payment Pending is visible as such — the state a booking approved without
    #: a fare used to land in silently.
    total_amount: Decimal | None = None


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


#: Most merchants one broadcast may name. Matches the 100-row page cap on
#: ``GET /api/admin/merchants`` (the picker's source), so a list the UI can build is
#: always accepted; anything larger must use ``send_to_all``.
BROADCAST_MAX_MERCHANTS = 100

#: Largest value a PostgreSQL BIGINT (``merchants.merchant_id``) can hold. An id above it
#: could never exist and would make the ``IN (...)`` lookup fail with a database error,
#: so it is refused at validation instead.
BIGINT_MAX = 9_223_372_036_854_775_807

#: A merchant id: a real JSON integer (no ``true``, ``"5"`` or ``1.0`` coercion), 1..BIGINT_MAX.
MerchantId = Annotated[int, Field(strict=True, ge=1, le=BIGINT_MAX)]


class BroadcastRequest(BaseModel):
    """Who a broadcast goes to is stated explicitly — never inferred.

    * ``send_to_all=true``  -> every ACTIVE merchant; ``merchant_ids`` must be absent.
    * ``send_to_all=false`` (the default) -> exactly the listed merchants;
      ``merchant_ids`` must be a non-empty list of unique positive ids.

    A missing, null or empty ``merchant_ids`` is never read as "everyone".
    """

    #: Strict: only a JSON ``true``/``false``. ``1``, ``"yes"``, ``"true"`` are refused, so a
    #: mass send can never be switched on by a loosely-typed client.
    send_to_all: StrictBool = False
    merchant_ids: list[MerchantId] | None = Field(default=None, max_length=BROADCAST_MAX_MERCHANTS)
    title: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def _audience_is_explicit(self):
        ids = self.merchant_ids
        if self.send_to_all:
            if ids is not None:
                raise ValueError(
                    "send_to_all=true cannot be combined with merchant_ids; omit merchant_ids"
                )
            return self
        if not ids:
            raise ValueError(
                "Choose at least one merchant, or set send_to_all=true to reach every active merchant"
            )
        if len(set(ids)) != len(ids):
            raise ValueError("merchant_ids must not contain duplicates")
        return self


class BroadcastResponse(BaseModel):
    sent: int
    skipped: int
    #: Recipients whose notification could not be delivered during the fan-out.
    #: A partial failure never aborts the broadcast; this surfaces it (and it is
    #: recorded in the audit trail) instead of being lost. Defaults to 0 so the
    #: field is backward-compatible with existing clients.
    failed: int = 0
    message: str = "Broadcast queued."
