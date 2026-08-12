'use strict';
/* Classic — Partner Assistant.
   ===========================================================================
   A launcher in the corner and a conversation panel. The merchant types a
   question; the assistant works out what they asked and answers it with their
   own data.

   THE ONE THING TO UNDERSTAND ABOUT THIS FILE
   It never invents a figure, and it is not able to. Two steps, and they are
   deliberately separated:

     1. POST /api/assistant/interpret  ->  an intent NAME and nothing else.
        No balance, booking, fare or passenger crosses that call in either
        direction. When a language model is configured it sees only the
        merchant's sentence; when one is not, a keyword matcher does the same
        job. Either way the answer is a member of a fixed enum.

     2. The handler for that intent calls the SAME MerchantApi method the
        corresponding screen calls, and renders the response. Every number on
        screen is a field from that response, formatted and never computed.

   That is also the whole of the access control. MerchantApi carries the
   merchant's own token, so a request here reaches exactly the rows the portal
   would show them anyway — a role that cannot see the wallet gets the same 403
   through the assistant as through the rail, and there is no id anywhere in
   this file that could name another company.

   WHERE THE MARKUP LIVES
   The launcher and panel are direct children of <body> in index.html, NOT in a
   section. `.cl-section.active` retains `transform:none` from its entrance
   animation, which is a containing block for `position:fixed` — anything fixed
   inside a section anchors to the section instead of the viewport. See the
   Partner Assistant block in classic.css. */

/* ---------------------------------------------------------------- state -- */

const CL_AS = {
  ready: false,
  open: false,
  busy: false,
  config: null,
  /* The merchant's own previous questions, oldest first. Only their text is
     kept: nothing this file renders is ever sent back, so no figure can
     re-enter the interpret call through the conversation. */
  history: [],
  greeted: false,
};

/* Quick actions, and the intent each one stands for. These are the same
   intents free text resolves to, so a chip and a sentence take identical
   paths — there is no second implementation behind the buttons. */
const CL_AS_QUICK = [
  /* "Book a Flight" is the brief's first quick action and it is real — it goes
     to the enquiry form, which is how a flight is booked here. Its sibling
     "Book a Hotel" is not offered: see clAsGreet for why. */
  { label: 'Book a Flight', go: 'enquiry' },
  { label: 'My Bookings', intent: 'bookings_list' },
  { label: 'Wallet', intent: 'wallet_balance' },
  { label: 'Help', intent: 'capabilities' },
];

/* Screen -> the two chips worth offering there. The assistant should read the
   room without being asked twice; anything longer than this becomes a menu the
   merchant has to dismiss. */
const CL_AS_CONTEXT = {
  wallet: ['wallet_balance', 'wallet_transactions'],
  payments: ['payments_pending', 'payments_list'],
  enquiry: ['enquiries_list', 'quotations_available'],
  'booking-request': ['bookings_list', 'enquiries_list'],
  'booking-history': ['bookings_list', 'payments_list'],
  requests: ['bookings_list', 'service_requests_list'],
  'service-request': ['service_requests_list', 'bookings_list'],
  approvals: ['bookings_list', 'payments_pending'],
  reports: ['bookings_list', 'wallet_transactions'],
};

const CL_AS_LABELS = {
  bookings_list: 'My bookings',
  booking_status: 'Booking status',
  enquiries_list: 'My enquiries',
  quotations_available: 'Available quotations',
  wallet_balance: 'Wallet balance',
  wallet_transactions: 'Recent transactions',
  payments_pending: 'Pending payments',
  payments_list: 'Payment history',
  service_requests_list: 'Service requests',
  contact_support: 'Talk to support',
};

/* ------------------------------------------------------- the robot is alive -

   The robot's shape is static markup in index.html. What lives here is the
   only part that cannot be CSS: WHEN it blinks.

   A blink on a fixed interval is the thing that makes an animated mascot read
   as a spinning throbber — the eye catches the rhythm within about three
   cycles and it stops looking alive and starts looking like a loading state.
   So every wait is drawn fresh from a range, and roughly one blink in five is
   a double. Same reason the glance is occasional rather than a cycle.

   ONE setTimeout CHAIN, NOT setInterval. A chain cannot overlap itself, it
   stops cleanly, and it lets each wait differ from the last. It also keeps
   running while the panel is open, because the robot stays on screen — a robot
   that freezes the moment you talk to it is worse than one that never moved.

   Everything it does is a class toggle; CSS owns every transform, so the whole
   effect composites on the GPU and no JavaScript runs between blinks. */

const CL_AS_BLINK = {
  timer: null,
  glance: null,
  /* Closed for 70-160ms. Below ~60 it reads as a glitch; above ~200 the robot
     looks sleepy rather than alive. */
  shut() { return 70 + Math.random() * 90; },
  /* 3-7s between blinks, per the brief, never the same twice running. */
  wait() { return 3000 + Math.random() * 4000; },
};

