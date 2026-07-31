'use strict';
/* Merchant Home — result filters and sorting.
   ---------------------------------------------------------------------------
   Filtering is CLIENT-SIDE and deliberately so. GET /api/catalog/search accepts
   travel_type / origin / destination / travel_date / cabin_class / passengers /
   max_price / airline / q and nothing else — there is no stops, star-rating,
   amenity, duration or departure-window parameter, and adding one would be a
   backend change this pass excludes. So the search call is unchanged and the
   page it returns is narrowed here.

   Every filter is FACET-DRIVEN: a group renders only when the returned
   inventory actually distinguishes on it. That is not just tidiness — the
   seeded catalog carries no refundable/fare-type or free-cancellation key
   (see 0027_seed_catalog_inventory.py), so those groups stay hidden instead of
   offering a control that would filter everything away or nothing at all. The
   moment such a key appears in travel_details, its group appears with it.

   The one server-side filter that stays server-side is passengers — inventory
   that cannot seat the party is excluded by the API and must never be shown.

   Because filters work on what the API returned, partner-home.js asks for a
   larger page (MH_PAGE_SIZE) than the old 20 so the rail describes the whole
   result set rather than the first screen of it. `page_size` maxes at 100 in
   the router, and the count is reported honestly when there is more. */

/* ---------------------------------------------------------------- accessors */

function mhD(item) { return item.details || {}; }
function mhNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/* Flight length in minutes. Prefers the explicit key, falls back to the
   timestamps, and returns null when neither is usable — a null must never sort
   as zero or a filter as "shortest". */
function mhDurationMins(item) {
  const d = mhD(item);
  const explicit = mhNum(d.duration_minutes);
  if (explicit != null) return explicit;
  if (d.departure_time && d.arrival_time) {
    const a = new Date(d.departure_time).getTime();
    const b = new Date(d.arrival_time).getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return Math.round((b - a) / 60000);
  }
  const nights = mhNum(d.nights);
  return nights != null ? nights * 24 * 60 : null;
}

/* Local hour-of-day of a timestamp, 0–23, or null. */
function mhHourOf(v) {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.getHours();
}

function mhAmenities(item) {
  const a = mhD(item).amenities;
  if (Array.isArray(a)) return a.map(x => String(x).toLowerCase());
  if (typeof a === 'string') return a.split(/[,;]/).map(x => x.trim().toLowerCase()).filter(Boolean);
  return [];
}

/* True/false/null — null meaning "the inventory doesn't say", which is why the
   group is hidden rather than defaulted. */
function mhFlag(item, keys) {
  const d = mhD(item);
  for (const k of keys) {
    if (d[k] === undefined || d[k] === null) continue;
    const v = d[k];
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    if (['true', 'yes', 'y', '1', 'refundable', 'included', 'free'].includes(s)) return true;
    if (['false', 'no', 'n', '0', 'non-refundable', 'non_refundable', 'excluded'].includes(s)) return false;
  }
  return null;
}

const MH_TIME_BANDS = [
  { value: 'early', label: 'Before 6 AM', icon: '🌙', from: 0, to: 5 },
  { value: 'morning', label: '6 AM – 12 PM', icon: '🌅', from: 6, to: 11 },
  { value: 'afternoon', label: '12 PM – 6 PM', icon: '☀️', from: 12, to: 17 },
  { value: 'evening', label: 'After 6 PM', icon: '🌆', from: 18, to: 23 },
];

function mhBandOf(hour) {
  if (hour == null) return null;
  return MH_TIME_BANDS.find(b => hour >= b.from && hour <= b.to)?.value || null;
}

const MH_FLIGHT_DUR_BUCKETS = [
  { value: 'u3', label: 'Under 3h', max: 180 },
  { value: '3to6', label: '3h – 6h', min: 180, max: 360 },
  { value: '6to10', label: '6h – 10h', min: 360, max: 600 },
  { value: 'o10', label: 'Over 10h', min: 600 },
];

