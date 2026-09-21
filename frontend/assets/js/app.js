'use strict';

/* SAME ORIGIN UNLESS THE PAGE CAME OFF A FILE SERVER.
   `localhost:8000` and `127.0.0.1:8000` are one machine and TWO ORIGINS to a
   browser, which is why an absolute base for both hostnames broke every login
   from http://localhost:8000 (3bcd3f6).

   The list is the FRONTEND-ONLY dev servers: Live Server on 5500/5501 and the
   `static` entry on 8420. Those serve files and no /api, so they need the
   absolute base. Everything else — uvicorn on any port, which mounts frontend/
   at /, and production behind Caddy — already serves its own API and must stay
   same-origin.

   An earlier version asked "is this port 8000?" instead of listing the file
   servers. That reads as more general and is in fact narrower: a second backend
   on any other port (verifying a change while 8000 is busy, say) was sent to
   8000 and failed. The set of file-server ports is small and known; the set of
   ports a backend might use is not. */
const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname)
                && ['5500', '5501', '8420'].includes(location.port))
  ? 'http://127.0.0.1:8000' : '';

/* escapeHtml() now lives in shared/formatters.js, loaded before this file. */

/* Turn an axios failure into a sentence a person can act on.
   FastAPI returns `detail` as a plain string for a raised HTTPException but as
   an ARRAY of {loc,msg,type} objects for a 422 validation error. Assigning that
   array straight to textContent renders "[object Object]", which is what the
   login and signup forms used to show. */
function apiErrorText(err, fallback) {
  /* Delegates to auth.js, which handles the two cases this used to get wrong:
     a request that never reached the server, and slowapi's 429 (which answers
     `{"error": ...}` with no `detail`, so the old code fell through to the
     fallback and told people their password was wrong when it was not).
     Kept as a named function because the whole customer portal calls it. */
  if (typeof authErrorText === 'function') return authErrorText(err, fallback);

  /* auth.js absent -- a page that loads app.js alone. Same shape, minus the
     origin hint, so behaviour degrades rather than throwing. */
  if (err && !err.response) return 'Could not reach the server. Check your connection and try again.';
  const detail = err?.response?.data?.detail;
  if (Array.isArray(detail)) {
    const text = detail.map(d => d?.msg).filter(Boolean).join(' ');
    return text || fallback;
  }
  if (typeof detail === 'string' && detail) return detail;
  return fallback;
}

/* THE HEADER'S BEHAVIOUR MOVED OUT OF THIS FILE.

   The transparent-to-black scroll fade, the hamburger and the hero parallax all
   used to be written here, against markup in index.html. They are hero-shell.js's
   now, because the Flights page wears the same header and does NOT load this
   file — so its navbar simply never faded, which is the kind of drift a second
   copy guarantees. One call, and both pages behave identically. */
const mobileNav = document.getElementById('mobileNav');
if (typeof HeroShell !== 'undefined') HeroShell.initBehaviour();

/* THE HERO CARD MOVED OUT OF THIS FILE.

   The product panel, its hero video, the swap button, the date fields and the
   Search button all used to be wired here, against markup that lived in
   index.html. Both are booking-card.js's now, because the Flights page renders
   the SAME card and does not load this file — a second copy of these handlers
   over there is exactly the drift the module exists to prevent.

   What is still this file's: WHERE a search goes and WHETHER it is allowed to
   run. See the hero search section further down, which hands the card a
   handler. */

/** The header's product links, by product. One page per product — the same
 *  targets the header uses, so a voice search and a header click land in the
 *  same place. */
/* No `cruises` entry. It was the last live route from the landing page to a
   cruise product: activateTab('cruises') finds no such tab on the booking card,
   falls through to this map, and NAVIGATED — so saying "cruises" into the voice
   search put a visitor on a cruise page for a service this business does not
   sell. cruises.html is untouched and still serves at its own URL, exactly as
   it did when the header and footer dropped it; nothing on this page points
   there any more. */
const SERVICE_PAGE = {
  flights: 'flights.html',
  hotels: 'hotels.html',
  packages: 'packages.html',
};

/** Point the traveller at a product.
 *
 *  THE HERO CARD IS NOT A PRODUCT SWITCHER ANY MORE. It carries the Flights
 *  search and nothing else: product navigation belongs to the site header, and
 *  the card duplicating it was the same four links twice on one screen. So ask
 *  the card first, and when it cannot serve that product — anything but
 *  flights, here — go to the page that can, exactly as clicking the header
 *  would.
 *
 *  Returns true when the card handled it in place, so a caller that was about
 *  to fill fields in knows whether those fields are still on this page. */
function activateTab(name, params) {
  if (typeof BookingCard !== 'undefined' && BookingCard.activateTab(name)) return true;
  const page = SERVICE_PAGE[name];
  if (page) {
    const qs = new URLSearchParams(
      Object.entries(params || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined)
    ).toString();
    window.location.href = qs ? `${page}?${qs}` : page;
  }
  return false;
}

/* Button ripple effect — shared by .btn and the floating action menu */
function createRipple(e, el) {
  const rect = el.getBoundingClientRect();
  const ripple = document.createElement('span');
  const size = Math.max(rect.width, rect.height);
  ripple.className = 'ripple';
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
  ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
  el.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
}
document.querySelectorAll('.btn').forEach(btn => {
  btn.addEventListener('click', function (e) { createRipple(e, this); });
});

/* Scroll reveal */
const revealItems = document.querySelectorAll('.reveal, .reveal-zoom');
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15 });
revealItems.forEach(el => revealObserver.observe(el));

/* THREE BLOCKS WERE REMOVED HERE WITH THE SECTIONS THEY DROVE.

   The duplicated marquee track cloned #offersTrack and #partnersTrack to fill
   the right-hand half of a 32-second loop. #offersTrack had already stopped
   existing; #partnersTrack went with Trusted travel partners.

   The route-price ticker nudged a hardcoded fare by a random few percent every
   four seconds under a "Live" badge. Popular fares is gone and so is it.

   The stat counters counted 2,000,000 Happy Travellers and three more figures
   nothing measured, on scroll. The statistics band is gone and so are they.

   Flights, Hotels and Tour Packages are untouched: none of this was theirs.
   The homepage shelf that replaced all three reads the API — see
   assets/js/home-destinations.js. */

/* Newsletter subscribe */
document.getElementById('newsletterForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('newsletterMsg');
  const email = document.getElementById('newsEmail').value;
  try {
    await axios.post(`${API_BASE}/api/newsletter`, { email });
    msg.textContent = "You're subscribed! Watch your inbox for deals.";
  } catch (err) {
    msg.textContent = 'Something went wrong — please try again.';
  }
  msg.classList.add('show');
  e.target.reset();
  setTimeout(() => msg.classList.remove('show'), 4000);
});

/* Contact form */
document.getElementById('contactForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('contactMsg');
  const payload = {
    name: document.getElementById('cName').value,
    email: document.getElementById('cEmail').value,
    subject: document.getElementById('cSubject').value || undefined,
    message: document.getElementById('cMessage').value,
  };
  try {
    await axios.post(`${API_BASE}/api/contact`, payload);
    msg.textContent = "Thanks for reaching out — our team will get back to you shortly.";
    msg.style.color = 'var(--emerald)';
    msg.classList.add('show');
    e.target.reset();
  } catch (err) {
    msg.textContent = apiErrorText(err, 'Something went wrong — please try again.');
    msg.style.color = 'var(--coral-dark)';
    msg.classList.add('show');
  }
});

/* showToast() now lives in components/toast.js, loaded before this file. */

/* Booking: shared handler for every "Book Now" button (package cards + search results) */
async function handleBookNow(type, id, price, label, quantity = 1, travelDate = null, couponCode = null) {
  const { access } = getStoredAuth();
  if (!access) {
    showToast('Please log in to book — opening login.', true);
    openAuth('login');
    return;
  }
  try {
    await axios.post(
      `${API_BASE}/api/bookings`,
      {
        booking_type: type, item_id: Number(id), total_price: Number(price),
        quantity: Number(quantity) || 1, travel_date: travelDate || undefined,
        coupon_code: couponCode || undefined,
      },
      { headers: { Authorization: `Bearer ${access}` } }
    );
    showToast(couponCode ? `Booked "${label}" with coupon ${couponCode} — confirmation sent instantly!` : `Booked "${label}" — confirmation sent instantly!`);
    loadUpcomingJourney();
  } catch (err) {
    showToast(apiErrorText(err, 'Booking failed — please try again.'), true);
  }
}
document.addEventListener('click', e => {
  const bookBtn = e.target.closest('[data-book-type]');
  if (!bookBtn) return;
  e.preventDefault();
  handleBookNow(bookBtn.dataset.bookType, bookBtn.dataset.bookId, bookBtn.dataset.bookPrice, bookBtn.dataset.bookLabel);
});

