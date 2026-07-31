import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, SmallInteger, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.target_schema.base import Base

log_type_enum = SAEnum(
    "activity", "session", "report_generation", "status_change", name="ts_log_type_enum", create_type=False
)


class SystemLog(Base):
    """Disposable operational/diagnostic history: activity feed entries,
    session records, report-generation runs, status-change events. Replaces
    activity_logs, user_sessions, report_generation_log, and the two SQL-only
    status-history tables. Append-only, high-volume, hence BigInteger PK and
    no updated_at.
    """

    __tablename__ = "ts_system_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    log_type: Mapped[str] = mapped_column(log_type_enum, nullable=False)

    user_id: Mapped[int | None] = mapped_column(ForeignKey("ts_users.id", ondelete="SET NULL"), nullable=True)
    entity_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    event: Mapped[str | None] = mapped_column(Text, nullable=True)
    old_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Real columns, not log_metadata: the admin Activity Log screen filters on
    # both (list_distinct_actions/list_distinct_modules do DISTINCT queries
    # against them) — caught while porting that screen; an earlier draft only
    # had `event` (one merged string) and would have made those filters
    # impossible to implement. activity_type is the short label (legacy
    # ActivityLog.action, e.g. "Booking Created"); event holds the longer
    # human-readable sentence (legacy ActivityLog.description).
    activity_type: Mapped[str | None] = mapped_column(String(60), nullable=True)
    module: Mapped[str | None] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="success")

    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    session_token_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    session_expires_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    logged_out_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Real column (not folded into log_metadata) because "is this session still
    # active" is a filtered/ordered query (online-user tracking), not just
    # informational — replaces user_sessions.last_seen_at.
    last_seen_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Report filters/format, device info — sparse extras that vary by log_type.
    log_metadata: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