const MH_NIGHT_BUCKETS = [
  { value: 'n1', label: '1 – 2 nights', min: 1, max: 2 },
  { value: 'n3', label: '3 – 4 nights', min: 3, max: 4 },
  { value: 'n5', label: '5 – 7 nights', min: 5, max: 7 },
  { value: 'n8', label: '8+ nights', min: 8 },
];

function mhBucketOf(buckets, n) {
  if (n == null) return null;
  return buckets.find(b => (b.min == null || n >= b.min) && (b.max == null || n <= b.max))?.value || null;
}

/* ------------------------------------------------------------- group builders

   A group is:
     { id, label, kind:'multi'|'price', values:[{value,label,count,icon}], … }
   `pick(item)` returns the value(s) an item falls under, so both facet counting
   and testing come off one function and cannot disagree. */

function mhMultiGroup(id, label, items, pick, opts = {}) {
  const counts = new Map();
  items.forEach(item => {
    const got = pick(item);
    (Array.isArray(got) ? got : [got]).forEach(v => {
      if (v == null || v === '') return;
      counts.set(v, (counts.get(v) || 0) + 1);
    });
  });
  /* A single value distinguishes nothing — every result carries it — so the
     group is dropped rather than rendered as a no-op control. */
  if (counts.size < 2) return null;
  /* Same reasoning for MULTI-value fields, where the check above isn't enough:
     the seeded hotels all list wifi/breakfast/pool/gym, so "Amenities" had four
     options that each matched all five results. If every option covers the whole
     set, ticking any of them changes nothing — drop the group. */
  if (items.length && [...counts.values()].every(n => n >= items.length)) return null;

  let values = [...counts.entries()].map(([value, count]) => ({
    value,
    label: opts.labelFor ? opts.labelFor(value) : String(value),
    count,
    icon: opts.iconFor ? opts.iconFor(value) : '',
  }));

  if (opts.order) {
    const idx = v => { const i = opts.order.indexOf(v.value); return i < 0 ? 999 : i; };
    values.sort((a, b) => idx(a) - idx(b));
  } else {
    values.sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
  }
  return { id, label, kind: 'multi', pick, values, collapsible: values.length > 6 };
}

function mhPriceGroup(items) {
  const prices = items.map(i => mhNum(i.total_amount)).filter(v => v != null);
  if (prices.length < 2) return null;
  const min = Math.floor(Math.min(...prices));
  const max = Math.ceil(Math.max(...prices));
  if (min === max) return null;
  /* Step keeps the handle usable across a ₹5k–₹150k spread. */
  const step = Math.max(100, Math.round((max - min) / 40 / 100) * 100);
  return { id: 'price', label: 'Price per passenger', kind: 'price', min, max, step };
}

/* --------------------------------------------------------------- definitions */

/* Returns the groups that the given result set actually supports, in the order
   the brief lists them per travel type. */
