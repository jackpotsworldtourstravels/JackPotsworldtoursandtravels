'use strict';

/* Backend API base — same-origin in production (nginx proxies /api to the backend),
   falls back to the local uvicorn dev server when the frontend is served from localhost */
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8000' : '';

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

/* Nav: header fades from transparent to solid black gradually over a long scroll range */
const header = document.getElementById('siteHeader');
const HEADER_FADE_RANGE = 600;
const updateHeader = () => {
  const progress = Math.min(1, Math.max(0, window.scrollY / HEADER_FADE_RANGE));
  header.style.backgroundColor = `rgba(0,0,0,${progress.toFixed(3)})`;
  header.style.backdropFilter = `blur(${(progress * 16).toFixed(1)}px)`;
  header.style.boxShadow = progress > 0.05 ? `0 1px 0 rgba(255,255,255,${(progress * 0.08).toFixed(3)})` : 'none';
};
window.addEventListener('scroll', updateHeader, { passive: true });
updateHeader();

const hamburgerBtn = document.getElementById('hamburgerBtn');
const mobileNav = document.getElementById('mobileNav');
hamburgerBtn.addEventListener('click', () => {
  const open = mobileNav.classList.toggle('open');
  hamburgerBtn.setAttribute('aria-expanded', open);
});
mobileNav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
  mobileNav.classList.remove('open');
  hamburgerBtn.setAttribute('aria-expanded', 'false');
}));

/* Hero parallax (subtle, disabled for reduced motion) */
const heroBg = document.getElementById('heroBg');
const heroVideoLayer = document.getElementById('heroVideoLayer');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (heroBg && !reduceMotion) {
  window.addEventListener('scroll', () => {
    const y = Math.min(window.scrollY, 800);
    const t = `translateY(${y * 0.25}px) scale(${1 + y * 0.0002})`;
    heroBg.style.transform = t;
    if (heroVideoLayer) heroVideoLayer.style.transform = t;
  }, { passive: true });
}

/* Hero background videos: one per booking tab, lazy-loaded on first use */
const heroVideos = document.querySelectorAll('.hero-video-layer video');
const HERO_VIDEO_SPEED = 1.35; // slightly faster than real-time, still smooth/natural
heroVideos.forEach(v => {
  v.playbackRate = HERO_VIDEO_SPEED;
  v.addEventListener('loadedmetadata', () => { v.playbackRate = HERO_VIDEO_SPEED; });
});
function switchHeroVideo(name) {
  heroVideos.forEach(v => {
    if (v.dataset.video === name) {
      v.classList.add('active');
      if (!v.getAttribute('src') && v.dataset.src) {
        v.setAttribute('src', v.dataset.src);
      }
      v.playbackRate = HERO_VIDEO_SPEED;
      const playPromise = v.play();
      if (playPromise && playPromise.catch) playPromise.catch(() => {});
    } else {
      v.classList.remove('active');
      v.pause();
    }
  });
}

/* Booking tabs */
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.search-panel');
function activateTab(name) {
  tabs.forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active);
  });
  panels.forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  switchHeroVideo(name);
}
tabs.forEach(tab => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
document.querySelectorAll('[data-tab-link]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    activateTab(link.dataset.tabLink);
    document.getElementById('home').scrollIntoView({ behavior: 'smooth' });
  });
});

/* Swap From/To fields */
document.querySelectorAll('.swap-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const fields = btn.parentElement.querySelectorAll('.field input');
    if (fields.length >= 2) {
      const tmp = fields[0].value;
      fields[0].value = fields[1].value;
      fields[1].value = tmp;
    }
  });
});

/* Date fields: open native picker on click, format the chosen date into the display input */
document.querySelectorAll('.field-date').forEach(field => {
  const display = field.querySelector('.date-display');
  const native = field.querySelector('.date-native');
  const openPicker = () => {
    if (native.showPicker) {
      try { native.showPicker(); } catch (e) { native.focus(); }
    } else {
      native.focus();
      native.click();
    }
  };
  display.addEventListener('click', openPicker);
  field.querySelector('.cal-icon').addEventListener('click', openPicker);
  native.addEventListener('change', () => {
    if (native.value) {
      const d = new Date(native.value + 'T00:00:00');
      const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
      const month = d.toLocaleDateString('en-US', { month: 'short' });
      display.value = `${weekday}, ${d.getDate()} ${month}`;
    }
  });
});

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
    const { data } = await axios.get(`${API_BASE}/api/wishlist`, { headers: { Authorization: `Bearer ${access}` } });
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
function cardActionsHtml(type, item, label) {
  const id = item.id;
  const detailsJson = JSON.stringify(item).replace(/'/g, '&apos;');
  return `
    <div class="card-actions">
      <button type="button" class="wl-btn" data-wl-type="${type}" data-wl-id="${id}" aria-label="Save to wishlist">&#9825;</button>
      <button type="button" class="review-link" data-review-type="${type}" data-review-id="${id}" data-review-label="${label}">&#9733; Reviews</button>
      <button type="button" class="details-link" data-details-type="${type}" data-details-item='${detailsJson}'>View Details</button>
    </div>`;
}
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
      await axios.delete(`${API_BASE}/api/wishlist/${wishlistMap.get(key)}`, { headers: { Authorization: `Bearer ${access}` } });
      wishlistMap.delete(key);
      showToast('Removed from wishlist.');
    } else {
      const { data } = await axios.post(
        `${API_BASE}/api/wishlist`, { item_type: type, item_id: id }, { headers: { Authorization: `Bearer ${access}` } }
      );
      wishlistMap.set(key, data.id);
      showToast('Saved to wishlist!');
    }
    applyWishlistState(wlBtn.closest('.pkg-grid, .search-results-list'));
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

