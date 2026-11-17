"""Guard: the Account Center payment-history table must not drift between its two
copies (Bug 10 follow-up).

The Account Center markup exists twice — a static copy in `frontend/index.html`
and the `MARKUP` constant inside `frontend/assets/js/account-center.js` that every
other page builds from. When the renderer gained a Service column and a pagination
container, the static copy had to match or index.html would render the old
five-column table with no pager. This test fails if the two ever disagree again.

Pure text inspection — no browser, no server.
"""
from __future__ import annotations

import re

from app.main import FRONTEND_DIR

INDEX_HTML = FRONTEND_DIR / "index.html"
ACCOUNT_CENTER_JS = FRONTEND_DIR / "assets" / "js" / "account-center.js"

EXPECTED_COLUMNS = ["Service", "Date", "Amount", "Method", "Status", "Transaction Ref"]

#: The table header block, from the table's id to the end of the table.
_TABLE_RE = re.compile(r'id="acctPaymentsTable".*?</table>', re.S)
_TH_RE = re.compile(r"<th>(.*?)</th>", re.S)
#: The payment-history renderer body, so the colspan check is scoped to it.
_LOADER_RE = re.compile(
    r"async function loadAcctPayments\b.*?(?=\n/\* -+ )", re.S
)


def _columns(text: str) -> list[str]:
    block = _TABLE_RE.search(text)
    assert block, "acctPaymentsTable header not found"
    return [c.strip() for c in _TH_RE.findall(block.group(0))]


def _read(path) -> str:
    return path.read_text(encoding="utf-8")


def test_payment_table_columns_match_between_static_html_and_js_renderer():
    html_cols = _columns(_read(INDEX_HTML))
    js_cols = _columns(_read(ACCOUNT_CENTER_JS))
    assert html_cols == EXPECTED_COLUMNS, html_cols
    assert js_cols == EXPECTED_COLUMNS, js_cols
    # The decisive assertion: the two copies cannot drift apart.
    assert html_cols == js_cols


def test_both_account_center_sources_have_the_payments_pager():
    assert 'id="acctPaymentsPager"' in _read(INDEX_HTML)
    assert 'id="acctPaymentsPager"' in _read(ACCOUNT_CENTER_JS)


def test_renderer_empty_state_spans_every_column():
    """A column added to the header without updating the empty/error-row colspan
    would misalign the table — guard the two numbers together."""
    js = _read(ACCOUNT_CENTER_JS)
    loader = _LOADER_RE.search(js)
    assert loader, "loadAcctPayments renderer not found"
    body = loader.group(0)
    assert f'colspan="{len(EXPECTED_COLUMNS)}"' in body
    assert 'colspan="5"' not in body  # the old five-column count must be gone
