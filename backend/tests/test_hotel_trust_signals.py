"""The hotel result card's trust signals must be grounded, never inferred.

WHY THIS EXISTS
The Hotel Results card shows a "Free cancellation" badge. It is NOT a stored
boolean — it is derived by ``CustomerHotel.free_cancellation`` from the policy
TEXT, and the card shows the badge only when that derivation returns True
(`hotel-results.js`: `h.freeCancellation === true`), otherwise it prints the
raw policy text in the property's own words. That makes the badge a claim about
a real property, so the derivation is exactly the kind of code that must not
drift: a future "simplification" that treated an unknown or non-refundable
policy as free cancellation would show a refund right the property never
granted. These tests pin the four cases the brief names — confirmed, false,
missing and unknown — and assert that only a confirmed policy is presented as
the benefit.

The property reads only ``self.cancellation_policy``, so these construct the
model in memory with no session or table — the derivation is the whole subject.

WHY TAXES ARE NOT TESTED HERE
There is deliberately no "taxes included" badge to pin. ``customer_hotel_pricing_service``
adds 12% tax ON TOP of the room subtotal, so the card's nightly rate is
tax-exclusive; the card shows an honest tax PREVIEW, not a "taxes included"
claim. A test asserting a benefit that the data does not support would itself be
the misleading claim the brief forbids. See docs/COMPETITOR_AUDIT_2026-10-27.md.
"""
import pytest

from app.models_customer import CustomerHotel


def _hotel(policy):
    # In-memory only: free_cancellation reads nothing but this attribute.
    return CustomerHotel(name="Test Property", location="Test City",
                         cancellation_policy=policy)


def test_confirmed_policy_is_a_free_cancellation_benefit():
    assert _hotel("Free cancellation up to 24 hours before check-in").free_cancellation is True


@pytest.mark.parametrize("policy", [
    "FREE CANCELLATION up to 48 hours before check-in",  # upper case
    "  Free cancellation up to 24 hours before check-in",  # leading whitespace
    "free cancellation until 6pm on arrival day",  # lower case
])
def test_confirmed_is_robust_to_case_and_whitespace(policy):
    # The same promise written three ways is still the same promise.
    assert _hotel(policy).free_cancellation is True


@pytest.mark.parametrize("policy", [
    "Non-refundable",
    "Partially refundable up to 7 days before arrival",
    "Cancellation fee of one night applies",
])
def test_a_policy_that_is_not_free_is_not_a_benefit(policy):
    # These have a real, stated policy — it is simply not free cancellation, so
    # the badge is withheld and the raw text is shown instead.
    assert _hotel(policy).free_cancellation is False


def test_a_policy_that_merely_mentions_the_words_is_not_a_benefit():
    # The conservative PREFIX rule is the point: a sentence that denies free
    # cancellation must never trip the badge just because the words appear.
    assert _hotel("No free cancellation is offered on this rate.").free_cancellation is False


@pytest.mark.parametrize("policy", [None, "", "   "])
def test_unknown_policy_is_never_presented_as_a_benefit(policy):
    # The brief's rule: unknown must not be shown as a confirmed benefit. A
    # missing or blank policy is unknown, so the badge is withheld.
    assert _hotel(policy).free_cancellation is False