function starString(rating) { return '★'.repeat(rating) + '☆'.repeat(5 - rating); }

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
    const { data } = await axios.get(`${API_BASE}/api/reviews`, { params: { item_type: type, item_id: id } });
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
          await axios.delete(`${API_BASE}/api/reviews/${btn.dataset.deleteReview}`, { headers: { Authorization: `Bearer ${access}` } });
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
      await axios.put(`${API_BASE}/api/reviews/${myReviewId}`, { rating: currentReviewRating, comment }, { headers: { Authorization: `Bearer ${access}` } });
    } else {
      await axios.post(
        `${API_BASE}/api/reviews`,
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

/* Featured tour packages: replace hardcoded cards with live data from the API */
async function loadFeaturedPackages() {
  const grid = document.querySelector('.packages-section .pkg-grid');
  if (!grid) return;
  try {
    const { data: packages } = await axios.get(`${API_BASE}/api/packages`, { params: { limit: 4 } });
    if (!packages.length) return;
    grid.innerHTML = packages.map((pkg, i) => `
      <article class="pkg-card reveal${i ? ' delay-' + Math.min(i, 3) : ''}">
        <div class="pkg-img"><img src="${pkg.image_url || ''}" alt="${pkg.title} package" loading="lazy"><span class="pkg-duration">${pkg.duration_days} Days</span></div>
        <div class="pkg-body">
          <h3>${pkg.title}</h3>
          <div class="pkg-stars"><span class="stars">★★★★★</span> ${pkg.rating.toFixed(1)}</div>
          <div class="pkg-foot">
            <div class="pkg-price">Starting from<b>₹${Math.round(pkg.price).toLocaleString('en-IN')}</b></div>
            <a href="#" class="btn btn-coral pkg-book" data-book-type="package" data-book-id="${pkg.id}" data-book-price="${pkg.price}" data-book-label="${pkg.title}">Book Now</a>
          </div>
          ${cardActionsHtml('package', pkg, pkg.title)}
        </div>
      </article>
    `).join('');
    grid.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
    applyWishlistState(grid);
  } catch (err) {
    /* API unreachable — keep the existing hardcoded cards visible */
  }
}
loadFeaturedPackages();

/* Search results: wire each tab's Search button to the matching content API */
/* Parse a count out of select text like "3 Passengers" or "5+ Guests" */
function parseCount(text) {
  const match = (text || '').match(/\d+/);
  return match ? Number(match[0]) : 1;
}
/* Each date field pairs a readonly display input with a hidden real <input type="date"> */
function nativeDateValue(displayInputId) {
  const display = document.getElementById(displayInputId);
  const native = display?.closest('.field-date')?.querySelector('.date-native');
  return native?.value || undefined;
}

const searchEndpoints = {
  flights: () => ['flights', {
    from_airport: document.getElementById('fFrom').value,
    to_airport: document.getElementById('fTo').value,
    departure_date: nativeDateValue('fDep'),
    cabin_class: document.getElementById('fCabin').value,
    passengers: parseCount(document.getElementById('fPax').value),
  }],
  hotels: () => ['hotels', {
    location: document.getElementById('hDest').value,
    rooms: parseCount(document.getElementById('hRooms').value),
  }],
  cruises: () => ['cruises', {
    cruise_type: document.getElementById('crType').value,
    departure_month: document.getElementById('crMonth').value,
    duration_days: parseCount(document.getElementById('crDur').value),
  }],
  packages: () => ['packages', {
    package_type: document.getElementById('pType').value,
    month: document.getElementById('pMonth').value,
  }],
};

function renderSearchResults(tab, items) {
  const section = document.getElementById('searchResultsSection');
  const list = document.getElementById('searchResultsList');
  const empty = document.getElementById('searchResultsEmpty');
  section.classList.add('open');
  if (!items.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  empty.style.display = 'none';
  const cardFor = {
    flights: f => `
      <div class="result-card">
        <div class="result-main">
          <div class="result-title">${f.airline} — ${f.from_airport} → ${f.to_airport}</div>
          <div class="result-sub">${new Date(f.departure_time).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · ${f.cabin_class}</div>
        </div>
        <div class="result-price">₹${Math.round(f.price).toLocaleString('en-IN')}</div>
        <a href="#" class="btn btn-coral result-book" data-book-type="flight" data-book-id="${f.id}" data-book-price="${f.price}" data-book-label="${f.airline} ${f.from_airport}→${f.to_airport}">Book Now</a>
        ${cardActionsHtml('flight', f, `${f.airline} ${f.from_airport}→${f.to_airport}`)}
      </div>`,
    hotels: h => `
      <div class="result-card">
        <div class="result-main">
          <div class="result-title">${h.name}</div>
          <div class="result-sub">${h.location} · ★ ${h.rating.toFixed(1)}</div>
        </div>
        <div class="result-price">₹${Math.round(h.price_per_night).toLocaleString('en-IN')}<span>/night</span></div>
        <a href="#" class="btn btn-coral result-book" data-book-type="hotel" data-book-id="${h.id}" data-book-price="${h.price_per_night}" data-book-label="${h.name}">Book Now</a>
        ${cardActionsHtml('hotel', h, h.name)}
      </div>`,
    cruises: c => `
      <div class="result-card">
        <div class="result-main">
          <div class="result-title">${c.name}</div>
          <div class="result-sub">${c.departure_port} · ${c.duration_days} Days · ${c.departure_month}</div>
        </div>
        <div class="result-price">₹${Math.round(c.price).toLocaleString('en-IN')}</div>
        <a href="#" class="btn btn-coral result-book" data-book-type="cruise" data-book-id="${c.id}" data-book-price="${c.price}" data-book-label="${c.name}">Book Now</a>
        ${cardActionsHtml('cruise', c, c.name)}
      </div>`,
    packages: p => `
      <div class="result-card">
        <div class="result-main">
          <div class="result-title">${p.title}</div>
          <div class="result-sub">${p.duration_days} Days · ★ ${p.rating.toFixed(1)}</div>
        </div>
        <div class="result-price">₹${Math.round(p.price).toLocaleString('en-IN')}</div>
        <a href="#" class="btn btn-coral result-book" data-book-type="package" data-book-id="${p.id}" data-book-price="${p.price}" data-book-label="${p.title}">Book Now</a>
        ${cardActionsHtml('package', p, p.title)}
      </div>`,
  };
  list.innerHTML = items.map(cardFor[tab]).join('');
  applyWishlistState(list);
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.querySelectorAll('.search-go').forEach(btn => {
  btn.addEventListener('click', async e => {
    e.preventDefault();
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    const buildQuery = searchEndpoints[activeTab];
    if (!buildQuery) return;
    const [endpoint, params] = buildQuery();
    try {
      const { data } = await axios.get(`${API_BASE}/api/${endpoint}`, { params });
      renderSearchResults(activeTab, data);
    } catch (err) {
      showToast('Search failed — please try again.', true);
    }
  });
});
document.getElementById('searchResultsClose')?.addEventListener('click', () => {
  document.getElementById('searchResultsSection').classList.remove('open');
});

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

  if (/\bhotels?\b/.test(lower)) {
    activateTab('hotels');
    const m = cleaned.match(/\bhotels?\s+(?:in|at|near)\s+([a-z\s]+)/i) || cleaned.match(/\bin\s+([a-z\s]+)$/i);
    if (m) { document.getElementById('hDest').value = titleCaseWords(m[1].trim()); confidentMatch = true; }
    if (dateStr) setNativeDate('hIn', dateStr);
  } else if (/\bcruises?\b/.test(lower)) {
    activateTab('cruises');
    /* No free-text origin field exists on the cruise panel — switch tabs only rather than guessing a field to fill. */
  } else if (/\b(packages?|tours?)\b/.test(lower)) {
    activateTab('packages');
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
    document.querySelector('.search-panel.active .search-go')?.click();
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

/* Auth: JWT session helpers now live in assets/js/auth.js (getStoredAuth,
   setStoredAuth, clearStoredAuth, authHeaders) -- loaded before this file. */

/* Presence heartbeat — only sent while a logged-in user is browsing this page,
   so the admin's Online Users widget can see them. */
function sendHeartbeat() {
  const { access } = getStoredAuth();
  if (!access) return;
  axios.post(`${API_BASE}/api/users/heartbeat`, { current_page: 'Home' }, {
    headers: { Authorization: `Bearer ${access}` },
  }).catch(() => {});
}
sendHeartbeat();
setInterval(sendHeartbeat, 30000);

const authNavPairs = [
  [document.getElementById('navLoginLink'), document.getElementById('navSignupLink')],
];

function renderAuthNav() {
  const { access, name, role } = getStoredAuth();
  const loggedIn = Boolean(access) && role !== 'admin';
  const isAdmin = Boolean(access) && role === 'admin';

  // Admins keep the old simple treatment (link straight to admin.html) — the
  // Account Center below is a customer-only experience.
  authNavPairs.forEach(([loginEl, signupEl]) => {
    if (loginEl) loginEl.textContent = isAdmin ? 'Dashboard' : 'Login';
    if (signupEl) signupEl.textContent = isAdmin ? 'Logout' : 'Sign Up';
    if (loginEl) loginEl.style.display = loggedIn ? 'none' : '';
    if (signupEl) signupEl.style.display = loggedIn ? 'none' : '';
  });

  document.getElementById('profileChipWrap').style.display = loggedIn ? '' : 'none';
  document.getElementById('mobileNav').classList.toggle('show-account', loggedIn);

  if (loggedIn) {
    const initials = name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'U';
    document.getElementById('profileChipName').textContent = name;
    document.getElementById('profileChipAvatar').textContent = initials;
  }

  const mobileLoginLink = document.getElementById('mobileNavLoginLink');
  const mobileSignupLink = document.getElementById('mobileNavSignupLink');
  if (isAdmin) { mobileLoginLink.textContent = 'Dashboard'; mobileSignupLink.textContent = 'Logout'; }
  else { mobileLoginLink.textContent = 'Login'; mobileSignupLink.textContent = 'Sign Up'; }
}
renderAuthNav();

/* Validate any stored token on load; drop it silently if it's no longer valid */
(function verifyStoredSession() {
  const { access } = getStoredAuth();
  if (!access) return;
  axios.get(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${access}` } })
    .catch(() => { clearStoredAuth(); renderAuthNav(); });
})();

/* Auth modal: Sign Up / Login */
const authOverlay = document.getElementById('authOverlay');
const signupView = document.getElementById('signupView');
const loginView = document.getElementById('loginView');
const authCloseBtn = document.getElementById('authCloseBtn');

function openAuth(view) {
  authOverlay.classList.add('open');
  signupView.style.display = view === 'login' ? 'none' : 'block';
  loginView.style.display = view === 'login' ? 'block' : 'none';
  document.body.style.overflow = 'hidden';
  /* Always reopen on the credentials step — a half-finished OTP attempt from
     a previous open would otherwise still be showing. */
  if (view === 'login') {
    loginChallengeToken = null;
    showLoginStep('creds');
    setModalMsg(document.getElementById('loginMsg'), '', 'muted');
    setModalMsg(document.getElementById('loginOtpMsg'), '', 'muted');
  }
  const firstInput = (view === 'login' ? loginView : signupView).querySelector('input');
  if (firstInput) firstInput.focus();
}
function closeAuth() {
  authOverlay.classList.remove('open');
  document.body.style.overflow = '';
}
document.querySelectorAll('[data-auth]').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    /* A merchant who already has a live session shouldn't be asked to sign in
       again — send them straight through. Merchant tokens live in their own
       namespace (PARTNER_KEYS), which getStoredAuth() below doesn't see. */
    if (el.dataset.auth === 'login' && isPartnerLoggedIn()) {
      window.location.href = MERCHANT_PORTAL_URL;
      return;
    }
    const { access, role } = getStoredAuth();
    if (access) {
      if (el.dataset.auth === 'signup') {
        axios.post(`${API_BASE}/api/auth/logout`, {}, { headers: { Authorization: `Bearer ${access}` } }).catch(() => {});
        clearStoredAuth();
        wishlistMap = new Map();
        renderAuthNav();
      }
      else if (el.dataset.auth === 'login' && role === 'admin') { window.location.href = 'admin/'; }
      return;
    }
    openAuth(el.dataset.auth);
  });
});
authCloseBtn.addEventListener('click', closeAuth);
authOverlay.addEventListener('click', e => { if (e.target === authOverlay) closeAuth(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && authOverlay.classList.contains('open')) closeAuth();
});

/** Where merchant onboarding requests go — the address the site already
    publishes in its Contact section. */
const MERCHANT_ONBOARDING_EMAIL = 'info@jackpotsworldtours.com';

/* ---------------------------------------------------------------------------
   Merchant access request.

   Merchants don't self-register: an Admin creates the company
   (POST /api/admin/merchants) and it stays pending_approval until approved, so
   there is no /api/auth/signup in the v2 API to post to. This collects the
   details the team needs and routes them through the existing contact channel
   rather than pretending an account was created.
   --------------------------------------------------------------------------- */
document.getElementById('suRequestBtn')?.addEventListener('click', async () => {
  const company = document.getElementById('suCompany').value.trim();
  const name = document.getElementById('suName').value.trim();
  const email = document.getElementById('suEmail').value.trim();
  const phone = document.getElementById('suPhone').value.trim();
  const msg = document.getElementById('signupMsg');
  const fail = text => {
    msg.textContent = text;
    msg.style.color = 'var(--coral-dark)';
    msg.classList.add('show');
  };

  if (!company) return fail('Please tell us your company name.');
  if (!name) return fail('Please tell us your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid work email.');

  /* Opens the visitor's mail client rather than posting anywhere: the legacy
     /api/contact route isn't mounted under the v2 schema, and a form that
     silently swallowed the request would be worse than one that plainly
     hands it over. Swap this for a real endpoint when one exists. */
  const body = [
    `Company: ${company}`,
    `Contact: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone || '—'}`,
    '',
    'We would like a merchant account on JackPots World Tours & Travels.',
  ].join('\n');
  window.location.href = `mailto:${MERCHANT_ONBOARDING_EMAIL}`
    + `?subject=${encodeURIComponent(`Merchant access request — ${company}`)}`
    + `&body=${encodeURIComponent(body)}`;

  msg.textContent = `Opening your email app — or write to ${MERCHANT_ONBOARDING_EMAIL}.`;
  msg.style.color = 'var(--emerald)';
  msg.classList.add('show');
});

/* ---------------------------------------------------------------------------
   Merchant sign-in — the site's "Login" is the merchant login.

   Runs the same two-step flow as the Merchant Portal's own shell
   (Login -> Password -> OTP -> Portal, API_CONTRACT.md §1) using the shared
   helpers in auth.js, then hands off to /merchant/. Tokens are written under
   the merchant namespace by storePortalTokens, so arriving at the portal the
   session is already live and no second sign-in is needed.
   --------------------------------------------------------------------------- */
const MERCHANT_PORTAL_URL = 'merchant/';
let loginChallengeToken = null;

function showLoginStep(step) {
  document.getElementById('loginStepCreds').style.display = step === 'creds' ? '' : 'none';
  document.getElementById('loginStepOtp').style.display = step === 'otp' ? '' : 'none';
}

function setModalMsg(el, text, tone) {
  el.textContent = text;
  el.style.color = tone === 'error' ? 'var(--coral-dark)'
    : tone === 'ok' ? 'var(--emerald)' : 'var(--text-muted)';
  el.classList.toggle('show', !!text);
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('liUser').value.trim();
  const pass = document.getElementById('liPass').value;
  const msg = document.getElementById('loginMsg');
  if (!email || !pass) {
    setModalMsg(msg, 'Enter your email and password.', 'error');
    return;
  }
  setModalMsg(msg, 'Checking…', 'muted');
  try {
    const data = await startPortalLogin('merchant', email, pass);
    loginChallengeToken = data.challenge_token;
    setModalMsg(msg, '', 'muted');
    setModalMsg(document.getElementById('loginOtpMsg'), '', 'muted');
    document.getElementById('liOtp').value = '';
    /* With SMTP unconfigured the API returns the code inline so local demos
       work without a mailbox; show it rather than leaving the user stuck. */
    document.getElementById('loginOtpSub').textContent = data.dev_otp
      ? `Dev mode — your code is ${data.dev_otp}`
      : `Enter the 6-digit code sent to ${email}.`;
    showLoginStep('otp');
    document.getElementById('liOtp').focus();
  } catch (err) {
    setModalMsg(msg, apiErrorText(err, 'Invalid email or password.'), 'error');
  }
});

document.getElementById('liVerifyBtn')?.addEventListener('click', async () => {
  const code = document.getElementById('liOtp').value.trim();
  const msg = document.getElementById('loginOtpMsg');
  if (!/^\d{6}$/.test(code)) {
    setModalMsg(msg, 'Enter the 6-digit code.', 'error');
    return;
  }
  setModalMsg(msg, 'Verifying…', 'muted');
  try {
    const data = await verifyPortalOtp(loginChallengeToken, code);
    storePortalTokens('merchant', data);
    setModalMsg(msg, 'Signed in — taking you to your portal…', 'ok');
    window.location.href = MERCHANT_PORTAL_URL;
  } catch (err) {
    setModalMsg(msg, apiErrorText(err, 'That code was not accepted.'), 'error');
  }
});

document.getElementById('liResendBtn')?.addEventListener('click', async e => {
  e.preventDefault();
  const msg = document.getElementById('loginOtpMsg');
  setModalMsg(msg, 'Sending a new code…', 'muted');
  try {
    const data = await resendPortalOtp(loginChallengeToken);
    /* resend issues a fresh challenge; keep using the newest one. */
    if (data.challenge_token) loginChallengeToken = data.challenge_token;
    setModalMsg(msg, data.dev_otp ? `Dev mode — your new code is ${data.dev_otp}` : 'A new code is on its way.', 'ok');
  } catch (err) {
    setModalMsg(msg, apiErrorText(err, 'Could not resend the code just now.'), 'error');
  }
});

document.getElementById('liBackBtn')?.addEventListener('click', e => {
  e.preventDefault();
  loginChallengeToken = null;
  document.getElementById('liPass').value = '';
  setModalMsg(document.getElementById('loginMsg'), '', 'muted');
  showLoginStep('creds');
  document.getElementById('liUser').focus();
});

document.getElementById('forgotPasswordLink').addEventListener('click', async e => {
  e.preventDefault();
  const msg = document.getElementById('loginMsg');
  const email = document.getElementById('liUser').value;
  if (!email) {
    msg.textContent = 'Enter your email above first, then click Forgot Password.';
    msg.style.color = 'var(--coral-dark)';
    msg.classList.add('show');
    return;
  }
  try {
    const { data } = await axios.post(`${API_BASE}/api/auth/forgot-password`, { email });
    msg.textContent = data.reset_link
      ? `Reset link generated (email delivery not yet configured): ${data.reset_link}`
      : data.message;
    msg.style.color = 'var(--emerald)';
    msg.classList.add('show');
  } catch (err) {
    msg.textContent = 'Something went wrong — please try again.';
    msg.style.color = 'var(--coral-dark)';
    msg.classList.add('show');
  }
});

/* ================================================================
   ACCOUNT CENTER — replaces the old separate dashboard.html.
   Every section below is a direct port of that page's logic, now
   living inside one modal on the homepage instead of its own page.
   ================================================================ */
/* authHeaders() (equivalent to getStoredAuth().access-based version that
   used to live here) now lives in assets/js/auth.js; money/fmtDate/fmtTime
   now live in shared/formatters.js. */

/* ---------- Modal open/close + tab switching ---------- */
const acctModalOverlay = document.getElementById('accountModalOverlay');
const acctLoadedTabs = new Set();
let acctCurrentUser = null;

function openAccountCenter(tab) {
  const { access } = getStoredAuth();
  if (!access) { openAuth('login'); return; }
  acctModalOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  goToAcctTab(tab || 'profile');
  if (!acctCurrentUser) loadAcctHeaderProfile();
}
function closeAccountCenter() {
  acctModalOverlay.classList.remove('open');
  document.body.style.overflow = '';
}
document.getElementById('acctModalCloseBtn').addEventListener('click', closeAccountCenter);
acctModalOverlay.addEventListener('click', e => { if (e.target === acctModalOverlay) closeAccountCenter(); });

function goToAcctTab(name) {
  document.querySelectorAll('.acct-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.acct-panel').forEach(p => p.classList.toggle('active', p.id === `acctPanel-${name}`));
  if (!acctLoadedTabs.has(name)) {
    acctLoadedTabs.add(name);
    loadAcctTab(name);
  }
}
document.querySelectorAll('.acct-tab').forEach(tab => {
  tab.addEventListener('click', () => goToAcctTab(tab.dataset.tab));
});
function loadAcctTab(name) {
  if (name === 'profile') return loadAcctProfile();
  if (name === 'bookings') return loadAcctBookings();
  if (name === 'wishlist') return loadAcctWishlist();
  if (name === 'payments') return loadAcctPayments();
  if (name === 'notifications') return loadAcctNotifications();
  if (name === 'support') return loadAcctSupportTickets();
  if (name === 'reviews') return loadAcctReviews();
}

/* Every dropdown item (desktop + mobile) and profile-chip toggle */
document.querySelectorAll('[data-acct-tab]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('profileDropdown').classList.remove('open');
    document.getElementById('profileChipBtn').classList.remove('open');
    mobileNav.classList.remove('open');
    openAccountCenter(link.dataset.acctTab);
  });
});
const profileChipBtn = document.getElementById('profileChipBtn');
const profileDropdown = document.getElementById('profileDropdown');
profileChipBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = profileDropdown.classList.toggle('open');
  profileChipBtn.classList.toggle('open', open);
});
document.addEventListener('click', () => {
  profileDropdown.classList.remove('open');
  profileChipBtn.classList.remove('open');
});

function doAccountLogout() {
  const { access } = getStoredAuth();
  axios.post(`${API_BASE}/api/auth/logout`, {}, { headers: { Authorization: `Bearer ${access}` } }).catch(() => {});
  clearStoredAuth();
  acctCurrentUser = null;
  acctLoadedTabs.clear();
  wishlistMap = new Map();
  closeAccountCenter();
  renderAuthNav();
}
document.getElementById('profileLogoutBtn').addEventListener('click', doAccountLogout);
document.getElementById('mobileLogoutLink').addEventListener('click', e => { e.preventDefault(); doAccountLogout(); });

/* ---------- Profile (header + editable form) ---------- */
async function loadAcctHeaderProfile() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
    acctCurrentUser = data;
    const initials = data.full_name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'U';
    document.getElementById('acctHeaderAvatar').textContent = initials;
    document.getElementById('acctHeaderName').textContent = data.full_name;
    document.getElementById('acctHeaderEmail').textContent = data.email;
  } catch (err) { /* header just won't populate this cycle */ }
}
async function loadAcctProfile() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
    acctCurrentUser = data;
    document.getElementById('acctProfileName').value = data.full_name;
    document.getElementById('acctProfileEmail').value = data.email;
    document.getElementById('acctProfileMobile').value = data.mobile || '';
    document.getElementById('acctProfileGender').value = data.gender || '';
    document.getElementById('acctProfileDob').value = data.dob || '';
    document.getElementById('acctProfileCountry').value = data.country || '';
    document.getElementById('acctProfileState').value = data.state || '';
    document.getElementById('acctProfileCity').value = data.city || '';
    document.getElementById('acctProfileAddress').value = data.address || '';
  } catch (err) { /* fields stay blank */ }
}
document.getElementById('acctProfileForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('acctProfileMsg');
  try {
    const { data } = await axios.put(`${API_BASE}/api/users/me`, {
      full_name: document.getElementById('acctProfileName').value,
      mobile: document.getElementById('acctProfileMobile').value || null,
      gender: document.getElementById('acctProfileGender').value || null,
      dob: document.getElementById('acctProfileDob').value || null,
      country: document.getElementById('acctProfileCountry').value || null,
      state: document.getElementById('acctProfileState').value || null,
      city: document.getElementById('acctProfileCity').value || null,
      address: document.getElementById('acctProfileAddress').value || null,
    }, { headers: authHeaders() });
    setStoredAuth(getStoredAuth().access, getStoredAuth().refresh, data.full_name, 'user', data.id);
    renderAuthNav();
    loadAcctHeaderProfile();
    msg.textContent = 'Profile updated.';
    msg.className = 'acct-msg success';
  } catch (err) {
    msg.textContent = apiErrorText(err, 'Failed to update profile.');
    msg.className = 'acct-msg error';
  }
});
document.getElementById('acctPasswordForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('acctPasswordMsg');
  try {
    await axios.post(`${API_BASE}/api/users/change-password`, {
      current_password: document.getElementById('acctCurrentPassword').value,
      new_password: document.getElementById('acctNewPassword').value,
    }, { headers: authHeaders() });
    msg.textContent = 'Password changed successfully.';
    msg.className = 'acct-msg success';
    e.target.reset();
  } catch (err) {
    msg.textContent = apiErrorText(err, 'Failed to change password.');
    msg.className = 'acct-msg error';
  }
});

/* ---------- Bookings (list, cancel, confirmation/timeline) ---------- */
const TYPE_ICONS = {
  flight: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-1 .1-1.3.5l-.7.7 4.2 3-1.5 1.5-2.5-.5-.7.7 2 2 2 2 .7-.7-.5-2.5 1.5-1.5 3 4.2.7-.7c.4-.3.6-.8.5-1.3Z"/>',
  hotel: '<path d="M3 21V7a2 2 0 0 1 2-2h6v16"/><path d="M11 9h8a2 2 0 0 1 2 2v10"/><path d="M3 21h18"/>',
  cruise: '<path d="M2 21c1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0 1.6 1.2 3.4 1.2 5 0"/><path d="M4 18l1-9h14l1 9"/><path d="M10 9V4h4v5"/>',
  package: '<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
};
let allBookingsCache = [];
let paymentsByBooking = new Map();
async function loadPaymentsMap() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/payments/history`, { headers: authHeaders() });
    paymentsByBooking = new Map(data.map(p => [p.booking_id, p]));
  } catch (err) { /* receipt just won't show payment rows */ }
}
function renderTimeline(booking) {
  if (booking.status === 'cancelled') {
    return `<div class="timeline">
      <div class="tl-step done"><span class="tl-dot"></span><span class="tl-label">Booked</span></div>
      <div class="tl-line done"></div>
      <div class="tl-step cancelled-step"><span class="tl-dot"></span><span class="tl-label">Cancelled</span></div>
    </div>`;
  }
  const isPastTravel = booking.travel_date && new Date(booking.travel_date) < new Date();
  const confirmedDone = booking.status === 'confirmed' || booking.status === 'completed';
  const completedDone = booking.status === 'completed' || (confirmedDone && isPastTravel);
  const steps = [{ label: 'Booked', done: true }, { label: 'Confirmed', done: confirmedDone }, { label: 'Completed', done: completedDone }];
  return `<div class="timeline">${steps.map((s, i) => `
    ${i > 0 ? `<div class="tl-line ${steps[i - 1].done ? 'done' : ''}"></div>` : ''}
    <div class="tl-step ${s.done ? 'done' : ''}"><span class="tl-dot"></span><span class="tl-label">${s.label}</span></div>
  `).join('')}</div>`;
}
const CATALOG_ENDPOINTS = { flight: 'flights', hotel: 'hotels', cruise: 'cruises', package: 'packages' };
const catalogItemCache = new Map();
async function fetchCatalogItem(type, id) {
  const cacheKey = `${type}-${id}`;
  if (catalogItemCache.has(cacheKey)) return catalogItemCache.get(cacheKey);
  const endpoint = CATALOG_ENDPOINTS[type];
  if (!endpoint) return null;
  try {
    const { data } = await axios.get(`${API_BASE}/api/${endpoint}/${id}`);
    catalogItemCache.set(cacheKey, data);
    return data;
  } catch (err) {
    return null;
  }
}
function bookingReference(bookingId) { return 'JWT-' + String(bookingId).padStart(6, '0'); }

function closeAcctTicket() { document.getElementById('acctConfirmOverlay').classList.remove('open'); }
document.getElementById('acctConfirmCloseBtn').addEventListener('click', closeAcctTicket);

async function showAcctConfirmation(bookingId) {
  const booking = allBookingsCache.find(b => String(b.id) === String(bookingId));
  if (!booking) return;
  const payment = paymentsByBooking.get(booking.id);
  const item = await fetchCatalogItem(booking.booking_type, booking.item_id);
  const reference = bookingReference(booking.id);
  const isFlight = booking.booking_type === 'flight';

  let itemTitle = `${booking.booking_type} — #${booking.item_id}`;
  let itemSub = '';
  let dateValue = fmtDate(booking.travel_date);
  let sourceDestRow = '';
  let timeRow = '';
  let seatRow = '';

  if (item) {
    if (isFlight) {
      itemTitle = `${item.airline} · ${item.cabin_class}`;
      dateValue = fmtDate(booking.travel_date || item.departure_time);
      sourceDestRow = `
        <div class="confirm-row"><span>From</span><span>${escapeHtml(item.from_airport)}</span></div>
        <div class="confirm-row"><span>To</span><span>${escapeHtml(item.to_airport)}</span></div>`;
      timeRow = `<div class="confirm-row"><span>Time</span><span>${fmtTime(item.departure_time)} – ${fmtTime(item.arrival_time)}</span></div>`;
      seatRow = `<div class="confirm-row"><span>Seat Number</span><span>Assigned at check-in</span></div>`;
    } else if (booking.booking_type === 'hotel') {
      itemTitle = item.name;
      itemSub = item.location;
    } else if (booking.booking_type === 'cruise') {
      itemTitle = item.name;
      itemSub = `Departs ${item.departure_port}`;
    } else if (booking.booking_type === 'package') {
      itemTitle = item.title;
      itemSub = item.package_type;
    }
  }

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(reference)}`;

  document.getElementById('acctConfirmBody').innerHTML = `
    <div class="ticket-head">
      <img src="assets/images/jackpots-logo-full.png" alt="JackPots World Tours & Travels">
      <div>
        <div class="th-name">${escapeHtml(itemTitle)}</div>
        ${itemSub ? `<div class="modal-sub" style="margin:2px 0 0;">${escapeHtml(itemSub)}</div>` : ''}
      </div>
    </div>
    ${renderTimeline(booking)}
    <div class="confirm-row"><span>Booking ID</span><span>#${booking.id}</span></div>
    <div class="confirm-row"><span>PNR / Booking Reference</span><span>${reference}</span></div>
    <div class="confirm-row"><span>Passenger Name</span><span>${escapeHtml(acctCurrentUser?.full_name || '—')}</span></div>
    <div class="confirm-row"><span>Type</span><span style="text-transform:capitalize">${booking.booking_type}</span></div>
    ${sourceDestRow}
    <div class="confirm-row"><span>Date</span><span>${dateValue}</span></div>
    ${timeRow}
    ${seatRow}
    <div class="confirm-row"><span>Quantity</span><span>${booking.quantity}</span></div>
    <div class="confirm-row"><span>Booking Status</span><span style="text-transform:capitalize">${booking.status}</span></div>
    ${payment ? `<div class="confirm-row"><span>Payment Status</span><span style="text-transform:capitalize">${payment.status}</span></div>` : ''}
    <div class="confirm-row"><span>Total Amount</span><span>${money(booking.total_price)}</span></div>
    <div class="confirm-row"><span>Booked On</span><span>${fmtDate(booking.created_at)}</span></div>
    ${payment ? `
      <div class="confirm-row"><span>Payment Method</span><span style="text-transform:capitalize">${payment.method}</span></div>
      <div class="confirm-row"><span>Transaction Ref</span><span>${payment.transaction_ref}</span></div>
    ` : ''}
    <div class="ticket-qr">
      <img src="${qrUrl}" alt="Booking QR code" width="140" height="140">
      <div class="tq-ref">${reference}</div>
    </div>
    <div class="ticket-support">Need help with this booking? Call +91 12345 67890 or email info@jackpotsworldtours.com</div>
    <div class="ticket-actions">
      <button type="button" class="btn btn-coral btn-sm" id="ticketDownloadBtn">Download PDF</button>
      <button type="button" class="btn btn-navy btn-sm" id="ticketPrintBtn">Print Ticket</button>
      <button type="button" class="btn btn-navy btn-sm" id="ticketShareBtn">Share Ticket</button>
      <button type="button" class="btn btn-ghost btn-sm" id="ticketCloseBtn">Close</button>
    </div>
  `;
  document.getElementById('acctConfirmOverlay').classList.add('open');

  document.getElementById('ticketDownloadBtn').addEventListener('click', () => window.print());
  document.getElementById('ticketPrintBtn').addEventListener('click', () => window.print());
  document.getElementById('ticketCloseBtn').addEventListener('click', closeAcctTicket);
  document.getElementById('ticketShareBtn').addEventListener('click', async () => {
    const shareText = `My ${booking.booking_type} booking with JackPots World Tours & Travels — Ref ${reference}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'JackPots World Tours & Travels — Booking Ticket', text: shareText }); }
      catch (err) { /* user cancelled the native share sheet */ }
      return;
    }
    const withTimeout = (promise, ms) => Promise.race([
      promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
    try {
      await withTimeout(navigator.clipboard.writeText(shareText), 2000);
      alert('Ticket details copied to clipboard.');
    } catch (err) {
      prompt('Copy your ticket details:', shareText);
    }
  });
}