function clAsReducedMotion() {
  return window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clAsBlinkOnce(bot, then) {
  bot.classList.add('is-blinking');
  setTimeout(() => {
    bot.classList.remove('is-blinking');
    if (then) setTimeout(then, 110 + Math.random() * 70);
  }, CL_AS_BLINK.shut());
}

function clAsBlinkLoop(bot) {
  clearTimeout(CL_AS_BLINK.timer);
  const calm = clAsReducedMotion();
  CL_AS_BLINK.timer = setTimeout(() => {
    /* A double blink about a fifth of the time — dropped under reduced motion,
       where one gentle blink is the whole budget. */
    const double = !calm && Math.random() < 0.2;
    clAsBlinkOnce(bot, double ? () => clAsBlinkOnce(bot) : null);
    clAsBlinkLoop(bot);
  }, calm ? CL_AS_BLINK.wait() * 1.8 : CL_AS_BLINK.wait());
}

/* The glance: left or right, hold, then back to centre — the robot's resting
   state is looking AT the merchant, so every glance returns. Suppressed
   entirely under reduced motion. */
function clAsGlanceLoop(bot) {
  clearTimeout(CL_AS_BLINK.glance);
  if (clAsReducedMotion()) return;
  CL_AS_BLINK.glance = setTimeout(() => {
    const side = Math.random() < 0.5 ? 'look-l' : 'look-r';
    bot.classList.add(side);
    setTimeout(() => bot.classList.remove(side), 900 + Math.random() * 700);
    clAsGlanceLoop(bot);
  }, 7000 + Math.random() * 9000);
}

function clAsAnimateBot() {
  const bot = document.getElementById('clAsBot');
  if (!bot) return;
  clAsBlinkLoop(bot);
  clAsGlanceLoop(bot);
}

/* ----------------------------------------------------------------- boot -- */

/* Called from clShowApp(), i.e. only once a merchant is actually signed in.
   Every failure below is swallowed: the assistant is an aid, and a portal that
   will not load because its helper could not is a far worse outcome than a
   portal with no helper. */
async function clAsBoot() {
  if (CL_AS.ready) return;
  try {
    CL_AS.config = await MerchantApi.assistantConfig();
  } catch (err) {
    return; /* 400 for staff, 404 when disabled, anything else — stay silent. */
  }
  if (!CL_AS.config || !CL_AS.config.enabled) return;

  CL_AS.ready = true;
  const fab = document.getElementById('clAsFab');
  if (!fab) return;
  fab.hidden = false;
  clAsAnimateBot();
  clAsHelloBubble();

  fab.addEventListener('click', clAsToggle);
  document.getElementById('clAsClose').addEventListener('click', clAsClose);
  document.getElementById('clAsMin').addEventListener('click', clAsClose);
  document.getElementById('clAsBack').addEventListener('click', clAsClose);
  document.getElementById('clAsForm').addEventListener('submit', clAsSubmit);

  const input = document.getElementById('clAsInput');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 104) + 'px';
    document.getElementById('clAsSend').disabled = !input.value.trim();
  });
  /* Enter sends, Shift+Enter breaks the line — the convention every messaging
     app uses, and this composer is a textarea precisely so the second one
     works. */
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); clAsSubmit(e); }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && CL_AS.open) clAsClose();
  });

  /* Delegated, because every chip and card button in the transcript is written
     by innerHTML after this runs. One listener survives every re-render; a
     per-button listener would not. */
  document.getElementById('clAsLog').addEventListener('click', e => {
    const btn = e.target.closest('[data-as-act]');
    if (!btn) return;
    const act = btn.dataset.asAct;
    if (act === 'go') { clAsClose(); clGo(btn.dataset.asTo); return; }
    if (act === 'intent') { clAsAsk(btn.dataset.asIntent, btn.textContent.trim()); return; }
    if (act === 'escalate') { clAsEscalate(); }
  });
}

/* Shown once, a moment after the portal settles, and it takes itself away.
   ONCE PER BROWSER, not once per page load: a merchant who navigates between
   screens all day does not want greeting again, and localStorage is the only
   thing here that survives a reload. Skipped entirely if they have already
   opened the assistant — greeting someone mid-conversation is noise. */
function clAsHelloBubble() {
  const el = document.getElementById('clAsHello');
  if (!el) return;
  try {
    if (localStorage.getItem('cl_as_greeted') === '1') return;
    localStorage.setItem('cl_as_greeted', '1');
  } catch (err) { /* private mode: greet this once and do not persist it. */ }

  setTimeout(() => {
    if (CL_AS.open) return;
    el.hidden = false;
    /* Two frames: the element has to be laid out with the start styles before
       the class that transitions away from them lands, or there is nothing to
       animate from and it simply appears. */
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    setTimeout(() => clAsHideHello(), 6500);
  }, 1400);
}

