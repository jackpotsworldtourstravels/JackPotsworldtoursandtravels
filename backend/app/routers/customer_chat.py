"""Live chat, customer side — ``/api/customer/chat/*`` (CR-9, migration 0064).

Every route resolves the caller through ``Depends(get_current_customer)``. There
is no customer id in any path or body, so there is nothing for one customer to
change in order to reach another's conversation — the same rule
``customer_account.py`` states and for the same reason.

WHY THERE IS NO ``POST /conversation``
Opening the chat is a GET that creates on demand. A create endpoint would be a
second way to reach the same state, and the two would eventually disagree about
which conversation is "the" conversation. ``GET /conversation`` never 404s and
never needs a body: that is what makes Support Center open straight into a chat
with no form in front of it, which is the entire point of CR-9.

SLICE 2 IS DELIBERATELY SOCKET-LESS. These endpoints are the complete
send/receive path on their own. Slice 3 adds a WebSocket that calls the same
service functions and publishes the same schemas; it does not replace this,
because a client whose socket is down must still be able to send — and because
a REST path that is exercised by the test suite is how the socket's behaviour
gets something to be checked against.
"""
from fastapi import (
    APIRouter, Depends, HTTPException, Query, Request, WebSocket, status,
)
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.config import settings
from app.models_customer import Customer, CustomerChatMessage
from app.schemas.customer_chat import (
    ChatMessageResponse,
    ConversationOpenResponse,
    ConversationResponse,
    MarkReadRequest,
    MarkReadResponse,
    MessageCreate,
    MessageSendResponse,
)
from app.services import chat_gateway, customer_chat_service as chat
from app.services.chat_broker import get_broker

router = APIRouter(prefix="/api/customer/chat", tags=["customer-chat"])

#: How many messages the widget opens with. Enough to fill a tall panel without
#: making the first paint wait on a hundred rows.
OPEN_PAGE_SIZE = 30


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")


@router.get(
    "/conversation",
    response_model=ConversationOpenResponse,
    summary="Open the chat (creates one on first use)",
)
def open_conversation(
    customer: Customer = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    """The live conversation and its newest page. Never 404s."""
    conversation = chat.get_or_create_conversation(db, customer.customer_id)
    messages = chat.list_messages(
        db, conversation, include_internal=False, limit=OPEN_PAGE_SIZE,
    )
    db.commit()
    return ConversationOpenResponse(
        conversation=ConversationResponse.for_customer(conversation),
        messages=[ChatMessageResponse.for_customer(m) for m in messages],
    )


@router.get(
    "/messages",
    response_model=list[ChatMessageResponse],
    summary="History page, or the reconnect gap",
)
def list_messages(
    before_id: int | None = Query(
        default=None, description="Page backwards through history (scroll up)."
    ),
    after_id: int | None = Query(
        default=None,
        description="Everything since this id — what a reconnecting client asks for.",
    ),
    limit: int = Query(default=OPEN_PAGE_SIZE, ge=1, le=100),
    customer: Customer = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    if before_id is not None and after_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pass before_id or after_id, not both",
        )
    conversation = chat.get_or_create_conversation(db, customer.customer_id)
    messages = chat.list_messages(
        db, conversation, include_internal=False,
        before_id=before_id, after_id=after_id, limit=limit,
    )
    db.commit()
    return [ChatMessageResponse.for_customer(m) for m in messages]


@router.post(
    "/messages",
    response_model=MessageSendResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Send a message",
)
#: 30/minute is a fast typist's ceiling, not a throttle anyone will meet in
#: normal use. It exists so a scripted client cannot fill the agent queue —
#: `slowapi` keys on the remote address, so this is the crude outer bound; the
#: per-conversation flood cap in the service layer is the sharper one.
@limiter.limit("30/minute")
def send_message(
    request: Request,
    payload: MessageCreate,
    customer: Customer = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    conversation = chat.get_or_create_conversation(db, customer.customer_id)
    try:
        message, created = chat.post_customer_message(
            db, conversation,
            body=payload.body,
            client_msg_id=payload.client_msg_id,
        )
    except chat.ChatError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    db.commit()
    return MessageSendResponse(
        message=ChatMessageResponse.for_customer(message), created=created,
    )


@router.post("/read", response_model=MarkReadResponse, summary="Mark support's messages read")
def mark_read(
    payload: MarkReadRequest,
    customer: Customer = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    conversation = chat.get_or_create_conversation(db, customer.customer_id)
    marked = chat.mark_read(
        db, conversation, reader="customer", up_to_message_id=payload.up_to_message_id,
    )
    db.commit()
    return MarkReadResponse(marked=marked, unread_count=conversation.customer_unread_count)


@router.delete(
    "/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete one of my own messages",
)
def delete_message(
    message_id: int,
    customer: Customer = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    """Soft delete. The row survives as a tombstone — see the service layer.

    The ownership check is the service's, and it raises ChatNotFound for a
    message belonging to someone else rather than 403, so this endpoint cannot
    be used to discover which message ids exist.
    """
    message = db.get(CustomerChatMessage, message_id)
    if message is None:
        raise _not_found()
    try:
        chat.soft_delete_message(db, message, by_customer_id=customer.customer_id)
    except chat.ChatNotFound:
        raise _not_found()
    except chat.ChatError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    db.commit()
    return None


# ---------------------------------------------------------------------------
# Real time (slice 3)
# ---------------------------------------------------------------------------
@router.post("/ws-ticket", summary="A one-time ticket for the WebSocket handshake")
@limiter.limit("30/minute")
async def ws_ticket(
    request: Request,
    customer: Customer = Depends(get_current_customer),
):
    """Exchange the bearer token for a short-lived, single-use ticket.

    WHY THIS EXISTS AT ALL. The browser `WebSocket` constructor cannot set an
    `Authorization` header — that is a limitation of the API, not an oversight.
    The two usual workarounds are both worse than this one:

      * token in the query string  — lands in Caddy's access log, in any proxy
        in between, and in the browser's own history.
      * cookie                     — this API is bearer-authenticated and has no
        CSRF machinery; adding ambient authority for one feature would weaken
        every other endpoint.

    So the token is exchanged over ordinary authenticated HTTPS for a ticket
    that is random, expires in 60 seconds, and is destroyed by the first socket
    that presents it (see `redeem_ticket`).
    """
    broker = get_broker()
    ticket = await broker.issue_ticket(customer.customer_id)
    return {"ticket": ticket, "expires_in": settings.chat_ticket_ttl_seconds}


@router.websocket("/ws")
async def chat_socket(websocket: WebSocket, ticket: str = Query(default="")):
    """The live channel.

    No `Depends(get_current_customer)`: dependencies that raise HTTPException
    cannot answer a WebSocket handshake, and the ticket is the credential here
    anyway. `serve_customer` closes with 4401 when it is missing or spent.
    """
    await chat_gateway.serve_customer(websocket, ticket)