function bookingRowHtml(b) {
  return `
    <div class="acct-row">
      <div class="ar-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;">${TYPE_ICONS[b.booking_type] || TYPE_ICONS.package}</svg></div>
      <div class="ar-main">
        <div class="ar-title">${escapeHtml(b.booking_type)} — #${b.item_id}</div>
        <div class="ar-sub">Booked ${fmtDate(b.created_at)} ${b.travel_date ? '· Travel ' + fmtDate(b.travel_date) : ''} ${b.quantity > 1 ? '· Qty ' + b.quantity : ''}</div>
      </div>
      <span class="badge ${b.status}">${escapeHtml(b.status)}</span>
      <div class="ar-amount">${money(b.total_price)}</div>
      <button type="button" class="btn btn-coral btn-sm" data-confirm-id="${b.id}">View Ticket</button>
      ${b.status !== 'cancelled' ? `<button type="button" class="btn btn-danger btn-sm" data-cancel-id="${b.id}">Cancel</button>` : ''}
    </div>`;
}
async function cancelBookingById(bookingId, onSuccess) {
  if (!confirm('Cancel this booking?')) return;
  try {
    await axios.delete(`${API_BASE}/api/bookings/${bookingId}`, { headers: authHeaders() });
    await loadPaymentsMap();
    if (typeof onSuccess === 'function') await onSuccess();
  } catch (err) { alert(apiErrorText(err, 'Failed to cancel booking.')); }
}
function wireBookingRowActions(container) {
  container.querySelectorAll('[data-confirm-id]').forEach(btn => btn.addEventListener('click', () => showAcctConfirmation(btn.dataset.confirmId)));
  container.querySelectorAll('[data-cancel-id]').forEach(btn => {
    btn.addEventListener('click', () => cancelBookingById(btn.dataset.cancelId, async () => {
      await loadAcctBookings();
      loadUpcomingJourney();
    }));
  });
}
async function loadAcctBookings() {
  const container = document.getElementById('acctBookingsList');
  try {
    const [{ data }] = await Promise.all([axios.get(`${API_BASE}/api/bookings`, { headers: authHeaders() }), loadPaymentsMap()]);
    allBookingsCache = data;
    if (!data.length) {
      container.innerHTML = '<div class="acct-empty">No bookings yet — go find your next trip!</div>';
      return;
    }
    container.innerHTML = data.map(b => bookingRowHtml(b)).join('');
    wireBookingRowActions(container);
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load bookings.</div>';
  }
}