function clAsHideHello() {
  const el = document.getElementById('clAsHello');
  if (!el || el.hidden) return;
  el.classList.remove('show');
  setTimeout(() => { el.hidden = true; }, 340);
}

function clAsToggle() { CL_AS.open ? clAsClose() : clAsOpen(); }

function clAsOpen() {
  CL_AS.open = true;
  clAsHideHello();
  document.getElementById('clAsPanel').classList.add('open');
  document.getElementById('clAsBack').classList.add('open');
  document.getElementById('clAsFab').setAttribute('aria-expanded', 'true');
  if (!CL_AS.greeted) { CL_AS.greeted = true; clAsGreet(); }
  /* Only focus the composer where a keyboard is the input device. On a phone
     this would throw up the on-screen keyboard over the greeting the merchant
     has not read yet. */
  if (window.innerWidth > 640) setTimeout(() => document.getElementById('clAsInput').focus(), 220);
}

function clAsClose() {
  CL_AS.open = false;
  document.getElementById('clAsPanel').classList.remove('open');
  document.getElementById('clAsBack').classList.remove('open');
  document.getElementById('clAsFab').setAttribute('aria-expanded', 'false');
}

/* THE LIST NAMES WHAT THIS PORTAL ACTUALLY DOES.
   The brief asked for "Hotel booking / Transport / Tour packages" alongside
   flights. This portal has none of them: the enquiry form carries no
   travel_type at all, EnquiryCreate does not accept one, and the hotel, cruise
   and package tables were dropped in the V2 migration. Advertising them here
   would put a merchant three taps from a dead end and make the assistant the
   least trustworthy thing on the screen. Flights, and everything wrapped
   around a flight booking, is the real surface — so that is what it offers.
   Restore the other lines the day those bookings exist. */
function clAsGreet() {
  const name = (localStorage.getItem(PARTNER_KEYS.fullName) || '').split(' ')[0];
  const hello = name ? 'Hi ' + name + '! 👋' : 'Hi! 👋';
  const here = CL_AS_CONTEXT[clCurrentSection] || [];
  /* Passed through as-is: a quick action may be a `go` (straight to a screen)
     as well as an `intent`, and rebuilding the object would drop whichever
     key this one happens to use. */
  const chips = here.length
    ? here.map(i => ({ label: CL_AS_LABELS[i], intent: i }))
    : CL_AS_QUICK.slice();

  const where = here.length && CL_TITLES[clCurrentSection]
    ? '\n\nI can see you are on ' + CL_TITLES[clCurrentSection] + '.'
    : '';

  clAsSay('bot',
    hello + " I'm your travel assistant. I can help you with:\n\n"
    + '• Flight enquiries and booking requests\n'
    + '• Booking and enquiry status\n'
    + '• Quotations and fares\n'
    + '• Wallet, payments and service requests\n'
    + '• Passenger details and how the portal works'
    + where,
    { chips });
}

/* --------------------------------------------------------------- render -- */

function clAsScroll() {
  const log = document.getElementById('clAsLog');
  log.scrollTop = log.scrollHeight;
}

/* The message goes in its own span so `white-space:pre-wrap` applies to the
   merchant's line breaks and NOT to the indentation of the template below.
   Those newlines and spaces are real text nodes; with pre-wrap on the bubble
   itself every message renders with several phantom blank lines. */
function clAsBubble(text) {
  return '<div class="cl-as-bub"><span class="cl-as-bub-txt">'
    + escapeHtml(text) + '</span></div>';
}

function clAsSay(who, text, { chips = [], card = '' } = {}) {
  const log = document.getElementById('clAsLog');
  const row = document.createElement('div');
  row.className = 'cl-as-row' + (who === 'me' ? ' me' : '');
  const chipHtml = chips.length
    ? '<div class="cl-as-chips">' + chips.map(c =>
      '<button type="button" class="cl-as-chip' + (c.primary ? ' primary' : '') + '"'
      + ' data-as-act="' + (c.go ? 'go' : c.escalate ? 'escalate' : 'intent') + '"'
      + (c.go ? ' data-as-to="' + escapeHtml(c.go) + '"' : '')
      + (c.intent ? ' data-as-intent="' + escapeHtml(c.intent) + '"' : '')
      + '>' + escapeHtml(c.label) + '</button>').join('') + '</div>'
    : '';
  row.innerHTML = (text ? clAsBubble(text) : '') + card + chipHtml;
  log.appendChild(row);
  clAsScroll();
  return row;
}

function clAsTyping(on) {
  const existing = document.getElementById('clAsTyping');
  if (existing) existing.remove();
  if (!on) return;
  const log = document.getElementById('clAsLog');
  const row = document.createElement('div');
  row.id = 'clAsTyping';
  row.className = 'cl-as-row';
  row.innerHTML = '<div class="cl-as-bub cl-as-typing"><i></i><i></i><i></i></div>';
  log.appendChild(row);
  clAsScroll();
}

