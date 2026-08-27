'use strict';
/* ===========================================================================
   group-enquiry.js — sending a Group Deals hotel enquiry.
   ===========================================================================
   THE ONE PLACE THE GROUP FLOW TALKS TO THE BACKEND, split out of the card for
   the same reason booking-api.js is split out of the booking flow: the card
   renders and validates, this decides where an enquiry goes. A fetch() inside
   a click handler is a fetch you cannot call from anywhere else and cannot
   test without clicking.

   WHY THIS IS NOT A SEARCH. Everything else the booking card submits ends in a
   navigation — criteria go in the URL and a results page answers them. A party
   of forty has no availability to show: it is quoted by a person. So this
   posts, stays on the page, and the card shows an acknowledgement.

   WHICH ALSO MEANS THE CRITERIA MUST NOT GO IN A URL. The group form collects
   a name, an email and a phone number, and query strings are logged by proxies,
   kept in history and leak through Referer. This is the reason the enquiry is a
   POST body and the reason the search handler must branch BEFORE it reaches
   goToSearch().
   =========================================================================== */

const GroupEnquiry = (function () {

  /* Same base as the rest of the site — read from the global rather than
     redefined, so there is one answer to "where is the API". */
  const base = () => (typeof API_BASE === 'string' ? API_BASE : '');

  const ENDPOINT = '/api/hotel-group-enquiry';

  /** The card's camelCase criteria, in the shape the endpoint accepts.
   *
   *  Kept as its own function because it is the whole contract between the two
   *  sides: if the endpoint's field names change, this is the only thing that
   *  has to. Empty optionals are dropped rather than sent as "", which the
   *  schema would reject as a too-short string. */
  function payloadOf(p) {
    const body = {
      destination: p.dest,
      check_in: p.checkIn,
      check_out: p.checkOut,
      rooms: p.rooms,
      guests: p.guests,
      name: p.name,
      email: p.email,
      phone: p.phone,
    };
    if (p.company && String(p.company).trim()) body.company = String(p.company).trim();
    if (p.notes && String(p.notes).trim()) body.notes = String(p.notes).trim();
    return body;
  }

  /** FastAPI returns `detail` as a string for a raised HTTPException and as an
   *  array of {loc,msg} for a 422. Both have to become one sentence, or the
   *  card renders "[object Object]" — the same trap apiErrorText() exists for
   *  in app.js, repeated here because this module is loaded on pages that do
   *  not have that function. */
  function messageFrom(data, fallback) {
    const detail = data && data.detail;
    if (Array.isArray(detail)) {
      const text = detail.map(d => d && d.msg).filter(Boolean).join(' ');
      return text || fallback;
    }
    if (typeof detail === 'string' && detail) return detail;
    return fallback;
  }

  /**
   * Submit one enquiry.
   * @returns {Promise<{ok: true}>} on success.
   * @throws  {Error} with a message already fit to show a traveller.
   */
  async function submit(criteria) {
    let res;
    try {
      res = await fetch(base() + ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadOf(criteria)),
      });
    } catch {
      /* No response at all — offline, DNS, the API down. Distinguished from a
         refusal below because the traveller's answer is different: try again
         versus fix something. */
      throw new Error('We could not reach the group desk — check your connection and try again.');
    }

    if (res.ok) return { ok: true };

    const GENERIC = 'We could not send your enquiry just now — please try again, or call us.';

    if (res.status === 429) {
      throw new Error('That is a few enquiries in quick succession — give it a minute, then try again.');
    }

    /* ONLY THESE STATUSES CARRY A SENTENCE WORTH SHOWING. 422 is the schema
       naming the field that is wrong and 503 is the endpoint's own "mail is
       down, call us instead" — both are written for a traveller to read.
       Anything else is the server describing itself: a 405 from a deployment
       missing this route renders as "Method Not Allowed", which tells the
       person at the keyboard nothing they can act on. */
    if (res.status === 422 || res.status === 503) {
      let data = null;
      try { data = await res.json(); } catch { /* 503s behind a proxy have no JSON body */ }
      throw new Error(messageFrom(data, GENERIC));
    }

    throw new Error(GENERIC);
  }

  /** Is this set of criteria a group enquiry rather than a search?
   *
   *  Exported so every search handler asks the same question the same way.
   *  There are two of them — app.js on the landing page, travel-explore.js on
   *  the service pages — because BookingCard holds ONE handler and whichever
   *  page mounted last owns it. A page that forgets this check does not fail
   *  visibly: it navigates, and puts the enquirer's name, email and phone in a
   *  query string. */
  const isGroup = (kind, params) => kind === 'hotels' && params && params.mode === 'group';

  /** Submit, and drive the card through pending -> sent / failed.
   *
   *  THE ORCHESTRATION LIVES HERE, NOT IN A HANDLER, for the reason above: two
   *  pages need identical behaviour, and two copies of it would drift. The card
   *  supplies the verbs (setBusy/showGroupSuccess/complain) and knows nothing
   *  about the network; this knows nothing about the markup.
   *
   *  Never rejects — the card has already been told what happened, and a
   *  handler is not a place an unhandled rejection can usefully surface. */
  async function handle(criteria) {
    const card = (typeof BookingCard !== 'undefined') ? BookingCard : null;
    if (!card) return { ok: false };

    card.clearError();
    card.setBusy(true, 'Sending…');
    try {
      await submit(criteria);
      card.setBusy(false);
      card.showGroupSuccess({ name: criteria.name, dest: criteria.dest });
      return { ok: true };
    } catch (err) {
      card.setBusy(false);
      /* Inline in the card's own footer, beside the button that was pressed —
         not a toast that floats away from the form it is about. */
      card.complain(err.message, null);
      return { ok: false, error: err.message };
    }
  }

  return { submit, handle, isGroup, payloadOf, ENDPOINT };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GroupEnquiry;
