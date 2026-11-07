# Account-deletion requests: staff runbook (draft)

**Status: DRAFT for your review.** Business-process steps for the person who handles account-deletion requests. It
follows the website's Privacy Policy (sections 8 and 10). It is not legal advice.

**What the system does and does not do today** (so nobody assumes otherwise):

- The app's *Delete my account* screen sends an **email to the business inbox**, through the same channel as the
  website's contact form (`POST /api/contact`), with the subject **"Account deletion request"**. That is all it does.
  The website's customer support is now a live chat, and its staff tools do not answer support tickets, so the app no
  longer creates them. Requests sent by earlier versions of the app are tickets with the same subject: they stay readable
  in the app and in the admin Communication tab (read-only).
- **Nothing is deleted automatically.** The backend has no account-deletion feature.
- **Nothing verifies the person's identity automatically.** The request says whether it came from a signed-in session or a
  guest session (a guest has no registered account, and gives a contact to reply to); that is a hint, not proof. The Privacy Policy promises that we verify identity, so a person must.
- **Nothing tracks the 30-day deadline automatically.** It is on whoever owns this process.

## 0. Before this process goes live (you decide)

| # | Decision | Notes |
|---|---|---|
| a | **Name the owner**, and a backup, for deletion requests | Without a named person, 30 days will be missed |
| b | **Where requests are watched** | The inbox the contact form writes to (in the backend, `CONTACT_FORM_RECIPIENT`, currently `jackpotsworldtours.travels@gmail.com`): confirm who reads it, how often, that it is the mailbox you want, and that the server can send mail (if it cannot, the app says so and gives the phone and email). Also check the old tickets in the admin Communication tab |
| c | **How identity is verified** (§3) | The options below are proposals |
| d | **How deletion is actually carried out** (§5) | **Not verified.** Depends on what the admin tools and database allow; confirm with whoever operates the backend |
| e | **The Privacy Policy wording** | It should mention the app and app support requests (blocker 7 in `RELEASE.md`) |

## 1. Receive

1. Find the email: subject **"Account deletion request"**. The body lists the account code, the email and
   mobile **on file**, any contact the customer gave, any open bookings the app saw, and any reason. Replying to the email
   reaches the customer at the address they gave.
2. Record it in a simple log you keep (spreadsheet is fine): date received, who is handling it,
   the **due date**, and status. *Due date:* the policy says 30 days from a **verified** request, so use 30 days from
   receipt as the conservative deadline and let verification only ever make it later by the customer's own delay.