function clAsCard(title, bodyHtml, actions = []) {
  const foot = actions.length
    ? '<div class="cl-as-card-f">' + actions.map(a =>
      '<button type="button" class="cl-as-chip' + (a.primary ? ' primary' : '') + '"'
      + ' data-as-act="' + (a.go ? 'go' : 'intent') + '"'
      + (a.go ? ' data-as-to="' + escapeHtml(a.go) + '"' : '')
      + (a.intent ? ' data-as-intent="' + escapeHtml(a.intent) + '"' : '')
      + '>' + escapeHtml(a.label) + '</button>').join('') + '</div>'
    : '';
  return '<div class="cl-as-card">'
    + '<div class="cl-as-card-h">' + escapeHtml(title) + '</div>'
    + '<div class="cl-as-card-b">' + bodyHtml + '</div>'
    + foot + '</div>';
}

/* A list of rows inside a card. `value` is pre-formatted by the caller — this
   helper never touches a number. */
function clAsRows(items) {
  if (!items.length) return '<div class="cl-as-sub">Nothing to show here yet.</div>';
  return items.map(it =>
    '<div class="cl-as-rowitem"><div class="cl-as-rowitem-main">'
    + '<div class="cl-as-rowitem-t">' + escapeHtml(it.title) + '</div>'
    + (it.sub ? '<div class="cl-as-rowitem-s">' + escapeHtml(it.sub) + '</div>' : '')
    + '</div>'
    + (it.value ? '<div class="cl-as-rowitem-v">' + escapeHtml(it.value) + '</div>' : '')
    + '</div>').join('');
}

/* ------------------------------------------------------------ the loop --- */

function clAsSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const input = document.getElementById('clAsInput');
  const text = input.value.trim();
  if (!text || CL_AS.busy) return;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('clAsSend').disabled = true;
  clAsHandle(text);
}

/* A chip press. The label is echoed as the merchant's own message so the
   transcript reads as a conversation rather than as a control panel, and the
   intent skips interpretation — we already know what was asked. */
function clAsAsk(intent, label) {
  if (CL_AS.busy) return;
  clAsSay('me', label);
  clAsRun(intent, {});
}

async function clAsHandle(text) {
  clAsSay('me', text);
  CL_AS.busy = true;
  clAsTyping(true);

  let reply;
  try {
    reply = await MerchantApi.assistantInterpret({
      message: text,
      page: clCurrentSection || null,
      history: CL_AS.history.slice(-4),
    });
  } catch (err) {
    clAsTyping(false);
    CL_AS.busy = false;
    /* Never surface a status code or a server message. The merchant can do
       nothing with either, and the desk is still reachable. */
    clAsSay('bot', 'The Partner Assistant is temporarily unavailable. '
      + 'You can still reach our team.', { chips: [{ label: 'Talk to support', escalate: true, primary: true }] });
    return;
  }
  CL_AS.history.push(text);
  clAsTyping(false);
  CL_AS.busy = false;

  if (reply.clarify && (reply.intent === 'out_of_scope' || reply.intent === 'unknown')) {
    clAsSay('bot', reply.clarify, { chips: CL_AS_QUICK.slice(0, 4) });
    return;
  }
  if (reply.intent === 'portal_help' && reply.help) { clAsHelp(reply.help); return; }
  clAsRun(reply.intent, reply);
}

/* Renders one help topic. The body is written server-side and ships with the
   release, so it cannot describe a portal we do not serve. */
function clAsHelp(help) {
  const actions = [];
  if (help.screen && CL_TITLES[help.screen]) {
    actions.push({ label: 'Go to ' + CL_TITLES[help.screen], go: help.screen, primary: true });
  }
  /* The bodies use **bold** for the screen names. Escape first, then promote
     the markers — the other way round would let a body inject markup. */
  const body = escapeHtml(help.body)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '<br><br>');
  clAsSay('bot', '', { card: clAsCard(help.title, body, actions) });
}

/* One line, picked at random, so asking twice does not give a copy-paste
   answer. Small enough to stay in character and never so chatty that it gets
   in the way of the thing the merchant actually opened the panel for. */
function clAsPick(lines) { return lines[Math.floor(Math.random() * lines.length)]; }