/* Wishlist: "type:id" -> wishlist entry id, refreshed on load and after login */
let wishlistMap = new Map();
async function refreshWishlistState() {
  wishlistMap = new Map();
  const { access } = getStoredAuth();
  if (!access) return;
  try {
    const { data } = await axios.get(`${API_BASE}/api/customer/wishlist`, { headers: { Authorization: `Bearer ${access}` } });
    data.forEach(w => wishlistMap.set(`${w.item_type}:${w.item_id}`, w.id));
  } catch (err) { /* ignore — hearts stay unfilled */ }
}
function applyWishlistState(container) {
  if (!container) return;
  container.querySelectorAll('[data-wl-type]').forEach(btn => {
    const saved = wishlistMap.has(`${btn.dataset.wlType}:${btn.dataset.wlId}`);
    btn.classList.toggle('saved', saved);
    /* Was the text glyphs BLACK HEART and WHITE HEART. Two different characters
       for one control, whose shapes and weights are whatever the viewer's OS
       font decided — and on most of them one is a flat outline and the other a
       full-colour emoji. One drawing now; `saved` carries the state and CSS
       carries the fill. */
    btn.innerHTML = (typeof JPIcon !== 'undefined')
      ? JPIcon.html('heart', { className: 'jpi-btn', label: saved ? 'Saved' : 'Save' })
      : (saved ? '♥' : '♡');
  });
}
/* cardActionsHtml() built the wishlist / Reviews / View Details row for each rendered
   card. It was only ever called by the search-result renderer and the featured-packages
   loader, both of which called retired catalog endpoints and are gone. Nothing in the
   static markup carries data-wl-type, data-review-type or data-details-type, so the
   handlers below them have no entry point left — see the note in index.html. */
document.addEventListener('click', async e => {
  const wlBtn = e.target.closest('[data-wl-type]');
  if (!wlBtn) return;
  e.preventDefault();
  const { access } = getStoredAuth();
  if (!access) { showToast('Please log in to save items — opening login.', true); openAuth('login'); return; }
  const type = wlBtn.dataset.wlType;
  const id = Number(wlBtn.dataset.wlId);
  const key = `${type}:${id}`;
  try {
    if (wishlistMap.has(key)) {
      await axios.delete(`${API_BASE}/api/customer/wishlist/${wishlistMap.get(key)}`, { headers: { Authorization: `Bearer ${access}` } });
      wishlistMap.delete(key);
      showToast('Removed from wishlist.');
    } else {
      const { data } = await axios.post(
        `${API_BASE}/api/customer/wishlist`, { item_type: type, item_id: id }, { headers: { Authorization: `Bearer ${access}` } }
      );
      wishlistMap.set(key, data.id);
      showToast('Saved to wishlist!');
    }
    /* `document`, not `closest('.pkg-grid')`. The grid it named was the Featured
       tour packages shelf; that section is gone, so the selector matched nothing
       and this line had quietly become a no-op — the heart stayed in its old
       state until the next page load. Refreshing every wishlist button on the
       page is what the call was always trying to do. */
    applyWishlistState(document);
  } catch (err) { showToast(apiErrorText(err, 'Wishlist update failed.'), true); }
});
refreshWishlistState();

/* Reviews modal: shared by result cards and package cards */
const reviewsModalOverlay = document.getElementById('reviewsModalOverlay');
const reviewForm = document.getElementById('reviewForm');
const reviewStarInput = document.getElementById('reviewStarInput');
let currentReviewItem = null;
let currentReviewRating = 0;
let myReviewId = null;

function setReviewStars(n) {
  currentReviewRating = n;
  reviewStarInput.querySelectorAll('span').forEach(s => s.classList.toggle('active', Number(s.dataset.star) <= n));
}
reviewStarInput.querySelectorAll('span').forEach(s => s.addEventListener('click', () => setReviewStars(Number(s.dataset.star))));

/* Was '★'.repeat(n) + '☆'.repeat(5-n) — two different glyphs whose shapes
   and widths came from whatever font the OS had, and which some platforms drew
   as full-colour emoji. jp-icons draws one star and dims the rest. */
function starString(rating) {
  return (typeof JPIcon !== 'undefined') ? JPIcon.stars(rating)
    : '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

async function openReviewsModal(type, id, label) {
  currentReviewItem = { type, id };
  myReviewId = null;
  setReviewStars(0);
  reviewForm.reset();
  document.getElementById('reviewFormMsg').textContent = '';
  document.getElementById('reviewSubmitBtn').textContent = 'Submit Review';
  document.getElementById('reviewsModalSub').textContent = label;
  document.getElementById('reviewsList').innerHTML = '<div class="empty-state">Loading reviews…</div>';
  reviewsModalOverlay.classList.add('open');
  const { access, userId } = getStoredAuth();
  document.getElementById('reviewFormWrap').style.display = access ? 'block' : 'none';
  try {
    const { data } = await axios.get(`${API_BASE}/api/customer/reviews`, { params: { item_type: type, item_id: id } });
    if (access && userId) {
      const mine = data.find(r => String(r.user_id) === String(userId));
      if (mine) {
        myReviewId = mine.id;
        setReviewStars(mine.rating);
        document.getElementById('reviewComment').value = mine.comment || '';
        document.getElementById('reviewSubmitBtn').textContent = 'Update Review';
      }
    }
    document.getElementById('reviewsList').innerHTML = data.length
      ? data.map(r => `
        <div class="review-item">
          <div class="rname">${escapeHtml(r.user_name)}</div>
          <div class="stars">${starString(r.rating)}</div>
          <div class="rdate">${new Date(r.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          ${r.comment ? `<div class="rcomment">${escapeHtml(r.comment)}</div>` : ''}
          ${access && userId && String(r.user_id) === String(userId) ? `<div class="ractions"><button type="button" data-delete-review="${r.id}">Delete my review</button></div>` : ''}
        </div>
      `).join('')
      : '<div class="empty-state">No reviews yet — be the first!</div>';
    document.querySelectorAll('[data-delete-review]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete your review?')) return;
        try {
          await axios.delete(`${API_BASE}/api/customer/reviews/${btn.dataset.deleteReview}`, { headers: { Authorization: `Bearer ${access}` } });
          openReviewsModal(type, id, label);
        } catch (err) { showToast('Failed to delete review.', true); }
      });
    });
  } catch (err) {
    document.getElementById('reviewsList').innerHTML = '<div class="empty-state">Failed to load reviews.</div>';
  }
}
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-review-type]');
  if (!btn) return;
  e.preventDefault();
  openReviewsModal(btn.dataset.reviewType, Number(btn.dataset.reviewId), btn.dataset.reviewLabel);
});
document.getElementById('reviewsModalCloseBtn').addEventListener('click', () => reviewsModalOverlay.classList.remove('open'));
reviewsModalOverlay.addEventListener('click', e => { if (e.target === reviewsModalOverlay) reviewsModalOverlay.classList.remove('open'); });

reviewForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('reviewFormMsg');
  const { access } = getStoredAuth();
  if (!currentReviewRating) {
    msg.textContent = 'Please select a star rating.';
    msg.style.color = 'var(--coral-dark)';
    msg.classList.add('show');
    return;
  }
  const comment = document.getElementById('reviewComment').value;
  try {
    if (myReviewId) {
      await axios.put(`${API_BASE}/api/customer/reviews/${myReviewId}`, { rating: currentReviewRating, comment }, { headers: { Authorization: `Bearer ${access}` } });
    } else {
      await axios.post(
        `${API_BASE}/api/customer/reviews`,
        { item_type: currentReviewItem.type, item_id: currentReviewItem.id, rating: currentReviewRating, comment },
        { headers: { Authorization: `Bearer ${access}` } }
      );
    }
    msg.textContent = 'Thanks for your review!';
    msg.style.color = 'var(--emerald)';
    msg.classList.add('show');
    openReviewsModal(currentReviewItem.type, currentReviewItem.id, document.getElementById('reviewsModalSub').textContent);
  } catch (err) {
    msg.textContent = apiErrorText(err, 'Failed to submit review.');
    msg.style.color = 'var(--coral-dark)';
    msg.classList.add('show');
  }
});

/* Details modal: shared by result cards and package cards */
const detailsModalOverlay = document.getElementById('detailsModalOverlay');
let currentDetailsItem = null;
let currentDetailsType = null;
let currentDetailsUnitPrice = 0;
let currentAppliedCoupon = null;

const detailsConfig = {
  flight: {
    qtyLabel: 'Passengers',
    unitPrice: f => f.price,
    rows: f => [
      ['Airline', f.airline], ['From', f.from_airport], ['To', f.to_airport],
      ['Departure', new Date(f.departure_time).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })],
      ['Arrival', new Date(f.arrival_time).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })],
      ['Cabin Class', f.cabin_class], ['Price', '₹' + Math.round(f.price).toLocaleString('en-IN')],
      ['Seats Available', f.seats_available],
    ],
    dateField: f => (f.departure_time || '').slice(0, 10),
  },
  hotel: {
    qtyLabel: 'Rooms',
    unitPrice: h => h.price_per_night,
    rows: h => [
      ['Name', h.name], ['Location', h.location],
      ['Price / Night', '₹' + Math.round(h.price_per_night).toLocaleString('en-IN')],
      ['Rating', '★ ' + h.rating.toFixed(1)], ['Amenities', h.amenities || '—'],
      ['Rooms Available', h.rooms_available],
    ],
    dateField: () => document.getElementById('hIn')?.closest('.field-date')?.querySelector('.date-native')?.value || '',
  },
  cruise: {
    qtyLabel: 'Travellers',
    unitPrice: c => c.price,
    rows: c => [
      ['Name', c.name], ['Type', c.cruise_type], ['Departure Port', c.departure_port],
      ['Duration', c.duration_days + ' Days'], ['Price', '₹' + Math.round(c.price).toLocaleString('en-IN')],
      ['Departure Month', c.departure_month],
    ],
    dateField: null,
  },
  package: {
    qtyLabel: 'Travellers',
    unitPrice: p => p.price,
    rows: p => [
      ['Title', p.title], ['Type', p.package_type], ['Duration', p.duration_days + ' Days'],
      ['Price', '₹' + Math.round(p.price).toLocaleString('en-IN')], ['Rating', '★ ' + p.rating.toFixed(1)],
      ['Available Month', p.available_month || '—'],
    ],
    dateField: null,
  },
};

