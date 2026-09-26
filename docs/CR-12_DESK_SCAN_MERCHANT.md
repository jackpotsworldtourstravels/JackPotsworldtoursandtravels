# CR-12 — Naming the merchant a desk scan belongs to

**Status: SPEC, NOT BUILT.** No code written. Follow-on to CR-8 §13 and to `e333a94`.
Every claim below is labelled **[Code]** (read from this repo), **[You]** (confirmed by
the owner) or **[Intent]** (proposed, not yet true). Nothing here is **[You]** yet —
§10 is the list of questions that would make it so.

---

## 1. What is still broken

Admin → **Booking** → Manual Request, opened with no enquiry and no saved draft, cannot
scan a passport. The screen holds no merchant anywhere in its state, and a scan has to
name one. **[Code]**

Since `e333a94` the failure is at least honest — the upload is skipped and the card says
*"This screen has lost track of which merchant the booking is for"* instead of the old
*"Passport scanning is for merchant accounts"*, which was an answer about merchant
accounts given to an operator whose account was fine. **[Code]** But an honest failure is
still a failure, and this is the screen the Booking nav item opens by default. **[Code]**

---

## 2. The constraint, which this CR does not propose changing

`passport_ocr_service._resolve_scan_owner` refuses to file a scan against nobody:

> THE OWNER IS NEVER INVENTED AND NEVER ARBITRARY. An admin has no `merchant_id` of its
> own, so the named merchant is required rather than optional.

An extraction row is owned by a merchant, `_scoped` re-checks that merchant on every
read, and `ticket.manual` is its own permission code rather than a relaxation of
`document.upload` — the permission is useless without the name and the name is refused
without the permission. **[Code]**

So the fix is never "let the desk scan without a merchant". It is "make sure the screen
knows which merchant, on every path that reaches it". **[Intent]**

---

## 3. What `e333a94` already covers

`ambScanMerchantId()` reads three sources in order, every one of them the booking's own
rather than the operator's current UI state: **[Code]**

| # | Source | Set by | Covers |
|---|---|---|---|
| 1 | `clBookingEnquiry.merchant_id` | `clStartBookingRequest` | Manual Enquiry → Raise Booking |
| 2 | `clBookingDraft.merchant_id` | the resume/save paths; `RequestResponse` carries it | a resumed draft, a reload, after a Save |
| 3 | `AMB.pendingEnquiry.merchant_id` | Raise Booking, before the screen renders | the enquiry the screen arrived with |

With all three null the upload is skipped rather than sent, shaped like an axios failure
so `clOcrErrorText` carries the reason to the card through the same channel as every
other scan error. **[Code]**

---

## 4. The gap, precisely

Only one path reaches Manual Request with all three null: **the Booking nav item, with
no enquiry selected and no draft yet saved.** **[Code]**

`AMB.converting` is *not* a fourth source and cannot be made into one cheaply. It is set
just before `clRenderBookingForm` and holds `{ quoted, merchantName }` — a display
**name**, assembled for the confirmation screen's wording, with no id in it. **[Code]**
Reverse-looking-up a name against `AMB.merchants` would reintroduce exactly the ambiguity
the id exists to avoid (two merchants may trade under similar names), so §5 does not do
it. **[Intent]**

The two stand-in enquiries `classic-booking.js` builds — `clStartDirectBooking` and
`clResumeBookingDraft` — set `clBookingEnquiry` with `id: null` and no `merchant_id` at
all. Admin does not reach this screen through either today, but anything that later did
would land in the same gap. **[Code]**

---

## 5. The design

### 5.1 One new piece of state

```
AMB.bookingMerchantId : number | null
```

The merchant **this booking** is for. Distinct from `AMB.merchantId`, which is the
Manual Enquiry picker's current value and must stay distinct — see §5.4. **[Intent]**

`ambScanMerchantId()` gains it as a **fourth and last** source, after the three that read
the booking's own record:

```js
of(clBookingEnquiry) ?? of(clBookingDraft) ?? of(AMB.pendingEnquiry)
  ?? AMB.bookingMerchantId ?? null
```

