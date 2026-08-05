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
    RequestStatus as S,
    RequestDocument,
    ServiceRequest,
    User,
)
from app.services import ticket_service

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
def _billable(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """The booking, if this actor may have its paperwork.

    Reuses ``ticket_service.get_request`` so merchant scoping is the same rule
    that governs every other read of a booking — a second scoping rule here is
    exactly how one of them ends up wrong.
    """
    request = ticket_service.get_request(db, actor, request_id)
    if request.status not in INVOICEABLE:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{request.request_number} has not been ticketed yet, so there is no "
                "invoice for it."
            ),
        )
    return request


# ---------------------------------------------------------------------------
# Invoice
# ---------------------------------------------------------------------------
def build_invoice(db: Session, actor: User, request_id: int) -> tuple[bytes, str]:
    """Render the invoice PDF. Returns ``(bytes, filename)``."""
    request = _billable(db, actor, request_id)
    merchant = request.merchant
    styles = _styles()

    story = []
    billed_to = _header(story, styles, "TAX INVOICE", request, merchant)

    meta = _kv_table([
        ("Invoice no.", request.invoice_number or "—"),
        ("Invoice date", (request.approved_at or request.created_at).strftime("%d %b %Y")),
        ("Booking ref", request.booking_reference or request.request_number),
        ("PNR", request.pnr or "—"),
        ("Ticket no.", request.ticket_number or "—"),
    ])
    top = Table([[billed_to, meta]], colWidths=(95 * mm, 100 * mm))
    top.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (0, 0), 0)]))
    story.append(Paragraph("Billed to", styles["h"]))
    story.append(top)

    story.append(Paragraph("Booking", styles["h"]))
    d = request.travel_details or {}
    # `or ''` and not `.get(k, '')`: both keys are PRESENT AND NULL on an open
    # enquiry (no carrier named), and a default only applies to a missing key —
    # so the dict form would interpolate the string "None" onto an invoice.
    flight = _flight_label(d)
    # A Paragraph, not a bare string: a plain table cell renders markup
    # literally, so the <br/> would print as the characters "<br/>".
    description = Paragraph(
        _sector(request) + (f"<br/>{flight}" if flight else ""), styles["cell"]
    )
    story.append(_grid(
        ["Description", "Travel date", "Passengers", "Amount"],
        [[
            description,
            request.travel_date.strftime("%d %b %Y") if request.travel_date else "—",
            str(len(request.passengers)),
            f"{request.total_amount:,.2f}",
        ]],
        widths=(95 * mm, 30 * mm, 25 * mm, 45 * mm),
    ))

    # Money. Refunds are netted off here rather than shown as a separate
    # document, so the invoice always states what is actually owed today.
    paid = sum(
        (p.amount for p in request.payments
         if p.payment_type is PaymentType.BOOKING_PAYMENT
         and p.payment_status is PaymentStatus.SUCCESS),
        Decimal("0"),
    )
    refunded = sum((p.refund_amount or Decimal("0") for p in request.payments), Decimal("0"))
    net_due = Decimal(request.total_amount) - paid + refunded

    totals = [
        ("Booking total", f"{request.total_amount:,.2f}"),
        ("Paid", f"-{paid:,.2f}"),
    ]
    if refunded:
        totals.append(("Refunded back", f"+{refunded:,.2f}"))
    totals.append(("Balance due", f"{net_due:,.2f}"))

    tt = Table([[k, v] for k, v in totals], colWidths=(150 * mm, 45 * mm))
    tt.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.8, NAVY),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("TEXTCOLOR", (0, -1), (-1, -1), NAVY),
        ("TOPPADDING", (0, -1), (-1, -1), 5),
    ]))
    story.append(Spacer(1, 6))
    story.append(tt)

    # 0040 — what the merchant made on this booking. Deliberately BELOW the
    # totals block and outside it: the client fare is what the merchant charged
    # *its own* customer and is not a line of this invoice, which states what we
    # billed them. Putting it inside the totals would make it look like a
    # discount we gave, and "Balance due" must be the last figure the reader
    # takes from that table.
    #
    # Rendered only when a client fare was recorded — `saved_amount` is None
    # when it was not, and "You saved 0.00" on a booking with no client fare
    # would be a claim about a number the merchant never entered.
    if request.saved_amount is not None:
        saved = Table(
            [[f"Client fare {request.client_fare:,.2f}",
              f"You saved {request.saved_amount:,.2f}"]],
            colWidths=(150 * mm, 45 * mm),
        )
        saved.setStyle(TableStyle([
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("FONTNAME", (1, 0), (1, -1), "Helvetica-Bold"),
            ("TEXTCOLOR", (0, 0), (-1, -1), NAVY),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(saved)

    if request.payments:
        story.append(Paragraph("Payments received", styles["h"]))
        story.append(_grid(
            ["Date", "Method", "Reference", "Status", "Amount"],
            [[
                (p.paid_date or p.created_at).strftime("%d %b %Y"),
                (p.payment_method or "—"),
                (p.transaction_id or "—"),
                p.payment_status.value.replace("_", " ").title(),
                f"{p.amount:,.2f}",
            ] for p in request.payments],
            widths=(28 * mm, 32 * mm, 60 * mm, 35 * mm, 40 * mm),
        ))

    story.append(Spacer(1, 14))
    story.append(Paragraph(
        f"Currency: {(request.pricing or {}).get('currency', 'INR')}. "
        "Computer-generated invoice — valid without signature. "
        f"Generated {datetime.datetime.now().strftime('%d %b %Y %H:%M')}.",
        styles["small"],
    ))

    return _render(story, title=f"Invoice {request.invoice_number}"), \
        f"invoice-{request.invoice_number or request.request_number}.pdf"


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

    story = []
    _header(story, styles, "BOOKING CONFIRMATION", request, request.merchant)

    story.append(_kv_table([
        ("Booking ref", request.booking_reference or request.request_number),
        ("PNR", request.pnr or "—"),
        ("Ticket no.", request.ticket_number or "—"),
        ("Airline ref", d.get("airline_reference") or "—"),
        ("Status", request.status.value.replace("_", " ").title()),
    ], widths=(38 * mm, 120 * mm)))

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
        "<b>This is a booking confirmation, not an airline ticket.</b> Carry the airline's own "
        "e-ticket and a valid photo ID or passport for travel. Quote the PNR above with the "
        "airline for any schedule change.",
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
