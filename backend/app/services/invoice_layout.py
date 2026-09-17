"""The JackPots World invoice — an A4 tax-invoice layout, built from real rows.

WHY THIS IS A SEPARATE MODULE
``invoice_service`` owns access control, the booking-confirmation PDF and the
"is this billable yet" rule. This owns one thing: what the invoice LOOKS like.
Keeping the layout apart means the page can be restructured without touching
the rules that decide who may see it.

--------------------------------------------------------------------------
WHAT THIS PAGE MAY AND MAY NOT SAY
--------------------------------------------------------------------------
An invoice is a tax document. Every identifier on it — GSTIN, PAN, CIN, a
registered office, a customer's GST number — is something a reader may act on,
file against, or be audited over. So the rule this module is built around is:

    IF THE DATABASE DOES NOT HOLD IT, THE CELL IS EMPTY.

Not "N/A", not "—", not a plausible-looking placeholder. `_v()` below is the
only way a value reaches the page, and it turns anything absent into "". The
LABEL still prints, because "GSTIN:" followed by nothing is an honest statement
that we have not supplied one; "GSTIN: 36ABCDE1234F1Z5" would be a fabricated
registration on a tax document, which is the single worst thing this file could
do.

THIS IS WHY LARGE PARTS OF THE PAGE PRINT BLANK TODAY, and that is correct
rather than unfinished:

  our GSTIN / PAN / CIN / offices   no company-profile table exists; they are
                                    settings, empty until the real
                                    certificates are entered (see config.py)
  the merchant's GSTIN / PAN        `merchants` has no such columns
  the fare breakdown                `service_requests.pricing` holds a currency
                                    and a final amount. There is no base fare,
                                    no OT/YQ/YR/K3 tax, no baggage, meal, seat
                                    or service charge anywhere in this schema.
  commission / TRA fee / TDS        nothing records them
  CGST / SGST / IGST                no tax engine, no configured rates
  passenger GST company details     never collected from the customer

Each of those columns is still DRAWN, because the structure is what makes the
document recognisable and because the day a value exists it should appear
without a redesign. They are drawn empty.

--------------------------------------------------------------------------
THE ONE ARITHMETIC DECISION WORTH STATING
--------------------------------------------------------------------------
The reference layout puts a Fare against every passenger row. This schema
records one `total_amount` for the booking and never an allocation across
travellers. Dividing it by the head count would be inventing a per-passenger
figure the business never agreed, so:

  * one passenger   -> Fare is the booking total, which is exactly true
  * more than one   -> the per-row Fare is BLANK and the total appears once,
                       as Gross

That is the honest reading of what is stored. When a real fare breakdown is
added, `_pax_rows` is the one place that changes.
"""
import datetime
from decimal import Decimal
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Image,
    KeepTogether,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from app.config import settings
from app.models_v2 import PassengerType, PaymentStatus, PaymentType, RequestStatus as S

# --------------------------------------------------------------------- ink --
#: Charcoal rather than pure black: at 6pt the reference's body text is grey-
#: black, and true #000 on white reads harsher in print than it does on screen.
INK = colors.HexColor("#1A1A1A")
MUTED = colors.HexColor("#5A5A5A")
#: The logo's own gold, sampled from jackpots-logo-full.png. Used ONLY for the
#: rules under section headings and the two header lines — the brief asks for a
#: professional invoice, not a marketing page, so gold never touches body text.
GOLD = colors.HexColor("#B8892B")
LINE = colors.HexColor("#BFBFBF")
#: Table header fill. The reference uses white with ruled borders, not a solid
#: band, which is what keeps an 18-column grid readable at this size.
HEAD_BG = colors.HexColor("#F4F4F4")

LOGO = (Path(__file__).resolve().parents[3]
        / "frontend" / "assets" / "images" / "jackpots-logo-full.png")

#: A4 portrait minus the margins `build()` sets. Every table width below is a
#: share of this, so a column change cannot silently overflow the page.
USABLE = 186 * mm

