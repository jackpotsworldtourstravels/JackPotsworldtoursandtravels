"""Live Support, agent side — ``/api/admin/chat/*`` (CR-9, slice 4).

The customer side is scoped by the caller's own id; this side is not, and cannot
be: an agent's whole job is reading other people's conversations. So the gate is
``Depends(get_current_admin)`` on every route, and the queue is deliberately
visible to any admin rather than only to the assignee — a chat nobody can see is
a chat nobody answers when its owner goes home.

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
    APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile,
    WebSocket, status,
)
from pydantic import BaseModel, Field
from sqlalchemy import or_, select, union_all
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.auth.rate_limit import limiter
from app.config import settings
from app.database.session import get_db
from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerConversation,
    CustomerHotelBooking,
    CustomerPackageBooking,
)
from app.models_v2 import User
from app.schemas.customer_chat import ChatMessageResponse
from app.services import chat_attachments as attachments
from app.services import chat_gateway, customer_chat_service as chat
from app.services import document_service
from app.services.chat_broker import get_broker

router = APIRouter(prefix="/api/admin/chat", tags=["admin-chat"])


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


def _row(conversation: CustomerConversation, customer: Customer | None) -> QueueRow:
    return QueueRow(
        conversation_id=conversation.conversation_id,
        customer_id=conversation.customer_id,
        customer_name=customer.full_name if customer else None,
        customer_email=customer.email if customer else None,
        customer_mobile=customer.mobile if customer else None,
        status=conversation.status,
        assigned_admin_id=conversation.assigned_admin_id,
        assigned_admin_name=conversation.assigned_admin_name,
        last_message=conversation.last_message,
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
    admin: User = Depends(get_current_admin),
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
    if status_filter:
        stmt = stmt.where(CustomerConversation.status == status_filter)
    if mine:
        stmt = stmt.where(CustomerConversation.assigned_admin_id == admin.user_id)
    if q:
        term = q.strip()
        clauses = [
            Customer.full_name.ilike(f"%{term}%"),
            Customer.email.ilike(f"%{term}%"),
            Customer.mobile.ilike(f"%{term}%"),
            Customer.customer_code.ilike(f"%{term}%"),
        ]
        # A bare number is almost always a conversation id an agent has been
        # given, so it is matched as one as well as as a phone fragment.
        if term.isdigit():
            clauses.append(CustomerConversation.conversation_id == int(term))
        # BOOKING REFERENCE. The single most common thing a customer opens with
        # is "about booking JWT12345", and until now the agent had to look that
        # up in another screen to find out whose chat to open. Matched across
        # all three booking products plus the airline PNR, because the customer
        # does not know or care which of our tables their trip lives in.
        clauses.append(CustomerConversation.customer_id.in_(_booking_owners(term)))
        stmt = stmt.where(or_(*clauses))

    stmt = stmt.order_by(
        CustomerConversation.last_message_at.desc().nullslast(),
        CustomerConversation.conversation_id.desc(),
    )
    rows = db.execute(stmt.limit(limit).offset(offset)).all()
    return QueueResponse(
        counts=chat.counts_by_status(db),
        conversations=[_row(conversation, customer) for conversation, customer in rows],
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
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    try:
        conversation = chat.get_for_admin(db, conversation_id)
    except chat.ChatNotFound:
        raise _not_found()
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
    admin: User = Depends(get_current_admin),
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
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    try:
        conversation = chat.get_for_admin(db, conversation_id)
    except chat.ChatNotFound:
        raise _not_found()
    target = db.get(User, payload.to_admin_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No such agent")
    chat.transfer(
        db, conversation, admin_id=target.user_id, admin_name=target.full_name,
    )
    db.commit()
    return _row(conversation, db.get(Customer, conversation.customer_id))


@router.post("/conversations/{conversation_id}/status", summary="Resolve, close or reopen")
def set_status(
    conversation_id: int,
    payload: StatusRequest,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    try:
        conversation = chat.get_for_admin(db, conversation_id)
    except chat.ChatNotFound:
        raise _not_found()
    try:
        chat.set_status(db, conversation, payload.status, actor=admin.full_name)
    except chat.ChatError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
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
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Write and PUBLISH.

    The publish is the half that is easy to forget: without it the message is
    stored and the customer sees nothing until they reload, which is exactly the
    failure this whole CR exists to remove. `publish_admin_message` is the one
    place that knows the envelope, so REST replies and socket replies produce
    identical frames.
    """
    try:
        conversation = chat.get_for_admin(db, conversation_id)
    except chat.ChatNotFound:
        raise _not_found()
    try:
        message = chat.post_admin_message(
            db, conversation,
            admin_id=admin.user_id, admin_name=admin.full_name,
            body=payload.body, is_internal=payload.is_internal,
        )
    except chat.ChatError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    db.commit()
    await chat_gateway.publish_admin_message(
        conversation_id, message, internal=payload.is_internal,
    )
    return ChatMessageResponse.model_validate(message)


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
    admin: User = Depends(get_current_admin),
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
        raise _not_found()
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
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    attachments.record(db, message, stored)
    body = ChatMessageResponse.model_validate(message)
    db.commit()

    await chat_gateway.publish_admin_message(conversation_id, message, internal=is_internal)
    return body