function openDetailsModal(type, item) {
  const cfg = detailsConfig[type];
  currentDetailsItem = item;
  currentDetailsType = type;
  currentDetailsUnitPrice = cfg.unitPrice(item);
  document.getElementById('detailsModalTitle').textContent = item.title || item.name || `${item.airline} ${item.from_airport}→${item.to_airport}`;
  document.getElementById('detailsModalSub').textContent = type.charAt(0).toUpperCase() + type.slice(1);
  document.getElementById('detailsBody').innerHTML = cfg.rows(item).map(([label, value]) => `
    <div class="detail-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>
  `).join('') + (item.description ? `<div class="detail-desc">${escapeHtml(item.description)}</div>` : '');
  document.getElementById('detailsQtyLabel').textContent = cfg.qtyLabel;
  document.getElementById('detailsQty').value = 1;
  document.getElementById('detailsMsg').textContent = '';
  document.getElementById('detailsCoupon').value = '';
  document.getElementById('detailsCouponMsg').textContent = '';
  currentAppliedCoupon = null;
  const dateField = document.getElementById('detailsDateField');
  if (cfg.dateField) {
    dateField.style.display = 'block';
    document.getElementById('detailsDate').value = cfg.dateField(item);
  } else {
    dateField.style.display = 'none';
  }
  detailsModalOverlay.classList.add('open');
}
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-details-type]');
  if (!btn) return;
  e.preventDefault();
  openDetailsModal(btn.dataset.detailsType, JSON.parse(btn.dataset.detailsItem.replace(/&apos;/g, "'")));
});
document.getElementById('detailsModalCloseBtn').addEventListener('click', () => detailsModalOverlay.classList.remove('open'));
detailsModalOverlay.addEventListener('click', e => { if (e.target === detailsModalOverlay) detailsModalOverlay.classList.remove('open'); });

document.getElementById('detailsCouponApplyBtn').addEventListener('click', async () => {
  const msg = document.getElementById('detailsCouponMsg');
  const code = document.getElementById('detailsCoupon').value.trim();
  const { access } = getStoredAuth();
  if (!code) { msg.textContent = ''; currentAppliedCoupon = null; return; }
  if (!access) { msg.textContent = 'Please log in first to apply a coupon.'; msg.className = 'modal-msg show'; msg.style.color = 'var(--coral-dark)'; return; }
  const qty = Math.max(1, Number(document.getElementById('detailsQty').value) || 1);
  try {
    const { data } = await axios.post(`${API_BASE}/api/coupons/validate`,
      { code, booking_type: currentDetailsType, item_id: currentDetailsItem.id, quantity: qty },
      { headers: { Authorization: `Bearer ${access}` } });
    if (data.valid) {
      currentAppliedCoupon = code;
      msg.textContent = `Coupon applied — you save ₹${Math.round(data.campaign_discount + data.coupon_discount).toLocaleString('en-IN')}. New total: ₹${Math.round(data.final_amount).toLocaleString('en-IN')}`;
      msg.style.color = 'var(--emerald)';
    } else {
      currentAppliedCoupon = null;
      msg.textContent = data.message;
      msg.style.color = 'var(--coral-dark)';
    }
    msg.classList.add('show');
  } catch (err) {
    currentAppliedCoupon = null;
    msg.textContent = apiErrorText(err, 'Could not validate this coupon right now.');
    msg.style.color = 'var(--coral-dark)';
    msg.classList.add('show');
  }
});

document.getElementById('detailsBookBtn').addEventListener('click', () => {
  const qty = Math.max(1, Number(document.getElementById('detailsQty').value) || 1);
  const date = document.getElementById('detailsDateField').style.display !== 'none' ? document.getElementById('detailsDate').value : null;
  const label = document.getElementById('detailsModalTitle').textContent;
  handleBookNow(currentDetailsType, currentDetailsItem.id, currentDetailsUnitPrice * qty, label, qty, date, currentAppliedCoupon);
  detailsModalOverlay.classList.remove('open');
});

/* Featured tour packages are static marketing content in index.html.
   They used to be replaced with live data from GET /api/packages, but the public
   catalog API (flights/hotels/cruises/packages) was retired in the V2 nine-table
   redesign — tour_packages no longer exists — so that call only ever 404'd and fell
   through to the hardcoded cards. Removed rather than left firing on every load. */

/* ===========================================================================
   Hero search — collect, gate, hand over.
   ===========================================================================
   The button used to say "Live search isn't available", which was true when
   the catalog endpoints were removed. It is not true any more: the travel
   pages search TravelData and render results, so the hero's job is to carry
   what the traveller typed to the page that can answer it.

   AUTH IS THE GATE, NOT A SUGGESTION. A signed-out click opens the auth modal
   and DOES NOT search. The criteria are parked first, so signing in resumes
   the search the traveller asked for rather than dropping them on the landing
   page to type it again.

   Cruises are deliberately still on the old toast — the cruise page has no
   search panel to hand criteria to, and a redirect that ignored them would be
   worse than saying so.
   =========================================================================== */

/** Where each panel's criteria go. READING them is booking-card.js's job — it
 *  owns the controls, so it is the only thing that can know whether a return
 *  date belongs to this search or is left over from a round trip the traveller
 *  switched away from. This map is only the destination. */
const HERO_SEARCH = {
  flights:  { page: 'flights.html' },
  hotels:   { page: 'hotels.html' },
  packages: { page: 'packages.html' },
  gaming:   { page: 'gaming-packages.html' },
};

/** Park a search so signing in can resume it.
 *
 *  sessionStorage, not local: a search is about this visit, and finding
 *  yesterday's criteria reapplied in a new tab would be surprising.
 *
 *  This is what makes the sign-in gate cost the traveller nothing. They fill
 *  the form, press Search, sign in or create an account, and land on the
 *  results for the search they already typed — the criteria are never asked
 *  for twice. */
const PENDING_SEARCH_KEY = 'jpc_pending_search';

function storePendingSearch(kind, params) {
  try { sessionStorage.setItem(PENDING_SEARCH_KEY, JSON.stringify({ kind, params })); }
  catch { /* private mode — the traveller re-runs the search */ }
}

function takePendingSearch() {
  try {
    const raw = sessionStorage.getItem(PENDING_SEARCH_KEY);
    sessionStorage.removeItem(PENDING_SEARCH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Send the traveller to the page that can answer, criteria in the URL. */
function goToSearch(kind, params) {
  const spec = HERO_SEARCH[kind];
  if (!spec) return;
  /* Objects and arrays are skipped, not stringified: URLSearchParams turns one
     into the literal text "[object Object]". Anything nested that a results
     page genuinely needs travels as an encoded scalar beside it — `legs` for an
     itinerary, `pax` for the per-room party. */
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) =>
      v !== '' && v !== null && v !== undefined && typeof v !== 'object')
  );
  window.location.href = `${spec.page}?${qs.toString()}`;
}

/* THE GATE. The card has already validated by the time this runs; what is left
   is whether this traveller may search at all. Signed out: park the criteria,
   open the modal, search nothing — the modal's success path picks it back up.

   Cruises never reach here: the card has no cruises handler to call because the
   cruise page has no search panel to hand criteria to, and a redirect that
   ignored them would be worse than saying so. */
if (typeof BookingCard !== 'undefined') {
  BookingCard.setSearchHandler((kind, params) => {
    /* GROUP DEALS IS NOT A SEARCH, and is checked before everything below.
       It does not navigate, so it needs no results page; it is quoted by a
       person, so it does not wait on a sign-in either — turning "tell us about
       your group" into "make an account first" loses the enquiry. And its
       criteria carry a name, an email and a phone number, which must never
       reach goToSearch(): that puts them in a query string. */
    if (typeof GroupEnquiry !== 'undefined' && GroupEnquiry.isGroup(kind, params)) {
      GroupEnquiry.handle(params);
      return;
    }
    /* The message names no product. It used to say "Cruise search isn't
       available yet — browse our featured sailings below", from when cruises
       were the one tab without a handler. All three tabs have handlers now, so
       this is a guard rather than a path anyone takes — and if a fourth product
       is ever added without one, a toast advertising sailings would be a
       stranger failure than the one being reported. */
    if (!HERO_SEARCH[kind]) {
      showToast("That search isn't available yet. Please call us and we'll book it for you.", true);
      return;
    }
    /* A SEARCH NEEDS AN ACCOUNT, AND ASKING COSTS THE TRAVELLER NOTHING.
       The criteria are parked first, so the modal is an interruption and not a
       loss: openAuth() runs one email-first flow that recognises a returning
       address and offers to create an account for a new one, so there is no
       Login-or-Sign-Up choice to make. resumePendingSearch() below picks the
       search back up the moment a session exists and goes straight to the
       results page — the form is never filled in twice. */
    const { access } = getStoredAuth();
    if (!access) {
      storePendingSearch(kind, params);
      openAuth();
      return;
    }
    goToSearch(kind, params);
  });
}