#: Printed when `settings.invoice_terms` is empty. Deliberately only statements
#: that are TRUE OF THIS DOCUMENT or of airline tickets generally — nothing
#: about jurisdiction, payment terms or interest, because those are claims a
#: business makes rather than facts, and inventing them would be putting words
#: into JackPots World's contract. The labelled-but-empty slots keep the
#: reference's shape and show exactly where the real clauses will go.
NEUTRAL_TERMS: tuple[tuple[str, str], ...] = (
    ("IMP:", "This is a computer-generated invoice and does not require a signature."),
    ("IMP:", "Changes, cancellations and refunds are subject to the fare rules of the "
             "operating airline."),
    ("IMP:", "Please check all details carefully and report any discrepancy before travel."),
    ("JURISDICTION:", ""),
    ("PAYMENT TERMS:", ""),
    ("LATE PAYMENT:", ""),
)

PAX_CODE = {
    PassengerType.ADULT: "ADT",
    PassengerType.CHILD: "CHD",
    PassengerType.INFANT: "INF",
}


def _v(value) -> str:
    """Every value on this page goes through here.

    Returns the empty string for anything absent, so a missing identifier
    prints as a blank cell under its label rather than as a dash, an "N/A" or a
    placeholder that could be mistaken for a real registration. See the module
    docstring — this is the whole safety rule, in one function.
    """
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in {"none", "null"} else text


def _amount_of(request) -> Decimal:
    """The figure this invoice is for.

    TWO COLUMNS HOLD IT, DEPENDING ON HOW THE BOOKING CAME ABOUT, and reading
    only one of them prints a wrong invoice for the other kind:

      quoted booking   ``total_amount`` — what the desk quoted and what the
                       merchant's wallet is actually debited.
      manual booking   ``total_amount`` is 0.00, because nothing was quoted and
                       no wallet moves for a ticket the desk bought
                       off-platform. The money is the Fare the operator typed
                       on Manual Request, which is stored in ``client_fare``.

    So the rule is: the billed total when there is one, otherwise the recorded
    fare. Not a sum of the two and not an estimate — whichever column the
    booking actually used. A manual booking with no fare entered yet falls
    through to zero, which is true of it.
    """
    total = Decimal(request.total_amount or 0)
    if total > 0:
        return total
    return Decimal(request.client_fare or 0)


def _money(value) -> str:
    """A figure, or blank. Never ``0.00`` for "we do not know".

    The distinction matters on a tax document: a printed 0.00 asserts that the
    charge was levied and came to nothing, which is a different claim from
    having no figure at all. Only a real Decimal reaches here.
    """
    if value is None:
        return ""
    return f"{Decimal(value):,.2f}"


def _styles():
    base = getSampleStyleSheet()
    mk = lambda name, **kw: ParagraphStyle(name, parent=base["Normal"], **kw)
    return {
        # The invoice word itself, centred between the two address blocks.
        "invoice": mk("invoice", fontName="Helvetica-Bold", fontSize=17,
                      textColor=INK, alignment=1, leading=20),
        "co_name": mk("co_name", fontName="Helvetica-Bold", fontSize=9.5,
                      textColor=INK, leading=12.5),
        "body": mk("body", fontSize=8.2, textColor=INK, leading=11.2),
        "body_b": mk("body_b", fontName="Helvetica-Bold", fontSize=8.2,
                     textColor=INK, leading=11.2),
        "label": mk("label", fontSize=8.2, textColor=MUTED, leading=11.2),
        "h": mk("h", fontName="Helvetica-Bold", fontSize=9.5, textColor=INK,
                leading=12, spaceAfter=3),
        "meta": mk("meta", fontName="Helvetica-Bold", fontSize=9.5, textColor=INK),
        "pnr": mk("pnr", fontName="Helvetica-Bold", fontSize=10,
                  textColor=INK, alignment=2),
        # The 18-column grid. 5.6pt is what makes it fit A4 portrait without
        # scaling; the reference sits at about the same size.
        "cell": mk("cell", fontSize=5.6, textColor=INK, leading=7, alignment=1),
        "cellh": mk("cellh", fontName="Helvetica-Bold", fontSize=5.6,
                    textColor=INK, leading=7, alignment=1),
        "note": mk("note", fontName="Helvetica-Bold", fontSize=8, textColor=INK),
        "terms_l": mk("terms_l", fontName="Helvetica-Bold", fontSize=7.4,
                      textColor=INK, leading=10),
        "terms_v": mk("terms_v", fontSize=7.4, textColor=INK, leading=10),
        "tiny": mk("tiny", fontSize=6.8, textColor=MUTED, leading=9),
    }