const CL_AS_HANDLERS = {
  greeting: () => clAsSay('bot',
    clAsPick([
      'Hello! What can I help you with?',
      'Hi there. What do you need?',
      'Hello. Ask me anything about your account.',
    ]),
    { chips: CL_AS_QUICK.slice(0, 4) }),

  /* SMALL TALK ALWAYS LANDS BACK ON SOMETHING USEFUL. A reply that is only
     pleasantry leaves the merchant with nothing to do next, which is how a
     chat panel becomes a novelty they close. */
  how_are_you: () => clAsSay('bot',
    clAsPick([
      "I'm doing well, thank you — and ready to help. What do you need?",
      "All good here, thanks for asking! What can I look up for you?",
      "Running smoothly, thank you. What would you like to check?",
    ]),
    { chips: CL_AS_QUICK.slice(0, 4) }),

  thanks: () => clAsSay('bot',
    clAsPick([
      "You're very welcome. Anything else?",
      'Happy to help. Anything else you need?',
      'Any time! Let me know if there is anything else.',
    ]),
    { chips: CL_AS_QUICK.slice(0, 3) }),

  about: () => clAsSay('bot',
    "I'm the Jackpot AI Assistant — the travel assistant built into your "
    + 'merchant portal. I can look things up on your account and explain how '
    + 'the portal works.\n\nEverything I tell you about your bookings, wallet '
    + 'or payments comes straight from your live account — I never guess a '
    + 'figure. If I cannot help, I will put you through to our team.',
    { chips: CL_AS_QUICK.slice(0, 4) }),

  goodbye: () => clAsSay('bot',
    clAsPick([
      'Goodbye! I am here whenever you need me.',
      'Take care. Just tap me again if anything comes up.',
      'Happy to help any time — see you soon.',
    ])),

  affirm: () => clAsSay('bot',
    clAsPick([
      'Anything else I can help with?',
      'Sure — what would you like to do next?',
      'Got it. What next?',
    ]),
    { chips: CL_AS_QUICK.slice(0, 4) }),

  capabilities: () => clAsSay('bot',
    'I can look up your bookings, enquiries, quotations, wallet, payments and '
    + 'service requests, and explain how the portal works — always from your '
    + 'live account, never from memory. For anything I cannot answer, I will '
    + 'put you through to our team.',
    {
      chips: [
        { label: 'My bookings', intent: 'bookings_list' },
        { label: 'My enquiries', intent: 'enquiries_list' },
        { label: 'Wallet', intent: 'wallet_balance' },
        { label: 'Service requests', intent: 'service_requests_list' },
        { label: 'Talk to support', escalate: true },
      ],
    }),

  wallet_balance: clAsWallet,
  wallet_transactions: clAsWalletLedger,
  bookings_list: clAsBookings,
  booking_status: clAsBookingRef,
  enquiries_list: clAsEnquiries,
  enquiry_status: clAsEnquiries,
  quotations_available: r => clAsEnquiries(Object.assign({}, r, { quoted: true })),
  payments_pending: r => clAsPayments(Object.assign({}, r, { pending: true })),
  payments_list: clAsPayments,
  service_requests_list: clAsServiceRequests,
  service_request_status: clAsServiceRequests,
  passenger_lookup: clAsPassenger,
  contact_support: clAsOfferSupport,

  out_of_scope: () => clAsSay('bot', 'I can only provide information related to your account.',
    { chips: CL_AS_QUICK.slice(0, 4) }),
};

/* EVERY MESSAGE GETS AN ANSWER. That is a promise the panel has to keep
   literally, not approximately: a merchant who types something and watches the
   typing dots vanish with nothing after them has been told the thing is
   broken, whatever the console says.

   Three ways a turn could otherwise end in silence, and all three are closed
   here — an intent with no handler, a handler that throws, and a handler that
   returns normally having rendered nothing (a mistake that is easy to make in
   a new handler and invisible in review). The last one is why the row count is
   taken before and after rather than trusting the handlers. */
/* EXCLUDES THE TYPING INDICATOR, which is itself a .cl-as-row. Counting it
   would exactly mask the case this exists to catch: the indicator is removed
   as the handler's own row is added, so a silent handler leaves the total
   unchanged and the backstop never fires. */
function clAsRowCount() {
  return document.querySelectorAll('#clAsLog .cl-as-row:not(#clAsTyping)').length;
}

function clAsLost() {
  clAsSay('bot',
    "Sorry, I did not quite catch that. I can look up your bookings, "
    + 'enquiries, wallet, payments and service requests, or explain how '
    + 'something in the portal works.\n\nTry asking me something like '
    + '"what is my wallet balance" or "show my bookings" — or pick one below.',
    { chips: CL_AS_QUICK.concat([{ label: 'Talk to support', escalate: true }]) });
}

async function clAsRun(intent, params) {
  const fn = CL_AS_HANDLERS[intent];
  if (!fn) { clAsLost(); return; }

  CL_AS.busy = true;
  clAsTyping(true);
  const before = clAsRowCount();
  try {
    await fn(params || {});
  } catch (err) {
    clAsTyping(false);
    clAsFailed(err);
  } finally {
    clAsTyping(false);
    CL_AS.busy = false;
  }
  /* The backstop. If the handler said nothing at all, say something. */
  if (clAsRowCount() === before) clAsLost();
}

