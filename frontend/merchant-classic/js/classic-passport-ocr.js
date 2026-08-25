/* Passport scanning on the booking form.
   =====================================================================
   Upload a passport, get the passenger fields filled in with a confidence
   score on each, a prompt if this merchant has sent that passport before, and
   a warning if it expires too close to the travel date.

   THE ONE RULE THIS FILE OBEYS
   Scanning is a shortcut over a form that already works. It never gates a
   submit, it never blocks a field, and every failure path ends with the
   merchant typing exactly as they would have anyway. CR-1 removed uploads from
   this screen because attaching a passport forced the merchant to save a draft
   first; this attaches to nothing, needs no draft, and is offered only when the
   deployment actually has an OCR provider — otherwise no control is rendered at
   all and the form is byte-for-byte what it was.

   WHY THE FILL IS TWO PILES, NOT AN OVERWRITE
   Same decision `clBindPassportLookup` already made for the passport-number
   lookup, and for the same reason: empty fields are filled outright, but a
   field the merchant has already typed something different into is never
   replaced without an answer. A merchant who corrected a scanned name and then
   re-scanned would otherwise lose the correction silently.

   Requires (in this order): MerchantApi, clConfirm, fmtDate — all already
   loaded by index.html before this file.
*/

/* Populated once per page load. `null` until asked, `false` when the
   deployment has no provider — which is the common case and must render
   nothing rather than a button that fails when pressed. */
let clOcrConfig = null;

/* extraction id -> the fields it produced, kept so `clOcrRecordEdits` can tell
   the server which values the merchant changed after the fill. Keyed by the
   passenger card, because a card can be re-scanned and only the last scan is
   the one whose values were actually used. */
const clOcrByCard = new WeakMap();

/* The one-line heading beside the button, per failure. The server already
   sends a sentence saying what to do — this only names the problem, because
   "Could not be read" on every failure makes three different situations look
   like one flaky feature, and the merchant's next action differs in each:
   re-photograph it, turn to a different page, or get the whole page in frame.
   Keyed on `error_code` rather than on the sentence so the wording can change
   without touching this, and any code not listed falls back to the old text. */
const CL_OCR_HEADLINES = {
  ocr_not_legible: 'Image too unclear',
  ocr_not_a_passport: 'Not a passport page',
  ocr_zone_incomplete: 'Bottom of page missing',
  ocr_timeout: 'Scan timed out',
  ocr_not_configured: 'Scanning unavailable',
  ocr_misconfigured: 'Scanning unavailable',
};

const CL_OCR_POLL_MS = 2000;
/* Long enough for a big PDF through a cold provider, short enough that a merchant
   is not left watching a spinner if something upstream has stopped answering. */
const CL_OCR_POLL_TIMEOUT_MS = 90000;

/* Shown when a passport could not be read. The server sends this same sentence
   as `error_detail` — it is defined in local_provider.UNREADABLE — and this is
   the fallback for the paths that never reach the server's wording, so the
   merchant is told the same thing however the read failed.

   IT OFFERS THE TWO THINGS THAT ACTUALLY HELP: a better photograph, or typing.
   What it must never do is suggest the engine got *something*, because it did
   not — a failed read produces no fields at all rather than a partial guess. */
const CL_OCR_UNREADABLE =
  'Unable to extract passport information. Please upload a clearer passport '
  + 'image or enter the details manually.';

/* The fields a scan may fill, in the order they are read off the page. Matches
   the server's PASSPORT_FIELDS; `passenger_type` is deliberately absent — it is
   seeded from the party breakdown the merchant already gave, and a child who has
   since become an adult must not be silently re-typed by a passport. */
/* The fields a scan may fill, and what to call one when asking about it.
   `mrz` is deliberately absent: it is not a passenger attribute and has no box
   on this form. It is rendered read-only by `clOcrMrz` instead, so a merchant
   can check a doubtful field against the machine-readable lines the value was
   actually verified from. See base.NON_PASSENGER_FIELDS on the server. */
