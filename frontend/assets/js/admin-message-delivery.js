/* Admin — Delivery Failures (M5)
   ==============================
   The screen that satisfies M5's last requirement: "a bounced or failed send is
   visible to staff, not silently swallowed."

   WHY THERE WAS NOTHING TO SHOW BEFORE
   Until M5 no email send wrote a `msg_logs` row. Password reset and OTP called
   the mail layer directly and recorded nothing, so a refused send and a
   successful one were equally invisible. Every send now writes its attempt with
   the outcome, and this lists the ones that failed.

   READ THIS BEFORE CALLING IT AN OUTAGE
   In an environment with no SMTP configured, EVERY attempt is recorded failed
   with "SMTP is not configured…". That is the platform being honest rather than
   pretending mail went out — it is what the panel's own subtitle says, so an
   operator does not raise a ticket about it.

   ENDPOINTS
     GET /api/admin/messages/counts   badge figures, one grouped query
     GET /api/admin/messages/failed   the list, newest first
   Both require `notification.send` — staff only. `notification.view` is every
   merchant's own bell and would have exposed other companies' recipients.
*/

let mdPage = 1;

function mdEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function mdWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

async function mdLoadCounts() {
  try {
    const { data } = await axios.get(
      `${API_BASE}/api/admin/messages/counts`, { headers: authHeaders() });
    const el = document.getElementById('mdFailSummary');
    if (!el) return;
    const byType = Object.entries(data.by_type || {})
      .map(([k, v]) => `${v} ${k}`).join(' · ');
    el.textContent = data.failed_total
      ? `${data.failed_total} failed${byType ? ` — ${byType}` : ''}`
      : 'Nothing has failed.';
  } catch { /* the list below reports its own error; one message is enough */ }
}

async function mdLoadFailed() {
  const tbody = document.querySelector('#mdFailTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
  try {
    const { data } = await axios.get(
      `${API_BASE}/api/admin/messages/failed?page=${mdPage}&page_size=20`,
      { headers: authHeaders() });

    tbody.innerHTML = data.items.length ? data.items.map(m => `
      <tr>
        <td>${mdEsc(mdWhen(m.created_at))}</td>
        <td>${mdEsc(m.message_type)}</td>
        <td>${mdEsc(m.recipient)}</td>
        <td>${mdEsc(m.subject || '—')}</td>
        <td class="ops-sub">${mdEsc(m.error_message || '—')}</td>
      </tr>`).join('')
      : '<tr><td colspan="5" class="ops-sub">No failed deliveries.</td></tr>';

    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    const pag = document.getElementById('mdFailPagination');
    pag.innerHTML = pages > 1
      ? `<button type="button" class="btn btn-sm" id="mdPrev" ${mdPage <= 1 ? 'disabled' : ''}>Previous</button>
         <span class="ops-sub">Page ${data.page} of ${pages} · ${data.total} total</span>
         <button type="button" class="btn btn-sm" id="mdNext" ${mdPage >= pages ? 'disabled' : ''}>Next</button>`
      : `<span class="ops-sub">${data.total} total</span>`;
    document.getElementById('mdPrev')?.addEventListener('click', () => { mdPage--; mdLoadFailed(); });
    document.getElementById('mdNext')?.addEventListener('click', () => { mdPage++; mdLoadFailed(); });
  } catch (err) {
    const detail = err?.response?.data?.detail || 'Could not load delivery failures.';
    tbody.innerHTML = `<tr><td colspan="5" class="msg error">${mdEsc(detail)}</td></tr>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('[data-section="notifications"]')?.addEventListener('click', () => {
    setTimeout(() => { mdPage = 1; mdLoadCounts(); mdLoadFailed(); }, 0);
  });
});
