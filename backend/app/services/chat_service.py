"""Support Management / Live Chat.

Kept in a module named for the file the earlier phase plan pointed at
(``support_tickets.py``), but what it implements is the spec's Live Chat
flow — there is no separate "raise a ticket" step in the approved spec's
Merchant flow, only "Live Chat":

    Merchant: Open Chat -> Admin Receives -> Conversation -> Resolved -> Close Ticket

Admin's "Support Management" nav item is the admin-side queue over these
same threads, not a second workflow — it lists every thread across every
merchant so Admin can triage, and "Live Chat" is the conversation view for
one thread at a time.

One conversation is one ``service_requests`` row
(``request_type='live_chat'``). Messages are ``msg_logs`` rows
(``message_type='live_chat'``) — the schema's own docstrings already name
Live Chat as one of the things ``msg_logs`` absorbs, so this needed no
migration.

Status machine (deliberately not routed through ``lifecycle.transition`` —
that module's edges are booking-specific and do not apply here):

    SUBMITTED (open) -> IN_REVIEW (claimed / being worked) -> COMPLETED (resolved & closed)

Permission mapping, matching the spec's Chat Support row (View / Manage / Create):

    merchant     -> chat.create, chat.view   (open + reply on its own threads)
    admin        -> chat.manage, chat.view, support.manage (respond, resolve, queue)
    super_admin  -> chat.view only            (visibility, cannot participate)

WHERE THE SUPPORT-CENTER FIELDS LIVE, AND WHY NONE OF THEM NEEDED A MIGRATION
A support ticket wants a category, a priority, a link to the booking it is
about, attachments, and staff-only notes. Every one of those already had a
home on the row a thread is:

    priority          ``service_requests.priority`` — the column has existed
                      since the v2 schema and was simply never set on a chat.
    category          ``travel_details`` JSONB. That column is documented as the
                      *type-specific payload*, and a support category applies to
                      ``live_chat`` rows and nothing else. A real column would
                      have been NULL on every booking in the table.
    related booking   ``parent_request_id``, which is how every other request
                      type points at what it is about (see ServiceRequest's own
                      docstring). Note this is ON DELETE CASCADE: hard-deleting
                      a booking would take its support threads with it. Nothing
                      in this application hard-deletes a booking — they reach
                      terminal *statuses* — so the referential integrity is
                      worth more than the hypothetical.
    attachments       ``request_documents`` rows keyed to the thread's own
                      request_id, written through ``document_service.store_upload``
                      so a chat file passes the exact same allowlist, magic-byte
                      sniff and streaming size cap as a passport scan.
    internal notes    ``request_notes``, the staff-only table added in 0032.

So the whole of the Support Center is additive on top of the existing schema.
"""
import datetime

from fastapi import HTTPException, UploadFile, status as http_status
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session

from app.auth.rbac import P, has_permission
from app.models_v2 import (
    DocumentType,
    DocumentVerification,
    MessageStatus,
    MessageType,
    MsgLog,
    Priority,
    RequestDocument,
    RequestNote,
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    User,
)
from app.services import activity_service, document_service, notification_service

_OPEN_STATUSES = (S.SUBMITTED, S.IN_REVIEW)

#: The spec's category list (§9). Held here rather than as a PostgreSQL ENUM
#: because it is a triage vocabulary the desk will want to change, and changing
#: a tuple is a deploy while changing an ENUM is a migration and a lock.
CATEGORIES: tuple[str, ...] = (
    "booking",
    "payment",
    "wallet",
    "refund",
    "ticket_issue",
    "account",
    "technical",
    "other",
)

CATEGORY_LABELS: dict[str, str] = {
    "booking": "Booking",
    "payment": "Payment",
    "wallet": "Wallet",
    "refund": "Refund",
    "ticket_issue": "Ticket Issue",
    "account": "Account",
    "technical": "Technical",
    "other": "Other",
}

#: How long a merchant may reopen a resolved thread rather than starting a new
#: one — the spec's "within configurable period". After this the conversation
#: is an archive record and a new thread is the honest way to continue, because
#: reopening a three-month-old ticket buries the new question under stale
#: context the operator has to read past.
REOPEN_WINDOW_DAYS = 14