const CL_OCR_FIELDS = {
  title: 'Title',
  first_name: 'First name',
  last_name: 'Last name',
  gender: 'Gender',
  dob: 'Date of birth',
  place_of_birth: 'Place of birth',
  nationality: 'Nationality',
  passport_number: 'Passport no.',
  passport_type: 'Passport type',
  passport_issue_country: 'Issuing country',
  passport_issue_date: 'Issue date',
  passport_expiry: 'Expiry',
};

const CL_OCR_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4Z"/>'
  + '<circle cx="12" cy="13" r="3.5"/></svg>';

/* ------------------------------------------------------------ availability */

/* Asked once, cached, and never allowed to throw: a failure to ask whether
   scanning exists must not stop the booking form rendering. */
async function clOcrLoadConfig() {
  if (clOcrConfig !== null) return clOcrConfig;
  try {
    const cfg = await MerchantApi.ocrAvailability();
    clOcrConfig = cfg && cfg.available ? cfg : false;
  } catch (err) {
    console.debug('passport OCR availability check failed', err);
    clOcrConfig = false;
  }
  return clOcrConfig;
}

/* ------------------------------------------------------------ the control */

/* Called from clAddPaxCard for every passenger row. Renders nothing at all
   when there is no provider — which is what keeps this feature invisible on a
   deployment that has not configured one. */
function clOcrAttach(card) {
  clOcrLoadConfig().then(cfg => {
    if (!cfg || !card.isConnected) return;

    const bar = document.createElement('div');
    bar.className = 'cl-ocr-bar';
    bar.innerHTML = `
      <button type="button" class="cl-ocr-btn" data-cl-ocr-go>
        ${CL_OCR_ICON}<span>Scan passport</span>
      </button>
      <input type="file" data-cl-ocr-file hidden
             accept="${cfg.accepted_types.join(',')}">
      <span class="cl-ocr-status" data-cl-ocr-status></span>`;

    /* Above the fields, not below them: the merchant's eye goes to the top of
       a card, and a control that fills the fields underneath it should be the
       first thing on the card, not something found after typing them by hand. */
    const form = card.querySelector('.cl-form');
    card.insertBefore(bar, form);

    /* The MRZ panel goes AFTER the fields, because it is what a merchant looks
       down at to settle a doubt about one of them — not something to read
       first. Hidden until a scan produces one, so a hand-typed passenger and a
       deployment whose provider returns no zone both see nothing. */
    const mrz = document.createElement('div');
    mrz.className = 'cl-ocr-mrz';
    mrz.hidden = true;
    mrz.setAttribute('data-cl-ocr-mrz', '');
    form.insertAdjacentElement('afterend', mrz);

    const input = bar.querySelector('[data-cl-ocr-file]');
    bar.querySelector('[data-cl-ocr-go]').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      // Reset first: picking the SAME file twice must fire `change` again,
      // which it does not if the value is still set.
      input.value = '';
      if (file) clOcrRun(card, file);
    });
  });
}

function clOcrStatus(card, html, kind) {
  const el = card.querySelector('[data-cl-ocr-status]');
  if (!el) return;
  el.className = `cl-ocr-status${kind ? ` is-${kind}` : ''}`;
  el.innerHTML = html || '';
}

function clOcrBusy(card, busy) {
  const btn = card.querySelector('[data-cl-ocr-go]');
  if (btn) btn.disabled = !!busy;
}

/* -------------------------------------------------------------- the run */