function mhBuildFilterGroups(travelType, items) {
  const g = [];
  const push = x => { if (x) g.push(x); };

  if (travelType === 'flight') {
    push(mhMultiGroup('stops', 'Stops', items, i => {
      const s = mhNum(mhD(i).stops);
      return s == null ? null : (s === 0 ? '0' : s === 1 ? '1' : '2+');
    }, {
      order: ['0', '1', '2+'],
      labelFor: v => v === '0' ? 'Non-stop' : v === '1' ? '1 stop' : '2+ stops',
    }));
    push(mhMultiGroup('airline', 'Airlines', items, i => mhD(i).airline || null));
    push(mhPriceGroup(items));
    push(mhMultiGroup('cabin', 'Cabin', items, i => mhD(i).cabin_class || null, {
      labelFor: v => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    }));
    push(mhMultiGroup('refundable', 'Fare type', items, i => {
      const f = mhFlag(i, ['refundable', 'is_refundable', 'fare_type']);
      return f == null ? null : (f ? 'yes' : 'no');
    }, { order: ['yes', 'no'], labelFor: v => v === 'yes' ? 'Refundable' : 'Non-refundable' }));
    push(mhMultiGroup('dep', 'Departure', items, i => mhBandOf(mhHourOf(mhD(i).departure_time)), {
      order: MH_TIME_BANDS.map(b => b.value),
      labelFor: v => MH_TIME_BANDS.find(b => b.value === v)?.label || v,
      iconFor: v => MH_TIME_BANDS.find(b => b.value === v)?.icon || '',
    }));
    push(mhMultiGroup('arr', 'Arrival', items, i => mhBandOf(mhHourOf(mhD(i).arrival_time)), {
      order: MH_TIME_BANDS.map(b => b.value),
      labelFor: v => MH_TIME_BANDS.find(b => b.value === v)?.label || v,
      iconFor: v => MH_TIME_BANDS.find(b => b.value === v)?.icon || '',
    }));
    push(mhMultiGroup('dur', 'Duration', items, i => mhBucketOf(MH_FLIGHT_DUR_BUCKETS, mhDurationMins(i)), {
      order: MH_FLIGHT_DUR_BUCKETS.map(b => b.value),
      labelFor: v => MH_FLIGHT_DUR_BUCKETS.find(b => b.value === v)?.label || v,
    }));
    return g;
  }

  if (travelType === 'hotel') {
    push(mhMultiGroup('star', 'Star rating', items, i => {
      const s = mhNum(mhD(i).star_rating);
      return s == null ? null : String(s);
    }, {
      order: ['5', '4', '3', '2', '1'],
      labelFor: v => `${'★'.repeat(Number(v))} ${v}-star`,
    }));
    push(mhPriceGroup(items));
    push(mhMultiGroup('amenity', 'Amenities', items, i => mhAmenities(i), {
      labelFor: v => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    }));
    push(mhMultiGroup('breakfast', 'Breakfast', items, i => {
      const flag = mhFlag(i, ['breakfast', 'breakfast_included']);
      if (flag != null) return flag ? 'yes' : 'no';
      return mhAmenities(i).some(a => a.includes('breakfast')) ? 'yes' : 'no';
    }, { order: ['yes', 'no'], labelFor: v => v === 'yes' ? 'Breakfast included' : 'Room only' }));
    push(mhMultiGroup('cancel', 'Cancellation', items, i => {
      const f = mhFlag(i, ['free_cancellation', 'refundable', 'cancellation']);
      return f == null ? null : (f ? 'yes' : 'no');
    }, { order: ['yes', 'no'], labelFor: v => v === 'yes' ? 'Free cancellation' : 'Non-refundable' }));
    push(mhMultiGroup('room', 'Room type', items, i => mhD(i).room_type || null));
    push(mhMultiGroup('nights', 'Length of stay', items, i => mhBucketOf(MH_NIGHT_BUCKETS, mhNum(mhD(i).nights)), {
      order: MH_NIGHT_BUCKETS.map(b => b.value),
      labelFor: v => MH_NIGHT_BUCKETS.find(b => b.value === v)?.label || v,
    }));
    return g;
  }

  if (travelType === 'cruise') {
    push(mhMultiGroup('line', 'Cruise line', items, i => mhD(i).cruise_line || null));
    push(mhMultiGroup('nights', 'Duration', items, i => mhBucketOf(MH_NIGHT_BUCKETS, mhNum(mhD(i).nights)), {
      order: MH_NIGHT_BUCKETS.map(b => b.value),
      labelFor: v => MH_NIGHT_BUCKETS.find(b => b.value === v)?.label || v,
    }));
    push(mhMultiGroup('port', 'Departure port', items, i => mhD(i).origin_city || mhD(i).origin || null));
    push(mhPriceGroup(items));
    push(mhMultiGroup('cabin', 'Cabin', items, i => mhD(i).cabin_class || null, {
      labelFor: v => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    }));
    return g;
  }

  /* package */
  push(mhPriceGroup(items));
  push(mhMultiGroup('nights', 'Duration', items, i => mhBucketOf(MH_NIGHT_BUCKETS, mhNum(mhD(i).nights)), {
    order: MH_NIGHT_BUCKETS.map(b => b.value),
    labelFor: v => MH_NIGHT_BUCKETS.find(b => b.value === v)?.label || v,
  }));
  push(mhMultiGroup('dest', 'Destination', items, i => mhD(i).destination_city || mhD(i).destination || null));
  push(mhMultiGroup('theme', 'Theme', items, i => mhD(i).theme || mhD(i).category || null, {
    labelFor: v => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
  }));
  push(mhMultiGroup('meals', 'Meals', items, i => mhD(i).meal_plan || mhD(i).meals || null));
  return g;
}