def _rule(color=GOLD, thickness=0.9, space_before=3, space_after=5):
    return HRFlowable(width="100%", thickness=thickness, color=color,
                      spaceBefore=space_before, spaceAfter=space_after)


def _kv_lines(st, pairs) -> Paragraph:
    """A label/value block as one flowing paragraph.

    Labels always print. A blank value leaves the line ending at the colon,
    which is the visible form of "we have not supplied this".
    """
    out = []
    for label, value in pairs:
        v = _v(value)
        out.append(f"<b>{label}</b> {v}" if v else f"<b>{label}</b>")
    return Paragraph("<br/>".join(out), st["body"])


# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
def _header(st, request) -> list:
    """Logo left, PNR right — then the invoice number/date band under a rule."""
    pnr = _v(request.pnr)
    # `kind="proportional"` fits the image INSIDE the box, so the square logo
    # was being constrained by the height and rendering at ~18mm wide — a
    # stamp in the corner of an A4 page. The box is squared off and enlarged so
    # the constraint is the width the masthead actually has.
    logo = (Image(str(LOGO), width=34 * mm, height=34 * mm, kind="proportional")
            if LOGO.exists() else Paragraph(_v(settings.company_legal_name), st["co_name"]))

    top = Table(
        [[logo, Paragraph(f"PNR: {pnr}" if pnr else "PNR:", st["pnr"])]],
        colWidths=(120 * mm, USABLE - 120 * mm),
    )
    top.setStyle(TableStyle([
        ("VALIGN", (0, 0), (0, 0), "MIDDLE"),
        ("VALIGN", (1, 0), (1, 0), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))

    # Invoice number and date share one band, as on the reference. Both are
    # real: `invoice_number` is allocated by issue_ticket, and the date is the
    # booking's own approval/creation timestamp.
    inv_no = _v(request.invoice_number)
    date = request.approved_at or request.created_at
    band = Table(
        [[Paragraph(f"Invoice No - {inv_no}" if inv_no else "Invoice No -", st["meta"]),
          Paragraph(f"Invoice Date : {date.strftime('%d-%b-%Y')}" if date
                    else "Invoice Date :", st["meta"])]],
        colWidths=(USABLE * 0.46, USABLE * 0.54),
    )
    band.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))

    return [top, _rule(thickness=1.1, space_before=4, space_after=2), band,
            _rule(color=LINE, thickness=0.7, space_before=0, space_after=6)]