Last, deliberately: a merchant the server put on the record always beats one an operator
typed into this screen. **[Intent]**

### 5.2 Where the operator sets it

On the Manual Request screen, a **"Booking for"** row at the top of the form — the same
place CR-8 §13's merchant row already renders for a converted enquiry. **[Code]** for the
existing row; **[Intent]** for the editable version.

- Reached **with** a merchant (sources 1–3 resolve): the row renders read-only, showing
  the company the booking belongs to. No new interaction. This is today's behaviour and
  must not change. **[Intent]**
- Reached **with none**: the row renders as a required chooser over `AMB.merchants`,
  above the passenger cards, empty by default — never pre-filled from the picker.
  **[Intent]**

### 5.3 The Scan control while it is unset

The Scan control stays rendered but refuses, keeping the existing message. It must not
be hidden: `OCR_PROVIDER=none` already means "no control at all", and reusing absence for
a second, recoverable reason would make a fixable state look like an unconfigured
deployment — the exact confusion CR-8 §3 is written to avoid. **[Intent]**

Better: once the chooser exists, the message should name the fix on the screen the
operator is already on, rather than sending them back to Manual Enquiry. **[Intent]**

### 5.4 Why not the Manual Enquiry picker

`admin-manual-booking.js` refuses the picker twice already, in the group-manifest wrapper
and in the passport wrapper, for one reason stated both times:

> The operator may well have changed that dropdown since; filing the sheet against
> whatever it now says would attach one company's travellers to another company's
> booking. **[Code]**

`AMB.bookingMerchantId` must therefore be a **latch, not a mirror**: **[Intent]**

- set once, when the operator answers the chooser on this booking;
- never written by the picker's `change` handler;
- cleared when the booking screen is left or a new booking is started, alongside
  `AMB.converting` and `AMB.pendingEnquiry`;
- **never** consulted while sources 1–3 resolve.

### 5.5 The server already accepts this

No backend change. The desk path — actor holds `ticket.manual`, `on_behalf_of_merchant_id`
names an existing merchant — is already built and already tested; the merchant is
validated (`db.get(Merchant, ...)`) and a merchant account is still refused from scanning
"for" anyone. **[Code]** CR-12 only changes where the frontend gets the id.

---

## 6. The sibling bug, which should land in the same change

`MerchantApi.uploadGroupManifest` was **not** updated by `e333a94`. It still reads
`clBookingEnquiry` alone, and on a null falls through to `originalManifest(opts)` — which
sends the upload with no `on_behalf_of_merchant_id` and is then refused by the server,
after the file has been spent on the round trip. **[Code]**

That is the same defect `e333a94` fixed for scanning, on the same screen, one wrapper
above it. A group booking resumed from a draft cannot attach its manifest today.
**[Code]** — **not reproduced in a browser; read from source only.**

It should be pointed at `ambScanMerchantId()` too, and given the same skip-and-explain
treatment rather than a doomed request. Renaming the helper `ambBookingMerchantId()`
would stop it reading as passport-specific. **[Intent]**

---

## 7. The invariant the server never checks

**This is the more important half of CR-12, and it is not a frontend problem.**

On the desk path the scan carries two merchant facts that are never compared:

- `on_behalf_of_merchant_id` — who will **own** the row. Validated only for existence
  (`db.get(Merchant, ...)`). **[Code]**
- `request_id` — which booking it is **labelled** to. Validated only by
  `ticket_service.scoped_query(actor)`, and that function's own docstring says *"Platform
  staff see every merchant's requests"* — so for an admin it adds no merchant condition
  at all. **[Code]**

Nothing asserts that the booking belongs to the named merchant. The manifest path does
exactly this check one service over — `attach_to_request` raises 403 *"That passenger
list belongs to another merchant"* on `imp.merchant_id != request.merchant_id` **[Code]**
— and the scan path has no equivalent.

### What that would leak