async function clOcrRun(card, file) {
  clOcrBusy(card, true);
  clOcrNote(card, '');
  clOcrStatus(card, '<span class="cl-ocr-spin"></span>Uploading…');

  let result;
  try {
    result = await MerchantApi.extractPassport(file, {
      // Only ever a label, and usually absent: the merchant is normally filling
      // a form that has never been saved. Sent when a draft does exist so the
      // desk can see the scan beside the booking later.
      requestId: (typeof clBookingDraft !== 'undefined' && clBookingDraft) ? clBookingDraft.id : null,
    });
  } catch (err) {
    clOcrBusy(card, false);
    clOcrStatus(card, '', null);
    clOcrNote(card, clOcrErrorText(err), 'error');
    return;
  }

  if (result.status === 'queued' || result.status === 'processing') {
    clOcrStatus(card, '<span class="cl-ocr-spin"></span>Processing passport…');
    try {
      result = await clOcrPoll(result.id);
    } catch (err) {
      clOcrBusy(card, false);
      clOcrStatus(card, '', null);
      clOcrNote(card, clOcrErrorText(err), 'error');
      return;
    }
  }

  clOcrBusy(card, false);

  if (result.status !== 'succeeded') {
    clOcrStatus(
      card,
      CL_OCR_HEADLINES[result.error_code] || 'Could not be read',
      'error',
    );
    clOcrNote(
      card,
      `${clOcrEsc(result.error_detail || CL_OCR_UNREADABLE)} `
      + 'Nothing about this booking is blocked.',
      'error',
    );
    return;
  }

  clOcrByCard.set(card, result);
  await clOcrApply(card, result);
}

/* Poll until the server says succeeded or failed. The server turns an
   abandoned run into `failed` once it is past its budget, so the only reason
   this loop needs its own timeout is a network that has stopped answering. */
async function clOcrPoll(extractionId) {
  const deadline = Date.now() + CL_OCR_POLL_TIMEOUT_MS;
  for (;;) {
    await new Promise(r => setTimeout(r, CL_OCR_POLL_MS));
    const row = await MerchantApi.getPassportExtraction(extractionId);
    if (row.status === 'succeeded' || row.status === 'failed') return row;
    if (Date.now() > deadline) {
      return {
        ...row,
        status: 'failed',
        error_detail: 'The scan is taking longer than expected.',
      };
    }
  }
}

/* ------------------------------------------------------------- the fill */