/* ---------- Homepage: Your Upcoming Journey ---------- */
let upcomingCountdownTimer = null;

function upcomingCardHtml(entry) {
  const { booking, item, when } = entry;
  const ref = bookingReference(booking.id);
  let title = `${booking.booking_type} — #${booking.item_id}`;
  let fromTo = '';
  let timeSpan = '';
  let seatSpan = '';
  if (item) {
    if (booking.booking_type === 'flight') {
      title = item.airline;
      fromTo = `<span>${escapeHtml(item.from_airport)} &rarr; ${escapeHtml(item.to_airport)}</span>`;
      timeSpan = `<span>Time: <b>${fmtTime(item.departure_time)}</b></span>`;
      seatSpan = `<span>Seat: <b>Assigned at check-in</b></span>`;
    } else if (booking.booking_type === 'hotel') title = item.name;
    else if (booking.booking_type === 'cruise') title = item.name;
    else if (booking.booking_type === 'package') title = item.title;
  }
  return `
    <div class="upcoming-card" data-upcoming-id="${booking.id}" data-upcoming-when="${when.toISOString()}">
      <div class="upcoming-main">
        <div class="upcoming-title">${escapeHtml(title)}</div>
        <div class="upcoming-sub">Booking #${booking.id} · PNR ${ref} · <span class="badge ${booking.status}">${escapeHtml(booking.status)}</span></div>
        <div class="upcoming-meta">
          ${fromTo}
          <span>Date: <b>${fmtDate(booking.travel_date)}</b></span>
          ${timeSpan}
          <span>Passengers: <b>${booking.quantity}</b></span>
          ${seatSpan}
        </div>
      </div>
      <div class="upcoming-countdown" data-countdown></div>
      <div class="upcoming-actions">
        <button type="button" class="btn btn-coral btn-sm" data-upcoming-view="${booking.id}">View Ticket</button>
        <button type="button" class="btn btn-navy btn-sm" data-upcoming-download="${booking.id}">Download Ticket</button>
        <button type="button" class="btn btn-ghost btn-sm" data-upcoming-account>View Booking</button>
        <button type="button" class="btn btn-danger btn-sm" data-upcoming-cancel="${booking.id}">Cancel Booking</button>
      </div>
    </div>`;
}