/* ------------------------------------------------------------------- sorting */

const MH_SORTS = {
  flight: [
    ['price_asc', 'Cheapest first'], ['price_desc', 'Highest fare first'],
    ['dep_asc', 'Earliest departure'], ['dep_desc', 'Latest departure'],
    ['dur_asc', 'Shortest duration'],
  ],
  hotel: [
    ['price_asc', 'Lowest price'], ['price_desc', 'Highest price'],
    ['star_desc', 'Star rating: high to low'], ['date_asc', 'Earliest check-in'],
  ],
  cruise: [
    ['price_asc', 'Lowest price'], ['price_desc', 'Highest price'],
    ['nights_desc', 'Longest sailing'], ['date_asc', 'Earliest departure'],
  ],
  package: [
    ['price_asc', 'Lowest price'], ['price_desc', 'Highest price'],
    ['nights_desc', 'Longest itinerary'], ['date_asc', 'Earliest departure'],
  ],
};

function mhSortItems(items, sortKey) {
  const out = [...items];
  /* Missing values sort last in every direction — an item with no duration must
     not win "shortest duration". */
  const by = (get, dir = 1) => (a, b) => {
    const x = get(a); const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  };
  const price = i => mhNum(i.total_amount);
  const dep = i => { const h = mhD(i).departure_time; const t = h ? new Date(h).getTime() : NaN; return Number.isFinite(t) ? t : null; };
  const date = i => { const t = i.travel_date ? new Date(i.travel_date).getTime() : NaN; return Number.isFinite(t) ? t : null; };

  switch (sortKey) {
    case 'price_desc': return out.sort(by(price, -1));
    case 'dep_asc': return out.sort(by(dep, 1));
    case 'dep_desc': return out.sort(by(dep, -1));
    case 'dur_asc': return out.sort(by(mhDurationMins, 1));
    case 'star_desc': return out.sort(by(i => mhNum(mhD(i).star_rating), -1));
    case 'nights_desc': return out.sort(by(i => mhNum(mhD(i).nights), -1));
    case 'date_asc': return out.sort(by(date, 1));
    case 'price_asc':
    default: return out.sort(by(price, 1));
  }
}

/* ------------------------------------------------------------------ applying */

/* state: { [groupId]: Set<string> } for 'multi', { price: {max:Number} }.
   Groups combine with AND; values inside a group with OR — the convention every
   travel site uses ("IndiGo or Emirates, non-stop only"). */
function mhFilterItems(items, groups, state) {
  return items.filter(item => groups.every(group => {
    if (group.kind === 'price') {
      const cap = state.price?.max;
      if (cap == null) return true;
      const p = mhNum(item.total_amount);
      return p == null || p <= cap;
    }
    const chosen = state[group.id];
    if (!chosen || !chosen.size) return true;
    const got = group.pick(item);
    const list = (Array.isArray(got) ? got : [got]).filter(v => v != null && v !== '');
    return list.some(v => chosen.has(String(v)));
  }));
}

function mhActiveFilterCount(groups, state) {
  return groups.reduce((n, group) => {
    if (group.kind === 'price') return n + (state.price?.max != null ? 1 : 0);
    return n + (state[group.id]?.size || 0);
  }, 0);
}

/* -------------------------------------------------------------------- render */