#: Chat attachments are recorded as ``other`` — DocumentType has no chat member
#: and adding one would be an enum migration for a label nothing branches on.
_CHAT_DOC_TYPE = DocumentType.OTHER


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _next_number(db: Session) -> str:
    # Shares the service-request sequence rather than allocating a new
    # PostgreSQL sequence for a fourth document prefix — chat threads are not
    # numbered documents anyone reconciles against, just a human-readable id.
    number = db.scalar(select(func.nextval("seq_service_request_number")))
    return f"CHT-{_now().year}-{number:06d}"


def _record_status(request: ServiceRequest, to: S, actor: User, label: str) -> None:
    request.status_history = list(request.status_history or []) + [
        {
            "from": request.status.value,
            "to": to.value,
            "label": label,
            "by": actor.user_id,
            "by_name": actor.full_name,
            "at": _now().isoformat(),
        }
    ]
    request.status = to


def scoped_query(actor: User):
    conditions = [ServiceRequest.request_type == RequestType.LIVE_CHAT]
    if not actor.is_platform_staff:
        conditions.append(ServiceRequest.merchant_id == actor.merchant_id)
    return and_(*conditions)


def category_of(thread: ServiceRequest) -> str | None:
    """The support category, read back out of the type-specific payload."""
    value = (thread.travel_details or {}).get("category")
    return value if value in CATEGORIES else None


def _clean_category(raw: str | None) -> str | None:
    if raw is None:
        return None
    value = str(raw).strip().lower()
    if value not in CATEGORIES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown category '{raw}'. Expected one of: {', '.join(CATEGORIES)}",
        )
    return value


def _linked_booking(db: Session, actor: User, request_id: int | None) -> ServiceRequest | None:
    """The booking a thread is about, checked to be one this actor may see.

    Resolved through the caller's own scope rather than by a bare ``db.get``, so
    a merchant cannot link its support ticket to another company's booking and
    read the reference back out of the thread payload.
    """
    if request_id is None:
        return None
    from app.services import ticket_service

    booking = db.scalars(
        select(ServiceRequest).where(
            and_(
                ServiceRequest.request_id == request_id,
                ServiceRequest.request_type != RequestType.LIVE_CHAT,
                ticket_service.scoped_query(actor),
            )
        )
    ).first()
    if not booking:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="That booking could not be found on your account",
        )
    return booking


def open_thread(
    db: Session,
    actor: User,
    subject: str,
    message: str,
    *,
    category: str | None = None,
    priority: Priority = Priority.NORMAL,
    related_request_id: int | None = None,
) -> ServiceRequest:
    if actor.merchant_id is None:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only merchant accounts can open a chat",
        )
    category = _clean_category(category)
    booking = _linked_booking(db, actor, related_request_id)

    thread = ServiceRequest(
        request_number=_next_number(db),
        merchant_id=actor.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.LIVE_CHAT,
        status=S.SUBMITTED,
        priority=priority,
        title=subject or "Support chat",
        # The booking this ticket is about, so an operator can jump straight to
        # it instead of asking the merchant for a reference they already gave.
        parent_request_id=booking.request_id if booking else None,
        travel_details={"category": category} if category else {},
        status_history=[
            {
                "from": None,
                "to": S.SUBMITTED.value,
                "label": "Chat opened",
                "by": actor.user_id,
                "by_name": actor.full_name,
                "at": _now().isoformat(),
            }
        ],
    )
    db.add(thread)
    db.flush()

    db.add(
        MsgLog(
            merchant_id=actor.merchant_id,
            user_id=actor.user_id,
            request_id=thread.request_id,
            message_type=MessageType.LIVE_CHAT,
            direction="inbound",
            sender_name=actor.full_name,
            sender_email=actor.email,
            recipient="support",
            message=message,
            status=MessageStatus.DELIVERED,
            sent_time=_now(),
            delivered_time=_now(),
        )
    )
    db.commit()
    db.refresh(thread)

    activity_service.log_activity(
        db, actor.user_id, "Chat opened",
        activity_type="Support", module="Live Chat",
        description=f"{actor.full_name} opened a chat: {subject}",
        reference_id=thread.request_id, merchant_id=actor.merchant_id,
    )
    notification_service.notify_admins(
        db, "New support chat",
        f"{actor.full_name} ({thread.merchant.company_name if thread.merchant else 'merchant'}) "
        f"opened a chat: {subject}",
    )
    return thread