/* One place decides what a failed lookup says. A 403 is a real answer — the
   merchant's role does not carry that permission — and telling them so is more
   use than a generic apology. Everything else stays vague on purpose: a raw
   status or server string helps nobody outside this repo. */
function clAsFailed(err) {
  const code = err && err.response ? err.response.status : 0;
  if (code === 403) {
    clAsSay('bot', 'Your role does not have access to that. Ask your Merchant Admin '
      + 'if you need it.', { chips: CL_AS_QUICK.slice(0, 3) });
    return;
  }
  if (code === 404) {
    clAsSay('bot', 'I could not find that on your account. Check the reference and try again.',
      { chips: [{ label: 'Talk to support', escalate: true }] });
    return;
  }
  clAsSay('bot', 'I could not retrieve that just now. Please try again, or contact support.',
    { chips: [{ label: 'Talk to support', escalate: true, primary: true }] });
}

/* -------------------------------------------------------------- handlers - */

/* Every figure below is a field off the API response, run through moneyStr —
   which reads the decimal STRING the API sends. money() parses to a float and
   drops paise, which is why it is not used on any money path in this file. */

async function clAsWallet() {
  const w = await MerchantApi.wallet();
  const negative = !moneyIsPositive(w.balance) && String(w.balance).trim() !== '0.00';
  const body =
    '<div class="cl-as-figure' + (negative ? ' neg' : '') + '">' + escapeHtml(moneyStr(w.balance)) + '</div>'
    + '<div class="cl-as-sub">Current balance'
    + (w.has_credit_limit && w.credit_available != null
      ? ' · ' + escapeHtml(moneyStr(w.credit_available)) + ' credit available' : '')
    + '</div>'
    + (negative
      ? '<div class="cl-as-sub" style="margin-top:8px">A negative balance is what you '
        + 'currently owe against your credit limit, not an error.</div>'
      : '');
  clAsSay('bot', '', {
    card: clAsCard('Wallet', body, [
      { label: 'Open Wallet', go: 'wallet', primary: true },
      { label: 'Recent transactions', intent: 'wallet_transactions' },
    ]),
  });
}

/* A LEDGER LINE HAS NO `amount` FIELD, AND NO `description` EITHER.
   WalletTransactionOut is `txn_number` / `txn_type` / `reason`, with the
   movement split across SEPARATE `debit` and `credit` columns — exactly one of
   which is non-zero. Guessing the names renders a column of dashes, which is
   what this did before the schema was read.

   Direction comes from moneySign, which reads the decimal STRING: "-0.00"
   round-trips through a float as -0, and -0 < 0 is false, so the one case a
   sign test exists for is the one a float gets wrong. */
async function clAsWalletLedger() {
  const page = await MerchantApi.walletTransactions({ page: 1, pageSize: 5 });
  const rows = (page.items || []).map(t => {
    const isDebit = moneySign(t.debit) !== 0;
    return {
      title: t.reason || t.txn_type || 'Movement',
      sub: [fmtDate(t.created_at), t.request_number || t.topup_number || t.txn_number]
        .filter(Boolean).join(' · '),
      value: (isDebit ? '- ' : '+ ') + moneyStr(isDebit ? t.debit : t.credit),
    };
  });
  clAsSay('bot', '', {
    card: clAsCard('Recent wallet activity', clAsRows(rows), [
      { label: 'Open Wallet', go: 'wallet', primary: true },
    ]),
  });
}

/* "pending" on a booking means the merchant is waiting on us, which is
   submitted or in review — not one status. The full list is left to the
   screen; this is a glance, not a replacement for it. */
const CL_AS_BOOKING_STATUS = {
  pending: 'submitted',
  approved: 'approved',
  confirmed: 'confirmed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  completed: 'completed',
};

async function clAsBookings(params) {
  const status = CL_AS_BOOKING_STATUS[params.status] || undefined;
  const page = await MerchantApi.listRequests({ status, page: 1, page_size: 5 });
  const items = page.items || [];
  /* The reference alone is the title. `r.title` carries the whole itinerary
     ("Hyderabad to Mumbai, IndiGo 6E1423"), and appending it ran every row to
     three wrapped lines in a 404px panel — the reference, which is what the
     merchant scans for, stopped being the thing the eye lands on. */
  const rows = items.map(r => ({
    title: r.request_number,
    sub: [r.title, r.status_label || r.status, 'travel ' + fmtDate(r.travel_date)]
      .filter(Boolean).join(' · '),
    value: moneyStr(r.total_amount),
  }));
  const heading = params.status
    ? params.status.charAt(0).toUpperCase() + params.status.slice(1) + ' bookings'
    : 'Your latest bookings';
  const note = page.total > items.length
    ? 'Showing ' + items.length + ' of ' + page.total + '.'
    : '';
  clAsSay('bot', '', {
    card: clAsCard(heading, clAsRows(rows)
      + (note ? '<div class="cl-as-sub" style="margin-top:8px">' + escapeHtml(note) + '</div>' : ''), [
      { label: 'Open My Requests', go: 'requests', primary: true },
      { label: 'Booking History', go: 'booking-history' },
    ]),
  });
}