/** Called once a session exists. Returns true if it navigated, which is what
 *  tells the caller not to carry on with its own post-sign-in routine. */
function resumePendingSearch() {
  const pending = takePendingSearch();
  if (!pending || !HERO_SEARCH[pending.kind]) return false;
  goToSearch(pending.kind, pending.params);
  return true;
}

/* THE TRAVEL ASSISTANT'S PANEL IS travel-assistant.js's, thread and all.
   What used to be here — four canned replies keyed by the chip that was
   pressed, and no way to type anything else — is the "UI only" the assistant
   replaces. This is the handle the rest of this file still calls. */
function toggleChatPanel(forceOpen) {
  if (typeof TravelAssistant === 'undefined') return;
  if (forceOpen === true) TravelAssistant.openPanel();
  else if (forceOpen === false) TravelAssistant.closePanel();
  else TravelAssistant.togglePanel();
}

/* ---------- Floating Action Menu ---------- */
const fabMenu = document.getElementById('fabMenu');
const fabMainBtn = document.getElementById('fabMainBtn');
const fabTopBtn = document.getElementById('fabTopBtn');
const fabSupportBtn = document.getElementById('fabSupportBtn');
const fabVoiceBtn = document.getElementById('fabVoiceBtn');
const fabAiBtn = document.getElementById('fabAiBtn');

function setFabOpen(open) {
  fabMenu.classList.toggle('open', open);
  fabMainBtn.setAttribute('aria-expanded', String(open));
}
fabMainBtn.addEventListener('click', () => setFabOpen(!fabMenu.classList.contains('open')));
document.addEventListener('click', e => {
  if (!fabMenu.contains(e.target)) setFabOpen(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && fabMenu.classList.contains('open')) { setFabOpen(false); fabMainBtn.focus(); }
});
fabMenu.querySelectorAll('.fab-item, .fab-main').forEach(btn => {
  btn.addEventListener('click', function (e) { createRipple(e, this); });
});