def list_threads(
    db: Session,
    actor: User,
    *,
    thread_status: S | None = None,
    category: str | None = None,
    priority: Priority | None = None,
    search: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[ServiceRequest], int]:
    conditions = [scoped_query(actor)]
    if thread_status is not None:
        conditions.append(ServiceRequest.status == thread_status)
    if category is not None:
        # Containment (``@>``) rather than ``->> = ``, because the table already
        # carries ix_sr_details_gin over travel_details and GIN answers
        # containment. The text-equality form would have ignored that index and
        # needed an expression index of its own — i.e. a migration.
        conditions.append(
            ServiceRequest.travel_details.contains({"category": _clean_category(category)})
        )
    if priority is not None:
        conditions.append(ServiceRequest.priority == priority)

    term = (search or "").strip()
    if term:
        # Subject, reference, and the message bodies themselves — a merchant
        # searching support looks for what was *said* at least as often as for
        # what the ticket was called. The message half is an EXISTS rather than
        # a join so a thread with four matching messages is still one row.
        like = f"%{term}%"
        conditions.append(
            or_(
                ServiceRequest.title.ilike(like),
                ServiceRequest.request_number.ilike(like),
                exists().where(
                    and_(
                        MsgLog.request_id == ServiceRequest.request_id,
                        MsgLog.message_type == MessageType.LIVE_CHAT,
                        MsgLog.message.ilike(like),
                    )
                ),
            )
        )
    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    stmt = (
        select(ServiceRequest)
        .where(where)
        .order_by(ServiceRequest.updated_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.scalars(stmt).all()), total


def get_thread(db: Session, actor: User, thread_id: int) -> ServiceRequest:
    thread = db.scalars(
        select(ServiceRequest).where(
            and_(ServiceRequest.request_id == thread_id, scoped_query(actor))
        )
    ).first()
    if not thread:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Chat not found")
    return thread


def list_messages(db: Session, thread: ServiceRequest) -> list[MsgLog]:
    stmt = (
        select(MsgLog)
        .where(
            and_(MsgLog.request_id == thread.request_id, MsgLog.message_type == MessageType.LIVE_CHAT)
        )
        .order_by(MsgLog.created_at.asc())
    )
    return list(db.scalars(stmt).all())


def unread_thread_count(db: Session, actor: User) -> int:
    """Open threads awaiting a response — drives a badge on the nav item."""
    where = and_(scoped_query(actor), ServiceRequest.status.in_(_OPEN_STATUSES))
    return db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0


def send_message(db: Session, actor: User, thread_id: int, message: str) -> MsgLog:
    thread = get_thread(db, actor, thread_id)
    # Closed-thread and permission checks both live in one gate now, shared with
    # attach_document — an attachment is part of a message and the two must not
    # be able to drift into disagreeing about who may write to a conversation.
    _assert_may_participate(actor, thread)
    is_admin_side = actor.is_platform_staff

    row = MsgLog(
        merchant_id=thread.merchant_id,
        user_id=actor.user_id,
        request_id=thread.request_id,
        message_type=MessageType.LIVE_CHAT,
        direction="outbound" if is_admin_side else "inbound",
        sender_name=actor.full_name,
        sender_email=actor.email,
        recipient="admin" if not is_admin_side else "merchant",
        message=message,
        status=MessageStatus.DELIVERED,
        sent_time=_now(),
        delivered_time=_now(),
    )
    db.add(row)

    # First admin reply auto-claims and moves the thread out of the open queue.
    if is_admin_side and thread.status is S.SUBMITTED:
        thread.assigned_admin = actor.user_id
        _record_status(thread, S.IN_REVIEW, actor, "Admin joined the conversation")
    else:
        thread.updated_at = _now()

    db.commit()
    db.refresh(row)

    if not is_admin_side:
        notification_service.notify_admins(
            db, "New chat message", f"{actor.full_name}: {message[:120]}"
        )
    elif thread.user_id:
        notification_service.create_notification(
            db, thread.user_id, "New reply on your chat", f"{actor.full_name}: {message[:120]}"
        )
    return row


def claim_thread(db: Session, actor: User, thread_id: int) -> ServiceRequest:
    thread = get_thread(db, actor, thread_id)
    if thread.status is not S.SUBMITTED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Chat is already {thread.status.value}",
        )
    thread.assigned_admin = actor.user_id
    _record_status(thread, S.IN_REVIEW, actor, "Claimed by admin")
    db.commit()
    db.refresh(thread)
    return thread


