'use strict';
/* ===========================================================================
   jw-foryou.js — the landing page's "Recommended for you" shelf.
   ===========================================================================
   TWO SOURCES, ONE SHELF, IN THIS ORDER OF TRUST:

     1. THE SERVER, when the traveller holds a session (a guest counts). It asks
        GET /api/customer/recommendations, scored from what they have viewed,
        saved and booked, and shows real packages with a price and the reason
        each was chosen. This is the backend recommendation engine (0085).

     2. LOCALSTORAGE, otherwise. A signed-out visitor has no server history, so
        the shelf falls back to the recently-viewed destinations jw-interest.js
        keeps locally — the same "pick up where you left off" it always did.

   Empty on both counts means the section never appears: a brand-new visitor
   sees the ordinary page, not an empty "Recommended" heading. Extend, don't
   replace — the localStorage path is untouched and is what runs when there is
   no session or the request fails.

   IT REUSES THE DESTINATIONS SHELF WHOLESALE — `.jw-dest-card`, `.jw-dest-grid`,
   JWMotion.grid — so this is a second shelf of the same kind, not a new
   component. The only new styling (quick-link pills, the price badge) is
   injected here so the section carries its own weight.
   =========================================================================== */
(function () {
  const sec = document.getElementById('jwForYou');
  const grid = document.getElementById('jwForYouGrid');
  if (!sec || !grid || typeof JWInterest === 'undefined') return;

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const money = n => {
    if (n == null) return '';
    try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n); }
    catch { return '₹' + Math.round(n); }
  };

  /* Same resolver the destinations shelf uses — the image key came from the API
     and its file, if it shipped, is in the manifest already on this page. */
  const artFor = key => {
    if (!key || typeof DESTINATION_IMAGE_FILES !== 'object' || !DESTINATION_IMAGE_FILES) return null;
    const stamp = DESTINATION_IMAGE_FILES[key];
    if (!stamp) return null;
    const dir = (typeof DESTINATION_IMAGE_DIR === 'string') ? DESTINATION_IMAGE_DIR : 'assets/destinations/';
    const v = (typeof stamp === 'string') ? '?v=' + stamp : '';
    return { src: dir + key + '.webp' + v, small: dir + key + '-480.webp' + v };
  };

  const pictureHtml = (key, name) => {
    const art = artFor(key);
    return art
      ? '<img class="jw-dest-img" src="' + esc(art.src) + '"'
        + ' srcset="' + esc(art.small) + ' 480w, ' + esc(art.src) + ' 960w"'
        + ' sizes="(max-width: 520px) 50vw, (max-width: 900px) 33vw, 25vw"'
        + ' alt="' + esc(name) + '" loading="lazy" decoding="async" onerror="this.remove()">'
      : '';
  };

  /* A server recommendation — a real package, with its price and the reason it
     was chosen. Links to the package detail page the booking flow opens from. */
  function recCardHtml(r) {
    const href = (r.type === 'package') ? ('package-details/' + encodeURIComponent(r.id))
      : ('destination/' + encodeURIComponent(r.destination || r.id));
    const price = r.price != null
      ? '<span class="jw-rec-price">' + esc(money(r.price)) + '</span>' : '';
    return '<a role="listitem" class="jw-dest-card" href="' + esc(href) + '"'
      + ' aria-label="' + esc(r.name) + '">'
      + '<span class="jw-dest-art">' + pictureHtml(r.image, r.name)
      + '<span class="jw-dest-scrim"></span>' + price + '</span>'
      + '<span class="jw-dest-body">'
      + '<span class="jw-dest-name">' + esc(r.name) + '</span>'
      + (r.reason ? '<span class="jw-dest-meta">' + esc(r.reason) + '</span>' : '')
      + '</span></a>';
  }

  /* A recently-viewed destination — the localStorage fallback card. */
  function recentCardHtml(d) {
    const href = 'destination/' + encodeURIComponent(d.id);
    return '<a role="listitem" class="jw-dest-card" href="' + esc(href) + '"'
      + ' aria-label="Continue exploring ' + esc(d.name) + '">'
      + '<span class="jw-dest-art">' + pictureHtml(d.image, d.name) + '<span class="jw-dest-scrim"></span></span>'
      + '<span class="jw-dest-body">'
      + '<span class="jw-dest-name">' + esc(d.name) + '</span>'
      + (d.country ? '<span class="jw-dest-meta">' + esc(d.country) + '</span>' : '')
      + '</span></a>';
  }

  const cityEl = document.getElementById('jwForYouCity');
  const linksEl = document.getElementById('jwForYouLinks');

  /* The headline + quick links are driven by whatever place is most relevant:
     the destination behind the top recommendation, or the most recent view. */
  function fillHead(name) {
    if (cityEl) cityEl.textContent = name;
    if (linksEl && name) {
      linksEl.innerHTML =
        '<a class="jw-fy-link" href="packages.html?destination=' + esc(encodeURIComponent(name)) + '">'
          + esc(name) + ' tour packages</a>';
    }
  }

  function reveal() {
    sec.hidden = false;
    if (typeof JWMotion !== 'undefined') JWMotion.grid(grid);
    injectStyle();
  }

  const token = () => {
    try { if (typeof getCustomerAuth === 'function') { const a = getCustomerAuth(); if (a && a.access) return a.access; } } catch { /* */ }
    try { return localStorage.getItem('jpc_access') || null; } catch { return null; }
  };

  function renderRecent() {
    const recent = JWInterest.recent(4);
    if (!recent.length) return false;              // nothing local either → stay hidden
    fillHead(recent[0].name);
    grid.innerHTML = recent.map(recentCardHtml).join('');
    reveal();
    return true;
  }

  async function run() {
    const t = token();
    if (t) {
      try {
        const res = await fetch('/api/customer/recommendations', {
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + t },
        });
        if (res.ok) {
          const data = await res.json();
          const recs = (data && data.recommendations) || [];
          if (recs.length) {
            fillHead(recs[0].destination || (recs[0].reason || '').replace(/^Because you explored\s*/i, ''));
            grid.innerHTML = recs.map(recCardHtml).join('');
            reveal();
            return;
          }
        }
      } catch { /* fall through to the local shelf */ }
    }
    /* No session, no server recs, or the request failed — the local shelf. */
    renderRecent();
  }

  function injectStyle() {
    if (document.getElementById('jw-foryou-style')) return;
    const style = document.createElement('style');
    style.id = 'jw-foryou-style';
    style.textContent =
      '.jw-fy-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;}'
      + '.jw-fy-link{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;'
      + 'font-size:13.5px;font-weight:700;color:var(--navy,#0A2540);background:rgba(255,255,255,.7);'
      + 'border:1px solid rgba(10,37,64,.12);text-decoration:none;'
      + 'transition:background .2s ease,border-color .2s ease,transform .2s ease;}'
      + '.jw-fy-link:hover{background:#fff;border-color:var(--coral,#E9B949);transform:translateY(-1px);}'
      + '.jw-rec-price{position:absolute;top:10px;right:10px;padding:5px 10px;border-radius:999px;'
      + 'background:rgba(255,255,255,.92);color:var(--navy,#0A2540);font-size:12.5px;font-weight:800;'
      + 'box-shadow:0 2px 8px rgba(10,37,64,.18);}';
    document.head.appendChild(style);
  }

  run();
})();
