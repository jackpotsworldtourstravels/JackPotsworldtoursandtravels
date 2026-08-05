"""Schemas for the group booking passenger manifest.

The merchant uploads one spreadsheet; three different audiences read what comes
back, and they need different amounts of it:

* the **upload screen** wants the summary and every row-level error, so it can
  render "48 of 50 imported" beside a list the merchant can act on;
* the **booking form** wants the parsed passengers, to show who is travelling
  before anything is submitted;
* the **Admin drawer** wants the summary and a link to the original file, and
  should not be paying to serialise 200 passengers into a listing.

Hence three models rather than one fat one — :class:`GroupImportSummary` is what
rides along on every enquiry/booking response, and the detail is fetched only
when a screen actually opens it.
"""
import datetime

from pydantic import BaseModel, Field

from app.models_v2 import GroupImportStatus
from app.schemas.ticket import PassengerInput


class GroupImportError(BaseModel):
    """One thing wrong with one row.

    ``row`` is the spreadsheet's own 1-based row number **as the merchant sees
    it in Excel**, header included — not the zero-based index of a parsed list.
    A validation message that says "Row 12" has to point at row 12 of the file
    on their screen, or it is worse than no message at all.
    """

    row: int
    #: The offending column's header, when the problem belongs to one. ``None``
    #: for whole-row problems ("Origin and Destination cannot be the same").
    column: str | None = None
    message: str


class GroupImportSummary(BaseModel):
    """The counts, and nothing that costs anything to produce."""

    import_id: int
    journey_type: str
    original_filename: str
    size_bytes: int
    validation_status: GroupImportStatus

    total_rows: int
    valid_rows: int
    invalid_rows: int
    passengers_imported: int

    #: Set once the sheet has been parsed; ``None`` while still pending.
    imported_at: datetime.datetime | None = None
    uploaded_by_name: str | None = None
    #: True when this import may be turned into a booking. Derived rather than
    #: stored so no caller has to remember that ``partial`` is not good enough.
    can_submit: bool = False

    @classmethod
    def of(cls, imp, *, uploaded_by_name: str | None = None) -> "GroupImportSummary":
        return cls(
            import_id=imp.import_id,
            journey_type=imp.journey_type,
            original_filename=imp.original_filename,
            size_bytes=imp.size_bytes,
            validation_status=imp.validation_status,
            total_rows=imp.total_rows,
            valid_rows=imp.valid_rows,
            invalid_rows=imp.invalid_rows,
            passengers_imported=imp.passengers_imported,
            imported_at=imp.imported_at,
            uploaded_by_name=uploaded_by_name,
            can_submit=imp.validation_status == GroupImportStatus.VALID,
        )


class GroupImportDetail(GroupImportSummary):
    """The summary plus everything the sheet actually contained."""

    #: The journey the sheet declared, as parsed. The booking is still raised
    #: from the *form's* itinerary — this is what the file said, kept so the two
    #: can be compared when they disagree.
    journey: dict = {}
    passengers: list[PassengerInput] = []
    errors: list[GroupImportError] = []

    @classmethod
    def of(cls, imp, *, uploaded_by_name: str | None = None) -> "GroupImportDetail":
        base = GroupImportSummary.of(imp, uploaded_by_name=uploaded_by_name)
        # Stored as plain dicts; re-validated on the way out so a hand-edited
        # JSONB blob cannot put a field on the wire that PassengerInput would
        # have refused on the way in.
        return cls(
            **base.model_dump(),
            journey=imp.imported_journey or {},
            passengers=[
                PassengerInput(**p)
                for p in (imp.imported_passengers or [])
                if isinstance(p, dict)
            ],
            errors=[GroupImportError(**e) for e in (imp.validation_errors or [])],
        )


class GroupImportUploadResult(BaseModel):
    """What the upload endpoint answers with.

    Carries the detail *and* an explicit message, because the difference between
    "imported" and "imported with problems" is a sentence the merchant reads
    before they read any number.
    """

    imported: GroupImportDetail
    message: str = Field(max_length=300)