def resolve_thread(db: Session, actor: User, thread_id: int) -> ServiceRequest:
    thread = get_thread(db, actor, thread_id)
    if thread.status is S.COMPLETED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Chat is already resolved"
        )
    _record_status(thread, S.COMPLETED, actor, "Resolved and closed")
    thread.completed_at = _now()
    thread.resolved_at = _now()
    db.commit()
    db.refresh(thread)
    if thread.user_id:
        notification_service.create_notification(
            db, thread.user_id, "Your chat was resolved",
            f"{thread.title} has been marked resolved and closed by our support team.",
        )
    return thread


def _days_since_resolved(thread: ServiceRequest) -> int | None:
    """Age of the resolution, or None if we cannot tell when it happened."""
    closed_at = thread.resolved_at or thread.completed_at or thread.updated_at
    if closed_at is None:
        return None
    # A naive timestamp out of the database would blow up the subtraction.
    # Everything this module writes is tz-aware; this keeps a legacy row from
    # turning a reopen into a 500.
    if closed_at.tzinfo is None:
        closed_at = closed_at.replace(tzinfo=datetime.timezone.utc)
    return (_now() - closed_at).days


def can_reopen(thread: ServiceRequest) -> bool:
    """Whether the merchant may still reopen this thread.

    The one place the window rule is evaluated, so the button the portal draws
    and the answer the endpoint gives cannot disagree — a Reopen button that
    409s is worse than no button.
    """
    if thread.status is not S.COMPLETED:
        return False
    age_days = _days_since_resolved(thread)
    return age_days is None or age_days <= REOPEN_WINDOW_DAYS


def reopen_thread(db: Session, actor: User, thread_id: int) -> ServiceRequest:
    """Put a resolved thread back in the queue.

    The spec's flow ends "Merchant Can Reopen (within configurable period) or
    Close", and until now resolving was terminal — a merchant who was told an
    issue was fixed and found it was not had to open a second ticket, which
    left the desk with two half-conversations and no thread showing the
    problem had recurred.

    It returns to SUBMITTED rather than IN_REVIEW, and the previous assignee is
    deliberately kept: the operator who resolved it is the one with the
    context, but the thread still has to be re-picked-up so it reappears in the
    unclaimed queue rather than sitting silently in someone's name.
    """
    thread = get_thread(db, actor, thread_id)
    if thread.status is not S.COMPLETED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="This conversation is already open.",
        )

    age_days = _days_since_resolved(thread)
    if age_days is not None and age_days > REOPEN_WINDOW_DAYS:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{thread.request_number} was resolved {age_days} days ago, past the "
                f"{REOPEN_WINDOW_DAYS}-day reopening window. Please start a new "
                "conversation so the desk gets the current details."
            ),
        )

    _record_status(thread, S.SUBMITTED, actor, "Reopened by the merchant")
    thread.completed_at = None
    thread.resolved_at = None
    db.commit()
    db.refresh(thread)

    activity_service.log_activity(
        db, actor.user_id, "Chat reopened",
        activity_type="Support", module="Live Chat",
        description=f"{actor.full_name} reopened {thread.request_number}",
        reference_id=thread.request_id, merchant_id=thread.merchant_id,
    )
    notification_service.notify_admins(
        db, "Support chat reopened",
        f"{actor.full_name} reopened {thread.request_number}: {thread.title}",
    )
    return thread


def set_triage(
    db: Session,
    actor: User,
    thread_id: int,
    *,
    priority: Priority | None = None,
    category: str | None = None,
) -> ServiceRequest:
    """Admin re-files a thread — priority and category.

    Triage is the desk's judgement, not the merchant's: a merchant marking its
    own ticket Urgent tells you only that it is their ticket. So this is
    ``chat.manage`` and the merchant-facing open payload takes priority as a
    *starting* value the desk can overrule.
    """
    if not has_permission(actor, P.CHAT_MANAGE):
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail=f"Missing required permission: {P.CHAT_MANAGE}",
        )
    thread = get_thread(db, actor, thread_id)
    changed: list[str] = []

    if priority is not None and priority is not thread.priority:
        changed.append(f"priority {thread.priority.value} -> {priority.value}")
        thread.priority = priority

    if category is not None:
        value = _clean_category(category)
        if value != category_of(thread):
            changed.append(f"category {category_of(thread) or 'unset'} -> {value}")
            # Rebound rather than mutated in place: SQLAlchemy does not track
            # in-place changes to a JSONB dict, and the UPDATE would be skipped.
            thread.travel_details = {**(thread.travel_details or {}), "category": value}

    if not changed:
        return thread

    thread.updated_at = _now()
    db.commit()
    db.refresh(thread)
    activity_service.log_activity(
        db, actor.user_id, "Chat triaged",
        activity_type="Support", module="Live Chat",
        description=f"{actor.full_name} updated {thread.request_number}: {', '.join(changed)}",
        reference_id=thread.request_id, merchant_id=thread.merchant_id,
        details={"request_number": thread.request_number, "changes": changed},
    )
    return thread