async function clOcrApply(card, result) {
  const field = f => card.querySelector(`[data-field="${f}"]`);
  const fields = result.fields || {};

  /* THE TWO PILES — see the header. Blanks are filled outright; a field
     already holding something DIFFERENT is never replaced without an answer,
     because that is the one the merchant may have deliberately corrected. */
  const blanks = [];
  const clashes = [];
  Object.entries(CL_OCR_FIELDS).forEach(([name, label]) => {
    const el = field(name);
    const read = fields[name];
    if (!el || !read || read.value === '' || read.value === null) return;
    const current = (el.value || '').trim();
    if (!current) blanks.push([el, read, name]);
    else if (current !== String(read.value)) clashes.push([el, read, name, label]);
  });

  blanks.forEach(([el, read, name]) => clOcrSet(card, el, read, name));

  if (clashes.length) {
    const names = clashes.map(([, , , label]) => label).join(', ');
    const ok = await clConfirm(
      `The scan read different values for: ${names}. Replace what you have typed `
      + 'with what the passport says?',
      'Replace');
    if (ok) clashes.forEach(([el, read, name]) => clOcrSet(card, el, read, name));
  }

  /* THE FIELDS THE SCAN DID NOT PRODUCE. A missing key means the provider read
     nothing there — not an empty value, and never a guess. Those boxes are
     marked so the merchant can see at a glance which ones are theirs to type,
     rather than discovering it at submit. `title` is excluded: no passport
     prints one, so it is always absent and flagging it would cry wolf on every
     single scan. */
  const unread = Object.keys(CL_OCR_FIELDS).filter(
    name => name !== 'title' && field(name) && !fields[name],
  );
  unread.forEach(name => {
    const wrap = field(name).closest('.cl-field');
    if (!wrap) return;

    /* CLEAR WHAT AN EARLIER SCAN LEFT BEHIND. Re-scanning a card is how a
       merchant fixes a bad photograph, and it is also how the wrong person
       ends up on a ticket: the previous passport's values stay in every box
       the new one could not read, wearing a "not read" caption that reads as
       "nothing here". A passport with no surname — an Indian passport whose
       zone runs `P<IND<<BENU<GOPAL`, where the field is genuinely empty — then
       keeps the surname of whoever was scanned before.
       Only a value this module put there is removed, and only while it is
       still untouched: `clOcrFilled` holds what the last scan wrote, so a
       merchant's own typing never matches and is never discarded. */
    const el = field(name);
    const scanned = el.dataset.clOcrFilled;
    if (scanned !== undefined && (el.value || '').trim() === scanned) {
      el.value = '';
      delete el.dataset.clOcrFilled;
    }

    wrap.classList.remove('cl-ocr-high', 'cl-ocr-medium', 'cl-ocr-low');
    wrap.classList.add('cl-ocr-unread');
    wrap.querySelector('.cl-ocr-badge')?.remove();
    const label = wrap.querySelector('label');
    if (label && !label.querySelector('.cl-ocr-badge')) {
      const badge = document.createElement('span');
      badge.className = 'cl-ocr-badge is-unread';
      badge.textContent = 'not read';
      badge.title = 'The scan could not read this. Enter it from the passport.';
      label.appendChild(badge);
    }
    // Typing it clears the marker — it has been dealt with, and a field the
    // merchant has just filled should not keep asking to be filled.
    field(name).addEventListener('input', () => {
      wrap.classList.remove('cl-ocr-unread');
      wrap.querySelector('.cl-ocr-badge.is-unread')?.remove();
    }, { once: true });
  });

  clOcrMrz(card, fields.mrz);

  const filled = blanks.length + (clashes.length ? clashes.length : 0);
  const needChecking = Object.values(fields).filter(f => f.band !== 'high').length;
  clOcrStatus(
    card,
    `Read ${Object.keys(fields).length} field${Object.keys(fields).length === 1 ? '' : 's'}`,
    'ok',
  );

  const parts = [];
  if (filled) {
    parts.push(`Filled ${filled} field${filled === 1 ? '' : 's'} from the passport.`);
  }
  if (needChecking) {
    parts.push(
      `<b>${needChecking} field${needChecking === 1 ? '' : 's'} the scan was less sure of `
      + `${needChecking === 1 ? 'is' : 'are'} outlined</b> — check ${needChecking === 1 ? 'it' : 'them'} against the passport.`,
    );
  } else {
    parts.push('Every field was read clearly. Check them before submitting.');
  }
  if (unread.length) {
    parts.push(
      `<b>${unread.length} field${unread.length === 1 ? '' : 's'} could not be read</b> `
      + `and ${unread.length === 1 ? 'is' : 'are'} marked “not read” — type `
      + `${unread.length === 1 ? 'it' : 'them'} from the passport. Nothing was guessed.`,
    );
  }
  if (result.simulated) {
    parts.push(
      '<span class="cl-ocr-sim">Simulated</span> These details were generated for '
      + 'development, not read from the document.',
    );
  }
  clOcrNote(card, parts.join(' '), result.simulated ? 'warn' : null);

  // Order matters: the expiry warning is about the booking and outranks a
  // duplicate prompt, which is about saving typing.
  clOcrValidity(card, result.validity);
  await clOcrDuplicate(card, result);
}

/* The machine-readable zone, read-only, under the passenger's fields.

   WHY IT IS SHOWN AT ALL. It is the only part of a passport that carries its own
   check digits, so a value derived from it is arithmetic rather than a confident
   guess — and when a merchant doubts the expiry the scan coloured red, the two
   lines below are what they check it against. Read-only and never submitted: it
   is evidence about the document, not an attribute of the traveller, and has no
   column on the passenger. Monospace because column position is the meaning. */