# ---------------------------------------------------------------------------
# Company | Invoice | Billed To
# ---------------------------------------------------------------------------
def _identity_row(st, merchant) -> Table:
    """Three columns, exactly as the reference places them.

    LEFT is us. Every legal identifier in it is a setting that defaults to
    empty (config.py), so on an unconfigured deployment the labels print and
    the values do not. RIGHT is the merchant, from `merchants` — which has no
    GSTIN, PAN or state column at all, so those three labels print blank on
    every invoice until such columns exist.
    """
    ours = [("", settings.company_legal_name)] if settings.company_legal_name else []
    left = [Paragraph(_v(settings.company_legal_name), st["co_name"])] if ours else []
    left.append(_kv_lines(st, [
        ("Regd Office:", settings.company_regd_office),
        ("Corp Office:", settings.company_corp_office),
        ("Email:", settings.company_email),
        ("Web:", settings.company_website),
        ("Phone:", settings.company_phone),
        ("State:", settings.company_state),
        ("GSTIN:", settings.company_gstin),
        ("PAN:", settings.company_pan),
        ("CIN:", settings.company_cin),
    ]))

    middle = [Paragraph("Invoice", st["invoice"])]

    # The merchant IS the party billed: this is a B2B platform and the wallet
    # debited is theirs. Their own customer never appears on our invoice.
    locality = ", ".join(x for x in ((merchant.city if merchant else None),
                                     (merchant.country if merchant else None)) if x)
    right = [
        Paragraph("<b>Billed To:</b>", st["body"]),
        Paragraph(f"<b>{_v(merchant.company_name if merchant else '')}</b>", st["body"]),
    ]
    for line in (_v(merchant.address if merchant else ""), locality):
        if line:
            right.append(Paragraph(line, st["body"]))
    right.append(Spacer(1, 4))
    right.append(_kv_lines(st, [
        ("Phone :", merchant.phone if merchant else ""),
        ("Email :", merchant.email if merchant else ""),
        # No column exists for either. The labels stay so the shape is right
        # and so a future column lands somewhere obvious.
        ("State :", ""),
        ("GSTIN :", ""),
        ("PAN :", ""),
    ]))

    t = Table([[left, middle, right]],
              colWidths=(USABLE * 0.38, USABLE * 0.24, USABLE * 0.38))
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("RIGHTPADDING", (-1, 0), (-1, 0), 0),
        ("LEFTPADDING", (1, 0), (-1, 0), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        # The two hairlines that separate the three blocks on the reference.
        ("LINEBEFORE", (1, 0), (1, 0), 0.7, LINE),
        ("LINEBEFORE", (2, 0), (2, 0), 0.7, LINE),
    ]))
    return t


# ---------------------------------------------------------------------------
# The passenger / fare grid
# ---------------------------------------------------------------------------
#: Header, and the share of the usable width each column takes. The first seven
#: carry data; the eleven after `Fare` are the reference's charge breakdown and
#: have no source in this schema (module docstring) — they are drawn empty.
#: WIDTHS ARE SET FROM WHAT THE COLUMNS ACTUALLY HOLD, not spread evenly.
#: A first pass gave every column a similar share and the two widest real
#: values broke across lines in the render — a ticket number came out as
#: "TKT-2026-00043 / 4" and a cabin class as "Econo / my", which on an invoice
#: reads as a defect rather than as wrapping. The seven data columns were
#: widened at the expense of the blank charge columns, which have nothing to
#: hold. Shares sum to ~0.99 of USABLE, leaving a hair rather than risking a
#: rounding overflow on the last column.
COLUMNS: tuple[tuple[str, float], ...] = (
    ("S.<br/>No.", 0.028),
    ("Ticket No", 0.112),
    ("Sectors", 0.070),
    ("Flight", 0.055),
    ("PAX Name", 0.108),
    ("Type", 0.032),
    ("Class", 0.060),
    ("Fare", 0.064),
    ("OT Tax", 0.048),
    ("K3/GST", 0.050),
    ("YQ Tax", 0.048),
    ("YR Tax", 0.048),
    ("Bag.Ch.", 0.047),
    ("Meal<br/>Ch.", 0.040),
    ("Seat<br/>Ch.", 0.040),
    ("Sp<br/>Service<br/>Ch.", 0.045),
    ("Service<br/>Charges", 0.048),
    ("Global<br/>Pr. Ch.", 0.046),
)


def _sector(details: dict) -> str:
    """"HYD - DEL" from whatever the booking actually recorded."""
    o = _v(details.get("origin")) or _v(details.get("origin_city"))
    d = _v(details.get("destination")) or _v(details.get("destination_city"))
    return f"{o} - {d}" if o and d else (o or d)


def _flight(details: dict) -> str:
    return " ".join(x for x in (_v(details.get("airline")),
                                _v(details.get("flight_number"))) if x)