@router.get(
    "/attachments/{attachment_id}",
    summary="Download any conversation's file",
)
def download_attachment(
    attachment_id: int,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Unscoped by conversation — reading other people's threads is the job.

    The role gate on this route is therefore the only thing between a customer
    token and every file in the system, which is why `verify_live_chat.py`
    checks the refusal before it checks anything this endpoint returns.
    """
    try:
        attachment = chat.attachment_for_admin(db, attachment_id)
    except chat.ChatNotFound:
        raise _not_found()
    return attachments.download(attachment)


@router.post("/conversations/{conversation_id}/read", summary="Mark the customer's messages read")
def mark_read(
    conversation_id: int,
    up_to_message_id: int = Query(...),
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    try:
        conversation = chat.get_for_admin(db, conversation_id)
    except chat.ChatNotFound:
        raise _not_found()
    marked = chat.mark_read(
        db, conversation, reader="admin", up_to_message_id=up_to_message_id,
    )
    db.commit()
    return {"marked": marked, "unread_count": conversation.admin_unread_count}


# ---------------------------------------------------------------------------
# Agents, analytics, real time
# ---------------------------------------------------------------------------
@router.get("/agents", summary="Who a chat can be transferred to")
def agents(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Every active admin — the set a conversation may be transferred to.

    Filtered in SQL by `_ADMIN_ROLES`, the SAME tuple `get_current_admin` gates
    on. Reusing it rather than restating the roles here means the list of people
    a chat can be handed to cannot drift from the list of people allowed to open
    one, which is the sort of divergence that ends with a transfer to somebody
    who then gets a 403.
    """
    from app.auth.deps import _ADMIN_ROLES
    from app.models_v2 import UserStatus

    rows = db.execute(
        select(User)
        .where(User.status == UserStatus.ACTIVE, User.role.in_(_ADMIN_ROLES))
        .order_by(User.full_name)
    ).scalars()
    return [
        {
            "admin_id": u.user_id,
            "full_name": u.full_name,
            "role": u.role.value if hasattr(u.role, "value") else str(u.role),
        }
        for u in rows
    ]


@router.get("/analytics", summary="Queue depth and response times")
def analytics(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
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
async def ws_ticket(request: Request, admin: User = Depends(get_current_admin)):
    broker = get_broker()
    ticket = await broker.issue_ticket(f"admin:{admin.user_id}")
    return {"ticket": ticket, "expires_in": settings.chat_ticket_ttl_seconds}


@router.websocket("/ws")
async def agent_socket(websocket: WebSocket, ticket: str = Query(default="")):
    await chat_gateway.serve_agent(websocket, ticket)