function mhFilterGroupHtml(group, state) {
  if (group.kind === 'price') {
    const cap = state.price?.max ?? group.max;
    return `
      <div class="mh-fgroup" data-mh-fgroup="${group.id}">
        <div class="mh-fgroup-h"><span>${escapeHtml(group.label)}</span>
          <output class="mh-fprice-out" id="mhFPriceOut">${money(cap)}</output>
        </div>
        <input type="range" class="mh-frange" id="mhFPrice"
          min="${group.min}" max="${group.max}" step="${group.step}" value="${cap}"
          aria-label="Maximum price per passenger">
        <div class="mh-frange-ends"><span>${money(group.min)}</span><span>${money(group.max)}</span></div>
      </div>`;
  }

  const shown = group.collapsible ? group.values.slice(0, 6) : group.values;
  const hidden = group.collapsible ? group.values.slice(6) : [];
  const row = v => {
    const on = state[group.id]?.has(String(v.value));
    const id = `mhF-${group.id}-${String(v.value).replace(/[^\w-]/g, '_')}`;
    return `<label class="mh-fopt" for="${id}">
      <input type="checkbox" id="${id}" data-mh-f="${group.id}" value="${escapeHtml(String(v.value))}"${on ? ' checked' : ''}>
      <span class="mh-fbox" aria-hidden="true"></span>
      <span class="mh-fopt-label">${v.icon ? `<span class="mh-fopt-ico" aria-hidden="true">${v.icon}</span>` : ''}${escapeHtml(v.label)}</span>
      <span class="mh-fopt-n">${v.count}</span>
    </label>`;
  };

  return `
    <div class="mh-fgroup" data-mh-fgroup="${group.id}">
      <div class="mh-fgroup-h"><span>${escapeHtml(group.label)}</span></div>
      ${shown.map(row).join('')}
      ${hidden.length ? `<div class="mh-fmore-wrap" hidden>${hidden.map(row).join('')}</div>
        <button type="button" class="mh-fmore" data-mh-fmore="${group.id}">
          + ${hidden.length} more</button>` : ''}
    </div>`;
}

/* Rebuilt wholesale on every result set. Bindings are delegated from the
   container, so re-rendering never leaves stale listeners behind. */
function mhRenderFilterRail(host, groups, state, travelType, onChange) {
  const active = mhActiveFilterCount(groups, state);
  if (!groups.length) { host.innerHTML = ''; host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = `
    <div class="mh-frail-head">
      <h3>Filters${active ? ` <span class="mh-fcount">${active}</span>` : ''}</h3>
      <button type="button" class="mh-fclear" id="mhFClear"${active ? '' : ' disabled'}>Clear all</button>
    </div>
    <div class="mh-frail-body">${groups.map(g => mhFilterGroupHtml(g, state)).join('')}</div>
    <!-- Only visible while the rail is a mobile bottom sheet; on desktop the rail
         is a live column and there is nothing to dismiss. -->
    <div class="mh-frail-foot">
      <button type="button" class="mh-btn mh-btn-coral mh-btn-sm" id="mhFilterDone">Show results</button>
    </div>`;

  if (host.dataset.wired) return;
  host.dataset.wired = '1';

  host.addEventListener('change', e => {
    const box = e.target.closest('[data-mh-f]');
    if (box) {
      const id = box.dataset.mhF;
      const set = state[id] instanceof Set ? state[id] : new Set();
      if (box.checked) set.add(box.value); else set.delete(box.value);
      state[id] = set;
      onChange();
      return;
    }
    if (e.target.id === 'mhFPrice') {
      state.price = { max: Number(e.target.value) };
      onChange();
    }
  });
  /* Live label while dragging; the filter itself waits for `change` so a drag
     across 40 steps isn't 40 re-renders. */
  host.addEventListener('input', e => {
    if (e.target.id !== 'mhFPrice') return;
    const out = document.getElementById('mhFPriceOut');
    if (out) out.textContent = money(Number(e.target.value));
  });
  host.addEventListener('click', e => {
    if (e.target.id === 'mhFClear') { mhClearFilterState(state); onChange(); return; }
    const more = e.target.closest('[data-mh-fmore]');
    if (more) {
      const wrap = more.previousElementSibling;
      wrap.hidden = false;
      more.remove();
    }
  });
}

function mhClearFilterState(state) {
  Object.keys(state).forEach(k => delete state[k]);
}

function mhSortSelectHtml(travelType, current) {
  const opts = MH_SORTS[travelType] || MH_SORTS.flight;
  return `<label class="mh-sort">
    <span>Sort</span>
    <select id="mhSortSelect" aria-label="Sort results">
      ${opts.map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}
    </select>
  </label>`;
}
