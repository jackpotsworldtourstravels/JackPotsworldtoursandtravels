'use strict';
/* ===========================================================================
   wishlist.js — "save this for later", for any product.
   ===========================================================================
   Generic over `item_type` because the endpoint is: the Account Center already
   stores flights, hotels and packages in one table, so nothing here is hotel-
   specific and the Hotels grid is simply its first caller.

   WHAT THE BACKEND GIVES US
       GET    /api/customer/wishlist            -> [{id, item_type, item_id}]
       POST   /api/customer/wishlist            {item_type, item_id}  (idempotent)
       DELETE /api/customer/wishlist/{id}
   All three require a CUSTOMER token. Signed out, there is no wishlist to read
   and nothing to write, so the button opens the sign-in door rather than
   failing quietly — saving something is a perfectly good reason to ask
   somebody to log in, and a heart that does nothing is not.

   OPTIMISTIC, AND HONEST WHEN IT IS WRONG. The heart fills on click rather
   than after the round trip, because waiting on the network to acknowledge a
   bookmark feels broken. If the request then fails the button goes back to
   where it was and says so — an optimistic UI that keeps a lie after the
   server disagreed is worse than a slow one.
   =========================================================================== */

const Wishlist = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const base = () => (typeof API_BASE === 'string' ? API_BASE : '');

  /** id -> wishlist row id, for the items we know are saved. Keyed by
   *  `${type}:${id}` so two products cannot collide on the same integer. */
  const saved = new Map();
  let loaded = false;
  const key = (type, id) => `${type}:${id}`;

  /* Both namespaces — see auth.js's getCustomerSession(). Reading
     getStoredAuth() alone meant the hearts were dead on every page that does
     not load app.js, which is every results page they appear on. */
  const auth = () => (typeof getCustomerSession === 'function' ? getCustomerSession()
    : (typeof getStoredAuth === 'function' ? getStoredAuth() : {}));
  const signedIn = () => !!auth().access;

  async function api(path, options) {
    const { access } = auth();
    const res = await fetch(`${base()}/api/customer${path}`, Object.assign({
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${access}`,
      },
    }, options || {}));
    if (!res.ok) throw new Error(`wishlist ${path} responded ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  /** Read the saved set once per page. Signed out this is a no-op rather than
   *  a 401 in the console on every load. */
  async function load() {
    if (loaded || !signedIn()) return;
    loaded = true;
    try {
      const rows = await api('/wishlist');
      saved.clear();
      (rows || []).forEach(r => saved.set(key(r.item_type, r.item_id), r.id));
    } catch (err) {
      /* Not fatal and not worth a message: the page works, the hearts are
         simply all shown empty until the next load succeeds. */
      loaded = false;
      console.warn('[wishlist] could not load saved items', err);
    }
  }

  const has = (type, id) => saved.has(key(type, id));

  /** The button. Rendered for everyone — signed out included, because the
   *  click is what invites them in. */
  function button(type, id, label) {
    const on = has(type, id);
    return `<button type="button" class="wl-btn${on ? ' is-on' : ''}"
      data-wl-type="${esc(type)}" data-wl-id="${esc(id)}"
      aria-pressed="${on}" title="${on ? 'Saved' : 'Save for later'}"
      aria-label="${on ? 'Remove' : 'Save'} ${esc(label || 'this')} ${on ? 'from' : 'to'} your wishlist">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z"/>
      </svg>
    </button>`;
  }

  /** Reflect state onto every button for one item — a grid may show the same
   *  property twice (list and an expanded panel), and both must agree. */
  function paint(type, id) {
    const on = has(type, id);
    document.querySelectorAll(
      `[data-wl-type="${CSS.escape(type)}"][data-wl-id="${CSS.escape(String(id))}"]`
    ).forEach(b => {
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Saved' : 'Save for later';
    });
  }

  async function toggle(type, id) {
    if (!signedIn()) {
      /* Ask them in rather than doing nothing. The landing page has the auth
         modal in it, so there openAuth opens it in place; a SERVICE page has no
         modal, and `index.html?signin=1` is the established handoff — the same
         URL service-shell.js's own Login link uses, which account-center reads
         on arrival and turns into an open sign-in dialog.

         The toast fires first because the navigation is a page change, and
         being moved somewhere without being told why is disorienting. */
      if (typeof openAuth === 'function') { openAuth('login'); return; }
      if (typeof showToast === 'function') showToast('Please sign in to save this stay.', 'info');
      setTimeout(() => {
        /* `next` so signing in returns to the results they were looking at,
           filters, expanded card and all. */
        const back = encodeURIComponent(location.pathname + location.search);
        location.href = `index.html?signin=1&next=${back}`;
      }, 900);
      return;
    }
    const k = key(type, id);
    const was = saved.get(k);

    if (was != null) {
      saved.delete(k); paint(type, id);                    // optimistic
      try { await api(`/wishlist/${was}`, { method: 'DELETE' }); }
      catch (err) {
        saved.set(k, was); paint(type, id);                // put it back
        if (typeof showToast === 'function') showToast('Could not remove that just now.', 'error');
        console.warn('[wishlist] remove failed', err);
      }
      return;
    }

    /* Optimistically saved with a placeholder row id: we do not know the real
       one until the POST answers, and the heart must fill now. */
    saved.set(k, -1); paint(type, id);
    try {
      const row = await api('/wishlist', {
        method: 'POST',
        body: JSON.stringify({ item_type: type, item_id: Number(id) }),
      });
      if (row && row.id != null) saved.set(k, row.id);
    } catch (err) {
      saved.delete(k); paint(type, id);
      if (typeof showToast === 'function') showToast('Could not save that just now.', 'error');
      console.warn('[wishlist] save failed', err);
    }
  }

  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    /* Delegated: cards are re-rendered on every filter and sort. */
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-wl-type]');
      if (!btn) return;
      /* The button sits on top of a card whose own click opens details. */
      e.preventDefault();
      e.stopPropagation();
      toggle(btn.dataset.wlType, btn.dataset.wlId);
    });
  }

  return {
    async init() { wire(); await load(); },
    button, has, toggle, paint,
    /** Repaint everything after a re-render. */
    refresh() { saved.forEach((_, k) => { const [t, i] = k.split(':'); paint(t, i); }); },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Wishlist;
