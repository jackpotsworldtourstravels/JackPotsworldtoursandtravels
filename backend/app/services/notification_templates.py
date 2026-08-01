"""The email layout every lifecycle message is rendered into (M5).

WHY ONE LAYOUT AND NOT ONE TEMPLATE PER EVENT
The roadmap asks for "templates rendered server-side" for submitted, approved,
rejected, payment verified, ticket issued, cancellation and reschedule. Those
events already write their own copy at the point they happen — a title and a
sentence in the vocabulary of that workflow, which the merchant reads in-app
today. Writing thirty separate email bodies would duplicate all of it, and the
duplicate is what goes stale: the in-app text gets corrected during a change
request and the email keeps saying last month's thing.

So the template is the **layout** — branding, greeting, the reference, the call
to action, the footer, the plain-text alternative — and the event supplies the
words. The email and the notification cannot disagree, because they are the same
sentence.

NO SECRETS, EVER
Nothing here interpolates a token, a password, an OTP or a full payment
instrument. The events this renders are lifecycle facts: a reference, a status,
an amount. `verify_m5.py` asserts it on the rendered output rather than trusting
this paragraph.

PLAIN TEXT IS NOT OPTIONAL
Every message goes out ``multipart/alternative``. A plain-text part is what
makes a message readable in a client that will not render HTML, and its absence
is a strong spam signal — a transactional mail that lands in spam has failed
whatever the SMTP conversation said.
"""
import html as _html
import re

#: Kept in one place so the wording can be corrected without hunting through
#: the services that raise these events.
BRAND = "JackPots World Tours & Travels"
SUPPORT_LINE = "If you were not expecting this message, reply to this email and we will look into it."

#: Events whose mail is worth flagging as needing action rather than just
#: informing. Used only to choose the call-to-action wording.
_ACTION_EVENTS = {
    "booking_submitted", "booking_returned", "payment_pending",
    "topup_rejected", "credit_blocked",
}


def _strip(text: str) -> str:
    """Collapse whitespace so a message written across source lines reads as a
    paragraph rather than inheriting the source file's line breaks."""
    return re.sub(r"\s+", " ", (text or "").strip())


def subject_for(title: str, reference: str | None) -> str:
    """``[REQ-2026-000123] Your ticket has been issued``.

    The reference goes **first**: a merchant with forty booking emails sorts and
    searches on it, and a subject that buries it behind the same six words on
    every message is one they cannot scan.
    """
    title = _strip(title) or "Update"
    return f"[{reference}] {title}" if reference else f"{title} — {BRAND}"


def render(
    title: str, message: str, *, reference: str | None = None,
    event: str | None = None, action_label: str | None = None,
) -> tuple[str, str, str]:
    """Return ``(subject, text_body, html_body)`` for one lifecycle message."""
    title = _strip(title) or "Update"
    body = _strip(message)
    subject = subject_for(title, reference)

    cta = action_label or (
        "Sign in to your portal to act on this."
        if event in _ACTION_EVENTS else
        "You can see the full details in your portal."
    )

    ref_line = f"Reference: {reference}\n" if reference else ""
    text_body = (
        f"{title}\n"
        f"{'=' * len(title)}\n\n"
        f"{body}\n\n"
        f"{ref_line}"
        f"{cta}\n\n"
        f"--\n{BRAND}\n{SUPPORT_LINE}\n"
    )

    e_title, e_body, e_cta = (_html.escape(x) for x in (title, body, cta))
    e_ref = _html.escape(reference) if reference else None
    html_body = f"""\
<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#f4f5f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#ffffff;border-radius:10px;
                    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="padding:20px 24px;border-bottom:1px solid #e6e8eb;">
          <span style="font-size:15px;font-weight:700;color:#1a1a1a;">{_html.escape(BRAND)}</span>
        </td></tr>
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:18px;line-height:1.35;color:#1a1a1a;">{e_title}</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#3c4043;">{e_body}</p>
          {f'<p style="margin:0 0 16px;font-size:13px;color:#5f6368;">Reference: <strong style="color:#1a1a1a;">{e_ref}</strong></p>' if e_ref else ''}
          <p style="margin:0;font-size:14px;line-height:1.6;color:#3c4043;">{e_cta}</p>
        </td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e6e8eb;
                       font-size:12px;line-height:1.5;color:#80868b;">
          {_html.escape(SUPPORT_LINE)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""
    return subject, text_body, html_body
