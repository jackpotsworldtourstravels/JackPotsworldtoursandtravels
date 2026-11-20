"""Live Support, agent side — ``/api/admin/chat/*`` (CR-9, slice 4).

The customer side is scoped by the caller's own id. This side (Phase 13, owner
decisions D7-D9, C4, C8) is gated by ``get_current_b2c_admin`` — an ACTIVE super
admin or an admin holding ``b2c.chat.manage`` — and then per conversation by
``chat_access``: the ASSIGNED agent reads and writes; a SUPER ADMIN may read and
write any conversation (supervision), audited when it is not theirs; any other
agent may only claim an unassigned conversation, seeing just the customer's name
in the queue until it is theirs. A chat whose owner has gone home is handed on by
a super admin (transfer) — not read by whoever happens to be signed in.

WHAT MAKES THIS DIFFERENT FROM A TICKET QUEUE
Nothing here creates anything. There is no "open a case" endpoint, because the
conversation already exists the moment a customer types. An agent claims, replies
and closes; the thread outlives all of it and is still there next month when the
same customer comes back.

INTERNAL NOTES ARE MESSAGES, NOT A SIDE TABLE. They sort into the thread where
the agent wrote them, and `include_internal=True` is passed on exactly the reads
an agent makes. The customer-facing reads never pass it — see
`customer_chat_service._visible`, which is the one place that filter lives.
"""
from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Path, Query, Request, UploadFile,
    WebSocket, status,
)
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select, union_all
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.auth.rate_limit import limiter
from app.config import settings
from app.database.session import get_db
from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerChatMessage,
    CustomerConversation,
    CustomerHotelBooking,
    CustomerPackageBooking,
)
from app.models_v2 import User
from app.schemas.customer_chat import (
    CallHistoryResponse,
    CallResponse,
    ChatMessageResponse,
)
from app.services import call_signaling
from app.services import chat_access
from app.services import chat_attachments as attachments
from app.services import chat_context_service
from app.services import customer_call_service as call_service
from app.services import chat_gateway, customer_chat_service as chat
from app.services import customer_admin_audit_service as b2c_audit
from app.services import document_service
from app.services.chat_broker import get_broker
from app.services.b2c_admin_readiness import require_audit_ready
from app.models_customer import AdminAuditOutcome

router = APIRouter(prefix="/api/admin/chat", tags=["admin-chat"])


def get_current_b2c_admin(admin: User = Depends(get_current_admin)) -> User:
    """A live-chat AGENT: an active super admin or an admin holding
    ``b2c.chat.manage`` explicitly (Phase 13, F-12a).

    Until Phase 13 ANY ``b2c.*`` scope opened the console, so an admin granted
    only ``b2c.customers.view`` could mint an agent ticket and read every
    conversation. The rule now lives in ``chat_access.is_eligible`` — the same
    one auto-assignment, transfers, the agent list and call routing use. The
    agent WebSocket admits only a ticket minted by ``/ws-ticket`` (gated here),
    and re-checks the rule on every frame (``chat_gateway.AgentConnection``).
    A refusal is written to the B2C audit trail (metadata only).
    """
    if not chat_access.is_eligible(admin):
        b2c_audit.record_independently(
            admin=admin, action="chat.access", outcome=AdminAuditOutcome.DENIED,
            entity_type="chat_console", reason="missing b2c.chat.manage",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Live chat access requires b2c.chat.manage",
        )
    return admin


def _open(db: Session, conversation_id: int, admin: User, *, write: bool, action: str):
    """Load a conversation the caller may read (``write=False``) or act on.

    Returns ``(conversation, level)`` where level is ``chat_access.OWNER`` or
    ``chat_access.SUPERVISOR``. Refusals are audited and returned as 403 (read)
    or 409 (write: "claim it first" / "assigned to somebody else")."""
    try:
        conversation = chat.get_for_admin(db, conversation_id)
    except chat.ChatNotFound:
        raise _not_found()
    try:
        level = chat_access.require(conversation, admin, write=write)
    except chat_access.ChatAccessDenied as exc:
        b2c_audit.record_independently(
            admin=admin, action=f"chat.{action}", outcome=AdminAuditOutcome.DENIED,
            entity_type="customer_conversation", entity_id=conversation_id,
            reason="not the assigned agent",
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT if exc.write else status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        )
    return conversation, level