def _pax_rows(st, request) -> list[list]:
    d = request.travel_details or {}
    sector = _sector(d)
    flight = _flight(d)
    travel_class = _v(d.get("booking_class")) or _v(d.get("travel_class"))
    passengers = list(request.passengers or [])

    # See the module docstring: a per-passenger fare is only stated when it is
    # unambiguous, which is when there is exactly one passenger to carry the
    # booking total. Otherwise the figure belongs to Gross and nowhere else.
    single = len(passengers) == 1

    rows = []
    for i, p in enumerate(passengers, 1):
        name = " ".join(x for x in (_v(p.title), _v(p.first_name), _v(p.last_name)) if x)
        cells = [
            str(i),
            _v(request.ticket_number) if single else "",
            sector,
            flight,
            name,
            PAX_CODE.get(p.passenger_type, ""),
            travel_class,
            _money(_amount_of(request)) if single else "",
        ]
        # The eleven charge columns. Blank, because nothing in this schema
        # records them — not 0.00, which would assert they were levied at nil.
        cells += [""] * (len(COLUMNS) - len(cells))
        rows.append([Paragraph(c, st["cell"]) for c in cells])
    return rows


def _pax_table(st, request) -> Table:
    widths = [share * USABLE for _, share in COLUMNS]
    header = [Paragraph(label, st["cellh"]) for label, _ in COLUMNS]
    rows = _pax_rows(st, request)
    if not rows:
        rows = [[Paragraph("", st["cell"]) for _ in COLUMNS]]

    # THE HEADER ROW STATES ITS HEIGHT. "Sp Service Ch." is three lines while
    # most headings are one, and left to auto-size the row was measured short:
    # the first line rendered clipped by the cell's top edge. Sizing it for the
    # tallest heading is what keeps every column label fully visible.
    t = Table([header] + rows, colWidths=widths, repeatRows=1,
              rowHeights=[10 * mm] + [None] * len(rows))
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 1.2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 1.2),
    ]))
    return t


# ---------------------------------------------------------------------------
# Billing block + totals
# ---------------------------------------------------------------------------
def _ticketed_by(request) -> str:
    """Who moved the booking to Ticket Issued.

    Read from `status_history`, which `lifecycle.transition` writes on every
    move — a real persisted name rather than a guess. There is no
    `ticketed_by` column; if the history has no such entry, this is blank.
    """
    for entry in reversed(request.status_history or []):
        if entry.get("to") == S.TICKET_ISSUED.value:
            return _v(entry.get("by_name"))
    return ""


def _payment_facts(request) -> tuple[str, str, Decimal]:
    """(invoice status, payment mode, amount settled) — from the payments.

    The brief is explicit that this must not default to "Paid". It is decided
    by what the ledger holds: a successful booking payment covering the total
    makes it Paid, anything less is Pending.
    """
    booking_payments = [
        p for p in (request.payments or [])
        if p.payment_type is PaymentType.BOOKING_PAYMENT
    ]
    paid = sum((p.amount for p in booking_payments
                if p.payment_status is PaymentStatus.SUCCESS), Decimal("0"))
    refunded = sum((p.refund_amount or Decimal("0") for p in (request.payments or [])),
                   Decimal("0"))
    settled = paid - refunded
    # Against the SAME figure the invoice states, not `total_amount` directly:
    # a manual booking's total is 0.00, and `0 >= 0` would have marked every
    # one of them Paid the moment it was created, with nothing paid at all.
    due = _amount_of(request)
    status = "Paid" if due > 0 and settled >= due else "Pending"

    methods = []
    for p in booking_payments:
        m = _v(p.payment_method)
        if m and m not in methods:
            methods.append(m)
    return status, " / ".join(methods), settled


