"""Small helpers the four Phase 5 catalogue services share, so none of them
restates them: list cleaning, and the one audit line every catalogue write
leaves in the portal-wide activity log (the same ``activity_service`` Phases
1-4 record their admin actions in — there is no second audit table).
"""
from __future__ import annotations

from fastapi import HTTPException, Request, status
from sqlalchemy.orm import Session

from app.models_v2 import User
from app.services import activity_service


def clean_list(values: list[str] | None, *, label: str, max_len: int) -> list[str]:
    """Trim, drop blanks, drop case-insensitive duplicates, keep first-seen order.

    A too-long entry is refused rather than truncated: silently cutting
    "Airport shuttle to all terminals" mid-word would put a half-sentence on the
    public site with nobody having chosen it.
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw in values or []:
        item = (raw or "").strip()
        if not item or item.lower() in seen:
            continue
        if len(item) > max_len:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Each {label} may be at most {max_len} characters ({item[:30]!r}… is {len(item)}).",
            )
        seen.add(item.lower())
        out.append(item)
    return out


def blank_to_none(value: str | None) -> str | None:
    """'' and whitespace mean "no value" — the nullable columns hold NULL, not ''."""
    if value is None:
        return None
    value = value.strip()
    return value or None


def log_change(
    db: Session, request: Request, user: User, *, action: str, description: str,
    reference_id: int | None = None,
) -> None:
    """Record one catalogue change. Adds to the session; the router commits."""
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, action, meta["ip_address"],
        activity_type="Update", module="B2CCatalogue", description=description,
        reference_id=reference_id, browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