def _audit_supervision(db: Session, admin: User, conversation, level: str, action: str, **new) -> None:
    """A super admin acting on a conversation not assigned to them (C4/D7) is
    recorded in the caller's transaction, so the write and its audit commit
    together. Never the message text."""
    if level != chat_access.SUPERVISOR:
        return
    b2c_audit.record_in_session(
        db, admin=admin, action=f"chat.{action}_supervisor", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_conversation", entity_id=conversation.conversation_id,
        new={"assigned_admin_id": conversation.assigned_admin_id, **new},
    )


def _audit_supervised_read(admin: User, conversation, level: str, what: str) -> None:
    """Durable (fail-closed) record of a super admin READING a conversation not
    assigned to them — written before the content is returned."""
    if level != chat_access.SUPERVISOR:
        return
    b2c_audit.record_independently(
        required=True,
        admin=admin, action="chat.supervise_read", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_conversation", entity_id=conversation.conversation_id,
        new={"what": what, "assigned_admin_id": conversation.assigned_admin_id},
    )


# ---------------------------------------------------------------------------
# Schemas — local, because nothing outside this module sends or receives them
# ---------------------------------------------------------------------------
class QueueRow(BaseModel):
    conversation_id: int
    customer_id: int
    customer_name: str | None = None
    customer_email: str | None = None
    customer_mobile: str | None = None
    status: str
    assigned_admin_id: int | None = None
    assigned_admin_name: str | None = None
    last_message: str | None = None
    last_message_at: str | None = None
    unread_count: int = 0


class QueueResponse(BaseModel):
    counts: dict[str, int]
    conversations: list[QueueRow]


class ThreadResponse(BaseModel):
    conversation: QueueRow
    messages: list[ChatMessageResponse]


class ReplyRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    #: An internal note is written into the thread but never delivered — see the
    #: module docstring.
    is_internal: bool = False


class TransferRequest(BaseModel):
    to_admin_id: int


class StatusRequest(BaseModel):
    status: str = Field(pattern="^(active|resolved|closed)$")


def _row(conversation: CustomerConversation, customer: Customer | None, *, masked: bool = False) -> QueueRow:
    """One queue row. ``masked`` (C8): an ordinary agent looking at a conversation
    nobody has claimed sees the customer's NAME only — no email, mobile or
    message preview until the conversation is assigned to them."""
    return QueueRow(
        conversation_id=conversation.conversation_id,
        customer_id=conversation.customer_id,
        customer_name=customer.full_name if customer else None,
        customer_email=None if masked else (customer.email if customer else None),
        customer_mobile=None if masked else (customer.mobile if customer else None),
        status=conversation.status,
        assigned_admin_id=conversation.assigned_admin_id,
        assigned_admin_name=conversation.assigned_admin_name,
        last_message=None if masked else conversation.last_message,
        last_message_at=(
            conversation.last_message_at.isoformat()
            if conversation.last_message_at else None
        ),
        unread_count=conversation.admin_unread_count,
    )


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")