def mark_thread_read(db: Session, actor: User, thread: ServiceRequest) -> None:
    """Mark the *other* side's messages as read by this reader.

    This is what turns the merchant portal's read receipt from a guess into a
    fact. It previously showed a double tick when the thread had been claimed
    or replied to — reasonable evidence, but not the same claim as "someone
    opened this". ``msg_logs.is_read`` has been on the table since the v2
    schema and nothing was writing it for chat.

    Scoped to rows that are still unread so the merchant's 9-second poll is a
    no-op UPDATE rather than a write amplifier on every tick.
    """
    # "Mine" is written from the platform's point of view: a merchant's message
    # is inbound, a staff reply is outbound. A reader marks the opposite side.
    theirs = "inbound" if actor.is_platform_staff else "outbound"
    db.query(MsgLog).filter(
        MsgLog.request_id == thread.request_id,
        MsgLog.message_type == MessageType.LIVE_CHAT,
        MsgLog.direction == theirs,
        MsgLog.is_read.is_(False),
    ).update({MsgLog.is_read: True}, synchronize_session=False)
    db.commit()


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------
def may_participate(actor: User) -> bool:
    """Can this account write into a conversation at all?

    True for a merchant with ``chat.create`` and an admin with ``chat.manage``;
    false for a Super Admin, who holds ``chat.view`` alone by design. Exposed
    because a read receipt is a claim that somebody who can *act* on the message
    saw it — a Super Admin auditing the queue must not light up the merchant's
    second tick.
    """
    return has_permission(actor, P.CHAT_MANAGE if actor.is_platform_staff else P.CHAT_CREATE)


def _assert_may_participate(actor: User, thread: ServiceRequest) -> None:
    """The same gate ``send_message`` applies, for anything that writes to a
    conversation. An attachment is part of a message, so it cannot be looser."""
    if thread.status is S.COMPLETED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="This chat is closed — reopen it or start a new one to keep talking.",
        )
    if not may_participate(actor):
        needed = P.CHAT_MANAGE if actor.is_platform_staff else P.CHAT_CREATE
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail=f"Missing required permission: {needed}",
        )


def list_documents(db: Session, thread: ServiceRequest) -> list[RequestDocument]:
    return list(
        db.scalars(
            select(RequestDocument)
            .where(RequestDocument.request_id == thread.request_id)
            .order_by(RequestDocument.created_at)
        ).all()
    )


