'use strict';

/* Backend API base.
   Same-origin everywhere EXCEPT the documented two-terminal dev setup, where
   the frontend is served by `python -m http.server 5500` and the API is a
   separate uvicorn on 8000.

   This used to send every localhost request to :8000 regardless of where the
   page was actually served from, which broke the case app.main is built for —
   uvicorn serving frontend/ AND /api from one origin (see .claude/launch.json,
   "app.main mounts frontend/ at /, so this origin serves the portals AND
   /api — same-origin, which the hardcoded API_BASE needs"). Anything that is
   not the static-server port now talks to its own origin. */
const STATIC_DEV_PORTS = ['5500', '5501'];
const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname)
                  && STATIC_DEV_PORTS.includes(location.port))
  ? 'http://127.0.0.1:8000' : '';

/* escapeHtml() now lives in shared/formatters.js, loaded before this file. */

/* Turn an axios failure into a sentence a person can act on.
   FastAPI returns `detail` as a plain string for a raised HTTPException but as
   an ARRAY of {loc,msg,type} objects for a 422 validation error. Assigning that
   array straight to textContent renders "[object Object]", which is what the
   login and signup forms used to show. */
function apiErrorText(err, fallback) {
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
const SERVICE_PAGE = {
  flights: 'flights.html',
  hotels: 'hotels.html',
  cruises: 'cruises.html',
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

/* Duplicate auto-scroll tracks for seamless infinite loop */
[document.getElementById('offersTrack'), document.getElementById('partnersTrack')].forEach(track => {
  if (track) track.innerHTML += track.innerHTML;
});

/* Trending route price flip (simulated live ticker) */
document.querySelectorAll('.route-price .amt[data-price]').forEach(amt => {
  setInterval(() => {
    const base = parseInt(amt.dataset.price, 10);
    const jitter = Math.round((Math.random() - 0.5) * base * 0.06);
    amt.classList.remove('flip');
    void amt.offsetWidth;
    amt.textContent = '₹' + (base + jitter).toLocaleString('en-IN');
    amt.classList.add('flip');
  }, 4000 + Math.random() * 2000);
});

/* Animated stat counters */
document.querySelectorAll('.stat-num').forEach(stat => {
  const target = parseInt(stat.dataset.count, 10);
  const suffix = stat.dataset.suffix || '';
  const statObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const duration = 1600;
        const start = performance.now();
        function tick(now) {
          const progress = Math.min(1, (now - start) / duration);
          const eased = 1 - Math.pow(1 - progress, 3);
          stat.textContent = Math.round(target * eased).toLocaleString('en-US') + suffix;
          if (progress < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
        statObserver.unobserve(stat);
      }
    });
  }, { threshold: 0.4 });
  statObserver.observe(stat);
});

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
    btn.textContent = saved ? '♥' : '♡';
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
    applyWishlistState(wlBtn.closest('.pkg-grid'));
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
};

/** Park a search so signing in can resume it. sessionStorage, not local: a
 *  search is about this visit, and finding yesterday's criteria reapplied on
 *  a new tab would be surprising. */
const PENDING_SEARCH_KEY = 'jpc_pending_search';

function storePendingSearch(kind, params) {
  try { sessionStorage.setItem(PENDING_SEARCH_KEY, JSON.stringify({ kind, params })); }
  catch { /* private mode — the traveller just re-runs the search */ }
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
    if (!HERO_SEARCH[kind]) {
      showToast("Cruise search isn't available yet — browse our featured sailings below.", true);
      return;
    }
    const { access } = getStoredAuth();
    if (!access) {
      storePendingSearch(kind, params);
      openAuth();
      return;
    }
    goToSearch(kind, params);
  });
}

/** Called once a session exists. Returns true if it navigated. */
function resumePendingSearch() {
  const pending = takePendingSearch();
  if (!pending || !HERO_SEARCH[pending.kind]) return false;
  goToSearch(pending.kind, pending.params);
  return true;
}

