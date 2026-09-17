"""Invoice and booking-confirmation PDFs.

WHY THE INVOICE IS GENERATED AND THE TICKET IS UPLOADED
They come from different places and the split is deliberate:

* The **invoice** is *our* document. Every figure on it already lives in this
  database — the booking, its passengers, its payments — so it is rendered on
  demand from those rows. Storing a generated copy would create a second source
  of truth that could disagree with the ledger after a refund.
* The **ticket** is the *airline's* document. The platform cannot manufacture a
  valid e-ticket, so the operations desk uploads the real one and it is served
  back through ``document_service``. What this module offers alongside it is a
  booking *confirmation* — a human-readable summary of what was booked, clearly
  not a substitute for the airline's ticket.

Both render through ``reportlab``, already a dependency for report exports.
"""
import datetime
import io
from decimal import Decimal

from fastapi import HTTPException, status as http_status
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy.orm import Session

from app.models_v2 import (
    DocumentType,
    PaymentStatus,
    PaymentType,
    RequestSource,
    RequestStatus as S,
    RequestDocument,
    RequestType,
    ServiceRequest,
    TravelType,
    User,
)
from app.services import invoice_layout, ticket_service

#: Matches the portals' navy/orange so a printed invoice looks like the product.
NAVY = colors.HexColor("#0A2E52")
BORDER = colors.HexColor("#CBD5E1")
MUTED = colors.HexColor("#5A6B80")

#: An invoice exists once the booking has been ticketed — that is when
#: ``issue_ticket`` allocates the invoice number, and billing for a booking that
#: might still be rejected would be wrong.
INVOICEABLE: frozenset[S] = frozenset({S.TICKET_ISSUED, S.COMPLETED})


def _styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("t", parent=base["Heading1"], fontSize=18, textColor=NAVY, spaceAfter=2),
        "sub": ParagraphStyle("s", parent=base["Normal"], fontSize=9, textColor=MUTED),
        "h": ParagraphStyle("h", parent=base["Heading2"], fontSize=11, textColor=NAVY, spaceBefore=10, spaceAfter=4),
        "n": ParagraphStyle("n", parent=base["Normal"], fontSize=9),
        # For markup inside a table cell — matches _grid's own font size so a
        # wrapped description sits on the same baseline as its neighbours.
        "cell": ParagraphStyle("c", parent=base["Normal"], fontSize=8, leading=10),
        "small": ParagraphStyle("sm", parent=base["Normal"], fontSize=7.5, textColor=MUTED),
    }


def _kv_table(rows: list[tuple[str, str]], widths=(38 * mm, 62 * mm)) -> Table:
    t = Table([[k, v or "—"] for k, v in rows], colWidths=widths)
    t.setStyle(
        TableStyle([
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("TEXTCOLOR", (0, 0), (0, -1), MUTED),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 1),
            ("LEFTPADDING", (0, 0), (0, -1), 0),
        ])
    )
    return t


def _grid(header: list[str], body: list[list[str]], widths) -> Table:
    t = Table([header] + body, colWidths=widths, repeatRows=1)
    t.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.4, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F4F6FA")]),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ])
    )
    return t


def _sector(request: ServiceRequest) -> str:
    d = request.travel_details or {}
    origin = d.get("origin_city") or d.get("origin") or ""
    dest = d.get("destination_city") or d.get("destination") or ""
    return f"{origin} → {dest}" if (origin or dest) else (request.title or "—")


def _flight_label(details: dict) -> str:
    """"IndiGo 6E217", "IndiGo", "6E217", or "" — whatever was actually stated.

    Both keys are optional as of 2026-08-05: an OPEN enquiry names no carrier
    and asks the desk to quote the best available, and a merchant may name a
    carrier without a service. Both are stored PRESENT AND NULL, which is the
    trap this exists to close — ``details.get("airline", "")`` returns ``None``
    for a key that exists with a null value, and an f-string then prints the
    word "None" onto an invoice a merchant sends to its own customer.
    """
    parts = [
        (details.get("airline") or "").strip(),
        (details.get("flight_number") or "").strip(),
    ]
    return " ".join(p for p in parts if p)