/* Button 1: Back to Top — only visible once scrolled 300px down */
function updateFabTopVisibility() {
  fabTopBtn.classList.toggle('is-hidden', window.scrollY <= 300);
}
window.addEventListener('scroll', updateFabTopVisibility, { passive: true });
updateFabTopVisibility();
fabTopBtn.addEventListener('click', () => {
  setFabOpen(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* Button 2: Customer Support — reuses the existing Support Tickets tab when logged in,
   falls back to the existing Contact section (already wired to /api/contact) when not */
fabSupportBtn.addEventListener('click', () => {
  setFabOpen(false);
  /* Support Center is where LiveChat is docked (account-center.js), so this
     is the real conversation with our staff rather than a second one. Signed
     out, openAccountCenter opens the sign-in dialog and returns here after —
     it no longer needs a branch of its own. */
  if (typeof AccountCenter !== 'undefined' && AccountCenter.open) AccountCenter.open('support');
});

/* Button 4: Travel Assistant — the real one, talking to
   /api/customer/assistant (travel-assistant.js). */
fabAiBtn.addEventListener('click', () => {
  setFabOpen(false);
  toggleChatPanel();
});

/* Button 3: Voice Assistant — the popup with the microphone, the transcript
   and the answer. The browser's own speech recogniser turns speech into text;
   the TEXT then goes to the same endpoint the typed panel uses, so both doors
   understand exactly the same phrases. travel-assistant.js owns all of it. */
fabVoiceBtn.addEventListener('click', () => {
  setFabOpen(false);
  if (typeof TravelAssistant !== 'undefined') TravelAssistant.openVoice();
});


/* ---------------------------------------------------------------------------
   THE LANDING PAGE'S STORED SESSION IS THE CUSTOMER'S.

   Session helpers live in assets/js/auth.js. This page used to read the jwt_*
   pair it shared with admin.html, back when both signed in through
   /api/auth/login and were told apart by `role`. The traveller now
   authenticates against the CUSTOMER database instead, so the four accessors
   are rebound here to the jpc_* namespace.

   Rebinding, rather than editing ~37 call sites, is the point: renderAuthNav(),
   the profile chip and the whole Account Center below are the original V1 code
   and keep working untouched — only the drawer they read from changed.

   This cannot affect another portal. app.js is loaded by index.html alone;
   admin.js, partner-shared.js and super-admin-shared.js each read their own
   namespace and never load this file.
   --------------------------------------------------------------------------- */
getStoredAuth = getCustomerAuth;
setStoredAuth = setCustomerAuth;
clearStoredAuth = clearCustomerAuth;
authHeaders = customerAuthHeaders;

/* THE PRESENCE HEARTBEAT IS GONE, AND MUST STAY GONE.

   It posted to /api/users/heartbeat every 30s so the ADMIN's "Online Users"
   widget could see whoever was browsing. That endpoint is the platform's, over
   the `users` table, and a customer must never surface in it — a traveller
   reading the homepage is not a merchant staff member at work, and mixing the
   two is exactly the leak the Customer database is separated to prevent.

   It would also simply fail: the platform refuses customer-scoped tokens, so
   this was a 401 every 30 seconds, silenced by its own .catch(). If customer
   presence is ever wanted, it needs an endpoint on the customer side. */

/** Tell the header the session changed.
 *
 *  This used to relabel and show/hide FOUR hand-maintained controls: a static
 *  Login and Sign Up in the header, and another pair in the mobile drawer,
 *  plus a nine-link account list toggled by a `show-account` class. All of it
 *  is deleted — profile-menu.js renders the authentication controls, and it
 *  reads the session itself, so the only thing left to say is "look again".
 *
 *  The duplicate Login/Sign Up came from exactly that overlap: the static pair
 *  never went away when the component started rendering its own. */
function renderAuthNav() {
  if (typeof ProfileMenu !== 'undefined') ProfileMenu.render();
}
renderAuthNav();

/* Validate any stored token on load; drop it silently if it's no longer valid */
(function verifyStoredSession() {
  const { access } = getStoredAuth();
  if (!access) return;
  axios.get(`${API_BASE}/api/customer/auth/me`, { headers: { Authorization: `Bearer ${access}` } })
    .catch(err => {
      /* Only a rejected TOKEN clears the session. A network blip or a 5xx must
         not sign a traveller out — that used to be a bare .catch(), so the page
         logged you out whenever the API hiccuped. */
      if (err?.response?.status === 401) { clearStoredAuth(); renderAuthNav(); }
    });
})();

/* ===========================================================================
   Auth modal — one door, five steps.
   ===========================================================================
   Both header buttons open this. The traveller gives an email, then either a
   password or the rest of a registration; the code step is shared because
   /login and /signup answer with the same challenge.

   THE FLOW NEVER ASKS THE SERVER WHO IS REGISTERED. See the comment on the
   markup in index.html: an "is this email known?" endpoint would let anyone
   enumerate customers, which this API avoids on purpose. So the email step
   leads to the password step and offers "Create your account" beside it,
   carrying the address across so nothing is typed twice.
   =========================================================================== */
const authOverlay = document.getElementById('authOverlay');
const authCard = authOverlay.querySelector('.modal-card');
const authCloseBtn = document.getElementById('authCloseBtn');

/** step name -> the element that is its view. */
const AUTH_STEPS = {
  email:    'authStepEmail',
  signup:   'authStepSignup',
  otp:      'loginStepOtp',
};

/** Where focus was before the modal took it, so it can be handed back. */
let authReturnFocus = null;
let authStep = 'email';
/** The code step's resend countdown. Declared up here because showStep()
 *  stops it, and showStep can run before the OTP section below is reached. */
let resendTimer = null;

function authView(name) { return document.getElementById(AUTH_STEPS[name]); }

/** Show one step and put the caret in the field that still needs filling. */
function showStep(name, opts) {
  if (!AUTH_STEPS[name]) return;

  /* prepareSignup() carries whatever the first step holds across, and
     unlocks the signup email when the first step did not supply one. */
  if (name === 'signup') prepareSignup();
  /* The resend countdown belongs to the code step and must not keep ticking
     on a form that has no resend button showing. */
  if (name !== 'otp') stopResendTimer();

  authStep = name;
  Object.keys(AUTH_STEPS).forEach(k => { authView(k).hidden = k !== name; });
  /* The dialog is named by whichever heading is on screen. */
  const heading = authView(name).querySelector('h2[id]');
  if (heading) authCard.setAttribute('aria-labelledby', heading.id);

  /* Messages belong to the step that produced them. Carrying "that password
     was wrong" onto the signup form would be nonsense. */
  if (!(opts && opts.keepMessage)) {
    ['authEmailMsg', 'signupMsg', 'loginOtpMsg']
      .forEach(id => setModalMsg(document.getElementById(id), '', 'muted'));
    clearFieldErrors();
  }

  /* rAF so the field exists on screen before it is focused — focusing a
     hidden element silently does nothing. Radios and fields inside a hidden
     wrapper (the Email field while Mobile is selected) are skipped, which is
     why visibility is checked in the frame rather than by the selector. */
  requestAnimationFrame(() => {
    const first = Array.from(authView(name).querySelectorAll(
      'input:not([readonly]):not([type=checkbox]):not([type=radio])'))
      .find(el => el.offsetParent !== null);
    if (first) first.focus();
  });
}

/* --- buttons that talk to the server --------------------------------------
   One helper for every Continue / Send OTP / Verify. While a request is in
   flight the button is disabled, which is also what stops a second request:
   a disabled submit button blocks Enter-key submission of its form too, so a
   double click or an impatient Enter cannot post the same OTP request twice. */
/* The resting markup is kept whole, not just its text, because Continue
   carries an arrow icon that a textContent round-trip would strip. */
const busyMarkup = new WeakMap();
function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    if (!busyMarkup.has(btn)) busyMarkup.set(btn, btn.innerHTML);
    btn.textContent = label || btn.textContent;
    btn.classList.add('is-loading');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
  } else {
    if (busyMarkup.has(btn)) btn.innerHTML = busyMarkup.get(btn);
    busyMarkup.delete(btn);
    btn.classList.remove('is-loading');
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}
const isBusy = btn => !!btn && btn.classList.contains('is-loading');

/* --- step one: Mobile Number or Email --------------------------------------
   Either is a real identifier for /request-otp (get_by_identifier matches the email
   case-insensitively, or the mobile exactly as signup stored it: dial code +
   digits). The two fields keep their own values, so flipping the selector and
   back does not lose what was typed. */
const authEmailInput = document.getElementById('authEmail');
const authMobileInput = document.getElementById('authMobile');

function authMethod() {
  const r = authOverlay.querySelector('input[name="authMethod"]:checked');
  return r ? r.value : 'mobile';
}

function syncAuthMethod() {
  const email = authMethod() === 'email';
  document.getElementById('authEmailField').hidden = !email;
  document.getElementById('authMobileField').hidden = email;
  syncContinueBtn();
}

/** Continue is disabled until there is something to continue with. */
function syncContinueBtn() {
  const btn = document.getElementById('authContinueBtn');
  if (isBusy(btn)) return;
  const input = authMethod() === 'email' ? authEmailInput : authMobileInput;
  btn.disabled = !input.value.trim();
}

/** The identifier exactly as /login wants it, or '' when nothing is typed. */
function stepOneIdentifier() {
  if (authMethod() === 'email') return authEmailInput.value.trim();
  const digits = authMobileInput.value.replace(/[\s-]/g, '');
  return digits ? dialOfSelect('authDial') + digits : '';
}

/** '+919876543210' -> { iso: 'IN', national: '9876543210' }.
 *
 *  Needed to put a remembered mobile back into the two controls, and to mask
 *  one. The longest dial code that prefixes the number wins, and on a tie
 *  (+1 is nineteen countries) the default country does — the national number
 *  is the same whichever of them is picked. */
function splitMobile(full) {
  const raw = String(full || '');
  const digits = raw.replace(/\D/g, '');
  if (!raw.trim().startsWith('+') || typeof CountryCodes === 'undefined') {
    return { iso: null, national: digits };
  }
  let best = null;
  CountryCodes.list().forEach(c => {
    const d = c.dial.slice(1);
    if (!digits.startsWith(d)) return;
    const len = best ? best.dial.length - 1 : -1;
    if (d.length > len || (d.length === len && c.iso === CountryCodes.DEFAULT_ISO)) best = c;
  });
  return best
    ? { iso: best.iso, national: digits.slice(best.dial.length - 1) }
    : { iso: null, national: digits };
}


/* --- masking ---------------------------------------------------------------
   The code step shows where the code went without printing the address in
   full: enough to recognise, not enough to harvest from a shoulder-surf or a
   screenshot. */
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return '';
  return `${user.charAt(0)}***@${domain}`;
}

function maskMobile(full) {
  const { iso, national } = splitMobile(full);
  const dial = iso && typeof CountryCodes !== 'undefined' ? CountryCodes.dialOf(iso) : '';
  const shown = national.slice(0, -2).replace(/\d/g, 'X') + national.slice(-2);
  const grouped = shown.length === 10 ? `${shown.slice(0, 5)} ${shown.slice(5)}` : shown;
  return (dial ? `${dial} ` : '') + grouped;
}

/* --- signup, reached with or without an address -----------------------------
   From an email on step one, the signup email is that address, locked, with
   Change beside it — nobody types it twice. From a mobile, or straight from
   "Create an account", there is no email yet, so the field is an ordinary one;
   a mobile already typed is carried into the signup mobile instead. Never
   overwrites a signup mobile the traveller has already edited. */
function prepareSignup() {
  const su = document.getElementById('suEmail');
  const fromStepOne = authMethod() === 'email' ? authEmailInput.value.trim() : '';
  const lock = isEmail(fromStepOne);
  if (lock) su.value = fromStepOne;
  su.readOnly = lock;
  document.getElementById('suEmailWrap').classList.toggle('field-locked', lock);
  document.getElementById('suEmailChange').hidden = !lock;

  const suMobile = document.getElementById('suMobile');
  const national = authMobileInput.value.trim();
  if (authMethod() === 'mobile' && national && !suMobile.value.trim()) {
    suMobile.value = national;
    document.getElementById('suDial').value = document.getElementById('authDial').value;
  }
}


/* --- inline validation ---------------------------------------------------
   Every message lands beside its own field. There is not a single alert() or
   confirm() in this flow, and the shared .modal-msg strip is reserved for what
   the SERVER said — never for "you missed a field", which belongs on it. */
function setFieldError(inputId, message) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(inputId + 'Err');
  if (input) {
    input.classList.toggle('is-invalid', !!message);
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
  if (box) box.textContent = message || '';
  if (message && input) input.focus();
  return !message;
}

function clearFieldErrors() {
  authOverlay.querySelectorAll('.field-error').forEach(e => { e.textContent = ''; });
  authOverlay.querySelectorAll('.is-invalid').forEach(e => {
    e.classList.remove('is-invalid');
    e.setAttribute('aria-invalid', 'false');
  });
}

const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/* --- password strength ---------------------------------------------------
   The server's rule is length only (8..72, bcrypt's truncation point). This
   adds a CLIENT-SIDE floor on top: eight characters drawn from at least two
   of lowercase / uppercase / digit / symbol, so "password" and "12345678"
   are refused at the form rather than accepted and regretted.

   Deliberately not stricter than that. A rule the server does not share can
   only ever be advisory — anyone posting straight to /signup bypasses it —
   so it is set where it stops the genuinely weak without turning a booking
   into a password-policy argument. */
const PW_CLASSES = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/];

function passwordScore(pw) {
  if (!pw) return 0;
  const classes = PW_CLASSES.filter(re => re.test(pw)).length;
  if (pw.length < 8) return 0;
  if (classes <= 1) return 1;                     // weak: one class only
  if (classes === 2) return pw.length >= 12 ? 3 : 2;
  return pw.length >= 12 ? 4 : 3;
}

const PW_LABELS = ['Too short', 'Too simple', 'Fair', 'Good', 'Strong'];

/** Live strength readout under the signup password field. */
function renderPasswordStrength() {
  const input = document.getElementById('suPass');
  const box = document.getElementById('suPassStrength');
  if (!input || !box) return;
  const pw = input.value;
  if (!pw) { box.textContent = ''; box.className = 'pw-strength'; return; }
  const score = passwordScore(pw);
  box.textContent = PW_LABELS[score];
  box.className = `pw-strength is-s${score}`;
}
/* THE NATIONAL NUMBER ONLY — the dial code is a separate control now.
   The bound is 6 at the bottom because plenty of countries are shorter than
   ten digits (Iceland is 7, the Faroes 6), and 14 at the top because E.164
   caps the WHOLE number at 15 and the shortest dial code is one digit. The
   combined length is checked separately, against the same 15. */
const isMobile = v => /^\d{6,14}$/.test(String(v).replace(/[\s-]/g, ''));

/** The sign-up form's country select, filled from the shared table.
 *
 *  Built here rather than written into index.html because it is 239 options:
 *  that is 12KB of markup on a page that mostly never opens this dialog, and
 *  three other forms want the same list (see country-codes.js). */
(function fillDialCodes() {
  if (typeof CountryCodes === 'undefined') return;
  /* Two selects now: signup's, and the sign-in mobile field's. */
  ['suDial', 'authDial'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = CountryCodes.options(CountryCodes.DEFAULT_ISO);
  });
})();

/** '+91', from whatever the given select is showing. */
function dialOfSelect(id) {
  const sel = document.getElementById(id);
  return (typeof CountryCodes !== 'undefined')
    ? CountryCodes.dialOf(sel ? sel.value : null) : '+91';
}
function signupDial() { return dialOfSelect('suDial'); }