/* AI chatbot */
const chatPanel = document.getElementById('chatPanel');
const chatBody = document.getElementById('chatBody');
function toggleChatPanel(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : !chatPanel.classList.contains('open');
  chatPanel.classList.toggle('open', open);
  fabAiBtn.setAttribute('aria-expanded', String(open));
}
const chatReplies = {
  'Best Goa package': "Our top pick is 'Goa Escape' — 4 days, beachfront stay, from ₹5,999. Want me to open it?",
  'Cheapest flights today': 'Hyderabad → Delhi is trending at ₹2,499 today. Check the Flights tab above for live fares.',
  'Hotels near beaches': 'Goa has 200+ verified beachfront hotels from ₹1,999/night, free cancellation included.',
  'Weekend trips under ₹10,000': 'Try Manali (from ₹7,499) or Kerala backwaters (from ₹9,299) — both fit a long weekend.'
};
document.querySelectorAll('.chat-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const q = chip.dataset.q;
    const userMsg = document.createElement('div');
    userMsg.className = 'chat-msg user';
    userMsg.textContent = q;
    chatBody.appendChild(userMsg);
    const botMsg = document.createElement('div');
    botMsg.className = 'chat-msg bot';
    botMsg.textContent = chatReplies[q] || "Let me look into that for you!";
    chatBody.appendChild(botMsg);
    chatBody.scrollTop = chatBody.scrollHeight;
  });
});

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
  const { access } = getStoredAuth();
  if (access) {
    openAccountCenter('support');
  } else {
    showToast('Log in to view your support tickets — or send us a message below.');
    document.getElementById('contact').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

/* Button 4: AI Travel Assistant — reuses the existing chatbot panel */
fabAiBtn.addEventListener('click', () => {
  setFabOpen(false);
  toggleChatPanel();
});

/* Button 3: Voice Search — lazily initialized Web Speech API, fills the active search tab */
let voiceRecognition = null;
function getVoiceRecognition() {
  if (voiceRecognition) return voiceRecognition;
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) return null;
  voiceRecognition = new SpeechRecognitionCtor();
  voiceRecognition.lang = 'en-IN';
  voiceRecognition.interimResults = false;
  voiceRecognition.maxAlternatives = 1;
  return voiceRecognition;
}
function setNativeDate(displayInputId, dateStr) {
  const display = document.getElementById(displayInputId);
  const native = display?.closest('.field-date')?.querySelector('.date-native');
  if (!native) return;
  native.value = dateStr;
  native.dispatchEvent(new Event('change'));
}
function isoDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function titleCaseWords(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }

function applyVoiceQuery(transcript) {
  const text = transcript.trim();
  const lower = text.toLowerCase();
  let confidentMatch = false;

  let dateStr = null;
  if (/\btomorrow\b/.test(lower)) dateStr = isoDateOffset(1);
  else if (/\btoday\b/.test(lower)) dateStr = isoDateOffset(0);
  const cleaned = lower.replace(/\b(tomorrow|today)\b/g, '').trim();

  /* HOTELS, CRUISES AND PACKAGES LEAVE THIS PAGE. Their search panels are not
     in the hero card any more — each product has its own page — so what was
     heard travels there in the URL rather than being typed into fields that no
     longer exist here. The toast is spoken before the navigation, because
     after it there is no page left to show it on. */
  if (/\bhotels?\b/.test(lower)) {
    const m = cleaned.match(/\bhotels?\s+(?:in|at|near)\s+([a-z\s]+)/i) || cleaned.match(/\bin\s+([a-z\s]+)$/i);
    showToast(`Heard: "${text}"`);
    activateTab('hotels', { dest: m ? titleCaseWords(m[1].trim()) : '', checkIn: dateStr || '' });
    return;
  } else if (/\bcruises?\b/.test(lower)) {
    /* Nothing to carry: no free-text criterion is heard here, and the cruise
       page is a browse rather than a search. */
    showToast(`Heard: "${text}"`);
    activateTab('cruises');
    return;
  } else if (/\b(packages?|tours?)\b/.test(lower)) {
    showToast(`Heard: "${text}"`);
    activateTab('packages');
    return;
  } else {
    activateTab('flights');
    const m = cleaned.match(/([a-z\s]+?)\s+to\s+([a-z\s]+)/i);
    if (m) {
      document.getElementById('fFrom').value = titleCaseWords(m[1].trim());
      document.getElementById('fTo').value = titleCaseWords(m[2].trim());
      confidentMatch = true;
    }
    if (dateStr) setNativeDate('fDep', dateStr);
  }

  showToast(`Heard: "${text}"`);
  if (confidentMatch) {
    /* One Search button for the whole card now, in its footer — it is no
       longer inside the active panel. */
    document.querySelector('.search-card .search-go')?.click();
  }
}
fabVoiceBtn.addEventListener('click', () => {
  setFabOpen(false);
  const recognition = getVoiceRecognition();
  if (!recognition) {
    showToast("Voice search isn't supported in this browser — try Chrome or Edge.", true);
    return;
  }
  if (fabVoiceBtn.classList.contains('listening')) { recognition.stop(); return; }
  fabVoiceBtn.classList.add('listening');
  showToast('Listening… try "Hyderabad to Delhi tomorrow"');
  recognition.onresult = e => applyVoiceQuery(e.results[0][0].transcript);
  recognition.onerror = () => showToast("Couldn't hear that — please try again.", true);
  recognition.onend = () => fabVoiceBtn.classList.remove('listening');
  try { recognition.start(); } catch (err) { fabVoiceBtn.classList.remove('listening'); }
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
  password: 'authStepPassword',
  signup:   'authStepSignup',
  otp:      'loginStepOtp',
  forgot:   'authStepForgot',
};

/** Where focus was before the modal took it, so it can be handed back. */
let authReturnFocus = null;
let authStep = 'email';

function authView(name) { return document.getElementById(AUTH_STEPS[name]); }

/** Show one step and put the caret in the field that still needs filling. */
function showStep(name, opts) {
  if (!AUTH_STEPS[name]) return;

  /* The password and signup steps both show the address as a READONLY field,
     because it was already given on the email step. Landing on either without
     one leaves a locked, empty box and no way forward, so send them back to
     the step that collects it. Guards openAuth('signup') from elsewhere on the
     page as much as anything internal. */
  if ((name === 'password' || name === 'signup') && !currentAuthEmail()) name = 'email';

  authStep = name;
  Object.keys(AUTH_STEPS).forEach(k => { authView(k).hidden = k !== name; });

  /* Messages belong to the step that produced them. Carrying "that password
     was wrong" onto the signup form would be nonsense. */
  if (!(opts && opts.keepMessage)) {
    ['authEmailMsg', 'loginMsg', 'signupMsg', 'loginOtpMsg', 'fpMsg']
      .forEach(id => setModalMsg(document.getElementById(id), '', 'muted'));
    clearFieldErrors();
  }

  const first = authView(name).querySelector('input:not([readonly]):not([type=checkbox])');
  /* rAF so the field exists on screen before it is focused — focusing a
     hidden element silently does nothing. */
  if (first) requestAnimationFrame(() => first.focus());
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
const isMobile = v => /^\d{10,15}$/.test(String(v).replace(/[\s-]/g, ''));

/* Clear a field's error the moment the traveller starts fixing it — leaving
   it there while they type reads as though the correction is not registering. */
authOverlay.addEventListener('input', e => {
  if (e.target.matches('input') && e.target.classList.contains('is-invalid')) {
    setFieldError(e.target.id, '');
  }
  if (e.target.id === 'suPass') renderPasswordStrength();
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

  /* Remember Me gives back the address, never the password. With one on file
     the email step has nothing left to ask, so it is skipped. */
  const remembered = localStorage.getItem(CUSTOMER_KEYS.remember);
  if (!step && remembered) {
    document.getElementById('liUser').value = remembered;
    document.getElementById('liRemember').checked = true;
    showStep('password');
    return;
  }
  if (remembered) {
    document.getElementById('authEmail').value = remembered;
    document.getElementById('liRemember').checked = true;
  }
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
  clearFieldErrors();
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
  /* Carry the address forward so it is never typed twice. */
  if (next === 'signup') document.getElementById('suEmail').value = currentAuthEmail();
  if (next === 'password') document.getElementById('liUser').value = currentAuthEmail();
  if (next === 'forgot') document.getElementById('fpEmail').value = currentAuthEmail();
  if (next === 'email') document.getElementById('authEmail').value = currentAuthEmail();
  showStep(next);
});

/** Whichever step holds the address the traveller has given us. */
function currentAuthEmail() {
  const ids = ['authEmail', 'liUser', 'suEmail', 'fpEmail'];
  for (const id of ids) {
    const v = (document.getElementById(id) || {}).value;
    if (v && v.trim()) return v.trim();
  }
  return '';
}

authCloseBtn.addEventListener('click', closeAuth);
authOverlay.addEventListener('click', e => { if (e.target === authOverlay) closeAuth(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && authOverlay.classList.contains('open')) closeAuth();
});

/* --- step 1: the email ---------------------------------------------------- */
document.getElementById('authEmailForm').addEventListener('submit', e => {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  if (!email) return setFieldError('authEmail', 'Enter your email address.');
  if (!isEmail(email)) return setFieldError('authEmail', 'That does not look like an email address.');
  setFieldError('authEmail', '');

  /* Straight to the password step. If they have no account they take the
     "Create your account" link below it, which carries this address across. */
  document.getElementById('liUser').value = email;
  document.getElementById('suEmail').value = email;
  showStep('password');
});

/* --- forgot password ------------------------------------------------------
   Finishes on customer/reset-password.html, because the API issues a link
   token rather than a code. The response is deliberately the same whether or
   not the address is registered, and this shows it verbatim. */
document.getElementById('forgotForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('fpEmail').value.trim();
  const msg = document.getElementById('fpMsg');
  const dev = document.getElementById('fpDevLink');
  dev.textContent = '';
  if (!email) return setFieldError('fpEmail', 'Enter your email address.');
  if (!isEmail(email)) return setFieldError('fpEmail', 'That does not look like an email address.');
  setFieldError('fpEmail', '');

  setModalMsg(msg, 'Sending…', 'muted');
  try {
    const { data } = await axios.post(`${API_BASE}/api/customer/auth/forgot-password`, { email });
    setModalMsg(msg, data.message || 'If an account exists for that email, a reset link is on its way.', 'ok');
    /* Debug builds return the link so a reset can be tested without SMTP. */
    if (data.reset_link) {
      const a = document.createElement('a');
      a.href = data.reset_link;
      a.textContent = 'Open the reset link (debug)';
      a.className = 'modal-devlink';
      dev.appendChild(a);
    }
  } catch (err) {
    setModalMsg(msg, apiErrorText(err, 'We could not send a reset link just now.'), 'error');
  }
});

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

/** Move the login view to its code step. Signup borrows this too, which is why
 *  it makes sure the LOGIN view is the one on screen. */
function showOtpStep(challenge, message, origin) {
  otpChallenge = challenge.challenge_token;
  otpOrigin = origin;
  /* keepMessage: the step machine would otherwise wipe the line the server
     just gave us, which on this step is the whole instruction. */
  showStep('otp', { keepMessage: true });
  document.getElementById('loginOtpSub').textContent = message;
  setModalMsg(document.getElementById('loginOtpMsg'), '', 'muted');
  showDevOtp(challenge.dev_otp);
  const box = document.getElementById('liOtp');
  box.value = '';
  box.focus();
}

/** Show the code instead of emailing it.
 *
 *  The API returns `dev_otp` only in DEV_MODE — either because no mail server
 *  is configured, or because OTP_DEV_MODE is on for local work while SMTP
 *  keeps sending everything else. It is never present on a deployed server, so
 *  this is a no-op there and the code arrives by email as normal.
 *
 *  It no longer says "email is not configured": that stopped being the only
 *  reason the moment the contact form needed SMTP switched on.
 *
 *  Text content, never innerHTML — the value is echoed from a response and has
 *  no business being parsed as markup. */
function showDevOtp(code) {
  const el = document.getElementById('liDevOtp');
  if (!el) return;
  el.textContent = code ? `Development mode — your code is ${code}` : '';
  el.className = code ? 'modal-devbox' : '';
}

/** Back to the credentials step, dropping the challenge. */
function showCredsStep() {
  otpChallenge = null;
  document.getElementById('liOtp').value = '';
  /* Back to whichever form started the challenge, so "use a different
     account" after a signup does not dump the traveller on a login form
     they never asked for. */
  showStep(otpOrigin === 'signup' ? 'signup' : 'password');
}

/** The one place a customer session is created. */
function completeCustomerSignIn(data) {
  const c = data.customer || {};
  setStoredAuth(data.access_token, data.refresh_token, c.full_name || 'Traveller',
                'customer', c.id);
  otpChallenge = null;
  renderAuthNav();
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
  if (!isMobile(mobile)) return setFieldError('suMobile', 'Enter a valid mobile number, 10 to 15 digits.');
  if (pass.length < 8) return setFieldError('suPass', 'Use at least 8 characters.');
  if (passwordScore(pass) < 2) {
    return setFieldError('suPass',
      'Mix in a capital, a number or a symbol — this one is too easy to guess.');
  }
  if (pass !== pass2) return setFieldError('suPass2', 'Both passwords must match.');

  setModalMsg(msg, 'Creating your account…', 'muted');
  try {
    const { data } = await axios.post(`${API_BASE}/api/customer/auth/signup`, {
      full_name: name, email, mobile: mobile.replace(/[\s-]/g, ''),
      password: pass, confirm_password: pass2,
    });
    setModalMsg(msg, '', 'muted');
    showOtpStep(data, data.message || `A verification code was sent to ${email}.`, 'signup');
  } catch (err) {
    setModalMsg(msg, apiErrorText(err, 'We could not create your account.'), 'error');
  }
});