/* A reference names one row, so this searches for it rather than listing.
   `search` is a server-side filter on the merchant's own scope — a reference
   belonging to another company simply returns nothing, which is the correct
   answer and not an error. */
async function clAsBookingRef(params) {
  if (!params.reference) return clAsBookings(params);
  const page = await MerchantApi.listRequests({ search: params.reference, page: 1, page_size: 3 });
  const items = page.items || [];
  if (!items.length) {
    clAsSay('bot', 'I could not find ' + params.reference + ' on your account.',
      { chips: [{ label: 'My bookings', intent: 'bookings_list' }, { label: 'Talk to support', escalate: true }] });
    return;
  }
  const r = items[0];
  const body =
    '<div class="cl-as-rowitem-t">' + escapeHtml(r.request_number) + '</div>'
    + (r.title ? '<div class="cl-as-sub">' + escapeHtml(r.title) + '</div>' : '')
    + '<div style="margin-top:9px"><div class="cl-as-figure" style="font-size:15px">'
    + escapeHtml(r.status_label || r.status) + '</div>'
    + '<div class="cl-as-sub">Travel ' + escapeHtml(fmtDate(r.travel_date))
    + ' · ' + escapeHtml(moneyStr(r.total_amount)) + '</div></div>'
    + (r.pnr ? '<div class="cl-as-sub" style="margin-top:6px">PNR ' + escapeHtml(r.pnr) + '</div>' : '')
    + (r.ticket_number ? '<div class="cl-as-sub">Ticket ' + escapeHtml(r.ticket_number) + '</div>' : '');
  clAsSay('bot', '', {
    card: clAsCard('Booking', body, [{ label: 'Open My Requests', go: 'requests', primary: true }]),
  });
}

async function clAsEnquiries(params) {
  const page = await MerchantApi.listEnquiries({ page: 1, page_size: 5 });
  let items = page.items || [];
  if (params.quoted) items = items.filter(e => e.quoted_fare != null);
  const rows = items.map(e => ({
    title: e.reference_number,
    sub: [e.origin, e.destination].filter(Boolean).join(' to ')
      + ' · ' + (e.status_label || e.status)
      + ' · ' + e.passenger_count + (e.passenger_count === 1 ? ' passenger' : ' passengers'),
    value: e.quoted_fare != null ? moneyStr(e.quoted_fare) : '',
  }));
  const heading = params.quoted ? 'Enquiries with a quotation' : 'Your latest enquiries';
  const empty = params.quoted && !items.length
    ? '<div class="cl-as-sub">None of your recent enquiries has been quoted yet.</div>'
    : clAsRows(rows);
  clAsSay('bot', '', {
    card: clAsCard(heading, empty, [
      { label: 'Open Booking Enquiry', go: 'enquiry', primary: true },
    ]),
  });
}

/* THE BUCKET NAMES DO NOT MEAN WHAT THEY LOOK LIKE, and getting this wrong
   tells a merchant they owe money they have already paid. `pending` is
   SUBMITTED — they have paid and the desk is verifying it, so there is nothing
   for them to do. `requests` is AWAITING_PAYMENT — the desk has raised it and
   it is unpaid. "What is awaiting me?" is therefore `requests`, not `pending`.
   Same trap as pending_payments_count, which is a row count and not a sum. */
async function clAsPayments(params) {
  /* "what payments are pending" carries the narrowing word in `status` but
     scores as the general list — "payments" is simply the longer match. Read
     the status here rather than lengthening the phrase table, because it fixes
     the whole family at once ("are pending", "still pending", "any pending")
     and it works whichever provider did the classifying. */
  const wantsPending = params.pending || params.status === 'pending';
  const counts = await MerchantApi.paymentRequestCounts().catch(() => null);
  const page = await MerchantApi.paymentRequests({
    bucket: wantsPending ? 'requests' : 'all', page: 1, pageSize: 5,
  });
  /* A payment request is `topup_number` / `submitted_at` / raw `status`, and
     unlike a booking it ships NO `status_label` — the wording is the UI's to
     supply, which is why it comes from clPrStatusText in classic-payments.js
     rather than being written again here. */
  const items = page.items || [];
  const rows = items.map(p => ({
    title: p.topup_number || ('Request ' + p.topup_id),
    sub: clPrStatusText(p.status) + ' · ' + fmtDate(p.submitted_at),
    value: moneyStr(p.amount),
  }));
  const head = wantsPending ? 'Payments awaiting you' : 'Recent payments';
  /* Deliberately says "to settle" rather than a rupee figure: this is a COUNT
     of requests, and printing it beside money would read as an amount. */
  const note = counts && counts.requests != null
    ? counts.requests + ' request' + (counts.requests === 1 ? '' : 's') + ' to settle.'
    : '';
  clAsSay('bot', '', {
    card: clAsCard(head, clAsRows(rows)
      + (note ? '<div class="cl-as-sub" style="margin-top:8px">' + escapeHtml(note) + '</div>' : ''), [
      { label: 'Open Payment Management', go: 'payments', primary: true },
    ]),
  });
}

