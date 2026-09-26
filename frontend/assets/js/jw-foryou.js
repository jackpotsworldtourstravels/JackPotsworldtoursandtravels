'use strict';
/* ===========================================================================
   jw-foryou.js — the landing page's "Recommended for you" shelf.
   ===========================================================================
   PERSONAL, BUT ONLY FROM WHAT THE TRAVELLER DID HERE. It reads the short
   recently-viewed list jw-interest.js keeps in localStorage and, when there is
   something in it, shows the destinations they last opened with a quick way
   back into each — the stays and the trips for that place. Empty history means
   the section never appears: a brand-new visitor sees the ordinary page, not an
   empty "Recommended" heading.

   IT REUSES THE DESTINATIONS SHELF WHOLESALE. The cards are `.jw-dest-card`,
   the grid is `.jw-dest-grid`, the entrance is JWMotion.grid — the same
   language the section below it speaks, so this is a second shelf of the same
   kind rather than a new component. The only new styling is the row of quick
   links, injected here so the section carries its own weight on a page that has
   not changed its stylesheet.

   NO REQUEST, NO DEPENDENCY BEYOND THE MANIFEST. The image key stored with each
   visit resolves through DESTINATION_IMAGE_FILES, already on this page for the
   destinations shelf; nothing is fetched.
   =========================================================================== */
(function () {
  const sec = document.getElementById('jwForYou');
  const grid = document.getElementById('jwForYouGrid');
  if (!sec || !grid || typeof JWInterest === 'undefined') return;

  const recent = JWInterest.recent(4);
  if (!recent.length) return;                     // no history → shelf stays hidden

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* Same resolver the destinations shelf uses — the key came from the API when
     the visit was recorded, and the file (if it shipped) is in the manifest. */
  const artFor = key => {
    if (!key || typeof DESTINATION_IMAGE_FILES !== 'object' || !DESTINATION_IMAGE_FILES) return null;
    const stamp = DESTINATION_IMAGE_FILES[key];
    if (!stamp) return null;
    const dir = (typeof DESTINATION_IMAGE_DIR === 'string') ? DESTINATION_IMAGE_DIR : 'assets/destinations/';
    const v = (typeof stamp === 'string') ? '?v=' + stamp : '';
    return { src: dir + key + '.webp' + v, small: dir + key + '-480.webp' + v };
  };

  function cardHtml(d) {
    const art = artFor(d.image);
    const picture = art
      ? '<img class="jw-dest-img" src="' + esc(art.src) + '"'
        + ' srcset="' + esc(art.small) + ' 480w, ' + esc(art.src) + ' 960w"'
        + ' sizes="(max-width: 520px) 50vw, (max-width: 900px) 33vw, 25vw"'
        + ' alt="' + esc(d.name) + '" loading="lazy" decoding="async" onerror="this.remove()">'
      : '';
    const href = 'destination/' + encodeURIComponent(d.id);
    return '<a role="listitem" class="jw-dest-card" href="' + esc(href) + '"'
      + ' aria-label="Continue exploring ' + esc(d.name) + '">'
      + '<span class="jw-dest-art">' + picture + '<span class="jw-dest-scrim"></span></span>'
      + '<span class="jw-dest-body">'
      + '<span class="jw-dest-name">' + esc(d.name) + '</span>'
      + (d.country ? '<span class="jw-dest-meta">' + esc(d.country) + '</span>' : '')
      + '</span></a>';
  }

  /* The headline names the most recent place; the quick links go straight to
     its stays and its trips — the two things someone who was just reading about
     a destination is most likely to want next. */
  const top = recent[0];
  const cityEl = document.getElementById('jwForYouCity');
  if (cityEl) cityEl.textContent = top.name;

  const links = document.getElementById('jwForYouLinks');
  if (links) {
    links.innerHTML =
      '<a class="jw-fy-link" href="destination/' + esc(encodeURIComponent(top.id)) + '">'
        + 'Hotels in ' + esc(top.name) + '</a>'
      + '<a class="jw-fy-link" href="packages.html?destination=' + esc(encodeURIComponent(top.name)) + '">'
        + esc(top.name) + ' tour packages</a>';
  }

  grid.innerHTML = recent.map(cardHtml).join('');
  sec.hidden = false;
  if (typeof JWMotion !== 'undefined') JWMotion.grid(grid);

  /* The quick-link pills are the only markup here the destinations stylesheet
     does not already cover, so the section brings its own small rule set. */
  if (!document.getElementById('jw-foryou-style')) {
    const style = document.createElement('style');
    style.id = 'jw-foryou-style';
    style.textContent =
      '.jw-fy-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;}'
      + '.jw-fy-link{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;'
      + 'font-size:13.5px;font-weight:700;color:var(--navy,#0A2540);background:rgba(255,255,255,.7);'
      + 'border:1px solid rgba(10,37,64,.12);text-decoration:none;'
      + 'transition:background .2s ease,border-color .2s ease,transform .2s ease;}'
      + '.jw-fy-link:hover{background:#fff;border-color:var(--coral,#E9B949);transform:translateY(-1px);}';
    document.head.appendChild(style);
  }
})();