function tickUpcomingCountdowns() {
  const now = Date.now();
  const cards = document.querySelectorAll('#upcomingJourneyList .upcoming-card');
  cards.forEach(card => {
    const when = new Date(card.dataset.upcomingWhen).getTime();
    const diff = when - now;
    if (diff <= 0) {
      card.remove();
      return;
    }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const box = card.querySelector('[data-countdown]');
    box.innerHTML = `
      <div class="cd-box"><div class="cd-num">${days}</div><div class="cd-label">Days</div></div>
      <div class="cd-box"><div class="cd-num">${String(hours).padStart(2, '0')}</div><div class="cd-label">Hours</div></div>
      <div class="cd-box"><div class="cd-num">${String(minutes).padStart(2, '0')}</div><div class="cd-label">Minutes</div></div>`;
  });
  if (!document.querySelectorAll('#upcomingJourneyList .upcoming-card').length) {
    document.getElementById('upcomingJourneySection').classList.remove('open');
    clearInterval(upcomingCountdownTimer);
  }
}

function wireUpcomingJourneyActions() {
  document.querySelectorAll('[data-upcoming-view]').forEach(btn => {
    btn.addEventListener('click', () => showAcctConfirmation(btn.dataset.upcomingView));
  });
  document.querySelectorAll('[data-upcoming-download]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await showAcctConfirmation(btn.dataset.upcomingDownload);
      window.print();
    });
  });
  document.querySelectorAll('[data-upcoming-account]').forEach(btn => {
    btn.addEventListener('click', () => openAccountCenter('bookings'));
  });
  document.querySelectorAll('[data-upcoming-cancel]').forEach(btn => {
    btn.addEventListener('click', () => cancelBookingById(btn.dataset.upcomingCancel, loadUpcomingJourney));
  });
}

