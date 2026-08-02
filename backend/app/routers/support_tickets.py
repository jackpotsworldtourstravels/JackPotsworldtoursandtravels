"""Support Management / Live Chat endpoints.

The file name predates this redesign; see app/services/chat_service.py for
why "Support Management" and "Live Chat" are one feature (chat threads) with
two views rather than two separate systems.

Endpoint shape, shared by both portals with permission-gated behaviour:

    POST /api/support/threads              open a chat        (merchant)
    GET  /api/support/threads              list threads        (scoped by role)
    GET  /api/support/threads/{id}         thread + messages   (scoped by role)
    POST /api/support/threads/{id}/messages  send a message    (either side)
    POST /api/support/threads/{id}/documents attach a file     (either side)
    GET  /api/support/threads/{id}/documents files on a thread (scoped by role)
    POST /api/support/threads/{id}/claim    claim (queue -> in progress)  (admin)
    POST /api/support/threads/{id}/resolve  resolve & close     (admin)
    POST /api/support/threads/{id}/reopen   reopen within the window (merchant)
    PATCH /api/support/threads/{id}/triage  priority / category (admin)
    GET  /api/support/threads/{id}/notes    internal notes      (admin)
    POST /api/support/threads/{id}/notes    add a note          (admin)

FILE BYTES ARE NOT SERVED FROM HERE. An attachment is a ``request_documents``
row, so it downloads through the existing ``GET /api/documents/{id}/download``,
which re-checks merchant scope on every read and streams as an attachment. A
second download path for chat would have been a second place to get that wrong.
"""
from fastapi import APIRouter, Depends, File, Query, UploadFile
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import Priority, RequestStatus, User
from app.schemas.pagination import Page
from app.schemas.support_ticket import (
    AddNoteRequest,
    Category,
    ChatDocumentResponse,
    ChatMessageResponse,
    ChatNoteResponse,
    ChatThreadDetailResponse,
    ChatThreadResponse,
    OpenChatRequest,
    SendMessageRequest,
    TriageRequest,
)
from app.services import chat_service

router = APIRouter(prefix="/api/support", tags=["support / live chat"])


def _user_name(db: Session, user_id: int | None) -> str | None:
    if not user_id:
        return None
    user = db.get(User, user_id)
    return user.full_name if user else None


def _documents(db: Session, thread) -> list[ChatDocumentResponse]:
    """Files on a thread, each tagged with which side shared it.

    ``is_staff`` is resolved from the uploader rather than stored, so it stays
    correct if a user's role changes; the alternative was denormalising a
    boolean onto request_documents for one screen.
    """
    out = []
    for d in chat_service.list_documents(db, thread):
        uploader = db.get(User, d.uploaded_by) if d.uploaded_by else None
        out.append(
            ChatDocumentResponse.of(
                d,
                uploader=uploader.full_name if uploader else None,
                is_staff=bool(uploader and uploader.is_platform_staff),
            )
        )
    return out


def _thread_response(db: Session, thread, messages, documents) -> ChatThreadResponse:
    return ChatThreadResponse.of(
        thread,
        message_count=len(messages),
        last_message_at=messages[-1].created_at if messages else None,
        attachment_count=len(documents),
        assigned_admin_name=_user_name(db, thread.assigned_admin),
        can_reopen=chat_service.can_reopen(thread),
    )


def _detail(db: Session, thread) -> ChatThreadDetailResponse:
    messages = chat_service.list_messages(db, thread)
    documents = _documents(db, thread)
    return ChatThreadDetailResponse(
        thread=_thread_response(db, thread, messages, documents),
        messages=[ChatMessageResponse.of(m) for m in messages],
        documents=documents,
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
    thread = chat_service.open_thread(
        db, current_user, payload.subject, payload.message,
        category=payload.category,
        priority=payload.priority,
        related_request_id=payload.related_request_id,
    )
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
    category: Category | None = None,
    priority: Priority | None = None,
    q: str | None = Query(
        None,
        max_length=200,
        description="Matches the subject, the reference, or the text of any message in the thread.",
    ),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_VIEW)),
):
    threads, total = chat_service.list_threads(
        db, current_user, thread_status=status, category=category, priority=priority,
        search=q, page=page, page_size=page_size,
    )
    items = []
    for t in threads:
        messages = chat_service.list_messages(db, t)
        items.append(
            ChatThreadResponse.of(
                t, message_count=len(messages),
                last_message_at=messages[-1].created_at if messages else None,
                attachment_count=len(chat_service.list_documents(db, t)),
                assigned_admin_name=_user_name(db, t.assigned_admin),
                can_reopen=chat_service.can_reopen(t),
            )
        )
    return Page.build(items, total, page, page_size)


