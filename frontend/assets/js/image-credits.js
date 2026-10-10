'use strict';
/* image-credits.js — the Image Credits page (image-credits.html).
   Draws one table per image set straight from the three generated manifests that already hold the
   photographer, licence and source of every file (destination-images.js, location-images.js,
   hotel-images.js) — nothing is retyped here, so a photograph added by the fetch scripts appears on
   this page the moment its manifest entry does. Every value is written with textContent. */
(function () {
  const el = (tag, text, attrs) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    Object.keys(attrs || {}).forEach(k => n.setAttribute(k, attrs[k]));
    return n;
  };

  /** 'goa__baga-beach' -> 'Baga Beach, Goa'; 'goa' -> 'Goa'. Derived from the manifest key, not invented. */
  function nameOf(key) {
    const words = s => s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const parts = String(key).split('__');
    return parts.length > 1 ? words(parts[1]) + ', ' + words(parts[0]) : words(parts[0]);
  }

  /** 'CC BY-SA 4.0' -> its Creative Commons deed; anything else (CC0, public domain) has none worth linking. */
  function deedOf(licence) {
    const m = /^CC (BY(?:-SA)?)\s+(\d\.\d)$/.exec(String(licence || '').trim());
    return m ? 'https://creativecommons.org/licenses/' + m[1].toLowerCase() + '/' + m[2] + '/' : '';
  }

  function section(title, credits) {
    const keys = Object.keys(credits || {}).sort();
    if (!keys.length) return null;
    const box = el('section');
    box.appendChild(el('h2', title));
    const wrap = el('div', null, { class: 'ic-scroll' });
    const table = el('table', null, { class: 'ic-table' });
    const head = el('tr');
    ['Photograph', 'Photographer', 'Licence', 'Source'].forEach(h => head.appendChild(el('th', h, { scope: 'col' })));
    table.appendChild(el('thead')).appendChild(head);
    const body = el('tbody');
    keys.forEach(k => {
      const c = credits[k] || {};
      const row = el('tr');
      row.appendChild(el('td', nameOf(k)));
      row.appendChild(el('td', /^https?:/.test(c.artist || '') ? 'Pixabay user' : (c.artist || '—')));
      const lic = el('td');
      const deed = deedOf(c.licence);
      if (deed) lic.appendChild(el('a', c.licence, { href: deed, rel: 'noopener', target: '_blank' }));
      else lic.textContent = c.licence || '—';
      row.appendChild(lic);
      const src = el('td');
      if (/^https:\/\//.test(c.source || '')) src.appendChild(el('a', 'View original', { href: c.source, rel: 'noopener', target: '_blank' }));
      else if (/^https:\/\//.test(c.artist || '')) src.appendChild(el('a', 'View original', { href: c.artist, rel: 'noopener', target: '_blank' }));
      else src.textContent = '—';
      row.appendChild(src);
      body.appendChild(row);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    box.appendChild(wrap);
    return box;
  }

  function render() {
    const host = document.getElementById('icBody');
    if (!host) return;
    host.textContent = '';
    const sets = [
      ['Destinations', typeof DESTINATION_IMAGE_CREDITS !== 'undefined' ? DESTINATION_IMAGE_CREDITS : null],
      ['Famous places', typeof LOCATION_IMAGE_CREDITS !== 'undefined' ? LOCATION_IMAGE_CREDITS : null],
      ['Hotels', typeof HOTEL_IMAGE_CREDITS !== 'undefined' ? HOTEL_IMAGE_CREDITS : null],
    ];
    sets.forEach(s => { const sec = section(s[0], s[1]); if (sec) host.appendChild(sec); });
    if (!host.children.length) host.appendChild(el('p', 'The image credits could not be loaded. Please try again.'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
  else render();
})();