def _hotel_label(details: dict) -> str:
    """"Taj Exotica 5★", "Taj Exotica", "5★", or "" — Hotel's ``_flight_label``.

    Same trap, same fix: ``hotel_name`` and ``star_category`` are both
    optional-but-present-as-null on some rows, so ``or ""`` guards each one
    individually rather than defaulting the whole expression.
    """
    parts = [
        (details.get("hotel_name") or "").strip(),
        (f"{details['star_category']}★" if details.get("star_category") else ""),
    ]
    return " ".join(p for p in parts if p)


def _header(story, styles, heading: str, request: ServiceRequest, merchant):
    story.append(Paragraph("JackPots World Tours &amp; Travels", styles["title"]))
    story.append(Paragraph("B2B travel bookings", styles["sub"]))
    story.append(Spacer(1, 8))
    story.append(Paragraph(heading, styles["h"]))

    billed = [merchant.company_name if merchant else "—"]
    if merchant:
        if merchant.address:
            billed.append(merchant.address)
        locality = ", ".join(x for x in (merchant.city, merchant.country) if x)
        if locality:
            billed.append(locality)
        billed.append(merchant.email)
    left = Paragraph("<br/>".join(x for x in billed if x), styles["n"])
    return left


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------
def _is_manual_booking(request: ServiceRequest) -> bool:
    """A booking the desk typed up in Admin -> Manual Booking.

    It is the one kind of booking that is finished while still at ``draft``:
    Manual Request saves the record of a ticket the desk already arranged and
    deliberately enters no workflow, so it never reaches ``ticket_issued``. See
    ``manager_service._classic_bookings_filter``, which excludes the same rows
    from the Manager's queue on the same column.
    """
    return (request.source is RequestSource.B2B_MANUAL_REQUEST
            and request.request_type is RequestType.BOOKING)


def _billable(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """The booking, if this actor may have its paperwork.

    Reuses ``ticket_service.get_request`` so merchant scoping is the same rule
    that governs every other read of a booking — a second scoping rule here is
    exactly how one of them ends up wrong.

    TWO WAYS TO BE INVOICEABLE, BECAUSE THERE ARE TWO KINDS OF BOOKING.

    The ordinary one reaches ``ticket_issued``, which is where ``issue_ticket``
    allocates the invoice number and bills the wallet. A MANUAL booking never
    does: it records a ticket the desk had already bought, so it is complete at
    ``draft`` and no money moves through this platform for it. Holding it to
    "has it been ticketed" would mean the desk could never invoice the one kind
    of booking it raises itself.

    The merchant's own draft is still refused. The test is on ``source``, not
    on the status — a merchant cannot set that column, and nothing but Manual
    Booking writes ``b2b_manual_request``.
    """
    request = ticket_service.get_request(db, actor, request_id)
    if request.status not in INVOICEABLE and not _is_manual_booking(request):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{request.request_number} has not been ticketed yet, so there is no "
                "invoice for it."
            ),
        )
    return request


def _ensure_invoice_number(db: Session, request: ServiceRequest) -> None:
    """Give a manual booking its invoice number, once.

    ``issue_ticket`` is where every other booking gets one — and that function
    also DEBITS THE MERCHANT'S WALLET, which must not happen for a ticket the
    desk bought off-platform. So the number is allocated here instead, from
    ``ticket_service._next_number``: the SAME PostgreSQL sequence, so a manual
    invoice cannot collide with an issued one and neither can two desks
    generating at the same moment.

    IDEMPOTENT, AND THAT IS THE WHOLE POINT. It is written once and re-read
    ever after, so pressing Generate Invoice five times yields one number, and
    Download shows the same document Generate did. Nothing else about the
    booking changes — not its status, not its wallet, not its queue.
    """
    if request.invoice_number or not _is_manual_booking(request):
        return
    request.invoice_number = ticket_service._next_number(db, "INV")
    db.commit()
    db.refresh(request)


