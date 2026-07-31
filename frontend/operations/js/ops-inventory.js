'use strict';
/* Operations Portal — Flights, Hotels, Cruises, Packages.
   ===========================================================================
   Four sidebar entries, one module: the only difference between them is
   `travel_type`, which is a single query parameter on two endpoints. Each
   section is two views over the same travel type:

     Inventory   GET /api/catalog/search   requires ticket.enquiry
     Bookings    GET /api/requests         requires ticket.view

   Both tabs are permission-gated independently, which matters: an ADMIN holds
   ticket.view but NOT ticket.enquiry (see rbac._ADMIN — enquiry and request
   belong to the merchant roles), so an admin opening Flights gets the bookings
   register and no inventory search, while a merchant operator gets both. The
   alternative — one nav item that 403s for half the staff — is what this
   avoids.

   A flight row and a hotel row genuinely describe different things, so each
   travel type gets its own columns rather than a lowest-common-denominator
   table with half the cells empty. Field names come from the `details` JSONB
   the catalog rows actually carry.
   =========================================================================== */

const OPS_TRAVEL_SECTIONS = {
  flights: 'flight',
  hotels: 'hotel',
  cruises: 'cruise',
  packages: 'package',
};

/* Per-type search criteria. Fields the API discards for a type are hidden
   rather than sent empty — offering a cabin class on a hotel search invites
   input that silently does nothing. */
const OPS_INV_FIELDS = {
  flight: ['origin', 'destination', 'travel_date', 'passengers', 'cabin_class', 'airline', 'max_price', 'q'],
  hotel: ['destination', 'travel_date', 'passengers', 'max_price', 'q'],
  cruise: ['origin', 'destination', 'travel_date', 'passengers', 'cabin_class', 'max_price', 'q'],
  package: ['destination', 'travel_date', 'passengers', 'max_price', 'q'],
};

const OPS_INV_LABELS = {
  flight: { destination: 'Destination', travel_date: 'Travel date', passengers: 'Passengers' },
  hotel: { destination: 'City', travel_date: 'Check-in', passengers: 'Guests' },
  cruise: { destination: 'Destination', travel_date: 'Sailing date', passengers: 'Passengers' },
  package: { destination: 'Destination', travel_date: 'Departure', passengers: 'Travellers' },
};

