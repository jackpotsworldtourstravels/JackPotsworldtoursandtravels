"""Support Management / Live Chat endpoints.

The file name predates this redesign; see app/services/chat_service.py for
why "Support Management" and "Live Chat" are one feature (chat threads) with
two views rather than two separate systems.

Endpoint shape, shared by both portals with permission-gated behaviour:

    POST /api/support/threads              open a chat        (merchant)
    GET  /api/support/threads              list threads        (scoped by role)
    GET  /api/support/threads/{id}         thread + messages   (scoped by role)
    POST /api/support/threads/{id}/messages  send a message    (either side)
    POST /api/support/threads/{id}/claim    claim (queue -> in progress)  (admin)
    POST /api/support/threads/{id}/resolve  resolve & close     (admin)
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import RequestStatus, User
from app.schemas.pagination import Page
from app.schemas.support_ticket import (
    ChatMessageResponse,
    ChatThreadDetailResponse,
    ChatThreadResponse,
    OpenChatRequest,
    SendMessageRequest,
)
from app.services import chat_service

router = APIRouter(prefix="/api/support", tags=["support / live chat"])


def _detail(db: Session, thread) -> ChatThreadDetailResponse:
    messages = chat_service.list_messages(db, thread)
    return ChatThreadDetailResponse(
        thread=ChatThreadResponse.of(
            thread,
            message_count=len(messages),
            last_message_at=messages[-1].created_at if messages else None,
        ),
        messages=[ChatMessageResponse.of(m) for m in messages],
    )


@router.post(
    "/threads",
    response_model=ChatThreadDetailResponse,
    status_code=201,
    summary="Open a chat",
    description="Requires `chat.create`. Merchant-only — opens a new thread with the first message.",
)
def open_thread(
    payload: OpenChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_CREATE)),
):
    thread = chat_service.open_thread(db, current_user, payload.subject, payload.message)
    return _detail(db, thread)


@router.get(
    "/threads",
    response_model=Page[ChatThreadResponse],
    summary="List chat threads",
    description=(
        "Requires `chat.view`. A merchant sees only its own threads; Admin and Super Admin see "
        "every merchant's — this is the Admin 'Support Management' queue."
    ),
)
def list_threads(
    status: RequestStatus | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_VIEW)),
):
    threads, total = chat_service.list_threads(
        db, current_user, thread_status=status, page=page, page_size=page_size
    )
    items = []
    for t in threads:
        messages = chat_service.list_messages(db, t)
        items.append(
            ChatThreadResponse.of(
                t, message_count=len(messages),
                last_message_at=messages[-1].created_at if messages else None,
            )
        )
    return Page.build(items, total, page, page_size)


@router.get(
    "/threads/{thread_id}",
    response_model=ChatThreadDetailResponse,
    summary="Get a chat thread with its messages",
    description="Requires `chat.view`. 404s for a thread belonging to another merchant.",
)
def get_thread(
    thread_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_VIEW)),
):
    thread = chat_service.get_thread(db, current_user, thread_id)
    return _detail(db, thread)


@router.post(
    "/threads/{thread_id}/messages",
    response_model=ChatThreadDetailResponse,
    summary="Send a message",
    description=(
        "Merchant side requires `chat.create`; admin side requires `chat.manage`. A super admin "
        "cannot send — visibility only, per the spec. An admin's first reply auto-claims the thread."
    ),
)
def send_message(
    thread_id: int,
    payload: SendMessageRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_CREATE, P.CHAT_MANAGE)),
):
    chat_service.send_message(db, current_user, thread_id, payload.message)
    thread = chat_service.get_thread(db, current_user, thread_id)
    return _detail(db, thread)


@router.post(
    "/threads/{thread_id}/claim",
    response_model=ChatThreadResponse,
    summary="Claim an open chat",
    description="Requires `chat.manage`. Moves the thread from the open queue to in progress.",
)
def claim_thread(
    thread_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_MANAGE)),
):
    thread = chat_service.claim_thread(db, current_user, thread_id)
    return ChatThreadResponse.of(thread)


@router.post(
    "/threads/{thread_id}/resolve",
    response_model=ChatThreadResponse,
    summary="Resolve and close a chat",
    description="Requires `chat.manage`. Terminal — the merchant would open a new thread to continue.",
)
def resolve_thread(
    thread_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_MANAGE)),
):
    thread = chat_service.resolve_thread(db, current_user, thread_id)
    return ChatThreadResponse.of(thread)


@router.get(
    "/unread-count",
    summary="Open threads awaiting a response",
    description="Requires `chat.view`. Drives a badge on the Support Management / Live Chat nav item.",
)
def unread_count(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_VIEW)),
):
    return {"count": chat_service.unread_thread_count(db, current_user)}
