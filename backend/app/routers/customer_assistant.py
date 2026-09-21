"""Travel Assistant — ``/api/customer/assistant/*``.

    POST /message            say something, get an answer and a screen to open
    GET  /messages           the conversation so far
    POST /claim              attach a guest conversation to the account

OPEN TO GUESTS, BY DESIGN. The assistant answers a visitor who has never
signed in — that is most of the landing page's traffic — so the customer token
is optional here. What identifies a conversation is the random `session_id` the
first reply hands out, which the browser keeps; signing in later claims it.

WHY IT CANNOT LEAK A CONVERSATION. Once a session belongs to an account, the
service refuses it to any other caller, signed in or not — so a copied
`session_id` stops working the moment its owner signs in, and an unclaimed one
holds nothing but what that same browser typed.

NOTHING HERE READS BUSINESS DATA. The reply is words plus an `action`; the
browser then opens the existing search screens under its own session, which
enforce their own rules. The assistant cannot see a fare, a room or a booking,
so it cannot leak one.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer, get_current_customer_optional
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.models_customer import Customer
from app.schemas.customer_assistant import (
    AssistantClaimRequest,
    AssistantClaimResponse,
    AssistantHistoryResponse,
    AssistantMessageRequest,
    AssistantMessageResponse,
)
from app.services import customer_assistant_service as assistant

router = APIRouter(prefix="/api/customer/assistant", tags=["customer-assistant"])


@router.post(
    "/message",
    response_model=AssistantMessageResponse,
    summary="Say something to the Travel Assistant",
    description=(
        "Public — a signed-in customer's token is used when present, and a guest is served "
        "just the same. Returns the reply, the intent it was understood as, an `action` "
        "naming the screen to open (`search_flights`, `search_hotels`, `hotels_near`, "
        "`search_packages`, `open_destination`, `open_support`, `open_bookings`, or `none`), "
        "and the `entities` read out of the sentence — origin, destination, date, passengers "
        "and trip type, each null when it was not said.\n\n"
        "**A route is a flight.** \"From Hyderabad to Colombo\" names no product at all, and "
        "two ends with a direction is what a flight is, so it opens the flight search rather "
        "than the holiday shelf — and it does so for a city the destinations catalogue has "
        "never heard of, because the route is read from the shape of the sentence. A product "
        "the traveller actually named still wins: a package with a route inside it is a "
        "package.\n\n"
        "**One place is not a route.** \"I want to visit Goa\" names where somebody is going "
        "and nothing else, so it opens the HOTEL search — not flights, which would be half a "
        "route, and not the holiday shelf, which is reached by asking for a package. A "
        "country (\"hotels in India\") is answered with the cities we cover in it, because no "
        "hotel's address is the word India and an empty results page is not an answer.\n\n"
        "**It never quotes a price or claims availability** — it understands the request and "
        "opens the search that holds the real answer. Rate-limited to 20/minute per IP, and a "
        "message is capped at 500 characters."
    ),
)
@limiter.limit("20/minute")
def send_message(
    request: Request,
    payload: AssistantMessageRequest,
    db: Session = Depends(get_db),
    customer: Customer | None = Depends(get_current_customer_optional),
):
    return assistant.process_message(
        db,
        session_key=payload.session_id,
        message=payload.message,
        customer=customer,
        kind=payload.kind or "assistant",
    )


@router.get(
    "/messages",
    response_model=AssistantHistoryResponse,
    summary="The conversation so far",
    description=(
        "Public, with the same ownership rule as /message: a conversation that belongs to an "
        "account is returned only to that account. An unknown or foreign `session_id` is a 404 "
        "rather than an empty list — those are different answers."
    ),
    responses={404: {"description": "No such conversation, or it belongs to someone else."}},
)
@limiter.limit("60/minute")
def get_messages(
    request: Request,
    session_id: str = Query(max_length=64),
    db: Session = Depends(get_db),
    customer: Customer | None = Depends(get_current_customer_optional),
):
    rows = assistant.history(db, session_id, customer)
    if rows is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No such conversation.",
        )
    return {"session_id": session_id, "messages": rows}


@router.post(
    "/claim",
    response_model=AssistantClaimResponse,
    summary="Keep a guest conversation after signing in",
    description=(
        "Requires a customer session. Attaches a conversation started while signed out to the "
        "account, so it continues instead of restarting. Nothing is copied — the rows already "
        "exist and this names their owner. A conversation already owned by another account is "
        "left alone and reported as `claimed: false`."
    ),
)
@limiter.limit("20/minute")
def claim_session(
    request: Request,
    payload: AssistantClaimRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return {"claimed": assistant.claim(db, payload.session_id, customer)}