3. Check for a duplicate. The phone remembers that a request was sent and does not offer a second, but an email cannot be
   looked up afterwards (a customer who clears the app's data, or reinstalls, can send again), and a customer may also have
   written or phoned. Merge them into one record.
4. Reply promptly to say it is received and that you will verify who they are (suggested: within one working day; the
   policy's grievance promise is one working day. This is a recommendation, not a stated policy for deletions).

## 2. Is it a deletion request, and from whom?

- **Registered customer:** the request names an email and mobile on file. Contact them on those, not on anything new in
  the request.
- **Guest:** a guest has no email on the account. The request carries the contact the guest gave. The customer-supplied
  contact is **unverified**: do not assume it belongs to the person whose data it is. Verify through §3.
- **Someone else on the customer's behalf** (family member, agent): the policy allows a nominee only for death or
  incapacity. Otherwise ask the account holder directly.
- **A request made in anger or by mistake:** ask, and do not proceed until the customer confirms.

## 3. Verify identity (do not skip)

The request alone is not proof. Proposed methods, choose and write down your standard:

1. Contact the person on the **email address or mobile number already on the account** (not one supplied only in the
   request), and ask them to confirm the request.
2. Ask for something only the real customer would know: a booking reference together with the travel dates or lead
   guest name. (Never ask for a password, one-time code, full card number or passport scan.)
3. For a guest: match the contact given against the contact details on the guest's bookings.
4. If still in doubt, call back on a number already held on a past booking.

Record **how** you verified, **when**, and **who** did it. If the person cannot be verified, do not delete; tell them
what is needed. Keep the reply.

## 4. Work out what can go and what must stay

Use the policy, not the app's summary alone.

| Data | Decision rule | Source |
|---|---|---|
| Profile: name, contact details, date of birth, gender, address | Delete (or anonymise) on closure, **except** what forms part of a booking or payment record | Policy §8 |
| Booking records, invoices, payment references | **Keep**, at least eight financial years from the end of the relevant year | Policy §8 |
| Saved travellers and passport details | Delete once no trip, refund, claim or dispute needs them. Keep while a trip is ahead or a claim is open | Policy §8 |
| Health and accessibility information | Delete once the trip is complete and any related claim closed | Policy §8 |
| Wishlist, saved preferences | Not covered by the policy's retention list. Delete on request (**confirm** you can) | Not in the policy: confirm |
| Sign-in sessions | Revoke when closing. (**Confirm** how) | Not in the policy: confirm |
| Support requests, including this one | **Keep** up to three years from last contact | Policy §8 |

Check bookings yourself in the admin tools. The app's list of open bookings is a hint only.

- **Open booking** (unpaid and still payable; or paid with the trip ahead): the request **cannot be completed yet**.
  Tell the customer. Offer to cancel an unpaid one (their choice). Diary a review for when the trip is over plus any
  claim period.
- **Open refund, claim or dispute:** same: keep documents until closed.
- **Nothing open:** continue.

## 5. Carry out the deletion

**This step is not verified.** The backend has no account-deletion feature, and I have not checked what your admin tools
can remove. Do **not** delete anything directly in the production database on the strength of this runbook. Before
anything is removed:

1. Confirm with the person who operates the backend **exactly** what can be removed or anonymised through the admin tools,
   and what would need a developer.
2. If a developer is needed, that is a change to a live system: it needs a written, approved procedure, a backup first,
   and a check afterwards. It is outside what the mobile app can do.
3. Account for the records you must keep (§4). Removing a customer record that bookings point to can break those
   bookings; anonymising is usually safer than deleting, but that is a decision for you and your advisers.
4. Wherever data also lives outside this system (email inboxes, payment provider dashboards, exported spreadsheets),
   it is part of the request too. List them and handle each.

## 6. Tell the customer

Send a plain message that says: what was deleted; what was kept and **why** (the legal reason); how long the kept
records will be held; and that the request is complete. If part cannot be done yet, say which part and what happens
next. Do not claim anything was deleted that was not.

Suggested wording, adapt as needed:

> Hello [name], we have completed your account-deletion request. We have deleted: [list]. We have kept: [list], because
> [law / open booking / claim], for [period]. If you have any questions, reply to this message.

If you cannot proceed:

> Hello [name], we have your request to delete your account. Before we can complete it we need to [verify who you are /
> wait until your trip on [date] is over / resolve the open refund]. We will contact you again by [date].

## 7. Close and record

1. Mark the entry resolved in your log. Keep the correspondence up to three years from last contact, as the policy says.
2. Complete your log: date completed, what was deleted, what was kept and why, who did it.
3. If the customer signs up again later, that is a new account. Do not restore deleted data.

## 8. Edge cases

| Situation | Handling |
|---|---|
| Customer wants to withdraw the request | Note it, mark the entry resolved with the reason; the account was never changed |
| Customer sends the request twice | One record; reply once |
| Customer is a minor | The policy says accounts are for adults; contact the adult who booked |
| The customer is also a traveller on someone else's booking | Their details on that booking belong to that booking's records: explain |
| Cannot meet 30 days | Write to the customer before the deadline, say why and give a new date |
| Authority or court asks you to retain the data | Retain it, and tell the customer what you can say |
| Customer complains | Follow the policy's grievance process (acknowledge in one working day; aim to resolve in 30 days) |

## 9. Reporting

Once a quarter, look at the log: how many requests, how many met 30 days, how long verification took, how many
were refused and why. It will tell you whether this interim process is sustainable or whether the proper backend
feature (still on the release-readiness list) is urgent.