/* Clear a field's error the moment the traveller starts fixing it — leaving
   it there while they type reads as though the correction is not registering. */
authOverlay.addEventListener('input', e => {
  if (e.target.id && e.target.matches('input') && e.target.classList.contains('is-invalid')) {
    setFieldError(e.target.id, '');
  }
  if (e.target.id === 'suPass') renderPasswordStrength();
  if (e.target === authEmailInput || e.target === authMobileInput) syncContinueBtn();
});

/* Mobile Number <-> Email. The caret follows the field that just appeared,
   and an error written against the other one is no longer about anything. */
authOverlay.addEventListener('change', e => {
  if (e.target.name !== 'authMethod') return;
  setFieldError('authEmail', '');
  setFieldError('authMobile', '');
  syncAuthMethod();
  (authMethod() === 'email' ? authEmailInput : authMobileInput).focus();
});

/* --- open / close --------------------------------------------------------- */
function openAuth(step) {
  /* Callers elsewhere on the page still say openAuth('login') / ('signup') —
     the wishlist prompt, the review form, the account chip. Those are no
     longer step names, and there is nothing to translate them into: the whole
     point is that the traveller does not pick a side any more. Anything that
     is not a real step opens the flow at the beginning. */
  if (step && !AUTH_STEPS[step]) step = undefined;
  authReturnFocus = document.activeElement;
  authOverlay.classList.remove('closing');
  authOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  otpChallenge = null;
  syncAuthMethod();
  syncDialFace();
  showStep(step || 'email');
}

function closeAuth() {
  /* Animate out, then hide. The class is removed on transitionend rather than
     a timer so the two cannot drift apart if the duration changes in CSS. */
  authOverlay.classList.add('closing');
  const done = () => {
    authOverlay.classList.remove('open', 'closing');
    document.body.style.overflow = '';
    authOverlay.removeEventListener('transitionend', done);
  };
  authOverlay.addEventListener('transitionend', done);
  /* Belt and braces: if the overlay has no transition (reduced motion),
     transitionend never fires. */
  setTimeout(done, 300);

  otpChallenge = null;
  stopResendTimer();
  clearOtp(false);
  showDevOtp(null);
  clearFieldErrors();
  /* Dismissed without signing in: the account tab that opened the modal is
     no longer wanted. (A successful sign-in took it already, above.) */
  if (typeof AccountCenter !== 'undefined' && AccountCenter.clearPendingTab) AccountCenter.clearPendingTab();
  if (authReturnFocus && document.contains(authReturnFocus)) authReturnFocus.focus();
  authReturnFocus = null;
}

/* --- focus trap -----------------------------------------------------------
   Tab must not walk out of a modal dialog and start operating the page behind
   it, which is still there and still clickable to a screen reader otherwise. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
authOverlay.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || !authOverlay.classList.contains('open')) return;
  const items = Array.from(authCard.querySelectorAll(FOCUSABLE))
    .filter(el => el.offsetParent !== null);        // visible only
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* --- entry points --------------------------------------------------------- */
document.querySelectorAll('[data-auth]').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    /* A partner session is none of this modal's business: forwarding a
       traveller's click into the Merchant Portal — just because someone at
       that desk signed in earlier on the same browser — is the wrong product.
       My Partner is the merchant's route. */
    const { access } = getStoredAuth();
    if (access) {
      /* Signed in, so the "Sign Up" slot is the sign-out. */
      if (el.dataset.auth === 'signup') {
        axios.post(`${API_BASE}/api/customer/auth/logout`, {}, { headers: { Authorization: `Bearer ${access}` } }).catch(() => {});
        clearStoredAuth();
        wishlistMap = new Map();
        renderAuthNav();
      }
      return;
    }
    /* BOTH buttons open the same modal at the same step. Which one was
       pressed no longer decides anything — the email does. */
    openAuth();
  });
});

/* In-modal navigation: Change, Forgot Password, Create your account, Back. */
authOverlay.addEventListener('click', e => {
  const target = e.target.closest('[data-step]');
  if (!target) return;
  e.preventDefault();
  const next = target.dataset.step;
  /* GUEST IS NOT A STEP, it is the way out. There is no guest session and
     nothing is created: booking already works signed out, so the honest
     implementation of "continue as guest" is to stop asking and give the page
     back. It rides on the same [data-step] dispatcher because it sits in the
     same row of links; showStep() would throw on a name AUTH_STEPS has no
     view for, so it is answered before that. */
  if (next === 'guest') { closeAuth(); return; }
  /* Carrying the address into signup is prepareSignup()'s job, run by
     showStep; the first step keeps its own values, so coming back to it
     returns exactly what was typed there. */
  showStep(next);
});

authCloseBtn.addEventListener('click', closeAuth);
authOverlay.addEventListener('click', e => { if (e.target === authOverlay) closeAuth(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && authOverlay.classList.contains('open')) closeAuth();
});

/* --- step 1: mobile number or email -> the code ---------------------------
   Continue validates, then asks /request-otp to send the code. That is the
   whole sign-in on this side: no password, and no session until the code is
   spent at /verify-otp. */
document.getElementById('authEmailForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('authContinueBtn');
  const msg = document.getElementById('authEmailMsg');
  if (isBusy(btn)) return;
  clearFieldErrors();
  setModalMsg(msg, '', 'muted');

  const byEmail = authMethod() === 'email';
  const fieldId = byEmail ? 'authEmail' : 'authMobile';
  if (byEmail) {
    const email = authEmailInput.value.trim();
    if (!email) return setFieldError('authEmail', 'Enter your email address.');
    if (!isEmail(email)) return setFieldError('authEmail', 'Enter a valid email address.');
  } else {
    const national = authMobileInput.value.trim();
    if (!national) return setFieldError('authMobile', 'Enter your mobile number.');
    if (!isMobile(national)) return setFieldError('authMobile', 'Enter a valid mobile number.');
    if ((dialOfSelect('authDial') + national).replace(/\D/g, '').length > 15) {
      return setFieldError('authMobile', 'That number is too long for the country code selected.');
    }
  }

  const identifier = stepOneIdentifier();
  setBusy(btn, true, 'Sending OTP…');
  try {
    const { data } = await axios.post(`${API_BASE}/api/customer/auth/request-otp`, { identifier });
    showOtpStep(data, 'login', identifier);
  } catch (err) {
    const status = err?.response?.status;
    /* No account matched: say so beside the field, where the fix is — the
       "Create an account" panel sits directly under this button. */
    if (status === 404) {
      setFieldError(fieldId, byEmail
        ? "We couldn't find an account with this email. Check it, or create an account below."
        : "We couldn't find an account with this mobile number. Check it, or create an account below.");
    } else if (status === 429) {
      setModalMsg(msg, 'Too many OTP requests. Please wait a little and try again.', 'error');
    } else if (status === 503) {
      /* The code could not be emailed (customer_otp_service.issue). Nothing
         was sent, so saying so is the truth; the generic 5xx line is not. */
      setModalMsg(msg, "We couldn't send your OTP right now. Please try again in a few minutes.", 'error');
    } else {
      setModalMsg(msg, authErrorFor(err, 'We could not send the OTP. Please try again.'), 'error');
    }
  } finally {
    setBusy(btn, false);
    syncContinueBtn();
  }
});

/* The country face beside the mobile field shows the flag and dial code
   only; the native select under it (transparent, full size) is what the
   traveller actually operates, so keyboard and screen-reader use is the
   browser's own. */
function syncDialFace() {
  const sel = document.getElementById('authDial');
  const face = document.getElementById('authDialFace');
  if (!sel || !face || typeof CountryCodes === 'undefined') return;
  face.querySelector('.auth-dial-flag').textContent = CountryCodes.flag(sel.value);
  face.querySelector('.auth-dial-code').textContent = CountryCodes.dialOf(sel.value);
}
document.getElementById('authDial').addEventListener('change', syncDialFace);

/* Where a MERCHANT lands once signed in. The sign-in itself lives on
   partner-login.html now; this constant stays because the Operations handoff
   still sends merchants through. The merchant UI is the Classic portal —
   merchant/ (Premium) redirects to it and its files are all still on disk. */
const MERCHANT_PORTAL_URL = 'merchant-classic/';

/* Where a traveller resets a forgotten password. The modal has no room for the
   reset form, and the emailed link has to land on a real page, so both live on
   their own: customer/forgot-password.html requests the link and
   customer/reset-password.html consumes the token the backend mails out. */
const CUSTOMER_RESET_URL = 'customer/forgot-password.html';

function setModalMsg(el, text, tone) {
  el.textContent = text;
  el.style.color = tone === 'error' ? 'var(--coral-dark)'
    : tone === 'ok' ? 'var(--emerald)' : 'var(--muted)';
  el.classList.toggle('show', !!text);
}

/* ===========================================================================
   CUSTOMER AUTH — sign up, sign in, and stay right here.
   ===========================================================================
   Both /api/customer/auth/signup and /api/customer/auth/login answer with the
   SAME CustomerLoginChallengeResponse: no session, just a challenge token and
   a posted code. So registration and sign-in converge on one shared OTP step
   (#loginStepOtp) instead of each carrying its own copy of it.

   Nothing here navigates. On success the modal closes and renderAuthNav()
   swaps the Login/Sign Up links for the profile chip — the traveller stays on
   the page they were reading. That is the V1 behaviour this page was built
   around, and the Account Center below is still the original V1 code.
   =========================================================================== */

