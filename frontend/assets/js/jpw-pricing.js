/* JPWPricing — client-side display of supplier markup + festival discount.
   ============================================================================
   The pricing services apply the admin's markup and festival discount to the
   AUTHORITATIVE prices (every quote, the Fare Summary, the booking). Listing
   "from" cards, though, are rendered from catalogue/sample data the browser
   holds, so without this they would show the bare supplier base and disagree
   with the checkout once a markup or a festival is configured.

   This reads the same config the server prices from
   (`GET /api/customer/pricing/config`) and applies the SAME formula —
   base → +markup → selling → −festival → final — to those cards, and shows the
   original (struck-through) price, the final price and the "% OFF" badge when a
   festival is running. With no config set it is inert: the card shows exactly
   what it showed before.

   USAGE (display only — never the amount charged): a renderer emits a
   placeholder in place of the formatted price, carrying the SUPPLIER base:

       <span class="jpw-price" data-svc="flight" data-base="4190" data-tax="310">
         ₹4,500
       </span>

   The fallback text inside the span is shown until the config loads (and for
   ever if it never does), so the page is correct even offline. `data-tax` is an
   amount added back AFTER the markup/festival (flight taxes are not marked up),
   and is optional. A MutationObserver paints new placeholders as cards render,
   so renderers need no knowledge of this file beyond the span. */
(function () {
  "use strict";
  var cfg = null;          // {markups:{svc:"%"}, festivals:{svc:{discount_type,discount_value}}}
  var loaded = false;

  function money(n) {
    return "₹" + (Math.round(Number(n) || 0)).toLocaleString("en-IN");
  }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  /* base -> {selling, final, amount, pct, hasDiscount} for one service. */
  function compute(service, base) {
    base = Number(base) || 0;
    var c = cfg || { markups: {}, festivals: {} };
    var mk = Number((c.markups || {})[service] || 0);
    var selling = round2(base * (1 + mk / 100));
    var f = (c.festivals || {})[service];
    var amount = 0;
    if (f && Number(f.discount_value) > 0) {
      amount = f.discount_type === "percent"
        ? round2(selling * Number(f.discount_value) / 100)
        : Math.min(Number(f.discount_value), selling);
    }
    var final = round2(selling - amount);
    var pct = (selling > 0 && amount > 0) ? Math.round(amount / selling * 100) : 0;
    return { selling: selling, final: final, amount: amount, pct: pct, hasDiscount: amount > 0 };
  }

  function paint(el) {
    if (!loaded) return;  // leave the fallback until the config is known
    var svc = el.getAttribute("data-svc") || "flight";
    var base = Number(el.getAttribute("data-base")) || 0;
    var tax = Number(el.getAttribute("data-tax")) || 0;
    var r = compute(svc, base);
    var finalShown = r.final + tax;
    if (r.hasDiscount) {
      var origShown = r.selling + tax;
      el.innerHTML =
        '<span class="jpw-orig" style="text-decoration:line-through;opacity:.55;font-weight:500;margin-right:6px;">' + money(origShown) + '</span>'
        + '<span class="jpw-final">' + money(finalShown) + '</span>'
        + '<span class="jpw-off" style="margin-left:6px;font-size:.72em;font-weight:700;color:#15803D;background:rgba(22,163,74,.14);border-radius:6px;padding:1px 6px;white-space:nowrap;">' + r.pct + '% OFF</span>';
    } else {
      el.innerHTML = money(finalShown);
    }
    el.classList.add("jpw-painted");
  }

  function paintAll(root) {
    var nodes = (root || document).querySelectorAll(".jpw-price:not(.jpw-painted)");
    for (var i = 0; i < nodes.length; i++) paint(nodes[i]);
  }

  function load() {
    return fetch("/api/customer/pricing/config")
      .then(function (r) { return r.ok ? r.json() : { markups: {}, festivals: {} }; })
      .catch(function () { return { markups: {}, festivals: {} }; })
      .then(function (c) { cfg = c; loaded = true; paintAll(document); return c; });
  }

  // Paint placeholders as cards are added, without each renderer calling in.
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || window.setTimeout)(function () {
      scheduled = false;
      paintAll(document);
    }, 0);
  }
  function startObserver() {
    if (!window.MutationObserver || !document.body) return;
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    paintAll(document);
  }

  window.JPWPricing = {
    load: load,
    compute: compute,
    paintAll: paintAll,
    // Force a repaint (e.g. after a config change in a long-lived page).
    repaint: function () {
      var painted = document.querySelectorAll(".jpw-painted");
      for (var i = 0; i < painted.length; i++) painted[i].classList.remove("jpw-painted");
      paintAll(document);
    },
  };

  load();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver);
  } else {
    startObserver();
  }
})();