def _booking_owners(term: str):
    """Customer ids whose booking reference or PNR matches `term`.

    A UNION over the three booking tables rather than three separate OR-ed
    subqueries: one scan each, and the planner gets to stop at the first table
    that matches instead of evaluating all three for every conversation row.

    `ilike` with no leading wildcard on purpose. A reference is quoted whole in
    a chat or read off a ticket, so a prefix match covers the real use; a
    leading `%` would make this an unindexable full scan on the busiest tables
    in the database, run on every keystroke of the agent's search box.
    """
    pattern = f"{term}%"
    parts = union_all(
        select(CustomerBooking.customer_id).where(
            or_(CustomerBooking.booking_ref.ilike(pattern),
                CustomerBooking.pnr.ilike(pattern)),
        ),
        select(CustomerHotelBooking.customer_id).where(
            CustomerHotelBooking.booking_ref.ilike(pattern),
        ),
        select(CustomerPackageBooking.customer_id).where(
            CustomerPackageBooking.booking_ref.ilike(pattern),
        ),
    ).subquery()
    # Wrapped in an explicit SELECT over the subquery rather than handed to
    # `in_()` as a compound directly: SQLAlchemy will coerce the latter, but
    # what it coerces it to has changed between versions, and an IN over a
    # named subquery is the form that compiles the same way on all of them.
    return select(parts.c.customer_id)


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------
@router.get("/conversations", response_model=QueueResponse, summary="The agent queue")
def queue(
    status_filter: str | None = Query(default=None, alias="status"),
    mine: bool = Query(default=False, description="Only conversations assigned to me"),
    q: str | None = Query(
        default=None,
        description="Name, email, phone, customer code, conversation id or booking reference",
    ),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    admin: User = Depends(get_current_b2c_admin),
    db: Session = Depends(get_db),
):
    """The work list, plus the badge counts, in one call.

    ONE QUERY WITH A JOIN, not a per-row customer lookup. The queue screen is
    the one an agent leaves open all day; an N+1 over `customers` here is fifty
    extra round trips every time it refreshes.
    """
    stmt = (
        select(CustomerConversation, Customer)
        .join(Customer, Customer.customer_id == CustomerConversation.customer_id)
    )
    supervisor = chat_access.is_super(admin)
    mine_clause = CustomerConversation.assigned_admin_id == admin.user_id
    unassigned_clause = CustomerConversation.assigned_admin_id.is_(None)
    # PHASE 13 (D8/C8). An ordinary agent sees conversations assigned to them,
    # plus the unassigned ones they could claim (name only). A super admin sees
    # every conversation (supervision, C4).
    if not supervisor:
        stmt = stmt.where(or_(mine_clause, unassigned_clause))
    if status_filter:
        stmt = stmt.where(CustomerConversation.status == status_filter)
    if mine:
        stmt = stmt.where(mine_clause)
    if q:
        term = q.strip()
        name_clauses = [Customer.full_name.ilike(f"%{term}%")]
        clauses = name_clauses + [
            Customer.email.ilike(f"%{term}%"),
            Customer.mobile.ilike(f"%{term}%"),
            Customer.customer_code.ilike(f"%{term}%"),
        ]
        # A bare number is almost always a conversation id an agent has been
        # given, so it is matched as one as well as as a phone fragment.
        if term.isdigit():
            clauses.append(CustomerConversation.conversation_id == int(term))
            name_clauses.append(CustomerConversation.conversation_id == int(term))
        # BOOKING REFERENCE. The single most common thing a customer opens with
        # is "about booking JWT12345", and until now the agent had to look that
        # up in another screen to find out whose chat to open. Matched across
        # all three booking products plus the airline PNR, because the customer
        # does not know or care which of our tables their trip lives in.
        clauses.append(CustomerConversation.customer_id.in_(_booking_owners(term)))
        if supervisor:
            stmt = stmt.where(or_(*clauses))
        else:
            # Unassigned rows are matched on what the agent may see of them
            # (name, conversation id) — otherwise a search for an email address
            # would confirm whose chat it is before the agent was assigned it.
            stmt = stmt.where(or_(
                and_(mine_clause, or_(*clauses)),
                and_(unassigned_clause, or_(*name_clauses)),
            ))

    stmt = stmt.order_by(
        CustomerConversation.last_message_at.desc().nullslast(),
        CustomerConversation.conversation_id.desc(),
    )
    rows = db.execute(stmt.limit(limit).offset(offset)).all()
    return QueueResponse(
        counts=chat.counts_by_status(db),
        conversations=[
            _row(conversation, customer,
                 masked=not supervisor and conversation.assigned_admin_id != admin.user_id)
            for conversation, customer in rows
        ],
    )