/** The challenge in flight, and which form started it (copy only). */
let otpChallenge = null;
let otpOrigin = 'login';

/** Move to the code step. Signup borrows this too.
 *
 *  `identifier` is what the traveller signed in with (or, for signup, the
 *  email they registered) — only ever used to say, masked, where the code
 *  went. The server's `message` is deliberately not shown: in email mode it
 *  prints the full address. */
function showOtpStep(challenge, origin, identifier) {
  otpChallenge = challenge.challenge_token;
  otpOrigin = origin;
  showStep('otp');

  const sub = document.getElementById('loginOtpSub');
  const dest = document.getElementById('otpDest');
  const back = document.getElementById('liBackLabel');
  if (isEmail(identifier)) {
    sub.textContent = "We've sent a 6-digit OTP to";
    dest.textContent = maskEmail(identifier);
    back.textContent = origin === 'signup' ? 'Change your details' : 'Change email address';
  } else {
    /* Codes are emailed, never texted — see the note on #loginStepOtp. */
    sub.textContent = "We've sent a 6-digit OTP to the email registered with";
    dest.textContent = maskMobile(identifier);
    back.textContent = 'Change mobile number';
  }

  setModalMsg(document.getElementById('loginOtpMsg'), '', 'muted');
  showDevOtp(challenge.dev_otp);
  clearOtp(true);
  startResendTimer();
}

/* --- the six boxes ---------------------------------------------------------
   Six inputs, one value. Typing moves forward, Backspace on an empty box
   moves back and clears it, the arrow keys walk, and a pasted or autofilled
   code is spread across all six from wherever it lands (a full six-digit
   paste always starts at the first box). Non-digits never make it in. */
const otpBoxes = Array.from(document.querySelectorAll('#otpBoxes .otp-box'));
const OTP_LEN = otpBoxes.length;

function otpValue() { return otpBoxes.map(b => b.value).join(''); }

function spreadOtp(digits, start) {
  const from = digits.length >= OTP_LEN ? 0 : start;
  digits.slice(0, OTP_LEN - from).split('').forEach((d, k) => { otpBoxes[from + k].value = d; });
  const next = Math.min(from + digits.length, OTP_LEN - 1);
  otpBoxes[next].focus();
  afterOtpChange();
}

function clearOtp(focus) {
  otpBoxes.forEach(b => { b.value = ''; });
  setOtpError('');
  syncVerifyBtn();
  if (focus && otpBoxes[0]) otpBoxes[0].focus();
}

function setOtpError(text) {
  document.getElementById('liOtpErr').textContent = text || '';
  otpBoxes.forEach(b => {
    b.classList.toggle('is-invalid', !!text);
    b.setAttribute('aria-invalid', text ? 'true' : 'false');
  });
}

function syncVerifyBtn() {
  const btn = document.getElementById('liVerifyBtn');
  if (!isBusy(btn)) btn.disabled = otpValue().length !== OTP_LEN;
}

function afterOtpChange() {
  if (document.getElementById('liOtpErr').textContent) setOtpError('');
  syncVerifyBtn();
}

otpBoxes.forEach((box, i) => {
  box.addEventListener('focus', () => box.select());
  box.addEventListener('input', () => {
    const digits = box.value.replace(/\D/g, '');
    if (digits.length > 1) { box.value = ''; spreadOtp(digits, i); return; }
    box.value = digits;
    if (digits && i < OTP_LEN - 1) otpBoxes[i + 1].focus();
    afterOtpChange();
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      e.preventDefault();
      otpBoxes[i - 1].value = '';
      otpBoxes[i - 1].focus();
      afterOtpChange();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault(); otpBoxes[i - 1].focus();
    } else if (e.key === 'ArrowRight' && i < OTP_LEN - 1) {
      e.preventDefault(); otpBoxes[i + 1].focus();
    }
  });
  box.addEventListener('paste', e => {
    const digits = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '');
    e.preventDefault();
    if (digits) spreadOtp(digits, i);
  });
});

/* --- resend countdown ------------------------------------------------------
   Thirty seconds between requests, on the client, so an impatient traveller
   is not the one who spends the server's limit (five codes an hour per
   customer, five resends a minute per IP — customer_otp_service and the
   /resend-otp decorator). Those are the real controls; this is manners. */
const RESEND_SECONDS = 30;

