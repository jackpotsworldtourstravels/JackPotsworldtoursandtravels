'use strict';
/* ===========================================================================
   booking-ticket.js — the ticket document, and what the confirmation buttons do.
   ===========================================================================
   Download / Print / Email all render the SAME document, so what someone saves
   is what they see and what they would have been sent.

   WHY THERE IS NO PDF LIBRARY. "Download ticket (demo PDF)" is served by
   printing to PDF — the browser's own print pipeline, which every OS exposes as
   "Save as PDF". Adding jsPDF or pdfmake would be ~300KB to reproduce, worse,
   something the platform already does. The download button therefore opens the
   print dialogue with a print-styled ticket; the saved file is a real PDF.

   Email is simulated and says so. Wiring a real send would need an endpoint and
   a template, and quietly doing nothing behind a button labelled "Email" is
   the one outcome worse than saying it is a demo.
   =========================================================================== */

const BookingTicket = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  function fmt(iso, withTime) {
    if (!iso) return '—';
    const d = new Date(iso.length > 10 ? iso : iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    const date = d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    return withTime ? `${date}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : date;
  }

  /** The ticket itself. Self-contained markup + styles so it survives being
   *  written into a blank print window with nothing else loaded. */
  function documentHtml(b) {
    const rows = (b.passengers || []).map((p, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(p.title)} ${esc(p.first)} ${esc(p.last)}</td>
        <td>${esc(p.kind || 'Adult')}</td>
        <td>${esc((b.seats && b.seats[i]) || '—')}</td>
        <td>${esc(p.passportNumber || '—')}</td>
      </tr>`).join('');

    const refs = [
      ['Booking reference', b.id],
      b.pnr ? ['PNR', b.pnr] : null,
      b.ticketNumber ? ['Ticket number', b.ticketNumber] : null,
      ['Status', b.status],
      ['Booked on', fmt(b.bookedAt, true)],
      ['Travel date', fmt(b.travelDate)],
    ].filter(Boolean).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

    const addons = (b.addons || []).length
      ? (b.addons || []).map(a => `<li>${esc(a.name)}<span>${a.price ? esc(money(a.price)) : 'Free'}</span></li>`).join('')
      : '<li>None<span>—</span></li>';

    const fare = ((b.pricing || {}).lines || []).map(l =>
      `<div><span>${esc(l.label)}</span><b>${l.free ? 'Included' : esc(money(l.amount))}</b></div>`).join('');

    return `
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:28px;font-family:'Montserrat',system-ui,-apple-system,'Segoe UI',sans-serif;color:#0A2540;background:#fff}
  .tk{max-width:760px;margin:0 auto;border:1px solid rgba(10,37,64,.14);border-radius:14px;overflow:hidden}
  .tk-top{background:#0A2540;color:#fff;padding:20px 24px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .tk-top h1{margin:0 0 4px;font-size:19px}
  .tk-top p{margin:0;font-size:12.5px;opacity:.75}
  .tk-kind{background:rgba(255,255,255,.16);padding:5px 12px;border-radius:999px;font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}
  .tk-body{padding:22px 24px}
  h2{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:#5B6B82;margin:22px 0 10px}
  h2:first-child{margin-top:0}
  .tk-refs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .tk-refs div,.tk-fare div{display:flex;flex-direction:column;gap:2px}
  .tk-refs span,.tk-fare span{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#5B6B82}
  .tk-refs b{font-size:15px;font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#5B6B82;padding:7px 8px;border-bottom:1px solid rgba(10,37,64,.12)}
  td{padding:9px 8px;border-bottom:1px solid rgba(10,37,64,.07)}
  ul{list-style:none;margin:0;padding:0;font-size:13px}
  ul li{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(10,37,64,.07)}
  .tk-fare{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .tk-total{margin-top:16px;padding-top:14px;border-top:2px solid #0A2540;display:flex;justify-content:space-between;font-size:17px;font-weight:800}
  .tk-demo{margin:22px 0 0;padding:12px 14px;border:1px dashed #FF4D4D;border-radius:10px;color:#B3252F;font-size:12px;font-weight:700}
  @media print{ body{padding:0} .tk{border:none} }
</style>
<div class="tk">
  <div class="tk-top">
    <div>
      <h1>JackPots World Tours &amp; Travels</h1>
      <p>${esc(b.title || '')}${b.subtitle ? ' — ' + esc(b.subtitle) : ''}</p>
    </div>
    <span class="tk-kind">${esc(b.kindLabel || b.kind)}</span>
  </div>
  <div class="tk-body">
    <h2>Booking</h2>
    <div class="tk-refs">${refs}</div>

    <h2>Travellers</h2>
    <table>
      <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Seat</th><th>Passport</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">—</td></tr>'}</tbody>
    </table>

    <h2>Add-ons</h2>
    <ul>${addons}</ul>

    <h2>Fare</h2>
    <div class="tk-fare">${fare}</div>
    <div class="tk-total"><span>Total paid</span><span>${esc(money(b.total))}</span></div>

    <p class="tk-demo">DEMO BOOKING — this document is generated by a demonstration
       environment. No payment has been taken and no airline, hotel or operator
       has issued a reservation against it.</p>
  </div>
</div>`;
  }

  /** Open the ticket in its own window, ready to print or save as PDF. */
  function openPrintable(b, autoPrint) {
    const w = window.open('', '_blank', 'width=860,height=1000');
    if (!w) {
      toast('Allow pop-ups for this site to download or print the ticket.', true);
      return null;
    }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
      <title>Ticket ${esc(b.id)} — JackPots World</title>
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
      </head><body>${documentHtml(b)}</body></html>`);
    w.document.close();
    if (autoPrint) {
      /* Wait for the webfont, or the first paint prints in a fallback face. */
      w.addEventListener('load', () => setTimeout(() => w.print(), 350));
    }
    return w;
  }

  function toast(msg, isError) {
    if (typeof showToast === 'function') showToast(msg, isError);
    else alert(msg);
  }

  function handle(action, booking) {
    if (!booking) return;
    if (action === 'download') {
      openPrintable(booking, true);
      toast('Choose "Save as PDF" in the print dialogue to download the ticket.');
    } else if (action === 'print') {
      openPrintable(booking, true);
    } else if (action === 'email') {
      const to = (booking.passengers && booking.passengers[0] && booking.passengers[0].email) || 'your email';
      toast(`Demo: the ticket for ${booking.id} would be emailed to ${to}.`);
    }
  }

  return { handle, documentHtml, openPrintable };
})();