function opsInitTravel(section) {
  const travelType = OPS_TRAVEL_SECTIONS[section];
  const host = $(`ops-${section}`);
  const noun = OPS_TITLES[section];

  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>${escapeHtml(noun)}</h1>
        <p>${escapeHtml(opsCan('ticket.enquiry')
          ? `Search live ${travelType} inventory at contracted fares, or review every ${travelType} booking on file.`
          : `Every ${travelType} booking on file. Inventory search requires the ticket.enquiry permission, which platform staff accounts do not hold.`)}</p>
      </div>
    </div>
    <div id="ops-${section}-tabs"></div>`;

  OpsTabs($(`ops-${section}-tabs`), [
    {
      id: 'inventory', label: 'Inventory search', when: opsCan('ticket.enquiry'),
      render: body => opsInventoryGrid(body, travelType),
    },
    {
      id: 'bookings', label: 'Bookings', when: opsCan('ticket.view'),
      render: body => opsTravelBookingsGrid(body, travelType),
    },
  ], { hash: section });
}

/* ========================================================= INVENTORY ===== */

function opsInvColumns(travelType, paxRef) {
  const d = r => r.details || {};
  const common = [
    {
      key: '_amount', label: 'Amount', align: 'right', nowrap: true,
      /* Hotel rates are for the whole stay per room; everything else is per
         passenger. The unit is printed in the cell because a bare number here
         is how a multi-guest quote gets misread. */
      render: r => {
        const unit = travelType === 'hotel' ? '/stay' : '/pax';
        const pax = paxRef() || 1;
        const total = travelType === 'hotel' || pax === 1
          ? '' : `<small class="ops-muted" style="display:block">${money(Number(r.total_amount) * pax)} total</small>`;
        return `${money(Number(r.total_amount))}<small class="ops-muted">${unit}</small>${total}`;
      },
      text: r => String(r.total_amount ?? ''),
      sortValue: r => Number(r.total_amount),
    },
    {
      key: 'available_units', label: 'Availability', nowrap: true,
      render: r => {
        const u = r.available_units;
        if (u == null) return '<span class="ops-muted">—</span>';
        return u <= 5 ? `<span class="ops-tag ops-tag-warn">Only ${u} left</span>` : `${u} available`;
      },
      text: r => (r.available_units == null ? '' : String(r.available_units)),
      sortValue: r => r.available_units,
    },
  ];
  const act = OpsCol.actions([
    { act: 'select', label: 'Select', primary: true, when: () => opsCan('ticket.request') },
    { act: 'quote', label: 'Quote' },
  ]);

  if (travelType === 'hotel') {
    return [
      { key: 'hotel', label: 'Hotel', value: r => d(r).hotel_name || r.title },
      { key: 'city', label: 'City', value: r => [d(r).destination_city || d(r).destination, d(r).country].filter(Boolean).join(', ') },
      { key: 'stars', label: 'Rating', value: r => (d(r).star_rating ? `${d(r).star_rating}★` : '') },
      { key: 'room', label: 'Room', value: r => d(r).room_type },
      { key: 'nights', label: 'Nights', value: r => d(r).nights, align: 'right' },
      OpsCol.date('travel_date', 'Check-in'),
      ...common, act,
    ];
  }
  if (travelType === 'cruise') {
    return [
      { key: 'cruise', label: 'Cruise', value: r => d(r).cruise_name || r.title },
      { key: 'line', label: 'Line', value: r => d(r).cruise_line },
      { key: 'route', label: 'Route', value: r => opsSector(r) },
      { key: 'nights', label: 'Nights', value: r => d(r).nights, align: 'right' },
      { key: 'cabin', label: 'Cabin', value: r => opsLabel(d(r).cabin_class) },
      OpsCol.date('travel_date', 'Sails'),
      ...common, act,
    ];
  }
  if (travelType === 'package') {
    return [
      { key: 'package', label: 'Package', value: r => d(r).package_name || r.title },
      { key: 'dest', label: 'Destination', value: r => [d(r).destination_city || d(r).destination, d(r).country].filter(Boolean).join(', ') },
      { key: 'nights', label: 'Nights', value: r => d(r).nights, align: 'right' },
      {
        key: 'inclusions', label: 'Inclusions',
        value: r => [d(r).meal_plan, d(r).hotels_included && 'Hotels', d(r).flights_included && 'Flights']
          .filter(Boolean).join(', '),
      },
      OpsCol.date('travel_date', 'Departs'),
      ...common, act,
    ];
  }
  return [
    { key: 'airline', label: 'Airline', value: r => d(r).airline },
    { key: 'flight', label: 'Flight', value: r => d(r).flight_number, nowrap: true },
    { key: 'route', label: 'Route', value: r => opsSector(r) || [d(r).origin, d(r).destination].filter(Boolean).join(' → ') },
    {
      key: 'dep', label: 'Departs', nowrap: true,
      render: r => (d(r).departure_time ? escapeHtml(fmtTime(d(r).departure_time)) : '<span class="ops-muted">—</span>'),
      text: r => d(r).departure_time || '',
    },
    {
      key: 'arr', label: 'Arrives', nowrap: true,
      render: r => (d(r).arrival_time ? escapeHtml(fmtTime(d(r).arrival_time)) : '<span class="ops-muted">—</span>'),
      text: r => d(r).arrival_time || '',
    },
    { key: 'duration', label: 'Duration', value: r => d(r).duration || d(r).duration_text, nowrap: true },
    { key: 'cabin', label: 'Cabin', value: r => opsLabel(d(r).cabin_class) },
    OpsCol.date('travel_date', 'Date'),
    ...common, act,
  ];
}

function opsInventoryGrid(host, travelType) {
  const fields = OPS_INV_FIELDS[travelType];
  const lab = OPS_INV_LABELS[travelType];
  const has = f => fields.includes(f);

  const filters = [];
  if (has('origin')) filters.push({ key: 'origin', label: 'Origin', type: 'text', placeholder: 'City or IATA' });
  if (has('destination')) filters.push({ key: 'destination', label: lab.destination, type: 'text', placeholder: 'City or IATA' });
  if (has('travel_date')) filters.push({ key: 'travel_date', label: lab.travel_date, type: 'date' });
  if (has('passengers')) filters.push({ key: 'passengers', label: lab.passengers, type: 'number', placeholder: '1' });
  if (has('cabin_class')) filters.push({ key: 'cabin_class', label: 'Cabin', type: 'select', options: OPS_CABINS, anyLabel: 'Any' });
  if (has('airline')) filters.push({ key: 'airline', label: 'Airline', type: 'text', placeholder: 'e.g. IndiGo' });
  if (has('max_price')) filters.push({ key: 'max_price', label: 'Max ₹', type: 'number', placeholder: 'No cap' });

  let grid = null;
  const pax = () => Number(grid?.state.filterValues.passengers) || 1;

  grid = OpsGrid({
    id: `inv-${travelType}`,
    mount: host,
    title: `${opsLabel(travelType)} inventory`,
    exportName: `${travelType}-inventory`,
    mode: 'client',   /* /api/catalog/search has no `search` param, only `q` */
    searchPlaceholder: 'Filter loaded rows…',
    filters,
    filterDefaults: { passengers: 1 },
    columns: opsInvColumns(travelType, () => pax()),
    pageSize: 25,
    note: `Filters the API accepts for inventory: travel type, origin, destination, date,
           cabin, passengers, max price, airline and a keyword. There is no stop-count,
           star-rating, amenity or refundable filter — use the search box above to narrow
           the rows already loaded.`,
    emptyText: 'No inventory matches these criteria. Widen the date or drop the price cap.',
    fetch: async ({ filters: f, search }) => {
      const params = { travel_type: travelType, page_size: OPS_PAGE_MAX };
      ['origin', 'destination', 'travel_date', 'cabin_class', 'airline'].forEach(k => {
        if (f[k]) params[k] = f[k];
      });
      if (f.passengers) params.passengers = Number(f.passengers);
      if (f.max_price) params.max_price = Number(f.max_price);
      /* The API's own keyword search, which is not the same thing as the grid's
         client-side row filter — this one reaches the whole catalog. */
      if (search) params.q = search;
      const d = await OpsApi.searchCatalog(params);
      return { rows: d.items || [], total: d.total ?? (d.items || []).length };
    },
    actions: {
      select: row => opsQuoteAndStart(row.id, pax()),
      quote: row => opsShowQuote(row.id, pax()),
    },
  });
  return grid;
}

/* Price the row for this party size, then hand the quote to the request form.
   Two calls in the same order the API expects: quote, then create. */
async function opsQuoteAndStart(itemId, passengers) {
  if (!opsCan('ticket.request')) return opsToast('Your account cannot raise requests.', 'err');
  try {
    const quote = await OpsApi.quote(itemId, passengers);
    opsStartRequestFrom(quote, passengers);
  } catch (err) {
    opsToast(opsError(err, 'Could not price this option.'), 'err');
  }
}

async function opsShowQuote(itemId, passengers) {
  const body = opsOpenModal('Price quote', opsSpinner('Pricing…'),
    '<span class="ops-spacer"></span><button type="button" class="ops-btn" id="opsQuoteClose">Close</button>');
  $('opsQuoteClose').addEventListener('click', opsCloseModal);
  try {
    const q = await OpsApi.quote(itemId, passengers);
    body.innerHTML = opsQuoteTable(q) + `
      <p class="ops-field-hint" style="margin-top:8px">
        A quote is not a commitment. The payable amount is fixed by the approvals team,
        which may set a final amount that differs from this figure.</p>`;
  } catch (err) {
    body.innerHTML = `<div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Pricing failed.'))}</div>`;
  }
}