@router.get(
    "/conversations/{conversation_id}",
    response_model=ThreadResponse,
    summary="One thread, including internal notes",
)
def thread(
    conversation_id: int,
    before_id: int | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    admin: User = Depends(get_current_b2c_admin),
    db: Session = Depends(get_db),
):
    conversation, level = _open(db, conversation_id, admin, write=False, action="read")
    _audit_supervised_read(admin, conversation, level, "thread")
    customer = db.get(Customer, conversation.customer_id)
    messages = chat.list_messages(
        db, conversation, include_internal=True, before_id=before_id, limit=limit,
    )
    return ThreadResponse(
        conversation=_row(conversation, customer),
        messages=[ChatMessageResponse.model_validate(m) for m in messages],
    )


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
@router.post("/conversations/{conversation_id}/claim", summary="Accept a waiting chat")
def claim(
    conversation_id: int,
    admin: User = Depends(get_current_b2c_admin),
    db: Session = Depends(get_db),
):
    """Take an unassigned conversation.

    Returns 409 when another agent won the race rather than silently stealing
    it — the service layer's conditional UPDATE is what decides, and the answer
    an agent needs is "somebody already has this", not a screen that looks like
    it worked.
    """
    try:
        conversation = chat.get_for_admin(db, conversation_id)
    except chat.ChatNotFound:
        raise _not_found()
    won = chat.claim(
        db, conversation, admin_id=admin.user_id, admin_name=admin.full_name,
    )
    if won:
        b2c_audit.record_in_session(
            db, admin=admin, action="chat.claim", outcome=AdminAuditOutcome.SUCCESS,
            entity_type="customer_conversation", entity_id=conversation_id,
        )
    db.commit()
    if not won:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Already assigned to {conversation.assigned_admin_name or 'another agent'}",
        )
    return _row(conversation, db.get(Customer, conversation.customer_id))


@router.post("/conversations/{conversation_id}/transfer", summary="Hand to another agent")
def transfer(
    conversation_id: int,
    payload: TransferRequest,
    admin: User = Depends(get_current_b2c_admin),
    db: Session = Depends(get_db),
):
    conversation, level = _open(db, conversation_id, admin, write=True, action="transfer")
    target = db.get(User, payload.to_admin_id)
    # X4: only an eligible agent — an ACTIVE super admin or admin holding
    # b2c.chat.manage. Never a merchant user, a suspended admin, or an admin
    # who would get a 403 opening the chat they were just handed.
    if not chat_access.is_eligible(target):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not an eligible live-chat agent")
    previous = conversation.assigned_admin_id
    chat.transfer(
        db, conversation, admin_id=target.user_id, admin_name=target.full_name,
    )
    b2c_audit.record_in_session(
        db, admin=admin, action="chat.transfer", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_conversation", entity_id=conversation_id,
        previous={"assigned_admin_id": previous},
        new={"to_admin_id": target.user_id, "as_supervisor": level == chat_access.SUPERVISOR},
    )
    db.commit()
    return _row(conversation, db.get(Customer, conversation.customer_id))


@router.post("/conversations/{conversation_id}/status", summary="Resolve, close or reopen")
def set_status(
    conversation_id: int,
    payload: StatusRequest,
    admin: User = Depends(get_current_b2c_admin),
    db: Session = Depends(get_db),
):
    conversation, level = _open(db, conversation_id, admin, write=True, action="set_status")
    previous = conversation.status
    try:
        chat.set_status(db, conversation, payload.status, actor=admin.full_name)
    except chat.ChatError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    b2c_audit.record_in_session(
        db, admin=admin, action="chat.set_status", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_conversation", entity_id=conversation_id,
        previous={"status": previous},
        new={"status": payload.status, "as_supervisor": level == chat_access.SUPERVISOR},
    )
    db.commit()
    return _row(conversation, db.get(Customer, conversation.customer_id))


@router.post(
    "/conversations/{conversation_id}/messages",
    status_code=status.HTTP_201_CREATED,
    summary="Reply, or leave an internal note",
)
@limiter.limit("60/minute")
async def reply(
    request: Request,
    conversation_id: int,
    payload: ReplyRequest,
    admin: User = Depends(get_current_b2c_admin),
    db: Session = Depends(get_db),
):
    """Write and PUBLISH.

    The publish is the half that is easy to forget: without it the message is
    stored and the customer sees nothing until they reload, which is exactly the
    failure this whole CR exists to remove. `publish_admin_message` is the one
    place that knows the envelope, so REST replies and socket replies produce
    identical frames.
    """
    # D9: replies AND internal notes need ownership (or a claim first); a super
    # admin may write into any conversation, audited (D7/C4).
    conversation, level = _open(
        db, conversation_id, admin, write=True,
        action="note" if payload.is_internal else "reply",
    )
    try:
        message = chat.post_admin_message(
            db, conversation,
            admin_id=admin.user_id, admin_name=admin.full_name,
            body=payload.body, is_internal=payload.is_internal,
        )
    except chat.ChatError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    _audit_supervision(
        db, admin, conversation, level, "note" if payload.is_internal else "reply",
        message_id=message.message_id, is_internal=payload.is_internal,
    )
    db.commit()
    await chat_gateway.publish_admin_message(
        conversation_id, message, internal=payload.is_internal,
    )
    return ChatMessageResponse.model_validate(message)


