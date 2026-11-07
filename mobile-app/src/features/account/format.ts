/**
 * "21 Oct, 3:42 pm" for a timestamp the server sent, in the phone's own locale
 * and time zone. An unparseable value reads as an em dash rather than "Invalid Date".
 */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const day = date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

/** What a session was, in the customer's words: "Chrome on Windows", or whatever the server recorded. */
export function describeSession(s: { browser: string | null; device: string | null }): string {
  const browser = s.browser?.trim();
  const device = s.device?.trim();
  if (browser && device) return `${browser} on ${device}`;
  return browser || device || 'A device';
}