def attach_document(
    db: Session, actor: User, thread_id: int, upload_file: UploadFile
) -> RequestDocument:
    """Attach a file to a conversation — the spec's File Sharing (§4).

    The bytes go through ``document_service.store_upload`` unchanged, which is
    the whole point: the declared-type allowlist, the magic-byte sniff that
    stops an HTML payload arriving as ``image/png``, the streaming size cap and
    the uuid filename are all security-critical and must not have a second
    implementation for chat. This function supplies a prefix and writes a row.

    THERE IS NO DELETE COUNTERPART, deliberately. A file that has been sent to
    the desk is part of what was said; letting either side make it disappear
    from a support record that may be evidence in a refund dispute would be a
    worse feature than not having it. ``document_service.delete`` refuses a
    non-draft request anyway, so the existing endpoint already declines.
    """
    thread = get_thread(db, actor, thread_id)
    _assert_may_participate(actor, thread)

    stored = document_service.store_upload(upload_file, prefix=f"chat/{thread.request_id}")

    document = RequestDocument(
        request_id=thread.request_id,
        merchant_id=thread.merchant_id,
        doc_type=_CHAT_DOC_TYPE,
        original_filename=stored.display_filename,
        stored_path=stored.relative_path,
        content_type=stored.content_type,
        size_bytes=stored.size_bytes,
        checksum=stored.checksum,
        uploaded_by=actor.user_id,
        # Verification is a passport/visa workflow and means nothing on a chat
        # file. PENDING matches the column default; no queue reads it for a
        # live_chat row, so it stays inert rather than showing up as unchecked
        # paperwork somewhere it was never meant to appear.
        verification_status=DocumentVerification.PENDING,
    )
    db.add(document)

    # A file with no message is a notification nobody can action, so the upload
    # posts its own line into the transcript. It is a real message row, which
    # means it appears in the log, in the PDF export and in the unread count
    # exactly like anything else either side said.
    is_admin_side = actor.is_platform_staff
    db.add(
        MsgLog(
            merchant_id=thread.merchant_id,
            user_id=actor.user_id,
            request_id=thread.request_id,
            message_type=MessageType.LIVE_CHAT,
            direction="outbound" if is_admin_side else "inbound",
            sender_name=actor.full_name,
            sender_email=actor.email,
            recipient="merchant" if is_admin_side else "support",
            message=f"Shared a file: {stored.display_filename}",
            status=MessageStatus.DELIVERED,
            sent_time=_now(),
            delivered_time=_now(),
        )
    )

    if is_admin_side and thread.status is S.SUBMITTED:
        thread.assigned_admin = actor.user_id
        _record_status(thread, S.IN_REVIEW, actor, "Admin joined the conversation")
    else:
        thread.updated_at = _now()

    db.commit()
    db.refresh(document)

    activity_service.log_activity(
        db, actor.user_id, "Chat file shared",
        activity_type="Support", module="Live Chat",
        description=(
            f"{actor.full_name} shared {document.original_filename} on {thread.request_number}"
        ),
        reference_id=thread.request_id, merchant_id=thread.merchant_id,
        details={
            "document_id": document.document_id,
            "request_number": thread.request_number,
            "size_bytes": document.size_bytes,
            "checksum": document.checksum,
        },
    )
    if is_admin_side:
        if thread.user_id:
            notification_service.create_notification(
                db, thread.user_id, "A file was shared on your chat",
                f"{actor.full_name} shared {document.original_filename}.",
            )
    else:
        notification_service.notify_admins(
            db, "File shared on a support chat",
            f"{actor.full_name} shared {document.original_filename} on {thread.request_number}.",
        )
    return document


# ---------------------------------------------------------------------------
# Internal notes (staff only)
# ---------------------------------------------------------------------------
def _assert_staff(actor: User) -> None:
    """Notes are staff-only and there is no visibility column to get wrong.

    Migration 0032 chose that on purpose: a note the merchant must not see is
    safer as a table nothing merchant-facing queries than as a row with a
    boolean somebody eventually forgets to filter on. This function is that
    guarantee for the support surface — every note read and write goes through
    it, and no merchant-facing schema references RequestNote.
    """
    if not actor.is_platform_staff or not has_permission(actor, P.CHAT_MANAGE):
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Internal notes are visible to the support desk only",
        )


def list_notes(db: Session, actor: User, thread_id: int) -> list[RequestNote]:
    _assert_staff(actor)
    thread = get_thread(db, actor, thread_id)
    return list(
        db.scalars(
            select(RequestNote)
            .where(RequestNote.request_id == thread.request_id)
            .order_by(RequestNote.note_id.desc())
        ).all()
    )


def add_note(db: Session, actor: User, thread_id: int, body: str) -> RequestNote:
    _assert_staff(actor)
    thread = get_thread(db, actor, thread_id)
    text = (body or "").strip()
    if not text:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="A note cannot be empty"
        )

    note = RequestNote(
        request_id=thread.request_id,
        merchant_id=thread.merchant_id,
        author_id=actor.user_id,
        body=text,
    )
    db.add(note)
    db.commit()
    db.refresh(note)

    activity_service.log_activity(
        db, actor.user_id, "Internal note added",
        activity_type="Support", module="Live Chat",
        description=f"{actor.full_name} added an internal note to {thread.request_number}",
        reference_id=thread.request_id, merchant_id=thread.merchant_id,
        # The body stays out of the activity feed — the feed is read in places
        # the note is not, and copying it there would undo the staff-only
        # guarantee the note was written under.
        details={"request_number": thread.request_number, "note_id": note.note_id},
    )
    return note