async function loadUpcomingJourney() {
  const section = document.getElementById('upcomingJourneySection');
  const list = document.getElementById('upcomingJourneyList');
  const { access } = getStoredAuth();
  if (!access) { section.classList.remove('open'); clearInterval(upcomingCountdownTimer); return; }
  try {
    const [{ data }] = await Promise.all([axios.get(`${API_BASE}/api/bookings`, { headers: authHeaders() }), loadPaymentsMap()]);
    allBookingsCache = data;
    const now = new Date();
    const candidates = data.filter(b => b.status !== 'cancelled' && b.status !== 'completed' && b.travel_date);
    const resolved = await Promise.all(candidates.map(async b => {
      const item = await fetchCatalogItem(b.booking_type, b.item_id);
      let when = new Date(`${b.travel_date}T00:00:00`);
      if (b.booking_type === 'flight' && item?.departure_time) {
        const clock = new Date(item.departure_time);
        when.setHours(clock.getHours(), clock.getMinutes(), clock.getSeconds(), 0);
      }
      return { booking: b, item, when };
    }));
    const upcoming = resolved.filter(r => r.when.getTime() > now.getTime()).sort((a, b) => a.when - b.when);
    clearInterval(upcomingCountdownTimer);
    if (!upcoming.length) {
      list.innerHTML = '';
      section.classList.remove('open');
      return;
    }
    list.innerHTML = upcoming.map(upcomingCardHtml).join('');
    wireUpcomingJourneyActions();
    tickUpcomingCountdowns();
    upcomingCountdownTimer = setInterval(tickUpcomingCountdowns, 1000);
    section.classList.add('open');
  } catch (err) {
    section.classList.remove('open');
  }
}

