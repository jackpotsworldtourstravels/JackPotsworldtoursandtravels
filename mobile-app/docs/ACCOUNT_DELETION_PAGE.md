# Public account-deletion page: text for review

**Status: DRAFT for your review. Nothing here has been published.** The matching HTML is
[`account-deletion.draft.html`](account-deletion.draft.html). Google Play asks for a public web address where a person
can read how to request deletion of their account and data; this is the text for that address.

The publishable text is everything between the two `=====` lines. The notes after it are for you and are **not** part of
the page.

=====

# Delete your JackpotsWorld account

*JackpotsWorld Tours & Travel · Hyderabad, India*

You can ask us to delete your JackpotsWorld account and the personal data we hold about you. This page explains how to
ask, what happens next, and what we can and cannot delete.

## What happens when you ask

**Asking is a request. It does not delete your account straight away.** A member of our team has to review it, check
that it really comes from you, and complete it. Until then your account stays as it is and keeps working. We respond
within 30 days of verifying your identity.

## How to ask

**In the app.** Open the JackpotsWorld app, go to **Profile**, and choose **Delete my account**. Read the explanation,
tick the box to confirm you understand, and send the request. If you are using the app as a guest (without an account),
give us an email address or mobile number we can reach you on, because we have no other way to reply.

**Without the app.** Write to **support@jackpotsworldtours.com** from the email address on your account or booking, or
call **+91 91778 47799**. Say that you want your account and personal data deleted.

Either way, we will ask you to verify your identity before we act. A request to delete an account is exactly the kind of
thing an impersonator might send, so we check it with you first, as our [Privacy Policy](https://jackpotsworldtours.com/privacy-policy.html)
describes.

## What we can delete

- Your profile: name, contact details, date of birth, gender and address.
- Saved travellers, including passport details, once no trip or claim needs them.
- Your wishlist and saved preferences.
- Your sign-in on your devices.

## What we must keep

The law, not our preference, decides some of this. As our Privacy Policy explains:

- **Booking records, invoices and payment references** are kept for as long as tax, accounting and company law require,
  which in India is generally at least eight financial years from the end of the relevant year.
- **Travel documents** for a trip that has not happened yet, or that has an open refund, claim or dispute, are kept until
  it is closed, then deleted unless a statutory record requires otherwise.
- **Correspondence**, including your deletion request, is kept for up to three years from the last contact, so that a
  later question about an old trip can still be answered.

Anything we keep is used only for the reason we are keeping it.

## If you have a booking coming up

You can still send your request. But records for a trip that has not happened yet are kept until it is over, so we
cannot complete your request until then. If you have an unpaid booking you no longer want, you can cancel it from its page
in the app first. If you want to cancel a paid booking, ask us and our team will review it.

## What you will hear from us

We will contact you on the email address or mobile number on your account (or the one you gave for a guest request) to
verify your identity, tell you what we have deleted and what we have kept and why, and confirm when it is done. If we
cannot complete part of your request, we will say which part and why.

## Questions or complaints

Write to **support@jackpotsworldtours.com** or call **+91 91778 47799**. Our Privacy Policy explains your other rights and
how to complain if you are not satisfied with our response.

=====

## Notes for you (not part of the page)

**Where each statement comes from.** The retention periods, the 30-day response, the identity-verification step and the
list of what is kept come from the website's current Privacy Policy (sections 8 and 10). The in-app path comes from the
screen built in `src/app/account/delete.tsx`. The phone number and email come from `STORE_LISTING.md`.

**Please confirm before publishing:**

1. **Your team can really do each deletion.** The backend has no account-deletion feature. The page lists "wishlist and
   saved preferences" and "your sign-in on your devices" as deletable; the Privacy Policy does not mention either, and I
   have not verified that your admin tools or database procedures can remove them. See the runbook,
   [`ACCOUNT_DELETION_RUNBOOK.md`](ACCOUNT_DELETION_RUNBOOK.md). Remove any line you cannot honour.
2. **The 30 days.** The policy promises a response within 30 days *of a verified request*. The app tells customers "we
   aim to reply within 30 days" (slightly more generous to them). Decide whether you are comfortable with both.
3. **The Privacy Policy does not mention the app** (blocker 7 in `RELEASE.md`). It should say that requests can also be
   made in the app, that app support requests are kept for up to three years, and that the app is covered. Until it
   does, this page and the policy say slightly different things about *how* to ask.
4. **The page address.** Where it will live (suggested: `https://jackpotsworldtours.com/account-deletion.html`) is your
   decision. It then goes in the Google Play Data safety form and in `STORE_LISTING.md`.
5. **Legal review.** I am not a lawyer; the wording about retention should be checked by whoever owns your privacy
   obligations.
6. **Who answers.** A named person must own these requests and the 30-day clock (runbook §1).
7. **Apple.** Apple's rule asks for deletion *within the app*. This is a request, not an in-app deletion. Whether Apple
   accepts it is Apple's judgement at review. The proper backend feature is still on the release-readiness list.