def _totals_rows(request, settled: Decimal) -> list[tuple[str, str, str, bool]]:
    """(prefix, item, value, is_emphasis) — three columns, as the reference.

    Gross and the two Net lines are real: `total_amount` is the figure the
    wallet is debited and the only amount this system holds for the booking.
    Everything between them — commission, TRA fee, TDS, CGST, SGST, IGST — has
    no source anywhere in this schema, so each prints its label with an empty
    value. No rate is named either: "CGST @ 9%" would assert a rate nobody
    configured.
    """
    total = _amount_of(request)
    gross = _money(total)
    # NET RECEIVABLE IS WHAT IS STILL OWED, which is the only reading of that
    # label that can be true on a booking somebody has paid for. It was the
    # invoice total regardless of the ledger in the first cut of this layout,
    # which would have told a merchant it still owed money it had already sent.
    #
    # Both figures are real: `total_amount` is what the wallet is billed, and
    # `settled` is successful booking payments less refunds, straight off the
    # payment rows. Nothing here is estimated — when nothing has been paid the
    # two lines agree, which is exactly what the reference shows.
    return [
        ("Gross :", "", gross, True),
        ("Less :", "Commission Earned", "", False),
        ("Add :", "TRA Fee", "", False),
        ("Add :", "TDS Deducted", "", False),
        ("Add :", "CGST", "", False),
        ("Add :", "SGST", "", False),
        ("Add :", "IGST", "", False),
        ("Net Amount", "", gross, True),
        ("Net Receivable", "", _money(total - settled), True),
    ]


def _billing_and_totals(st, request) -> Table:
    status, mode, settled = _payment_facts(request)
    left = _kv_lines(st, [
        ("Billed by", f": {_v(settings.company_legal_name)}"),
        ("Ticketed By", f": {_ticketed_by(request)}" if _ticketed_by(request) else ":"),
        ("Invoice Status", f": {status}"),
        ("Payment Mode", f": {mode}" if mode else ":"),
    ])

    rows = _totals_rows(request, settled)
    body = [[Paragraph(prefix, st["body_b"] if strong else st["body"]),
             Paragraph(item, st["body"]),
             Paragraph(value, st["body_b"] if strong else st["body"])]
            for prefix, item, value, strong in rows]
    totals = Table(body, colWidths=(20 * mm, 36 * mm, 26 * mm))
    style = [
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("SPAN", (0, 0), (1, 0)),      # Gross :
        ("SPAN", (0, 7), (1, 7)),      # Net Amount
        ("SPAN", (0, 8), (1, 8)),      # Net Receivable
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 1.6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.6),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        # The rule above Net Amount, as on the reference.
        ("LINEABOVE", (0, 7), (-1, 7), 0.9, INK),
        ("TOPPADDING", (0, 7), (-1, 7), 5),
    ]
    totals.setStyle(TableStyle(style))

    amount_note = Paragraph("(Amount in <font name='Helvetica'>Rs.</font>)", st["tiny"])

    t = Table([[left, [totals, amount_note]]],
              colWidths=(USABLE - 82 * mm, 82 * mm))
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("RIGHTPADDING", (-1, 0), (-1, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


# ---------------------------------------------------------------------------
# GST sections
# ---------------------------------------------------------------------------
def _labelled_grid(st, headers, widths, rows, *, row_height=None) -> Table:
    """A ruled grid with a bold header.

    `row_height` exists because an entirely blank row has no content to give it
    height, and ReportLab then draws it as a 2pt sliver — which reads as a
    rendering fault rather than as an empty row. The GST table is blank by
    design (no tax engine), so it states its height explicitly.
    """
    t = Table([[Paragraph(h, st["body_b"]) for h in headers]] + rows,
              colWidths=widths, repeatRows=1,
              rowHeights=None if row_height is None
              else [None] + [row_height] * len(rows))
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def _gst_details(st) -> list:
    """The tax summary, drawn empty.

    There is no tax engine in this platform: nothing computes CGST/SGST/IGST,
    no SAC is stored, and no rate is configured. The table is drawn because it
    is part of what makes this document an invoice, and because the day those
    values exist they belong here — but every cell is blank, and no rate
    appears in a heading. A "@ 18%" printed against an empty figure would be
    asserting a rate this system has never applied.
    """
    headers = ["Service Description", "SAC", "Taxable Value", "CGST", "SGST", "IGST", "Total"]
    widths = [USABLE * s for s in (0.26, 0.10, 0.16, 0.12, 0.12, 0.12, 0.12)]
    blank = [[Paragraph("", st["body"]) for _ in headers]]
    return [Paragraph("GST Details :", st["h"]),
            _labelled_grid(st, headers, widths, blank, row_height=9 * mm)]


def _passenger_gst(st, request) -> list:
    """Lead passenger, and the GST company details we have never collected.

    The lead name is real — it is the first traveller on the booking. The five
    GST company fields are not collected anywhere in this application, so they
    print blank under their labels rather than being filled with the merchant's
    own details, which would be a different company's tax identity.
    """
    passengers = list(request.passengers or [])
    lead = ""
    if passengers:
        p = passengers[0]
        lead = " ".join(x for x in (_v(p.title), _v(p.first_name), _v(p.last_name)) if x)

    headers = ["Lead Pax Name", "GST Number", "GST Company<br/>Contact Number",
               "GST Company<br/>Address", "GST Company Email", "GST Company Name"]
    widths = [USABLE * s for s in (0.18, 0.17, 0.16, 0.16, 0.17, 0.16)]
    row = [[Paragraph(lead, st["body"])] + [Paragraph("", st["body"]) for _ in range(5)]]
    return [Paragraph("Passenger GST Details:", st["h"]),
            _labelled_grid(st, headers, widths, row)]


# ---------------------------------------------------------------------------
# Terms
# ---------------------------------------------------------------------------
def _terms(st) -> list:
    configured = [
        line.split("|", 1) for line in
        (settings.invoice_terms or "").splitlines() if line.strip()
    ]
    pairs = [(a.strip(), (b[0].strip() if b else "")) for a, *b in configured] \
        if configured else list(NEUTRAL_TERMS)

    rows = [[Paragraph(label, st["terms_l"]), Paragraph(text, st["terms_v"])]
            for label, text in pairs]
    t = Table(rows, colWidths=(30 * mm, USABLE - 30 * mm))
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 1.4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.4),
    ]))
    return [Paragraph("Terms &amp; Conditions :", st["h"]), _rule(space_before=0, space_after=4), t]