/* --- Sign in, step 1: password ------------------------------------------ */
document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const identifier = document.getElementById('liUser').value.trim();
  const pass = document.getElementById('liPass').value;
  const msg = document.getElementById('loginMsg');

  if (!identifier) { setModalMsg(msg, 'Enter your email or mobile number.', 'error'); return; }
  if (!pass) { setModalMsg(msg, 'Enter your password.', 'error'); return; }

  /* Remember Me holds the ADDRESS only, never the password, and it outlives
     sign-out on purpose — that is the feature. */
  if (document.getElementById('liRemember').checked) {
    localStorage.setItem(CUSTOMER_KEYS.remember, identifier);
  } else {
    localStorage.removeItem(CUSTOMER_KEYS.remember);
  }

  setModalMsg(msg, 'Checking…', 'muted');
  try {
    const { data } = await axios.post(`${API_BASE}/api/customer/auth/login`,
      { identifier, password: pass });
    setModalMsg(msg, '', 'muted');
    document.getElementById('liPass').value = '';
    showOtpStep(data, data.message || 'Enter the 6-digit code we just sent you.', 'login');
  } catch (err) {
    /* A merchant or admin address fails here exactly as an unknown one does —
       the endpoint reads the customer database and nothing else. Saying so
       would confirm the account exists somewhere, so the copy stays generic. */
    setModalMsg(msg, apiErrorText(err, 'Those details did not match an account.'), 'error');
  }
});