@router.get(
    "/threads/{thread_id}",
    response_model=ChatThreadDetailResponse,
    summary="Get a chat thread with its messages",
    description=(
        "Requires `chat.view`. 404s for a thread belonging to another merchant. "
        "Opening a thread marks the **other** side's messages read, which is what drives the "
        "delivered/read receipt — except for a Super Admin, whose role is visibility without "
        "participation and whose reading therefore must not tell a merchant the desk has "
        "answered."
    ),
)
def get_thread(
    thread_id: int,
    mark_read: bool = Query(
        True,
        description=(
            "Whether this read counts as the reader having seen the conversation. Pass `false` "
            "for a background fetch — the merchant portal samples recent threads to measure its "
            "average-reply tile, and those must not tell the desk a merchant opened something "
            "it never looked at."
        ),
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_VIEW)),
):
    thread = chat_service.get_thread(db, current_user, thread_id)
    # A read receipt is a claim that someone who can act on the message saw it.
    # Super Admin holds chat.view alone and cannot reply, so its read must not
    # light up the merchant's second tick.
    if mark_read and chat_service.may_participate(current_user):
        chat_service.mark_thread_read(db, current_user, thread)
    return _detail(db, thread)


@router.post(
    "/threads/{thread_id}/reopen",
    response_model=ChatThreadResponse,
    summary="Reopen a resolved conversation",
    description=(
        "Requires `chat.create`. Returns a resolved thread to the unclaimed queue, within "
        f"{chat_service.REOPEN_WINDOW_DAYS} days of it being resolved — 409 afterwards, when a "
        "new conversation is the honest way to continue. `can_reopen` on the thread payload "
        "says whether this will succeed."
    ),
)
def reopen_thread(
    thread_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_CREATE)),
):
    thread = chat_service.reopen_thread(db, current_user, thread_id)
    return ChatThreadResponse.of(thread, can_reopen=False)


@router.patch(
    "/threads/{thread_id}/triage",
    response_model=ChatThreadResponse,
    summary="Set a thread's priority and category",
    description=(
        "Requires `chat.manage`. Triage is the desk's judgement — the merchant supplies a "
        "starting priority when it opens the thread and this overrules it. Omitted fields are "
        "left alone, so setting priority cannot silently clear a category."
    ),
)
def triage_thread(
    thread_id: int,
    payload: TriageRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_MANAGE)),
):
    thread = chat_service.set_triage(
        db, current_user, thread_id, priority=payload.priority, category=payload.category
    )
    return ChatThreadResponse.of(
        thread,
        assigned_admin_name=_user_name(db, thread.assigned_admin),
        can_reopen=chat_service.can_reopen(thread),
    )


@router.get(
    "/threads/{thread_id}/documents",
    response_model=list[ChatDocumentResponse],
    summary="Files shared on a conversation",
    description=(
        "Requires `chat.view`. Metadata only — bytes come from "
        "`GET /api/documents/{id}/download`, which re-checks merchant scope on every read."
    ),
)
def list_thread_documents(
    thread_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_VIEW)),
):
    thread = chat_service.get_thread(db, current_user, thread_id)
    return _documents(db, thread)


@router.post(
    "/threads/{thread_id}/documents",
    response_model=ChatThreadDetailResponse,
    status_code=201,
    summary="Share a file on a conversation",
    description=(
        "Merchant side requires `chat.create`; admin side requires `chat.manage` — the same gate "
        "as sending a message, because an attachment is part of one. Multipart upload of a PDF, "
        "JPEG, PNG or WebP, size-capped and signature-checked against the file's actual leading "
        "bytes by the same code path that handles passport scans. Posts a line into the "
        "transcript so the file is visible in the conversation, not just in a sidebar. "
        "**There is no delete** — a file sent to the desk is part of the support record."
    ),
)
def upload_thread_document(
    thread_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_CREATE, P.CHAT_MANAGE)),
):
    chat_service.attach_document(db, current_user, thread_id, file)
    thread = chat_service.get_thread(db, current_user, thread_id)
    return _detail(db, thread)


@router.get(
    "/threads/{thread_id}/notes",
    response_model=list[ChatNoteResponse],
    summary="Internal notes on a conversation",
    description=(
        "Requires `chat.manage` **and** a platform-staff account. Staff-only: these are the "
        "desk's working notes and no merchant-facing response embeds them. Newest first."
    ),
)
def list_thread_notes(
    thread_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_MANAGE)),
):
    notes = chat_service.list_notes(db, current_user, thread_id)
    return [ChatNoteResponse.of(n, author=_user_name(db, n.author_id)) for n in notes]


@router.post(
    "/threads/{thread_id}/notes",
    response_model=ChatNoteResponse,
    status_code=201,
    summary="Add an internal note",
    description=(
        "Requires `chat.manage` and a platform-staff account. The note is never shown to the "
        "merchant and its body is deliberately kept out of the activity feed, which is read in "
        "places the note is not."
    ),
)
def add_thread_note(
    thread_id: int,
    payload: AddNoteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.CHAT_MANAGE)),
):
    note = chat_service.add_note(db, current_user, thread_id, payload.body)
    return ChatNoteResponse.of(note, author=_user_name(db, note.author_id))


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