function clOcrMrz(card, mrz) {
  const host = card.querySelector('[data-cl-ocr-mrz]');
  if (!host) return;
  if (!mrz || !mrz.value) { host.innerHTML = ''; host.hidden = true; return; }
  host.hidden = false;
  const verified = mrz.band === 'high';
  host.innerHTML = `
    <div class="cl-ocr-mrz-head">
      Machine-readable zone
      <span class="cl-ocr-mrz-flag ${verified ? 'is-ok' : 'is-warn'}">
        ${verified ? 'Check digits verify' : 'Check digits did not verify'}
      </span>
    </div>
    <pre class="cl-ocr-mrz-lines">${clOcrEsc(mrz.value)}</pre>
    <div class="cl-ocr-mrz-foot">${verified
      ? 'The passport number and both dates were confirmed by the arithmetic in these lines.'
      : 'These lines did not add up, so nothing was taken from them. Check every field against the passport.'}</div>`;
}

/* Set one value and mark the field with the band it was read at. */
function clOcrSet(card, el, read, name) {
  el.value = read.value;
  // A select can only take a value it has an option for; gender is the only
  // one a scan fills, and an unrecognised value must leave the field alone
  // rather than blanking a select the merchant may already have set.
  if (el.tagName === 'SELECT' && el.value !== String(read.value)) {
    el.value = '';
    return;
  }
  const wrap = el.closest('.cl-field');
  if (!wrap) return;
  wrap.classList.remove('cl-ocr-high', 'cl-ocr-medium', 'cl-ocr-low', 'cl-ocr-unread');
  if (read.band && read.band !== 'unknown') wrap.classList.add(`cl-ocr-${read.band}`);

  /* NO CONFIDENCE PERCENTAGE ON THE FIELD. It was shown here and removed: a
     number against every box turned a filled-in form into a scoreboard, and
     "80%" invites the wrong question — whether to trust the figure — when the
     only thing to do is glance at the passport and read the value back. The
     signal survives where it is useful and silent: the band still tints the
     field, and a field the scan could not read still says "not read", which is
     a fact about the document rather than a score. Any badge left by an
     earlier scan of this card is cleared, including the "not read" one, which
     `clOcrApply` re-adds for the fields that still need it. */
  wrap.querySelector('.cl-ocr-badge')?.remove();

  /* WHO PUT THIS VALUE HERE. Recorded on the element so a later scan of a
     DIFFERENT passport can tell its own leftovers from something a human
     typed. Without it a re-scan leaves the previous passport's value sitting
     in any box the new one could not read — captioned "not read", which is
     the worst of both: the box looks filled, so nobody types over it, and the
     wrong surname reaches a ticket. Compared by value rather than trusted as
     a flag, so a merchant who edits the box owns it from then on. */
  el.dataset.clOcrFilled = String(read.value);

  /* Editing a scanned field clears its highlight: the tint described what OCR
     read, and once a human has changed it the tint is about a value that is
     no longer on screen. Once only — re-scanning re-adds it. */
  el.addEventListener('input', () => {
    wrap.classList.remove('cl-ocr-high', 'cl-ocr-medium', 'cl-ocr-low', 'cl-ocr-unread');
    wrap.querySelector('.cl-ocr-badge')?.remove();
    delete el.dataset.clOcrFilled;
  }, { once: true });
}

/* --------------------------------------------------------- the warnings */

function clOcrValidity(card, validity) {
  if (!validity || !validity.checked || validity.valid) return;
  /* An expiry problem is appended to the note rather than replacing it: the
     merchant still needs to know what was filled in, and a warning that erased
     that context reads as though the scan failed. */
  const note = card.querySelector('[data-cl-ocr-note]');
  const text = clOcrEsc(validity.message || '');
  const extra = validity.severity === 'error'
    ? `<b>${text}</b> This booking cannot be submitted until the expiry is corrected.`
    : `<b>${text}</b> Check with the airline before submitting.`;
  if (note) {
    note.innerHTML += ` ${extra}`;
    note.className = `cl-ocr-note is-${validity.severity === 'error' ? 'error' : 'warn'}`;
    note.dataset.clOcrNote = '';
  } else {
    clOcrNote(card, extra, validity.severity === 'error' ? 'error' : 'warn');
  }
}

/* ------------------------------------------------------------ duplicates */