/* --- Sign in, step 2: the code ------------------------------------------ */
document.getElementById('liVerifyBtn').addEventListener('click', async () => {
  const code = document.getElementById('liOtp').value.trim();
  const msg = document.getElementById('loginOtpMsg');
  if (!/^\d{4,8}$/.test(code)) { setModalMsg(msg, 'Enter the code we sent you.', 'error'); return; }
  if (!otpChallenge) { setModalMsg(msg, 'That code has expired — please sign in again.', 'error'); return; }

  setModalMsg(msg, 'Verifying…', 'muted');
  try {
    const { data } = await axios.post(`${API_BASE}/api/customer/auth/verify-otp`,
      { challenge_token: otpChallenge, code });
    completeCustomerSignIn(data);
  } catch (err) {
    setModalMsg(msg, apiErrorText(err, 'That code was not right.'), 'error');
  }
});

/* Enter submits the code, the same as the button. */
document.getElementById('liOtp').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('liVerifyBtn').click(); }
});

document.getElementById('liResendBtn').addEventListener('click', async e => {
  e.preventDefault();
  const msg = document.getElementById('loginOtpMsg');
  if (!otpChallenge) { setModalMsg(msg, 'Please sign in again.', 'error'); return; }
  setModalMsg(msg, 'Sending a new code…', 'muted');
  try {
    const { data } = await axios.post(`${API_BASE}/api/customer/auth/resend-otp`,
      { challenge_token: otpChallenge });
    /* Resending issues a FRESH challenge; keeping the old token would verify
       against a code that is no longer the live one. The displayed dev code
       has to move with it for the same reason. */
    if (data.challenge_token) otpChallenge = data.challenge_token;
    showDevOtp(data.dev_otp);
    document.getElementById('liOtp').value = '';
    setModalMsg(msg, data.message || 'A new code is on its way.', 'ok');
  } catch (err) {
    setModalMsg(msg, apiErrorText(err, 'We could not send another code.'), 'error');
  }
});

document.getElementById('liBackBtn').addEventListener('click', e => {
  e.preventDefault();
  showCredsStep();
  setModalMsg(document.getElementById('loginMsg'), '', 'muted');
  document.getElementById('liUser').focus();
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
