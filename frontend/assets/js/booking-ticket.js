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

  /* ---------------------------------------------------------------------
     FLIGHT E-TICKET — a server flight booking, drawn as an airline e-ticket.
     --------------------------------------------------------------------- */

  /** Server flights only: they have a record the QR can point at. Local demo
   *  bookings (the products with no backend) keep the generic document. */
  const isServerFlight = b => !!b && b.kind === 'flight' && b.demo === false;

  const apiBase = () => ((typeof API_BASE === 'string') ? API_BASE : '');

  /** The owner's ticket data: QR + verification link + company contact. */
  async function fetchEticket(b) {
    const auth = (typeof getCustomerAuth === 'function') ? getCustomerAuth() : {};
    const res = await fetch(`${apiBase()}/api/customer/bookings/${encodeURIComponent(b.id)}/ticket`, {
      headers: { Authorization: 'Bearer ' + (auth.access || '') },
    });
    if (!res.ok) throw new Error('ticket ' + res.status);
    const j = await res.json();
    return { qrSvg: j.qr_svg, verifyUrl: j.verify_url, company: j.company };
  }

  function lastPayment(b) {
    const list = b.payments || [];
    return list.length ? list[list.length - 1] : null;
  }

  function paymentLabel(b) {
    const p = lastPayment(b);
    if (!p) return 'Not paid';
    const st = String(p.status || '').toLowerCase();
    if (st === 'captured') return 'Paid';
    return st ? st.charAt(0).toUpperCase() + st.slice(1) : 'Pending';
  }

  function baggageFor(b, i) {
    const items = (b.addons || []).filter(a => String(a.type || '').toLowerCase() === 'baggage'
      && (a.passengerIndex == null || a.passengerIndex === i));
    return items.length ? items.map(a => a.name).join(', ') : '—';
  }

  const PLANE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';

  function flightTicketHtml(b) {
    const tk = b.eticket || {};
    const company = tk.company || { name: 'JackPots World Tours & Travels', email: 'support@jackpotsworldtours.com', phone: '+91 9177847799' };
    const status = String(b.status || 'Pending');
    const cancelled = /cancel/i.test(status);
    const paid = paymentLabel(b) === 'Paid';
    const origin = origin_(b), dest = dest_(b);

    const info = [
      ['Booking reference', b.id],
      ['PNR', b.pnr || 'Pending — issued by the airline'],
      ['Status', status],
      ['Payment', paymentLabel(b)],
      ['Booked on', fmt(b.bookedAt, true)],
      ['Travel date', fmt(b.travelDate)],
    ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

    const rows = (b.passengers || []).map((p, i) => `
      <tr><td>${i + 1}</td>
        <td>${esc([p.title, p.first, p.last].filter(Boolean).join(' '))}</td>
        <td>${esc(p.kind ? p.kind.charAt(0).toUpperCase() + p.kind.slice(1) : 'Adult')}</td>
        <td>${esc((b.seats && b.seats[i]) || p.seat || 'Assigned at check-in')}</td>
        <td>${esc(baggageFor(b, i))}</td></tr>`).join('');

    /* Every add-on actually on the booking: what it is, who it is for, what it cost.
       Nothing is listed when there are none. */
    const who = a => (a.passengerIndex == null ? 'All passengers'
      : esc([((b.passengers || [])[a.passengerIndex] || {}).first, ((b.passengers || [])[a.passengerIndex] || {}).last].filter(Boolean).join(' ') || 'Passenger ' + (a.passengerIndex + 1)));
    const addonRows = (b.addons || []).map(a => {
      const amt = Number(a.price || 0) * Number(a.quantity || 1);
      return `<tr><td>${esc(a.name)}</td><td>${who(a)}</td><td style="text-align:right">${amt ? esc(money(amt)) : 'Free'}</td></tr>`;
    }).join('');

    const lines = ((b.pricing || {}).lines || []);
    const fare = lines.map(l =>
      `<div class="fl"><span>${esc(l.label)}</span><b>${l.free ? 'Included' : (l.amount < 0 ? '−' : '') + esc(money(Math.abs(l.amount)))}</b></div>`).join('');

    const qr = tk.qrSvg
      ? `<div class="qr" aria-label="Ticket verification QR code">${tk.qrSvg}</div>`
      : `<div class="qr qr-none">Verification QR unavailable</div>`;

    return `
<style>
  *{box-sizing:border-box}
  :root{--navy:#0A2540;--gold:#B08A3E;--ink:#0A2540;--mute:#5B6B82;--line:rgba(10,37,64,.14)}
  body{margin:0;padding:20px;font-family:'Montserrat',system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--ink);background:#EEF1F5}
  .bar{max-width:820px;margin:0 auto 12px;display:flex;gap:10px;justify-content:flex-end}
  .bar button{font:700 13px 'Montserrat',system-ui,sans-serif;padding:9px 16px;border-radius:9px;border:1px solid var(--navy);cursor:pointer;background:var(--navy);color:#fff}
  .bar button.ghost{background:#fff;color:var(--navy)}
  .et{max-width:820px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 10px 34px rgba(10,37,64,.12)}
  .et-top{background:var(--navy);color:#fff;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid var(--gold)}
  .et-brand{display:flex;align-items:center;gap:14px;min-width:0}
  .et-brand img{height:54px;width:auto;flex:none}
  .et-brand h1{margin:0;font-size:16px;letter-spacing:.02em}
  .et-brand p{margin:3px 0 0;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#E8C777}
  .et-air{text-align:right}.et-air b{display:block;font-size:17px}.et-air span{font-size:12.5px;opacity:.8}
  .et-body{padding:22px 24px}
  .et h2{margin:24px 0 10px;font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);font-weight:800;padding-bottom:6px;border-bottom:1px solid var(--line)}
  .et h2:first-child{margin-top:0}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 18px}
  .grid div{display:flex;flex-direction:column;gap:3px;min-width:0}
  .grid span,.fl span{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}
  .grid b{font-size:14px;overflow-wrap:anywhere}
  .route{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:16px;padding:6px 0}
  .stop b.code{display:block;font-size:34px;line-height:1;letter-spacing:.02em}
  .stop .city{font-size:13px;color:var(--mute);margin-top:4px}.stop .t{font-size:20px;font-weight:800;margin-top:8px}
  .stop.to{text-align:right}
  .mid{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:150px;color:var(--gold)}
  .mid .ln{display:flex;align-items:center;width:100%;gap:8px}.mid .ln i{flex:1;height:0;border-top:2px dashed #C9B27A}
  .mid .ln svg{transform:rotate(90deg);flex:none}
  .mid small{font-size:11.5px;color:var(--mute);text-align:center;line-height:1.5}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);padding:7px 8px;border-bottom:1px solid var(--line)}
  td{padding:10px 8px;border-bottom:1px solid rgba(10,37,64,.07);overflow-wrap:break-word}
  .fares{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
  .fl{display:flex;flex-direction:column;gap:2px}.fl b{font-size:14px}
  .total{margin-top:14px;padding-top:12px;border-top:2px solid var(--navy);display:flex;justify-content:space-between;font-size:18px;font-weight:800}
  .foot{display:grid;grid-template-columns:auto 1fr;gap:22px;align-items:center;margin-top:24px;padding-top:18px;border-top:1px solid var(--line)}
  .qr{width:152px;height:152px;flex:none}.qr svg{width:100%;height:100%;display:block}
  .qr-none{display:grid;place-items:center;text-align:center;font-size:11.5px;color:var(--mute);border:1px dashed var(--line);border-radius:10px;padding:8px}
  .qr-cap{font-size:10.5px;color:var(--mute);margin-top:6px;max-width:152px;text-align:center}
  .badge{display:inline-block;padding:9px 18px;border-radius:999px;font-weight:800;font-size:15px;letter-spacing:.1em;text-transform:uppercase;border:2px solid}
  .badge.ok{color:#1E6B45;border-color:#1E6B45;background:#EAF6EF}
  .badge.warn{color:#9A6A12;border-color:#D9A32C;background:#FFF6E0}
  .badge.bad{color:#B3252F;border-color:#B3252F;background:#FDECEE}
  .pay{margin-top:10px;font-size:12.5px;color:var(--mute)}
  .note{margin-top:16px;padding:11px 14px;border:1px dashed #D9A32C;border-radius:10px;font-size:12px;color:#7a5a12;background:#FFFBF0}
  .cancelled-note{background:#FDECEE;border-color:#B3252F;color:#8d1d26;font-weight:700}
  .info{font-size:11.5px;color:var(--mute);line-height:1.6;margin:0;padding-left:18px}
  .contact{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--mute);display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 18px}
  .contact b{color:var(--ink)}
  @media (max-width:640px){
    body{padding:10px}.et-top{flex-direction:column;align-items:flex-start}.et-air{text-align:left}
    .grid{grid-template-columns:repeat(2,1fr)}.route{grid-template-columns:1fr;gap:10px}.stop.to{text-align:left}
    .mid{min-width:0;width:100%}
    .foot{grid-template-columns:1fr;justify-items:center;text-align:center}
    .et-body{padding:18px 14px}.stop b.code{font-size:28px}th,td{padding:8px 4px;font-size:12px}
  }
  @page{size:A4;margin:10mm}
  @media print{
    body{background:#fff;padding:0}.bar{display:none}.et{box-shadow:none;border:1px solid var(--line);max-width:none}
    /* Tighter for paper so a typical ticket lands on one A4 page; a longer one flows to a second page between rows, never through one. */
    .et-top{padding:12px 18px}.et-brand img{height:42px}.et-body{padding:14px 18px}
    .et h2{margin:14px 0 6px;padding-bottom:4px}.grid{gap:8px 14px}.grid b{font-size:13px}
    .stop b.code{font-size:28px}.stop .t{font-size:17px;margin-top:4px}.route{padding:0}
    th{padding:5px 8px}td{padding:5px 8px;font-size:12px}.fares{gap:8px}.total{margin-top:8px;padding-top:8px;font-size:16px}
    .foot{margin-top:12px;padding-top:12px}.qr{width:128px;height:128px}.qr-cap{max-width:128px}
    .note{margin-top:8px;padding:7px 10px}.info{line-height:1.45}.contact{margin-top:10px;padding-top:8px}
    tr,.foot,.note,.route,h2{break-inside:avoid}h2{break-after:avoid}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
</style>
<div class="bar"><button type="button" class="ghost" onclick="window.print()">Print ticket</button>
  <button type="button" onclick="window.print()">Download PDF</button></div>
<div class="et">
  <div class="et-top">
    <div class="et-brand">
      <img src="${esc((typeof location !== 'undefined' ? location.origin : '') + '/assets/images/jackpots-logo-full.png')}" alt="JackPots World">
      <div><h1>JackPots World Tours &amp; Travels</h1><p>Airline / Flight ticket</p></div>
    </div>
    <div class="et-air"><b>${esc(b.airline || b.title || '')}</b><span>${esc(b.flightNumber || '')}</span></div>
  </div>
  <div class="et-body">
    <h2>Booking information</h2>
    <div class="grid">${info}</div>

    <h2>Flight itinerary</h2>
    <div class="route">
      <div class="stop"><b class="code">${esc(origin.code)}</b><div class="city">${esc(origin.city)}</div><div class="t">${esc(b.departure || '—')}</div></div>
      <div class="mid"><div class="ln"><i></i>${PLANE}<i></i></div>
        <small>${esc(fmt(b.travelDate))}<br>${esc(b.durationLabel || '')}${b.stops ? ' · ' + esc(b.stops) + ' stop' + (b.stops > 1 ? 's' : '') : (b.durationLabel ? ' · Non-stop' : '')}${b.cabinClass ? '<br>' + esc(String(b.cabinClass).replace(/\w/g, c => c.toUpperCase())) : ''}</small></div>
      <div class="stop to"><b class="code">${esc(dest.code)}</b><div class="city">${esc(dest.city)}</div><div class="t">${esc(b.arrival || '—')}</div></div>
    </div>

    <h2>Passenger details</h2>
    <table><thead><tr><th>No.</th><th>Passenger name</th><th>Type</th><th>Seat</th><th>Baggage</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">—</td></tr>'}</tbody></table>

    ${addonRows ? `<h2>Add-ons &amp; services</h2>
    <table><thead><tr><th>Item</th><th>For</th><th style="text-align:right">Amount</th></tr></thead><tbody>${addonRows}</tbody></table>` : ''}

    <h2>Fare details</h2>
    <div class="fares">${fare}</div>
    <div class="total"><span>${paid ? 'Total paid' : 'Total amount'}</span><span>${esc(money(b.total))}</span></div>

    <div class="foot">
      <div>${qr}<div class="qr-cap">Scan to verify this ticket</div></div>
      <div>
        <span class="badge ${cancelled ? 'bad' : /confirm|complete/i.test(status) ? 'ok' : 'warn'}">${esc(cancelled ? 'Cancelled' : status)}</span>
        <div class="pay">Payment: <b>${esc(paymentLabel(b))}</b></div>
      </div>
    </div>
    ${cancelled ? '<div class="note cancelled-note">This booking has been cancelled. This ticket is no longer valid for travel.</div>'
      : (!paid ? '<div class="note">Payment has not been completed, so this booking is not confirmed for travel.</div>' : '')}
    ${!b.pnr && !cancelled ? '<div class="note">This booking has not been ticketed by the airline yet — the PNR will be issued on ticketing.</div>' : ''}

    <h2>Important travel information</h2>
    <ul class="info">
      <li>Carry a valid government photo ID matching the passenger name; international travel needs a valid passport.</li>
      <li>Reach the airport at least 2 hours before domestic and 3 hours before international departures.</li>
      <li>Baggage allowance, check-in and boarding times are set by the airline and may change.</li>
    </ul>
    <div class="contact"><span><b>${esc(company.name)}</b></span><span>${esc(company.email)}</span><span>${esc(company.phone)}</span></div>
  </div>
</div>`;
  }

  function origin_(b) {
    const parts = String(b.subtitle || '').split('→').map(x => x.trim());
    return { code: b.originCode || '', city: b.originCity || parts[0] || '' };
  }
  function dest_(b) {
    const parts = String(b.subtitle || '').split('→').map(x => x.trim());
    return { code: b.destinationCode || '', city: b.destinationCity || parts[1] || '' };
  }

  /** The ticket itself. Self-contained markup + styles so it survives being
   *  written into a blank print window with nothing else loaded. */
  function documentHtml(b) {
    if (isServerFlight(b)) return flightTicketHtml(b);
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
      /* A server booking has no PNR until an airline issues one. Saying so
         beats omitting the row: a ticket with no PNR line at all reads as
         though one was forgotten, rather than as one that is genuinely
         still to come. Local demo bookings keep their generated PNR. */
      b.pnr ? ['PNR', b.pnr]
            : (b.demo === false ? ['PNR', 'Pending — issued by the airline on ticketing'] : null),
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
  .tk-demo{margin:22px 0 0;padding:12px 14px;border:1px dashed #D9A32C;border-radius:10px;color:#B3252F;font-size:12px;font-weight:700}
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

  /** Open the ticket in its own window, ready to print or save as PDF.
   *
   *  The window is opened BEFORE anything is fetched: a pop-up opened after an
   *  await is no longer "from a click" and is blocked. A server flight then
   *  fetches its QR + verification link and draws the e-ticket into that window. */
  function openPrintable(b, autoPrint) {
    const w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) {
      toast('Allow pop-ups for this site to download or print the ticket.', true);
      return null;
    }
    const head = `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Ticket ${esc(b.id)} — JackPots World</title>
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
      </head><body>`;
    const paint = booking => {
      w.document.open();
      w.document.write(head + documentHtml(booking) + '</body></html>');
      w.document.close();
      if (autoPrint) w.addEventListener('load', () => setTimeout(() => w.print(), 350));
    };
    if (!isServerFlight(b)) { paint(b); return w; }

    w.document.write(head + '<p style="font:14px system-ui;padding:24px">Preparing your ticket…</p></body></html>');
    w.document.close();
    fetchEticket(b)
      .then(tk => paint(Object.assign({}, b, { eticket: tk })))
      .catch(() => {
        w.document.open();
        w.document.write(head + '<p style="font:14px system-ui;padding:24px;color:#B3252F">We could not load your ticket. Please close this window and try again.</p></body></html>');
        w.document.close();
      });
    return w;
  }

  function toast(msg, isError) {
    if (typeof showToast === 'function') showToast(msg, isError);
    else alert(msg);
  }

  function handle(action, booking) {
    if (!booking) return;
    if (action === 'view') {
      openPrintable(booking, false);
    } else if (action === 'download') {
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