/* ---------- Payment History ---------- */
async function loadAcctPayments() {
  const tbody = document.querySelector('#acctPaymentsTable tbody');
  try {
    const { data } = await axios.get(`${API_BASE}/api/payments/history`, { headers: authHeaders() });
    tbody.innerHTML = data.map(p => `
      <tr><td>${fmtDate(p.created_at)}</td><td>${money(p.amount)}</td><td style="text-transform:capitalize">${escapeHtml(p.method)}</td><td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td><td>${escapeHtml(p.transaction_ref)}</td></tr>
    `).join('') || `<tr><td colspan="5" class="acct-empty">No payments yet.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="acct-empty">Failed to load payment history.</td></tr>`;
  }
}

/* ---------- Wishlist ---------- */
const ACCT_WISHLIST_ENDPOINTS = { flight: 'flights', hotel: 'hotels', cruise: 'cruises', package: 'packages' };
async function fetchWishlistWithCatalog() {
  const { data } = await axios.get(`${API_BASE}/api/wishlist`, { headers: authHeaders() });
  const catalogs = {};
  await Promise.all([...new Set(data.map(w => w.item_type))].map(async t => {
    const { data: items } = await axios.get(`${API_BASE}/api/${ACCT_WISHLIST_ENDPOINTS[t]}`);
    catalogs[t] = new Map(items.map(i => [i.id, i]));
  }));
  return { data, catalogs };
}
function wishlistLabel(type, item) {
  if (!item) return `${type} #? (no longer available)`;
  if (type === 'flight') return `${item.airline} ${item.from_airport}→${item.to_airport}`;
  if (type === 'hotel') return item.name;
  if (type === 'cruise') return item.name;
  return item.title;
}
function wishlistPrice(type, item) { return item ? money(type === 'hotel' ? item.price_per_night : item.price) : '—'; }
async function loadAcctWishlist() {
  const container = document.getElementById('acctWishlistList');
  try {
    const { data, catalogs } = await fetchWishlistWithCatalog();
    if (!data.length) {
      container.innerHTML = '<div class="acct-empty">Your wishlist is empty.</div>';
      return;
    }
    container.innerHTML = data.map(w => {
      const item = catalogs[w.item_type]?.get(w.item_id);
      return `
        <div class="acct-row">
          <div class="ar-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;">${TYPE_ICONS[w.item_type] || TYPE_ICONS.package}</svg></div>
          <div class="ar-main">
            <div class="ar-title" style="text-transform:none;">${escapeHtml(wishlistLabel(w.item_type, item))}</div>
            <div class="ar-sub" style="text-transform:capitalize;">${w.item_type} · ${wishlistPrice(w.item_type, item)} · Saved ${fmtDate(w.created_at)}</div>
          </div>
          <button type="button" class="btn btn-danger btn-sm" data-remove-wishlist="${w.id}">Remove</button>
        </div>`;
    }).join('');
    container.querySelectorAll('[data-remove-wishlist]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await axios.delete(`${API_BASE}/api/wishlist/${btn.dataset.removeWishlist}`, { headers: authHeaders() });
          loadAcctWishlist();
        } catch (err) { alert('Failed to remove item.'); }
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load wishlist.</div>';
  }
}