# ---------------------------------------------------------------------------
# Invoice
# ---------------------------------------------------------------------------
def build_invoice(db: Session, actor: User, request_id: int) -> tuple[bytes, str]:
    """Render the invoice PDF. Returns ``(bytes, filename)``.

    THE PAGE ITSELF LIVES IN ``invoice_layout``. This function keeps what it
    always kept — who may ask for it, and whether the booking is far enough
    along to have one — and hands the rendering to a module that does nothing
    else. The split is what lets the layout be reworked without touching an
    access rule, which is the half that must not be got wrong.

    The layout module is also where the document's central safety rule lives:
    a value the database does not hold prints as a BLANK cell under its label,
    never as a placeholder. Read its docstring before changing anything there —
    an invented GSTIN or a guessed tax figure on a tax document is the failure
    mode that file exists to prevent.
    """
    request = _billable(db, actor, request_id)
    # Lazily, so Generate and Download are the same call and the second press
    # reuses the first press's number rather than burning another.
    _ensure_invoice_number(db, request)
    story = invoice_layout.story(request, request.merchant)
    name = request.invoice_number or request.request_number
    return _render_page(story, title=f"Invoice {name}"), f"invoice-{name}.pdf"


def _render_page(story: list, *, title: str) -> bytes:
    """Build with the invoice layout's own A4 geometry.

    Separate from ``_render`` below, which the booking confirmation still uses:
    the confirmation keeps its original margins, and the invoice's column
    widths are computed against the margins ``invoice_layout.page_setup``
    declares. Sharing one renderer would couple the two documents' page
    geometry for no reason.
    """
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, title=title, **invoice_layout.page_setup())
    doc.build(story)
    return buf.getvalue()