async function clAsServiceRequests(params) {
  const page = await MerchantApi.listChangeRequests({ page: 1, page_size: 5 });
  const items = page.items || [];
  /* The field is `change_type`, not `request_type`, and the API already ships
     `change_type_label` — so the label is read, never derived. Deriving one by
     stripping underscores is how a screen ends up saying "date change" where
     the rest of the portal says "Reschedule". */
  const rows = items.map(s => ({
    title: s.request_number,
    sub: [s.change_type_label || s.change_type, s.status_label || s.status,
      s.booking_request_number].filter(Boolean).join(' · '),
    value: '',
  }));
  clAsSay('bot', '', {
    card: clAsCard('Your service requests', clAsRows(rows), [
      { label: 'Open Service Requests', go: 'service-request', primary: true },
    ]),
  });
}

async function clAsPassenger(params) {
  if (!params.passport) {
    clAsSay('bot', 'Give me the passport number and I will check whether that traveller '
      + 'is already saved on your account.');
    return;
  }
  /* PassengerLookupResponse is FLAT — the fields sit at the top level, and
     there is deliberately no `id` on it (that id would name a passenger row on
     someone else's booking). `found:false` is a successful answer, not a 404. */
  const p = await MerchantApi.lookupPassenger(params.passport);
  if (!p || !p.found) {
    clAsSay('bot', 'No saved traveller on your account matches that passport number. '
      + 'You can add them on the booking form.',
      { chips: [{ label: 'Raise a booking', go: 'booking-request', primary: true }] });
    return;
  }
  const body =
    '<div class="cl-as-rowitem-t">' + escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' ')) + '</div>'
    + '<div class="cl-as-sub">Passport ' + escapeHtml(p.passport_number || params.passport) + '</div>'
    + (p.nationality ? '<div class="cl-as-sub">' + escapeHtml(p.nationality) + '</div>' : '')
    + (p.passport_expiry ? '<div class="cl-as-sub">Expires ' + escapeHtml(fmtDate(p.passport_expiry)) + '</div>' : '');
  clAsSay('bot', '', {
    card: clAsCard('Saved traveller', body, [
      { label: 'Raise a booking', go: 'booking-request', primary: true },
    ]),
  });
}

/* ------------------------------------------------------------ escalation - */

function clAsOfferSupport() {
  clAsSay('bot', 'I can start a conversation with our partner desk for you. '
    + 'They will see everything you have asked me here.',
    { chips: [{ label: 'Start a conversation', escalate: true, primary: true },
      { label: 'Open Support Center', go: 'support' }] });
}

/* Hands the merchant into the EXISTING Support Center — the same threads the
   desk already works from, on service_requests + msg_logs. There is no second
   chat store and there must not be one: a conversation the desk cannot see is
   worse than no conversation. */
async function clAsEscalate() {
  if (CL_AS.busy) return;
  CL_AS.busy = true;
  clAsTyping(true);
  const asked = CL_AS.history.slice(-3);
  const opening = asked.length
    ? 'I was using the Partner Assistant and need a person. What I asked:\n\n'
      + asked.map(q => '- ' + q).join('\n')
    : 'I would like to speak to someone about my account.';
  try {
    await MerchantApi.openSupportThread({ message: opening });
    clAsTyping(false);
    clAsSay('bot', 'I have opened a conversation with our partner desk. '
      + 'You can carry on there.',
      { chips: [{ label: 'Open Support Center', go: 'support', primary: true }] });
    /* The Support Center caches its thread list, so it must be re-rendered or
       the merchant lands on a list without the conversation they just started. */
    clInvalidate('support');
  } catch (err) {
    clAsTyping(false);
    const code = err && err.response ? err.response.status : 0;
    if (code === 403) {
      clAsSay('bot', 'Your role cannot write to the partner desk. Ask a Manager or '
        + 'Supervisor in your company to raise it.');
    } else {
      clAsSay('bot', 'I could not open that conversation just now. '
        + 'You can start one from the Support Center.',
        { chips: [{ label: 'Open Support Center', go: 'support', primary: true }] });
    }
  } finally {
    CL_AS.busy = false;
  }
}