/* ---------- Notifications ---------- */
async function loadAcctNotifications() {
  const container = document.getElementById('acctNotificationsList');
  const clearBar = document.getElementById('acctNotifClearBar');
  try {
    const { data } = await axios.get(`${API_BASE}/api/notifications`, { headers: authHeaders() });
    if (!data.length) {
      container.innerHTML = `
        <div class="acct-empty acct-empty-notif">
          <div class="aei">🔔</div>
          <div class="aet">No notifications yet</div>
          <div class="aes">We'll notify you when something important happens.</div>
        </div>`;
      clearBar.style.display = 'none';
      return;
    }
    container.innerHTML = data.map(n => `
      <div class="acct-notif-item ${n.is_read ? '' : 'unread'}">
        <div class="nt">${escapeHtml(n.title)}</div>
        <div class="nm">${escapeHtml(n.message)}</div>
        <div class="ndate">${fmtDate(n.created_at)}</div>
        ${!n.is_read ? `<div class="acct-notif-actions"><button type="button" class="btn btn-ghost btn-sm" data-mark-read="${n.id}">Mark as Read</button></div>` : ''}
      </div>
    `).join('');
    clearBar.style.display = data.some(n => n.is_read) ? 'flex' : 'none';
    container.querySelectorAll('[data-mark-read]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await axios.patch(`${API_BASE}/api/notifications/${btn.dataset.markRead}/read`, {}, { headers: authHeaders() });
          loadAcctNotifications();
        } catch (err) { alert('Failed to mark as read.'); }
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load notifications.</div>';
    clearBar.style.display = 'none';
  }
}

document.getElementById('acctMarkAllReadBtn').addEventListener('click', async () => {
  try {
    await axios.patch(`${API_BASE}/api/notifications/read-all`, {}, { headers: authHeaders() });
    loadAcctNotifications();
  } catch (err) { alert('Failed to mark all as read.'); }
});

document.getElementById('acctClearAllBtn').addEventListener('click', async () => {
  if (!confirm('Are you sure you want to clear all notifications?')) return;
  try {
    await axios.delete(`${API_BASE}/api/notifications/read`, { headers: authHeaders() });
    loadAcctNotifications();
  } catch (err) { alert('Failed to clear notifications.'); }
});

/* ---------- Reviews ---------- */
function starString(rating) { return '★'.repeat(rating) + '☆'.repeat(5 - rating); }
async function loadAcctReviews() {
  const container = document.getElementById('acctReviewsList');
  try {
    const { data } = await axios.get(`${API_BASE}/api/reviews/mine`, { headers: authHeaders() });
    if (!data.length) {
      container.innerHTML = "<div class=\"acct-empty\">You haven't written any reviews yet.</div>";
      return;
    }
    container.innerHTML = data.map(r => `
      <div class="acct-row" data-review-row="${r.id}">
        <div class="ar-main">
          <div class="ar-title">${escapeHtml(r.item_type)} #${r.item_id}</div>
          <div class="ar-sub" style="color:var(--gold-dark); letter-spacing:1px;">${starString(r.rating)}</div>
          ${r.comment ? `<div class="ar-sub">${escapeHtml(r.comment)}</div>` : ''}
          <div class="ar-sub">${fmtDate(r.created_at)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-edit-review="${r.id}" data-rating="${r.rating}" data-comment="${escapeHtml(r.comment || '')}">Edit</button>
        <button type="button" class="btn btn-danger btn-sm" data-delete-review="${r.id}">Delete</button>
      </div>
    `).join('');
    container.querySelectorAll('[data-edit-review]').forEach(btn => {
      btn.addEventListener('click', () => openAcctReviewEdit(btn.dataset.editReview, Number(btn.dataset.rating), btn.dataset.comment));
    });
    container.querySelectorAll('[data-delete-review]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this review?')) return;
        try {
          await axios.delete(`${API_BASE}/api/reviews/${btn.dataset.deleteReview}`, { headers: authHeaders() });
          loadAcctReviews();
        } catch (err) { alert('Failed to delete review.'); }
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load reviews.</div>';
  }
}
function openAcctReviewEdit(reviewId, rating, comment) {
  const row = document.querySelector(`[data-review-row="${reviewId}"]`);
  let selected = rating;
  row.innerHTML = `
    <div class="ar-main" style="width:100%;">
      <div class="acct-star-input" id="acctEditStars-${reviewId}">
        ${[1, 2, 3, 4, 5].map(n => `<span data-star="${n}" class="${n <= rating ? 'active' : ''}">★</span>`).join('')}
      </div>
      <input type="text" id="acctEditComment-${reviewId}" value="${escapeHtml(comment)}" style="width:100%; padding:10px 12px; border-radius:10px; border:1.5px solid var(--line); font-size:13.5px; margin-bottom:10px;">
      <div style="display:flex; gap:8px;">
        <button type="button" class="btn btn-coral btn-sm" id="acctSaveReview-${reviewId}">Save</button>
        <button type="button" class="btn btn-ghost btn-sm" id="acctCancelReview-${reviewId}">Cancel</button>
      </div>
    </div>
  `;
  row.querySelectorAll(`#acctEditStars-${reviewId} span`).forEach(s => {
    s.addEventListener('click', () => {
      selected = Number(s.dataset.star);
      row.querySelectorAll(`#acctEditStars-${reviewId} span`).forEach(x => x.classList.toggle('active', Number(x.dataset.star) <= selected));
    });
  });
  document.getElementById(`acctCancelReview-${reviewId}`).addEventListener('click', loadAcctReviews);
  document.getElementById(`acctSaveReview-${reviewId}`).addEventListener('click', async () => {
    try {
      await axios.put(`${API_BASE}/api/reviews/${reviewId}`, { rating: selected, comment: document.getElementById(`acctEditComment-${reviewId}`).value }, { headers: authHeaders() });
      loadAcctReviews();
    } catch (err) { alert('Failed to update review.'); }
  });
}

/* ---------- Support Tickets ---------- */
async function loadAcctSupportTickets() {
  const container = document.getElementById('acctTicketsList');
  try {
    const { data } = await axios.get(`${API_BASE}/api/support-tickets`, { headers: authHeaders() });
    if (!data.length) {
      container.innerHTML = '<div class="acct-empty">No support tickets yet.</div>';
      return;
    }
    container.innerHTML = data.map(t => `
      <div class="acct-row">
        <div class="ar-main">
          <div class="ar-title" style="text-transform:none;">${escapeHtml(t.subject)}</div>
          <div class="ar-sub">${escapeHtml(t.description)}</div>
          <div class="ar-sub">Priority: ${escapeHtml(t.priority)} · Raised ${fmtDate(t.created_at)}</div>
        </div>
        <span class="badge ${t.status}">${escapeHtml(t.status.replace('_', ' '))}</span>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = '<div class="acct-empty">Failed to load support tickets.</div>';
  }
}
document.getElementById('acctTicketForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('acctTicketMsg');
  try {
    await axios.post(`${API_BASE}/api/support-tickets`, {
      subject: document.getElementById('acctTicketSubject').value,
      description: document.getElementById('acctTicketDescription').value,
      priority: document.getElementById('acctTicketPriority').value,
    }, { headers: authHeaders() });
    msg.textContent = 'Ticket submitted — our support team will get back to you.';
    msg.className = 'acct-msg success';
    e.target.reset();
    loadAcctSupportTickets();
  } catch (err) {
    msg.textContent = apiErrorText(err, 'Failed to submit ticket.');
    msg.className = 'acct-msg error';
  }
});

loadUpcomingJourney();