`for_request` gates on the **booking** being visible to the caller, then returns every
`PassportOcrExtraction` with that `request_id` **and applies no merchant filter to the
rows themselves**. **[Code]** So a row owned by merchant A but labelled to merchant B's
booking is returned to merchant B, whose own `scoped_query` passes on their own request.
`_scoped` — the filter that would have stopped it — is not on this path. **[Code]**

### How reachable it is

Not reachable through the UI as built: `ambScanMerchantId()` and the `request_id` sent on
save both derive from the same booking, so the pair cannot currently disagree. **[Code]**
It needs either a resolution bug — precisely the class `e333a94` just fixed and §5 is
about — or an admin holding `ticket.manual` sending a hand-made pair. So: an integrity
invariant with a read-leak consequence, not a live breach. **Not reproduced; read from
source only.**

### The fix

One comparison in `_resolve_scan_owner`'s caller, where `request_id` is already being
validated (`passport_ocr_service.py:278`): when both a named merchant and a `request_id`
are present, refuse unless `ServiceRequest.merchant_id == owner_merchant_id`, with the
manifest path's wording. **[Intent]** Cheap, and it makes §5 defence-in-depth rather than
the only guard — which is the right shape, since §5 is frontend state and this is not.

**This should land first, and can land without §5.** **[Intent]**

---

## 8. What this does not do

- Does not let a scan be filed with no merchant. §2. **[Intent]**
- Does not change `_resolve_scan_owner`, any permission code, or any endpoint. **[Intent]**
- Does not touch the merchant portal, which resolves its owner from the actor and never
  sends `on_behalf_of_merchant_id` at all. **[Code]**
- Does not make the Manual Enquiry dropdown a booking-level control. §5.4. **[Intent]**

---

## 9. Verification

`tests/verify_passport_ocr.py` is at **194/194** on `c437ea2`, run against a live server
and database on 2026-09-19. **[Code]**

The suite cannot catch this class on its own: `e333a94` was a frontend
merchant-resolution bug and the suite passed at 194/194 both before and after it. Its
commit says *"VERIFIED in the browser through the real wrapper"* for that reason.
**[Code]** CR-12 therefore needs browser verification as its primary evidence, with the
suite as a regression floor.

Python checks worth adding — each asserts the server contract the frontend now leans on:

1. a desk scan naming a merchant the operator chose on the screen is accepted and owned
   by that merchant;
2. a desk scan naming a merchant that does not exist is refused, and no row is written;
3. **§7, and the one that matters most:** a desk scan naming merchant A while
   `request_id` is a booking belonging to merchant B is **refused**, no row is written,
   and merchant B's `for_request` returns nothing new. Assert the read consequence and
   not just the status code — the status code alone would have passed while the leak
   existed. **[Intent]**

Browser checks:

4. Booking nav → Manual Request with no enquiry: chooser renders, Scan refuses with the
   on-screen reason, and **zero HTTP requests** are made by the attempt;
5. answer the chooser, scan, save: the row is owned by the chosen merchant and linked to
   the booking and traveller;
6. change the Manual Enquiry picker afterwards, scan again: still filed against the
   booking's merchant, not the picker's. **[Intent]**

---

## 10. Open questions — answer these before any code

1. **Should the chooser exist at all, or should the Booking nav item stop opening a
   blank Manual Request?** If a booking always begins at Manual Enquiry, the gap in §4
   closes with no new UI and no new state. This is the smaller change and may be the
   right one. Which is the intended workflow?
2. **Can an operator change the merchant after a passport has already been scanned
   against the booking?** Cleanest is no — latch it on first scan and require a new
   booking to change it. Confirm.
3. **§7 is a finding, not a proposal — do you want it fixed on its own, ahead of
   everything else here?** It needs no UI, no new state and no decision from §5. The only
   open parts are the refusal's status code and wording (mirror `attach_to_request`'s 403
   *"That passenger list belongs to another merchant"*?), and whether any existing rows
   should be checked for a mismatch before the guard goes in — there may be none, but
   nobody has looked.
4. **Is §6 in scope for this CR**, or a separate fix to land first? It is a live defect
   today, independent of the chooser.