def _send_attachment_access(conversation_id: int = Path(...), admin: User = Depends(get_current_admin)) -> User:
    """Live-chat gate for the attachment SEND (Phase 13: super admin or
    b2c.chat.manage), recording a DENIED audit event (metadata only) on refusal."""
    if not chat_access.is_eligible(admin):
        b2c_audit.record_independently(
            admin=admin, action="chat.attachment_send", outcome=AdminAuditOutcome.DENIED,
            entity_type="customer_conversation", entity_id=conversation_id, reason="missing b2c.chat.manage",
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Live chat access requires b2c.chat.manage")
    return admin


@router.post(
    "/conversations/{conversation_id}/attachments",
    response_model=ChatMessageResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Send a file to the customer",
)
@limiter.limit("20/minute")
async def send_attachment(
    request: Request,
    conversation_id: int,
    file: UploadFile = File(..., description="JPEG, PNG, WebP or PDF, up to 10 MB"),
    caption: str | None = Form(default=None),
    is_internal: bool = Form(default=False),
    admin: User = Depends(_send_attachment_access),
    db: Session = Depends(get_db),
):
    """An agent sending a voucher, a revised itinerary, or a screenshot back.

    `is_internal` is honoured here exactly as it is for a text note, and it is
    the reason `attachment_for_admin` and `attachment_for_customer` are separate
    functions rather than one with a flag: an internal note's file must be
    unreachable by the customer even by guessing its id, and the safest way to
    guarantee that is for the customer's lookup to have no code path that could
    return one.
    """
    try:
        conversation = chat.get_for_admin(db, conversation_id)
    except chat.ChatNotFound:
        b2c_audit.record_independently(
            admin=admin, action="chat.attachment_send", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer_conversation", entity_id=conversation_id, reason="conversation not found",
        )
        raise _not_found()
    try:
        level = chat_access.require(conversation, admin, write=True)
    except chat_access.ChatAccessDenied as exc:
        b2c_audit.record_independently(
            admin=admin, action="chat.attachment_send", outcome=AdminAuditOutcome.DENIED,
            entity_type="customer_conversation", entity_id=conversation_id, reason="not the assigned agent",
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    attachments.guard_open(conversation)
    stored = attachments.store(file, conversation_id=conversation_id)

    try:
        message = chat.post_admin_message(
            db, conversation,
            admin_id=admin.user_id, admin_name=admin.full_name,
            body=attachments.caption(caption),
            message_type=attachments.message_type_for(stored),
            is_internal=is_internal,
        )
    except chat.ChatError as exc:
        document_service.discard_file(stored.relative_path)
        b2c_audit.record_independently(
            admin=admin, action="chat.attachment_send", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer_conversation", entity_id=conversation_id, reason=str(exc),
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    attachments.record(db, message, stored)
    body = ChatMessageResponse.model_validate(message)
    # Metadata only — never the file bytes, the caption text, or any credential.
    b2c_audit.record_in_session(
        db, admin=admin, action="chat.attachment_send", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer_conversation", entity_id=conversation_id,
        new={"message_type": attachments.message_type_for(stored), "is_internal": is_internal,
             "as_supervisor": level == chat_access.SUPERVISOR,
             "assigned_admin_id": conversation.assigned_admin_id,
             "content_type": getattr(stored, "content_type", None),
             "filename": getattr(stored, "original_filename", None)},
    )
    db.commit()

    await chat_gateway.publish_admin_message(conversation_id, message, internal=is_internal)
    return body


def _attachment_conversation(db: Session, attachment) -> CustomerConversation | None:
    """The conversation an attachment belongs to. An attachment has no
    conversation_id of its own — it hangs off a message."""
    message = db.get(CustomerChatMessage, attachment.message_id)
    if message is None:
        return None
    return db.get(CustomerConversation, message.conversation_id)


def _attachment_access(attachment_id: int = Path(...), admin: User = Depends(get_current_admin)) -> User:
    """Live-chat gate for the document download (Phase 13: super admin or
    b2c.chat.manage), recording a DENIED audit event on refusal."""
    if not chat_access.is_eligible(admin):
        b2c_audit.record_independently(
            admin=admin, action="document.download", outcome=AdminAuditOutcome.DENIED,
            entity_type="chat_attachment", entity_id=attachment_id, reason="missing b2c.chat.manage",
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Live chat access requires b2c.chat.manage")
    return admin


@router.get(
    "/attachments/{attachment_id}",
    summary="Download any conversation's file",
    dependencies=[Depends(require_audit_ready)],
)
def download_attachment(
    attachment_id: int,
    admin: User = Depends(_attachment_access),
    db: Session = Depends(get_db),
):
    """Unscoped by conversation — reading other people's threads is the job.

    The role gate on this route is therefore the only thing between a customer
    token and every file in the system, which is why `verify_live_chat.py`
    checks the refusal before it checks anything this endpoint returns.

    Stage 2 audit lifecycle (metadata only — never file bytes/credentials):
    DENIED in `_attachment_access`; FAILURE here on not-found; SUCCESS once the
    attachment resolves and the file is served.
    """
    try:
        attachment = chat.attachment_for_admin(db, attachment_id)
    except chat.ChatNotFound:
        b2c_audit.record_independently(
            admin=admin, action="document.download", outcome=AdminAuditOutcome.FAILURE,
            entity_type="chat_attachment", entity_id=attachment_id, reason="attachment not found",
        )
        raise _not_found()
    # Phase 13 (D8): only the assigned agent or a super admin may open a
    # conversation's files — the same rule as reading its thread.
    conversation = _attachment_conversation(db, attachment)
    conversation_id = conversation.conversation_id if conversation is not None else None
    if conversation is None or chat_access.access(conversation, admin) is None:
        b2c_audit.record_independently(
            admin=admin, action="document.download", outcome=AdminAuditOutcome.DENIED,
            entity_type="chat_attachment", entity_id=attachment_id, reason="not the assigned agent",
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This file belongs to a conversation assigned to another agent.")
    try:
        response = attachments.download(attachment)
    except Exception:
        b2c_audit.record_independently(
            admin=admin, action="document.download", outcome=AdminAuditOutcome.FAILURE,
            entity_type="chat_attachment", entity_id=attachment_id, reason="stored file unavailable",
        )
        raise
    # required=True — the file is NOT served unless this SUCCESS audit is durably
    # persisted. The door-gate (require_audit_ready) only narrows the window; if
    # the audit store became unwritable since, fail closed (503) rather than
    # disclose a file we could not record was accessed.
    b2c_audit.record_independently(
        required=True,
        admin=admin, action="document.download", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="chat_attachment", entity_id=attachment_id,
        new={"conversation_id": conversation_id,
             "as_supervisor": chat_access.access(conversation, admin) == chat_access.SUPERVISOR,
             "filename": getattr(attachment, "original_filename", None),
             "content_type": getattr(attachment, "content_type", None)},
    )
    return response


@router.post("/conversations/{conversation_id}/read", summary="Mark the customer's messages read")
def mark_read(
    conversation_id: int,
    up_to_message_id: int = Query(...),
    admin: User = Depends(get_current_b2c_admin),
    db: Session = Depends(get_db),
):
    conversation, _level = _open(db, conversation_id, admin, write=False, action="mark_read")
    marked = chat.mark_read(
        db, conversation, reader="admin", up_to_message_id=up_to_message_id,
    )
    db.commit()
    return {"marked": marked, "unread_count": conversation.admin_unread_count}


# ---------------------------------------------------------------------------
# Agents, analytics, real time
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Voice calls (CR-10)
# ---------------------------------------------------------------------------
@router.get("/ice", summary="ICE servers for a call")
def ice_config(admin: User = Depends(get_current_b2c_admin)):
    """Same config the customer gets — see the customer route for why it is
    served rather than hardcoded, and why it is authenticated."""
    return call_signaling.ice_config(f"admin:{admin.user_id}")


@router.get(
    "/conversations/{conversation_id}/calls",
    response_model=CallHistoryResponse,
    summary="Call history for one conversation",
)
def conversation_calls(
    conversation_id: int,
    limit: int = Query(default=20, ge=1, le=100),
    before_id: int | None = Query(default=None),
    admin: User = Depends(get_current_b2c_admin),
    db: Session = Depends(get_db),
):
    """The agent's view of the same log, with staff ids left in.

    `CallResponse` rather than `CallResponse.for_customer`: the console needs
    `admin_id` to tell the agent's own calls from a colleague's, and this side
    of the wall is where that identifier belongs.
    """
    conversation, level = _open(db, conversation_id, admin, write=False, action="read")
    _audit_supervised_read(admin, conversation, level, "calls")
    rows = call_service.history(db, conversation_id, limit=limit, before_id=before_id)
    return CallHistoryResponse(
        calls=[CallResponse.model_validate(c) for c in rows],
        next_before_id=rows[-1].call_id if len(rows) == limit else None,
    )


@router.get(
    "/conversations/{conversation_id}/context",
    summary="Who this customer is and what they have booked",
)
def conversation_context(
    conversation_id: int,
    admin: User = Depends(get_current_b2c_admin),
    db: Session = Depends(get_db),
):
    """The panel that stops an agent asking for a booking reference.

    Scoped by looking the CONVERSATION up first and reading its customer_id,
    never by taking a customer id from the caller. An agent may open any
    conversation, so this is not a privacy boundary between agents — but it does
    mean the endpoint cannot be used to enumerate customers who have no
    conversation at all, which is a different and worthwhile limit.

    Read-only, and derived entirely from tables that already exist.
    """
    conversation, level = _open(db, conversation_id, admin, write=False, action="read")
    _audit_supervised_read(admin, conversation, level, "context")
    return chat_context_service.for_customer(db, conversation.customer_id)


@router.get("/agents", summary="Who a chat can be transferred to")
def agents(admin: User = Depends(get_current_b2c_admin), db: Session = Depends(get_db)):
    """Every eligible agent — the set a conversation may be transferred to.

    `chat_access.eligible_agents` (Phase 13, X4): ACTIVE super admins and admins
    holding `b2c.chat.manage`, the SAME rule that opens the console, so a chat
    cannot be handed to somebody who then gets a 403.
    """
    eligible = {uid for uid, _name, _sup in chat_access.eligible_agents(db)}
    rows = [u for u in db.execute(select(User).where(User.user_id.in_(eligible))
                                  .order_by(User.full_name)).scalars()] if eligible else []
    return [
        {
            "admin_id": u.user_id,
            "full_name": u.full_name,
            "role": u.role.value if hasattr(u.role, "value") else str(u.role),
        }
        for u in rows
    ]


@router.get("/analytics", summary="Queue depth and response times")
def analytics(admin: User = Depends(get_current_b2c_admin), db: Session = Depends(get_db)):
    """Derived from the conversation rows, with no metrics table behind it.

    A separate metrics table would need to be written on every transition and
    would drift from the thing it describes the first time a write was missed.
    These numbers are the conversations themselves, counted.
    """
    counts = chat.counts_by_status(db)
    return {
        "counts": counts,
        "waiting": counts.get("waiting", 0),
        "open": counts.get("waiting", 0) + counts.get("active", 0),
    }


@router.post("/ws-ticket", summary="A one-time ticket for the agent WebSocket")
@limiter.limit("60/minute")
async def ws_ticket(request: Request, admin: User = Depends(get_current_b2c_admin)):
    broker = get_broker()
    ticket = await broker.issue_ticket(f"admin:{admin.user_id}")
    return {"ticket": ticket, "expires_in": settings.chat_ticket_ttl_seconds}


@router.websocket("/ws")
async def agent_socket(websocket: WebSocket, ticket: str = Query(default="")):
    await chat_gateway.serve_agent(websocket, ticket)