function startResendTimer() {
  stopResendTimer();
  const btn = document.getElementById('liResendBtn');
  let left = RESEND_SECONDS;
  const tick = () => {
    if (left <= 0) { stopResendTimer(true); return; }
    btn.disabled = true;
    btn.textContent = `Resend OTP in ${left}s`;
    left -= 1;
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

function stopResendTimer(ready) {
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = null;
  if (ready) {
    const btn = document.getElementById('liResendBtn');
    btn.disabled = false;
    btn.textContent = 'Resend OTP';
  }
}


/** Leave the code step, dropping the challenge.
 *
 *  Back to the first step, which still holds what was typed so it can be
 *  corrected — or, after a signup, back to the signup form, so a correction
 *  there does not dump the traveller on a form they never asked for. */
/** Local development only: show the code the API returned.
 *
 *  `dev_otp` exists only on a non-deployed host in dev delivery mode — the
 *  backend never sends it from a deployed one (settings.deployed), so in
 *  production this always receives nothing and hides the box. The frontend
 *  decides nothing here; it only displays what the server chose to return.
 *  Text content, never innerHTML, and never logged or stored. */
function showDevOtp(code) {
  const el = document.getElementById('liDevOtp');
  if (!el) return;
  el.textContent = code ? `Development mode — your code is ${code}` : '';
  el.hidden = !code;
}

function showCredsStep() {
  otpChallenge = null;
  stopResendTimer();
  showDevOtp(null);
  clearOtp(false);
  if (otpOrigin === 'signup') showStep('signup');
  else showStep('email');
}

/** The one place a customer session is created. */
function completeCustomerSignIn(data) {
  const c = data.customer || {};
  setStoredAuth(data.access_token, data.refresh_token, c.full_name || 'Traveller',
                'customer', c.id);
  otpChallenge = null;
  renderAuthNav();
  /* Taken BEFORE closeAuth(), which forgets it: a Wishlist (or other account)
     click that opened this modal gets that screen as soon as the traveller is
     signed in, instead of having to click it again. */
  const acctTab = (typeof AccountCenter !== 'undefined' && AccountCenter.takePendingTab)
    ? AccountCenter.takePendingTab() : null;
  closeAuth();
  /* Reset to the first step for next time, AFTER closing — doing it before
     would flash the email form as the modal fades out. */
  showStep('email');

  /* If the traveller was stopped mid-search, resume it. The greeting is
     skipped in that case: they are already navigating away, and a toast that
     outlives its page is just a flicker. */
  if (typeof resumePendingSearch === 'function' && resumePendingSearch()) return;
  /* Or sent here from another page to sign in — go back to it. Same reason the
     greeting is skipped: they are leaving. */
  if (returnToNext()) return;
  showToast(`Welcome back, ${(c.full_name || '').split(' ')[0] || 'traveller'}!`);
  if (acctTab && typeof AccountCenter !== 'undefined') AccountCenter.open(acctTab);
}

/** Honour `?next=` after signing in.
 *
 *  A service page that has no sign-in modal of its own sends the traveller here
 *  with `next` set to where they were — the wishlist heart on the Hotels
 *  results does exactly that, and carries the filters with it — so signing in
 *  returns them to the list they were reading rather than stranding them on the
 *  home page.
 *
 *  SAME-ORIGIN PATHS ONLY. `next` comes from a URL anyone can write, and a
 *  redirect that accepts whatever it is handed is an open redirect: a link that
 *  looks like this site and lands on someone else's login form. It must start
 *  with a single "/" — which rejects "//evil.test" (protocol-relative) and
 *  "https://evil.test" alike — and is resolved against this origin so the
 *  browser cannot be talked into leaving it.
 *
 *  @returns {boolean} whether a navigation was started. */
function returnToNext() {
  const raw = new URLSearchParams(location.search).get('next');
  if (!raw || raw[0] !== '/' || raw[1] === '/' || raw.includes('\\')) return false;
  const url = new URL(raw, location.origin);
  if (url.origin !== location.origin) return false;
  location.href = url.pathname + url.search + url.hash;
  return true;
}

/* --- Registration ------------------------------------------------------- */
document.getElementById('signupForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const name = document.getElementById('suName').value.trim();
  const email = document.getElementById('suEmail').value.trim();
  const mobile = document.getElementById('suMobile').value.trim();
  const pass = document.getElementById('suPass').value;
  const pass2 = document.getElementById('suPass2').value;
  const msg = document.getElementById('signupMsg');

  /* Inline, beside the field, never in an alert. Checked here only so the
     traveller is told which field is wrong and lands in it — the server
     validates all of this again and is the authority. */
  clearFieldErrors();
  if (name.length < 2) return setFieldError('suName', 'Enter your full name.');
  if (!isEmail(email)) return setFieldError('suEmail', 'That does not look like an email address.');
  if (!isMobile(mobile)) return setFieldError('suMobile', 'Enter a valid mobile number, 6 to 14 digits.');
  /* E.164 caps the dial code and the number together at 15 digits. Checked
     here so the traveller is told which field to shorten, not handed the
     server's generic rejection of the whole form. */
  const dial = signupDial();
  if ((dial + mobile).replace(/[^\d]/g, '').length > 15) {
    return setFieldError('suMobile', 'That number is too long for the country code selected.');
  }
  if (pass.length < 8) return setFieldError('suPass', 'Use at least 8 characters.');
  if (passwordScore(pass) < 2) {
    return setFieldError('suPass',
      'Mix in a capital, a number or a symbol — this one is too easy to guess.');
  }
  if (pass !== pass2) return setFieldError('suPass2', 'Both passwords must match.');

  const suBtn = document.getElementById('suRequestBtn');
  if (isBusy(suBtn)) return;
  setModalMsg(msg, '', 'muted');
  setBusy(suBtn, true, 'Creating your account…');
  try {
    const { data } = await axios.post(`${API_BASE}/api/customer/auth/signup`, {
      /* The dial code travels WITH the number. The API stores one string and
         validates `^\+?\d{8,15}$`, so a bare national number would be
         indistinguishable from an Indian one the moment anybody tried to ring
         it back. */
      full_name: name, email, mobile: dial + mobile.replace(/[\s-]/g, ''),
      password: pass, confirm_password: pass2,
    });
    setModalMsg(msg, '', 'muted');
    /* The signup code goes to the email just registered, so that is the
       address shown (masked) on the code step. */
    showOtpStep(data, 'signup', email);
  } catch (err) {
    setModalMsg(msg, apiErrorText(err, 'We could not create your account.'), 'error');
  } finally {
    setBusy(suBtn, false);
  }
});

/* --- Sign in, step 2: the code ------------------------------------------
   The server's wording is translated into the messages a traveller can act
   on. Its details are already plain English — this API never returns a stack
   trace — but "No verification code outstanding" means nothing to someone
   looking at a code in their inbox, and it is the same situation as an
   expired one: ask for another. */
function otpFailureText(err) {
  const status = err?.response?.status;
  const detail = String(err?.response?.data?.detail || '');
  if (status === 400 && /expired|outstanding/i.test(detail)) {
    return { expired: true, text: 'OTP expired. Please request a new OTP.' };
  }
  if (status === 429) return { expired: true, text: 'Too many attempts. Please request a new OTP.' };
  if (status === 400) return { expired: false, text: 'Invalid OTP. Please try again.' };
  return null;
}

/** A server fault is never shown in its own words — a 5xx detail is for the
 *  log, not the traveller. Everything else keeps apiErrorText's wording,
 *  which already handles the unreachable-server and rate-limit cases. */
function authErrorFor(err, fallback) {
  if ((err?.response?.status || 0) >= 500) return 'Something went wrong on our side. Please try again.';
  return apiErrorText(err, fallback);
}

/** The challenge is gone server-side: only asking for a new code can work. */
function otpSessionExpired() {
  showCredsStep();
  setModalMsg(document.getElementById(otpOrigin === 'signup' ? 'signupMsg' : 'authEmailMsg'),
    'Your sign-in session expired. Please continue again.', 'error');
}

document.getElementById('otpForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('liVerifyBtn');
  const msg = document.getElementById('loginOtpMsg');
  if (isBusy(btn)) return;
  setModalMsg(msg, '', 'muted');

  const code = otpValue();
  if (!/^\d{6}$/.test(code)) { setOtpError('Enter all 6 digits of the OTP.'); return; }
  if (!otpChallenge) { otpSessionExpired(); return; }

  setBusy(btn, true, 'Verifying…');
  let signedIn = false;
  try {
    const { data } = await axios.post(`${API_BASE}/api/customer/auth/verify-otp`,
      { challenge_token: otpChallenge, code });
    signedIn = true;
    stopResendTimer();
    completeCustomerSignIn(data);
  } catch (err) {
    /* A dead challenge means the ten-minute window closed. Say so and go
       back, rather than leaving them retrying a code against a token the
       server has forgotten. */
    if (err?.response?.status === 401) { otpSessionExpired(); return; }
    const known = otpFailureText(err);
    if (!known) {
      setModalMsg(msg, authErrorFor(err, 'We could not verify the OTP. Please try again.'), 'error');
      return;
    }
    /* Wrong digits are cleared so the next attempt starts clean; an expired
       or burned code frees Resend at once — waiting out the countdown for a
       code that can never work is pointless. */
    clearOtp(true);
    setOtpError(known.text);
    if (known.expired) stopResendTimer(true);
  } finally {
    setBusy(btn, false);
    if (!signedIn) syncVerifyBtn();
  }
});

document.getElementById('liResendBtn').addEventListener('click', async () => {
  const btn = document.getElementById('liResendBtn');
  const msg = document.getElementById('loginOtpMsg');
  if (btn.disabled) return;
  if (!otpChallenge) { otpSessionExpired(); return; }

  /* Disabled for the whole request and then for a fresh countdown, success
     or failure alike, so a failing resend cannot be hammered either. */
  btn.disabled = true;
  btn.textContent = 'Sending…';
  setModalMsg(msg, '', 'muted');
  try {
    const { data } = await axios.post(`${API_BASE}/api/customer/auth/resend-otp`,
      { challenge_token: otpChallenge });
    /* Resending issues a FRESH challenge; keeping the old token would verify
       against a code that is no longer the live one. The displayed dev code
       has to move with it for the same reason. */
    if (data.challenge_token) otpChallenge = data.challenge_token;
    showDevOtp(data.dev_otp);
    clearOtp(true);
    setModalMsg(msg, 'A new OTP has been sent.', 'ok');
  } catch (err) {
    if (err?.response?.status === 401) { otpSessionExpired(); return; }
    setModalMsg(msg, err?.response?.status === 429
      ? 'Too many OTP requests. Please try again later.'
      : authErrorFor(err, 'We could not send a new OTP. Please try again.'), 'error');
  }
  startResendTimer();
});

/* "Change mobile number" / "Change email address": back to the first step,
   which still holds what was typed, so it can be corrected rather than
   retyped. The challenge is dropped — a code for the old address is no use. */
document.getElementById('liBackBtn').addEventListener('click', () => {
  showCredsStep();
});

/* ---------------------------------------------------------------------------
   Arriving here to sign in, sent by the Operations workspace.

   HISTORICAL: /operations/ used to bounce merchants to this page with #login,
   because the modal above was the merchant login. It now sends them to
   partner-login.html instead (OPS_SIGNIN in operations/js/ops-core.js), so this
   handler only catches an old bookmark or an in-flight tab — and it must not
   open the CUSTOMER modal for a merchant. It forwards instead, carrying the
   reason so the partner login can still explain itself.
   --------------------------------------------------------------------------- */
(function handleOperationsSignInHandoff() {
  if (location.hash !== '#login') return;

  /* A live session means they did not need to sign in at all — just go. */
  if (isPartnerLoggedIn()) {
    window.location.replace(MERCHANT_PORTAL_URL);
    return;
  }

  const reason = new URLSearchParams(location.search).get('ops_reason');
  window.location.replace('partner-login.html'
    + (reason ? `?ops_reason=${encodeURIComponent(reason)}` : ''));
})();

/* THE "FORGOT PASSWORD?" HANDLER USED TO LIVE HERE, AND IT WAS WRONG TWICE.

   It POSTed the typed address to /api/auth/forgot-password — the PLATFORM
   reset, which reads the `users` table. That is the merchant/admin side. For a
   traveller it is the wrong system entirely, and it is precisely the kind of
   cross-boundary call the Customer Portal was built to make impossible.

   It also called e.preventDefault(), so once the link was pointed at the
   portal's own reset page the navigation would have been swallowed and the
   platform call made instead — the link would have looked right and behaved
   wrong.

   The customer reset is /api/customer/auth/forgot-password, reached through
   customer/forgot-password.html. That is a plain <a href> in the markup now,
   with no JavaScript in front of it, so there is nothing here to get wrong. */

/* ================================================================
   ACCOUNT CENTER — now assets/js/account-center.js, so that every
   B2C page can open it instead of only this one.

   It used to be the bottom 800 lines of this file, which is why the
   profile chip on the flight, hotel and package pages navigated HERE
   rather than opening it in place: on those pages it did not exist.
   The markup it drives is still the block at the bottom of
   index.html; the module injects its own copy only on pages that
   have none.

   These two are declarations, not consts, because both are called
   from handlers defined ABOVE this point.
   ================================================================ */
AccountCenter.configure({
  API_BASE,
  apiErrorText,
  mobileNav,
  openAuth,
  renderAuthNav,
  /* app.js owns the wishlist map; logging out clears it here so the
     hearts rendered by this file go dark with it. */
  resetWishlist: () => { wishlistMap = new Map(); },
});

function openAccountCenter(tab)   { return AccountCenter.open(tab); }
function loadUpcomingJourney()    { return AccountCenter.loadUpcomingJourney(); }