# ---------------------------------------------------------------------------
# The page
# ---------------------------------------------------------------------------
def story(request, merchant) -> list:
    """Everything on the invoice, in the reference's order."""
    st = _styles()
    out: list = []
    out += _header(st, request)
    out.append(_identity_row(st, merchant))
    out.append(_rule(color=LINE, thickness=0.7, space_before=0, space_after=7))
    out.append(_pax_table(st, request))
    out.append(Spacer(1, 6))
    out.append(Paragraph("Note: * Validation and refund as per fare rules", st["note"]))
    out.append(_billing_and_totals(st, request))
    out.append(Spacer(1, 10))
    # EACH SECTION IS BOUND TO ITS OWN HEADING. A nine-passenger booking runs
    # onto a second page, and appended loose these left "GST Details :" stranded
    # at the foot of page one with its table starting the next — which reads as
    # a heading for nothing. KeepTogether moves the pair as a unit.
    out.append(KeepTogether(_gst_details(st)))
    out.append(Spacer(1, 8))
    out.append(KeepTogether(_passenger_gst(st, request)))
    out.append(Spacer(1, 10))
    # Kept together so the terms never split across a page break, which is what
    # the reference's footer position implies.
    out.append(KeepTogether(_terms(st)))
    return out


def page_setup() -> dict:
    """A4 portrait with the margins every width above assumes."""
    return {
        "pagesize": A4,
        "leftMargin": 12 * mm, "rightMargin": 12 * mm,
        "topMargin": 12 * mm, "bottomMargin": 12 * mm,
    }