function opsQuoteTable(q) {
  const fees = Number(q.service_fee || q.fees || 0);
  return `
    <dl class="ops-dl">
      <div><dt>Item</dt><dd>${escapeHtml(q.item?.title || '—')}</dd></div>
      <div><dt>Type</dt><dd>${escapeHtml(opsLabel(q.item?.travel_type))}</dd></div>
      <div><dt>Date</dt><dd>${escapeHtml(fmtDate(q.item?.travel_date))}</dd></div>
      <div><dt>Party size</dt><dd>${escapeHtml(String(q.passengers))}</dd></div>
    </dl>
    <table class="ops-table" style="margin-top:10px">
      <tbody>
        <tr><td>Base fare <span class="ops-muted">× ${escapeHtml(String(q.passengers))}</span></td>
            <td class="ops-num">${money(Number(q.base_fare))}</td></tr>
        <tr><td>Taxes &amp; surcharges <span class="ops-muted">× ${escapeHtml(String(q.passengers))}</span></td>
            <td class="ops-num">${money(Number(q.taxes))}</td></tr>
        ${fees ? `<tr><td>Service fee</td><td class="ops-num">${money(fees)}</td></tr>` : ''}
        <tr><td>Per passenger</td><td class="ops-num">${money(Number(q.per_passenger))}</td></tr>
        <tr><td><b>Total</b></td><td class="ops-num"><b>${money(Number(q.total))}</b></td></tr>
      </tbody>
    </table>`;
}

/* ========================================================== BOOKINGS ===== */

/* The same register as the Bookings section, narrowed to one travel type.
   Built from the shared factory in ops-requests.js so the columns, the detail
   drawer and the lifecycle actions cannot drift between the two entry points. */
function opsTravelBookingsGrid(host, travelType) {
  return opsBuildRequestGrid(host, {
    id: `bookings-${travelType}`,
    title: `${opsLabel(travelType)} bookings`,
    exportName: `${travelType}-bookings`,
    fixed: { request_type: 'booking', travel_type: travelType },
    showTypeColumn: false,
    showTravelColumn: false,
  });
}