# ---------------------------------------------------------------------------
# Booking confirmation
# ---------------------------------------------------------------------------
def build_confirmation(db: Session, actor: User, request_id: int) -> tuple[bytes, str]:
    """A readable summary of what was booked.

    Explicitly *not* an e-ticket: it carries the PNR so a traveller can look the
    booking up with the airline, and says so on its face, because handing
    someone a platform-generated page that looks like a boarding document is how
    people get turned away at a check-in desk.
    """
    request = _billable(db, actor, request_id)
    styles = _styles()
    d = request.travel_details or {}
    is_hotel = request.travel_type is TravelType.HOTEL

    story = []
    _header(story, styles, "BOOKING CONFIRMATION", request, request.merchant)

    story.append(_kv_table([
        ("Booking ref", request.booking_reference or request.request_number),
        ("PNR", request.pnr or "—"),
        ("Ticket no.", request.ticket_number or "—"),
        ("Airline ref", d.get("airline_reference") or "—"),
        ("Status", request.status.value.replace("_", " ").title()),
    ], widths=(38 * mm, 120 * mm)))

    if is_hotel:
        story.append(Paragraph("Hotel Stay", styles["h"]))
        story.append(_kv_table([
            ("Destination", d.get("destination_city") or "—"),
            ("Hotel", _hotel_label(d) or "—"),
            ("Room type", d.get("room_type") or "—"),
            ("Meal plan", (d.get("meal_plan") or "").replace("_", " ").title() or "—"),
            ("Check-in", request.travel_date.strftime("%d %b %Y") if request.travel_date else "—"),
            ("Check-out", request.return_date.strftime("%d %b %Y") if request.return_date else "—"),
        ], widths=(38 * mm, 120 * mm)))

        story.append(Paragraph("Guests", styles["h"]))
        story.append(_grid(
            ["#", "Name", "Type", "Room", "ID Proof"],
            [[
                str(i),
                f"{(g.title + ' ') if g.title else ''}{g.first_name} {g.last_name}",
                g.guest_type.value.title(),
                f"Room {g.room_number}" + (" (Lead)" if g.is_lead_guest else ""),
                g.id_proof_number or "—",
            ] for i, g in enumerate(request.hotel_guests, start=1)],
            widths=(10 * mm, 60 * mm, 25 * mm, 40 * mm, 45 * mm),
        ))
    else:
        story.append(Paragraph("Itinerary", styles["h"]))
        story.append(_kv_table([
            ("Route", _sector(request)),
            ("Flight", _flight_label(d) or "All Airlines"),
            ("Departure", request.travel_date.strftime("%d %b %Y") if request.travel_date else "—"),
            ("Time", d.get("preferred_time") or "—"),
            ("Return", request.return_date.strftime("%d %b %Y") if request.return_date else "—"),
            ("Class", d.get("travel_class") or "—"),
        ], widths=(38 * mm, 120 * mm)))

        story.append(Paragraph("Passengers", styles["h"]))
        story.append(_grid(
            ["#", "Name", "Type", "Passport", "Expiry"],
            [[
                str(i),
                p.full_name,
                p.passenger_type.value.title(),
                p.passport_number or "—",
                p.passport_expiry.strftime("%d %b %Y") if p.passport_expiry else "—",
            ] for i, p in enumerate(request.passengers, start=1)],
            widths=(10 * mm, 70 * mm, 25 * mm, 45 * mm, 45 * mm),
        ))

    contact = d.get("contact") or {}
    if contact:
        story.append(Paragraph("Contact", styles["h"]))
        story.append(_kv_table([
            ("Name", contact.get("name") or "—"),
            ("Email", contact.get("email") or "—"),
            ("Phone", contact.get("phone") or "—"),
        ], widths=(38 * mm, 120 * mm)))

    if d.get("special_requests"):
        story.append(Paragraph("Special requests", styles["h"]))
        story.append(Paragraph(str(d["special_requests"]), styles["n"]))

    # 0040 — the merchant's own margin on this booking, on the document it is
    # most likely to keep. Only when a client fare was recorded: `saved_amount`
    # is None otherwise, and NULL means "not recorded", never "saved nothing".
    #
    # Both figures are shown, not just the saving, so a booking we billed MORE
    # for than the merchant sold at reads honestly — `saved_amount` floors at
    # zero, and a bare "You saved 0.00" beside no context would hide a loss
    # rather than state it.
    if request.saved_amount is not None:
        story.append(Paragraph("Your fare", styles["h"]))
        story.append(_kv_table([
            ("Client fare", f"{request.client_fare:,.2f}"),
            ("Booked at", f"{request.total_amount:,.2f}"),
            ("You saved", f"{request.saved_amount:,.2f}"),
        ], widths=(38 * mm, 120 * mm)))

    story.append(Spacer(1, 14))
    story.append(Paragraph(
        (
            "<b>This is a booking confirmation, not the hotel voucher.</b> Carry the issued "
            "voucher and a valid photo ID at check-in. Quote the reference above with the hotel "
            "for any change."
        ) if is_hotel else (
            "<b>This is a booking confirmation, not an airline ticket.</b> Carry the airline's own "
            "e-ticket and a valid photo ID or passport for travel. Quote the PNR above with the "
            "airline for any schedule change."
        ),
        styles["small"],
    ))

    return _render(story, title=f"Booking {request.request_number}"), \
        f"confirmation-{request.booking_reference or request.request_number}.pdf"


def _render(story: list, *, title: str) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, title=title,
        leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm, bottomMargin=14 * mm,
    )
    doc.build(story)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# The airline's own ticket
# ---------------------------------------------------------------------------
def ticket_documents(db: Session, actor: User, request_id: int) -> list[RequestDocument]:
    """E-tickets the desk has attached to this booking.

    Goes through ``ticket_service.get_request`` for scoping, so a merchant can
    only ever reach its own — the same guarantee the download endpoint re-checks
    per file.
    """
    request = ticket_service.get_request(db, actor, request_id)
    return [d for d in request.documents if d.doc_type is DocumentType.TICKET]
