import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.target_schema.base import Base

audit_action_enum = SAEnum("insert", "update", "delete", name="ts_audit_action_enum", create_type=False)


class AuditLog(Base):
    """Compliance-grade before/after row snapshots. Replaces partner_audit_logs
    and extends the same coverage to the core domain, which currently has no
    audit trail at all. Kept separate from system_logs deliberately — audit
    trails must survive even if operational logs are pruned.
    """

    __tablename__ = "ts_audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(audit_action_enum, nullable=False)
    changed_by: Mapped[int | None] = mapped_column(ForeignKey("ts_users.id", ondelete="SET NULL"), nullable=True)
    old_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    new_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
