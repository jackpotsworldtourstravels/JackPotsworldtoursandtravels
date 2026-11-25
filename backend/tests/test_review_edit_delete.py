"""Issue #20 — a customer may EDIT and DELETE their own review, and only their own.

Independent verification + regression guard (the edit/delete paths had no test of
their own; #19's suite only covers the create gate). Pins the service layer the
routers `PUT`/`DELETE /api/customer/reviews/{id}` sit on:

  * get_owned_review() returns a review ONLY to the customer who wrote it — a
    different customer gets None, which the router turns into 404 (so one
    customer can never read, edit or delete another's review: IDOR-safe).
  * update_review() changes rating + comment AND resets status to 'pending', so
    an edited review is moderated again before it shows (0090).
  * delete_review() removes the row; it is then gone for its owner too.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import tests.conftest  # installs the SQLite type shim  # noqa: F401
from app.models_customer import Customer, CustomerReview
from app.services import customer_account_service as acct

_ids = iter(range(42000, 48000))


@pytest.fixture()
def session():
    engine = create_engine("sqlite://")
    for t in (Customer, CustomerReview):
        t.__table__.create(engine)
    s = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


def _cust(s):
    cid = next(_ids)
    c = Customer(customer_id=cid, customer_code=f"C{cid}", full_name="T",
                 email=f"{cid}@x.test", mobile="9000000000")
    s.add(c)
    s.flush()
    return c


def _review(s, cust, *, rating=4, comment="ok", status="approved"):
    r = CustomerReview(customer_review_id=next(_ids), customer_id=cust.customer_id,
                       item_type="hotel", item_id=7, rating=rating, comment=comment, status=status)
    s.add(r)
    s.flush()
    return r


def test_owner_can_fetch_edit_and_delete_their_review(session):
    owner = _cust(session)
    r = _review(session, owner, rating=4, comment="was fine", status="approved")

    # fetch
    assert acct.get_owned_review(session, owner, r.customer_review_id) is r

    # edit: new rating/comment, and status returns to pending for re-moderation
    acct.update_review(session, r, 2, "actually disappointing")
    assert (r.rating, r.comment, r.status) == (2, "actually disappointing", "pending")

    # delete
    acct.delete_review(session, r)
    session.flush()
    assert acct.get_owned_review(session, owner, r.customer_review_id) is None


def test_a_different_customer_cannot_touch_the_review(session):
    owner = _cust(session)
    stranger = _cust(session)
    r = _review(session, owner)

    # The stranger's ownership lookup returns None — the router answers 404, so
    # the stranger can neither read, edit nor delete the owner's review.
    assert acct.get_owned_review(session, stranger, r.customer_review_id) is None
    # The owner still has it (nothing was leaked or removed).
    assert acct.get_owned_review(session, owner, r.customer_review_id) is r


def test_unknown_review_id_is_not_found(session):
    owner = _cust(session)
    assert acct.get_owned_review(session, owner, 999999) is None