/* "Passenger already exists" — the three-way choice, offered only when this
   merchant has actually sent this passport before.

   NOTHING HERE CAN CREATE A DUPLICATE RECORD, by construction rather than by
   rule: the lookup writes nothing, returns no row id, and all three answers end
   with the same form being saved the same way. "Create new" is simply "leave
   the scan's values alone" — the booking creates its own passenger row exactly
   as it always has. */
async function clOcrDuplicate(card, result) {
  const dup = result.duplicate;
  if (!dup || !dup.found) return;

  const when = dup.last_used ? ` (last booked ${fmtDate(dup.last_used)})` : '';
  const differing = [];
  Object.entries(CL_OCR_FIELDS).forEach(([name, label]) => {
    if (name === 'passport_number') return;
    const onFile = dup.fields[name];
    const el = card.querySelector(`[data-field="${name}"]`);
    if (!onFile || !el) return;
    if ((el.value || '').trim() !== String(onFile)) differing.push([el, onFile, label]);
  });

  if (!differing.length) {
    clOcrNote(
      card,
      `<b>${clOcrEsc(dup.full_name || 'This traveller')} is already on file</b>${when} `
      + 'and the scan agrees with what you booked before.',
    );
    return;
  }

  const names = differing.map(([, , label]) => label).join(', ');
  const ok = await clConfirm(
    `${dup.full_name || 'This traveller'} is already on file for this passport${when}, `
    + `with different: ${names}. Use the details from that booking instead of the scan?`,
    'Use existing');
  if (!ok) {
    clOcrNote(
      card,
      `<b>Kept the scanned details.</b> ${clOcrEsc(dup.full_name || 'A traveller')} is on `
      + `file for this passport${when} with different ${clOcrEsc(names)}.`,
    );
    return;
  }
  differing.forEach(([el, value]) => {
    el.value = value;
    const wrap = el.closest('.cl-field');
    wrap?.classList.remove('cl-ocr-high', 'cl-ocr-medium', 'cl-ocr-low');
    wrap?.querySelector('.cl-ocr-badge')?.remove();
  });
  clOcrNote(
    card,
    `<b>Used the details on file</b> for ${clOcrEsc(dup.full_name || 'this traveller')}${when}. `
    + `Replaced: ${clOcrEsc(names)}.`,
  );
}

/* ------------------------------------------------------------- the audit */

/* Told to the server after a save: which OCR values the merchant changed, and
   which booking and traveller the scan became.

   Never allowed to throw into the save path. A booking that was saved
   successfully must not be reported as a failure because an audit write did
   not land — the audit is about the scan, and the scan is a convenience. */
async function clOcrRecordEdits(cards, requestId) {
  await Promise.all(cards.map(async card => {
    const result = clOcrByCard.get(card);
    if (!result) return;
    const values = {};
    Object.keys(CL_OCR_FIELDS).forEach(name => {
      const el = card.querySelector(`[data-field="${name}"]`);
      if (el) values[name] = (el.value || '').trim() || null;
    });
    try {
      await MerchantApi.recordPassportEdits(result.id, values, {
        requestId: requestId ?? null,
        passengerId: card.dataset.clPaxId ? Number(card.dataset.clPaxId) : null,
      });
    } catch (err) {
      console.debug('recording passport OCR edits failed', err);
    }
  }));
}

/* ------------------------------------------------------------- plumbing */

/* One note per card, replaced rather than appended — a card scanned three
   times must not accumulate three notes. */
function clOcrNote(card, html, kind) {
  let note = card.querySelector('[data-cl-ocr-note]');
  if (!html) return note?.remove();
  if (!note) {
    note = document.createElement('div');
    note.dataset.clOcrNote = '';
    card.appendChild(note);
  }
  note.className = `cl-ocr-note${kind ? ` is-${kind}` : ''}`;
  note.innerHTML = html;
}

function clOcrEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clOcrErrorText(err) {
  const detail = err?.response?.data?.detail;
  if (err?.response?.status === 503) {
    return 'Passport scanning is not available right now. Enter the details by hand.';
  }
  return clOcrEsc(detail || CL_OCR_UNREADABLE);
}
