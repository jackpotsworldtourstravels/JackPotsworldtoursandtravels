"""index the Manager approval queue

Revision ID: 0035_manager_queue_index
Revises: 0034_manager_scope_constraint
Create Date: 2026-07-31

WHAT THE QUEUE ACTUALLY ASKS FOR
Every read of the Manager's desk is the same shape: Classic Tours bookings
(``request_type = 'booking'`` with an ``enquiry_reference`` in ``travel_details``),
narrowed to a handful of statuses, oldest first.

``EXPLAIN ANALYZE`` before this index, on 1,126 rows:

    Limit
      -> Index Scan Backward using ix_sr_created_at
           Filter: (travel_details ->> 'enquiry_reference') IS NOT NULL
                   AND status = ANY (...) AND request_type = 'booking'
           Rows Removed by Filter: 277

It walked the whole table in date order and threw away fourteen rows for every
one it kept. That ratio is not a constant — it is the proportion of all requests
that are *not* Classic Tours bookings awaiting a manager, and it grows with every
enquiry, change request and catalog booking the platform ever takes. The JSONB
predicate had no index at all and was re-evaluated per row.

WHY A PARTIAL INDEX, AND WHY THIS PREDICATE
The interesting rows are a small, permanent subset of a large table, which is
exactly what a partial index is for — it stays small as the table grows, and it
excludes the rows the queue can never want.

The predicate is written as ``(travel_details ->> 'enquiry_reference') IS NOT
NULL`` — character for character what ``manager_service._classic_bookings_filter``
emits. The planner only uses a partial index when it can *prove* the query implies
the predicate, and it will not prove that ``->> ... IS NOT NULL`` implies the
tidier-looking ``travel_details ? 'enquiry_reference'``. The two must match.

WHY ``(created_at, status)`` AND NOT ``(status, created_at)``
The obvious order — equality column first, sort column second — was measured and
is the worse one here. Every bucket except *Approved* covers more than one
status, so ``status`` is a range, not an equality, and leading with it leaves
Postgres unable to read the index in ``created_at`` order; it fell back to the
plain date index and filtered, discarding 277 rows to return 20.

Leading with ``created_at`` gives the queue its sort for free and lets ``status``
ride along as an index condition rather than a post-filter. Measured on the same
1,126 rows:

    list    192 buffers, 277 rows discarded  ->  23 buffers, 0 discarded
    counts  143 buffers, heap filter         ->  34 buffers, index-only scan

Both queries are served by this one index; there is no second index to keep.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0035_manager_queue_index"
down_revision: Union[str, None] = "0034_manager_scope_constraint"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_PREDICATE = (
    "request_type = 'booking' "
    "AND (travel_details ->> 'enquiry_reference') IS NOT NULL"
)


def upgrade() -> None:
    op.execute(
        f"""
        CREATE INDEX ix_sr_classic_queue
            ON service_requests (created_at, status)
            WHERE {_PREDICATE}
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_sr_classic_queue")
