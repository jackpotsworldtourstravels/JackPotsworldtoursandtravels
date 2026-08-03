'use strict';
/* Merchant Portal — Support Center.
   ===========================================================================
   A FULL-PAGE MESSAGING WORKSPACE, not a ticket form. Three columns: the
   merchant's conversations on the left, the conversation itself in the middle,
   and everything known about the open ticket on the right. It reads as
   WhatsApp / Slack / Intercom because that is what it is — a chat with the
   partner desk that happens to be recorded as a support ticket.

   WHAT THIS REPLACED, AND WHY THE OLD SHAPE WAS WRONG
   The previous screen led with five KPI tiles and three channel cards, put the
   conversation in a 560px box below them, and raised a ticket through a modal
   carrying five fields. A merchant with a problem had to scroll past analytics
   about their own ticket history and then fill in a form. The conversation is
   the product; everything else is furniture, and furniture does not go first.

   ZERO BACKEND CHANGE. Every call this file makes already existed:
   `app/routers/support_tickets.py` and the five MerchantApi support methods are
   untouched, as are the permissions (`chat.create` / `chat.view`) and the
   lifecycle (a merchant cannot claim or resolve its own ticket — only the desk
   can, and only reopening comes back to this side).

   WHAT IS REAL AND WHAT IS DERIVED — stated because a support screen that
   invents signals is a support screen nobody trusts:

   - REAL, from the API: the threads, every message with its direction and
     sender, `status` and its chat-specific label, `assigned_admin_name`,
     `priority`, `category`, the linked booking, `message_count`,
     `attachment_count`, `last_message_at`, `can_reopen`, the shared FILES, and
     the READ RECEIPT (`is_read` per message, set when the other side actually
     opens the thread). PNR, passenger and travel date come from
     `GET /api/requests/{id}` for the booking the ticket is linked to.
   - DERIVED, and labelled as such wherever it shows: the per-conversation
     UNREAD COUNT (see clScUnread — the list endpoint has no unread field);
     the "operator is responding" indicator (thread In Progress, claimed, and
     the last message is the merchant's); the Open/Waiting/Resolved/Closed
     split, which is the server's three statuses plus `can_reopen`; and
     online/offline, which is the published business-hours window and nothing
     more.

   TWO PUBLISHED FIGURES, ONE MEASURED AND ONE CONFIGURED. The header badge for
   average response is MEASURED across the merchant's own recent conversations
   (real elapsed time from their message to the desk's first answer) and falls
   back to CL_SUPPORT_TARGET only while that measurement is in flight or when
   nothing has been answered yet. Support hours are CL_SUPPORT_HOURS — change
   that one constant to `{ always: true }` and the badge reads 24×7 and the
   presence dot never goes dark.

   THERE IS NO WEBSOCKET, so "live" is a poll: every CL_SC_POLL_MS while the
   screen is open and the tab is visible. It stops on `document.hidden` and on
   leaving the screen — a background tab hammering an endpoint is how a portal
   gets rate-limited. */

const CL_SUPPORT_PHONE = '+91 40 3500 0000';
const CL_SUPPORT_WHATSAPP = '919000035000';           // digits only, for wa.me
const CL_SUPPORT_EMAIL = 'partners@jackpotsworldtours.com';
const CL_SUPPORT_ESCALATION = 'escalations@jackpotsworldtours.com';
const CL_SUPPORT_EMERGENCY = '+91 98490 00000';
const CL_SUPPORT_ADDRESS = 'JackPots World Tours & Travels, Road No. 36, Jubilee Hills, Hyderabad 500033, Telangana, India';

/* Published business hours, in local time. `days` is 0=Sunday. This drives the
   presence dot and the "Support hours" badge and NOTHING else — it is a
   published fact, not a guess at whether an operator is at their desk.
   Set `always: true` if the desk genuinely moves to 24×7; the badge, the dot
   and every "outside hours" string follow from it. */
const CL_SUPPORT_HOURS = {
  always: false,
  days: [1, 2, 3, 4, 5, 6], from: 9, to: 19,
  text: '09:00 – 19:00 IST, Mon–Sat',
};
/* Shown as the response badge only until the real measurement lands, and on an
   account with nothing answered yet to measure. It is labelled "Target" in that
   state rather than being passed off as an observation. */
const CL_SUPPORT_TARGET = 'Under 15 min';

const CL_SC_POLL_MS = 9000;
/* Client-side ceiling, checked before a file is read into memory for a preview.
   The server enforces its own cap while streaming and is the real authority —
   this exists so a 200 MB video fails instantly instead of after an upload. */
const CL_FILE_MAX_MB = 15;
/* EXACTLY what document_service.ALLOWED_CONTENT_TYPES accepts. Anything outside
   these four is a 415 from the server, so it is refused here with a sentence
   that explains it rather than after the upload. */
const CL_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/* Priority is READ here, never set. The merchant no longer states one when
   opening a conversation and cannot change it afterwards: the desk owns it
   through PATCH /api/support/threads/{id}/triage. This map is only how the
   value the desk chose is coloured in the details panel.

   THE CATEGORY AND PRIORITY PICKERS THAT USED TO LIVE HERE ARE GONE, along
   with the keyword table that pre-filled them. Filing a ticket is the desk's
   job — a merchant chasing a passenger at a counter should be typing, not
   deciding between "Booking" and "Ticket Issue". Category labels shown on this
   screen come from the server as `category_label` on the thread, so nothing
   here has to keep a copy of the eight values in step with chat_service. */
const CL_PRIORITY_TONE = { low: 'ok', normal: 'info', high: 'warn', urgent: 'err' };

/* --------------------------------------------------------------- state */

let clScThreads = [];          /* what the list currently shows (server result) */
let clScTotal = 0;
let clScOpenId = null;
let clScThread = null;
let clScMessages = [];
let clScDocs = [];
let clScFiles = [];            /* queued attachments; object URLs revoked on clear */
let clScFailed = [];           /* outgoing messages that failed, awaiting retry */
let clScTimer = null;
let clScTab = '';              /* '' | submitted | in_review | completed */
let clScQuery = '';            /* what is typed, filtered instantly */
let clScServerQuery = '';      /* what the server has actually been asked */
let clScSearching = false;
let clScSearchTimer = null;
let clScSeen = {};             /* threadId -> message_count when last opened */
let clScBooking = null;        /* the linked booking, for PNR / passenger / date */
let clScBookingFor = null;
let clScAtBottom = true;       /* is the log scrolled to the newest message? */
let clScAutoScroll = false;    /* a scroll THIS FILE started — see clScScrollToEnd */
let clScAutoScrollTimer = null;
let clScAvgReply = '';         /* measured, for the header badge */
let clFaqQuery = '';
/* Object URLs for attachment thumbnails, keyed by document id.
   WITHOUT THIS EVERY POLL RE-DOWNLOADED EVERY IMAGE. Thumbnails cannot be a
   plain `src` — the bytes come from an authenticated endpoint — so each one is
   fetched and turned into an object URL. The transcript re-renders on a 9s
   poll and the details column renders the same files again, which made a
   conversation with five photos pull ten files every nine seconds. A document
   is immutable once shared, so one fetch per id per session is enough. */
const clScThumbs = new Map();
/* What the open thread looked like at the last render — see clScSignature. */
let clScRendered = '';

/* ===================================================================== page */

function clInitSupport() {
  clScSeen = clScSeenLoad();
  /* The screen is being rebuilt, so the cached thumbnails belong to DOM that
     is about to be thrown away. Revoke before dropping them or a merchant who
     visits Support repeatedly leaks one blob per image per visit. */
  clScThumbs.forEach(url => URL.revokeObjectURL(url));
  clScThumbs.clear();
  clScRendered = '';

  $('cl-support').innerHTML = `
    <div class="cl-sc">

      <!-- ======================================================== header -->
      <!-- ONE ROW ABOVE THE CHAT, not three.
           This used to open with a full-width WhatsApp banner — icon, two lines
           of copy, both numbers and two buttons — and then a page title, and
           then a badge strip, before any conversation was visible. On a laptop
           the message box was below the fold on a screen whose whole purpose is
           to send a message.

           The urgent channels are not lost, only made proportionate: WhatsApp
           and the desk number are inline here, and the floating WhatsApp button
           below follows the merchant down the page. The 24-hour advice moved
           into the call link's tooltip, where it is read at the moment it
           matters rather than every time the screen opens. -->
      <header class="cl-sc-head">
        <div class="cl-sc-head-copy">
          <h1>Support Center</h1>
          <p>Chat with our travel support team in real time.</p>
        </div>
        <div class="cl-sc-head-live">
          <a class="cl-btn cl-btn-wa cl-btn-sm" target="_blank" rel="noopener" id="clScWa"
             href="${clScWaLink()}">${clIco('whatsapp', { size: 15 })} WhatsApp</a>
          <a class="cl-btn cl-btn-sm" href="tel:${CL_SUPPORT_PHONE.replace(/\s/g, '')}"
             title="Travelling inside 24 hours? Always call.">
            ${clIco('phone', { size: 14 })} ${escapeHtml(CL_SUPPORT_PHONE)}
          </a>
        </div>
        <div class="cl-sc-badges" id="clScBadges">${clScBadges()}</div>
      </header>

      <!-- ===================================================== workspace -->
      <div class="cl-sc-grid" id="clScGrid">

        <!-- ---- left: every conversation ---- -->
        <aside class="cl-sc-col cl-sc-side" aria-label="Your conversations">
          <div class="cl-sc-side-head">
            <div>
              <b>Conversations</b>
              <span id="clScCount">&nbsp;</span>
            </div>
            <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" id="clScNew"
              ${clActionAttrs('chat.create', CL_NO_CHAT)}>
              ${clIco('plus', { size: 14 })} New
            </button>
          </div>
          <div class="cl-sc-side-tools">
            <div class="cl-sc-search">
              ${clIco('search', { size: 15 })}
              <label class="cl-sr" for="clScSearch">Search your conversations</label>
              <input type="search" id="clScSearch" placeholder="Search conversations…"
                     autocomplete="off">
            </div>
            <!-- THE OPEN / ACTIVE / RESOLVED TABS ARE GONE. They asked the
                 merchant to think in the desk's states before they had said
                 anything, and a merchant with four conversations does not need
                 to filter them. Each card still shows its own status, resolved
                 threads still sort below live ones, and search still reaches
                 the server across every thread. -->
          </div>
          <div class="cl-sc-convs" id="clScConvs"></div>
        </aside>

        <!-- ---- centre: the conversation ---- -->
        <section class="cl-sc-col cl-sc-chat" aria-label="Conversation">
          <div class="cl-sc-chat-head" id="clScChatHead"></div>
          <div class="cl-sc-log-wrap">
            <div class="cl-sc-log" id="clScLog" role="log" aria-live="polite"
                 aria-label="Messages"></div>
            <button type="button" class="cl-sc-jump" id="clScJump" hidden>
              ${clIco('chevronDown', { size: 15 })} <span id="clScJumpText">Latest messages</span>
            </button>
          </div>
          <div class="cl-sc-foot" id="clScFoot"></div>
        </section>

        <!-- THE THIRD COLUMN IS ADMIN-ONLY NOW.
             It listed assigned team, handling operator, priority, category,
             booking number, PNR, passenger and travel date — a case file. Most
             of those are the DESK's working notes about the merchant's ticket,
             and reading them back to the merchant is what made this screen feel
             like a ticket system instead of a conversation. The Admin portal is
             where that panel belongs and where the controls behind it live.

             clScRenderInfo() is still called and simply no-ops without its
             host, so nothing had to be unpicked from the render path. -->
      </div>
    </div>

    <!-- The floating WhatsApp card. It coexists with the chat above rather
         than replacing it: WhatsApp is the desk's fastest channel, the thread
         is the recorded one, and a merchant is entitled to both. -->
    <a class="cl-sc-fab" id="clScFab" target="_blank" rel="noopener" href="${clScWaLink()}"
       aria-label="Chat with support on WhatsApp">
      ${clIco('whatsapp', { size: 25 })}
      <span>WhatsApp us</span>
    </a>

    <!-- The new-conversation drawer. NOT the old five-field modal: a message is
         the only thing required, and everything else is either optional or
         worked out from what was typed. -->
    <div class="cl-sc-drawer-back" id="clScDrawerBack"></div>
    <aside class="cl-sc-drawer" id="clScDrawer" role="dialog" aria-modal="true"
           aria-labelledby="clScDrawerTitle" hidden></aside>`;

  clScBindShell();
  clScRenderChatHead();
  clScRenderLog();
  clScRenderFoot();
  clScRenderInfo();

  document.addEventListener('visibilitychange', clScPollGuard);

  return Promise.all([clScLoadThreads(), clScMeasureReply()]);
}

/* ------------------------------------------------------------ desk hours */

/* Business hours. `getDay()` is 0=Sunday, matching CL_SUPPORT_HOURS.days. */
function clDeskOnline(now = new Date()) {
  if (CL_SUPPORT_HOURS.always) return true;
  return CL_SUPPORT_HOURS.days.includes(now.getDay())
    && now.getHours() >= CL_SUPPORT_HOURS.from
    && now.getHours() < CL_SUPPORT_HOURS.to;
}

function clScHoursText() {
  return CL_SUPPORT_HOURS.always ? '24×7' : CL_SUPPORT_HOURS.text;
}

/* The three header badges: are we here, how fast do we answer, when are we
   open. Re-rendered when the measurement lands. */
function clScBadges() {
  const online = clDeskOnline();
  const measured = !!clScAvgReply;
  return `
    <span class="cl-sc-badge ${online ? 'online' : ''}">
      <i></i>${online ? 'Online' : 'Outside hours'}
    </span>
    <span class="cl-sc-badge">
      <span class="cl-sc-badge-k">${measured ? 'Average response' : 'Target response'}</span>
      <b>${escapeHtml(measured ? clScAvgReply : CL_SUPPORT_TARGET)}</b>
    </span>
    <span class="cl-sc-badge">
      <span class="cl-sc-badge-k">Support hours</span>
      <b>${escapeHtml(clScHoursText())}</b>
    </span>`;
}

function clScWaPretty() {
  return `+${CL_SUPPORT_WHATSAPP.replace(/^(\d{2})(\d{5})(\d+)$/, '$1 $2 $3')}`;
}

/* The pre-filled WhatsApp message. It names the account so the desk knows who
   is writing before they ask, and quotes the open ticket when there is one so
   the two channels do not become two separate conversations. */
function clScWaLink(thread) {
  const company = localStorage.getItem(PARTNER_KEYS.companyName) || 'a partner';
  const ref = thread?.request_number ? ` about ticket ${thread.request_number}` : '';
  const text = encodeURIComponent(
    `Hello JackPots partner desk — this is ${company}${ref}. `);
  return `https://wa.me/${CL_SUPPORT_WHATSAPP}?text=${text}`;
}

/* ------------------------------------------------------------ page wiring */

function clScBindShell() {
  $('clScNew').addEventListener('click', () => clScOpenDrawer());

  /* SEARCH RUNS TWICE, ON PURPOSE.
     Instantly, over the threads already in hand, so the list responds to the
     keystroke — that is what "searching should filter instantly" means. Then,
     debounced, on the SERVER, which also matches message bodies and threads
     outside the loaded page. The server result is a superset, so the list only
     ever gains rows as it lands; the caption says a wider search is running so
     the difference is never a surprise. */
  $('clScSearch').addEventListener('input', e => {
    clScQuery = e.target.value.trim();
    clScRenderConvs();
    clearTimeout(clScSearchTimer);
    clScSearchTimer = setTimeout(() => {
      if (clScQuery === clScServerQuery) return;
      clScLoadThreads();
    }, 320);
  });

  $('clScTabs')?.querySelectorAll('[data-cl-sc-tab]').forEach(b =>
    b.addEventListener('click', () => {
      clScTab = b.dataset.clScTab;
      $('clScTabs').querySelectorAll('button').forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      clScLoadThreads();
    }));

  /* Optional chaining because the details column is admin-only and no longer
     rendered here — see the note where it used to be. */
  $('clScInfoClose')?.addEventListener('click', () => clScShowInfo(false));

  /* Auto-scroll only when the merchant is already at the newest message. If
     they have scrolled up to read something, a poll landing must not yank the
     log out from under them — the jump pill offers the trip back instead. */
  $('clScLog').addEventListener('scroll', () => {
    /* Ignore this file's own scrolling — see clScScrollToEnd. */
    if (clScAutoScroll) return;
    const log = $('clScLog');
    clScAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    clScUpdateJump();
  });
  $('clScJump').addEventListener('click', () => {
    clScAtBottom = true;
    clScScrollToEnd(true);
    clScUpdateJump();
  });
}

/* ======================================================== conversation list */

async function clScLoadThreads({ quiet = false } = {}) {
  const host = $('clScConvs');
  if (!host) return;
  if (!quiet && !clScThreads.length) {
    host.innerHTML = `<div class="cl-sc-conv" style="cursor:default">
      <span class="cl-skel cl-skel-line w60"></span>
      <span class="cl-skel cl-skel-line w80"></span></div>`.repeat(4);
  }

  clScServerQuery = clScQuery;
  clScSearching = !!clScQuery;
  try {
    const data = await MerchantApi.listSupportThreads({
      status: clScTab || undefined,
      q: clScQuery || undefined,
      pageSize: 50,
    });
    /* A slower response for an older search term must not overwrite a newer
       one — the request that comes back is only authoritative if the box still
       says what it was asked about. */
    if (clScServerQuery !== clScQuery) return;

    clScThreads = data.items || [];
    clScTotal = data.total ?? clScThreads.length;
    clScSearching = false;

    /* FIRST VISIT SEEDS THE SEEN MAP. Without this, switching a merchant with
       twenty historical threads onto a screen that tracks unread would light
       every one of them up as new. "Unread" here means new since you last had
       this screen open, which is what a chat sidebar badge means anywhere. */
    if (!Object.keys(clScSeen).length && clScThreads.length) {
      clScThreads.forEach(t => { clScSeen[t.id] = t.message_count || 0; });
      clScSeenSave();
    }

    clScRenderConvs();

    /* Land on the most recent conversation, so the middle column is never an
       empty box on a screen somebody opened because they need help. Only on a
       wide layout: on a phone the list IS the landing screen. */
    if (!clScOpenId && clScThreads.length && window.innerWidth > 900) {
      clScOpen(clScThreads[0].id);
    } else if (!clScOpenId) {
      clScRenderLog();
      clScRenderFoot();
    }
    clLoadSupportBadge();
  } catch (err) {
    clScSearching = false;
    host.innerHTML = `<div class="cl-msg cl-msg-err" style="margin:12px">${
      escapeHtml(clError(err, 'Could not load your conversations.'))}</div>`;
  }
}

/* The four statuses the cards speak in. The server has three; `can_reopen`
   splits the third, because a resolved ticket you can still reply to and one
   that is past the window are different things to a merchant. */
function clScStatus(t) {
  if (t.status === 'submitted') return { key: 'open', label: 'Open', tone: 'warn' };
  if (t.status === 'in_review') return { key: 'waiting', label: 'In progress', tone: 'info' };
  if (t.can_reopen) return { key: 'resolved', label: 'Resolved', tone: 'ok' };
  return { key: 'closed', label: 'Closed', tone: 'plain' };
}

/* HOW LONG THIS HAS BEEN WAITING. It sits beside priority, not instead of it:
   priority is what the ticket was filed as, this is what has happened to it
   since, and a merchant chasing an answer cares about the second one. */
function clScWaiting(t) {
  if (t.status === 'completed') return null;
  const hours = (Date.now() - new Date(t.last_message_at || t.created_at).getTime()) / 3600000;
  if (hours >= 48) return { text: `Waiting ${Math.floor(hours / 24)}d`, tone: 'err' };
  if (hours >= 8) return { text: `Waiting ${Math.floor(hours)}h`, tone: 'warn' };
  return null;
}

/* UNREAD IS DERIVED, AND THIS IS THE ONLY PLACE IT IS DECIDED.
   `ChatThreadResponse` carries no unread field and `/unread-count` answers for
   the account, not per thread — the only per-thread figure that would be exact
   is `is_read` on each message, and that costs one round trip per row. So:
   the count of messages on the thread now, minus the count it had when this
   merchant last opened it. The merchant's own sends update the stored figure
   immediately, so a message they just wrote is never counted as unread to
   themselves. */
function clScUnread(t) {
  const seen = clScSeen[t.id];
  if (seen == null) return 0;
  return Math.max(0, (t.message_count || 0) - seen);
}

function clScSeenKey() {
  const who = `${localStorage.getItem(PARTNER_KEYS.companyName) || ''}|${
    localStorage.getItem(PARTNER_KEYS.fullName) || ''}`;
  return `cl_sc_seen_v1:${who}`;
}
function clScSeenLoad() {
  try { return JSON.parse(localStorage.getItem(clScSeenKey())) || {}; } catch { return {}; }
}
function clScSeenSave() {
  try { localStorage.setItem(clScSeenKey(), JSON.stringify(clScSeen)); } catch { /* quota */ }
}
function clScMarkSeen(id, count) {
  if (id == null) return;
  clScSeen[id] = count ?? 0;
  clScSeenSave();
}

/* The instant filter. It runs over what is already loaded and matches the
   fields a card SHOWS — subject, reference, booking reference, preview. The
   server search is wider (it reads every message body) and replaces this list
   when it lands. */
function clScVisible() {
  const q = clScQuery.toLowerCase();
  if (!q || clScQuery === clScServerQuery) return clScThreads;
  return clScThreads.filter(t => [
    t.title, t.request_number, t.related_request_number,
    t.category_label, t.status_label, t.last_message_preview,
  ].filter(Boolean).join(' ').toLowerCase().includes(q));
}

function clScRenderConvs() {
  const host = $('clScConvs');
  if (!host) return;
  const rows = clScVisible();
  const narrowed = clScTab || clScQuery;

  $('clScCount').textContent = clScQuery
    ? `${rows.length} matching`
    : clScTotal
      ? `${clScTotal} total`
      : '';

  if (!rows.length) {
    host.innerHTML = `<div class="cl-sc-blank">
      <span class="cl-sc-blank-ico">${clIco(narrowed ? 'search' : 'chat', { size: 22 })}</span>
      <b>${narrowed ? 'Nothing matches' : 'No conversations yet'}</b>
      <p>${clScQuery
        ? `Nothing mentions “${escapeHtml(clScQuery)}”.${clScSearching ? '' : ' The search covers subjects, references and everything said.'}`
        : narrowed
          ? 'Clear the filter — your other conversations are still there.'
          : 'Start one and it becomes a tracked ticket you can come back to.'}</p>
      ${clScSearching ? '<span class="cl-sc-searching"><span class="cl-spin"></span> Searching every message…</span>' : ''}
    </div>`;
    return;
  }

  host.innerHTML = (clScSearching
    ? '<div class="cl-sc-searching"><span class="cl-spin"></span> Searching every message…</div>'
    : '') + rows.map(clScConvCard).join('');

  host.querySelectorAll('[data-cl-sc-conv]').forEach(el => {
    el.addEventListener('click', () => clScOpen(el.dataset.clScConv));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clScOpen(el.dataset.clScConv); }
    });
  });
}

function clScConvCard(t) {
  const status = clScStatus(t);
  const waiting = clScWaiting(t);
  const unread = clScUnread(t);
  const active = String(t.id) === String(clScOpenId);
  /* Normal is the default the server applies when nobody chose, so a chip
     reading "Normal" would sit on nearly every card and turn the one that says
     Urgent into just more grey. Only a deviation is worth the ink. */
  const priority = t.priority && t.priority !== 'normal' ? t.priority : '';

  return `<div class="cl-sc-conv${active ? ' active' : ''}${unread ? ' unread' : ''}"
       data-cl-sc-conv="${t.id}" role="button" tabindex="0"
       aria-label="${escapeHtml(`${t.title || 'Conversation'}, ${status.label}${unread ? `, ${unread} unread` : ''}`)}">
    <span class="cl-sc-conv-av" aria-hidden="true">${clIco('headset', { size: 16 })}</span>
    <div class="cl-sc-conv-main">
      <div class="cl-sc-conv-top">
        <b>${escapeHtml(t.title || 'Conversation')}</b>
        <time>${escapeHtml(clScShortTime(t.last_message_at || t.created_at))}</time>
      </div>
      <div class="cl-sc-conv-ref">
        <span class="cl-ref">${escapeHtml(t.request_number || '')}</span>
        ${t.related_request_number
          ? `<span class="cl-sc-dot"></span><span class="cl-sc-book">${clIco('ticket', { size: 11 })} ${
              escapeHtml(t.related_request_number)}</span>` : ''}
      </div>
      <p class="cl-sc-conv-last">${escapeHtml(clScPreview(t))}</p>
      <div class="cl-sc-conv-foot">
        <span class="cl-tag cl-tag-${status.tone}">${escapeHtml(status.label)}</span>
        ${priority ? `<span class="cl-tag cl-tag-${CL_PRIORITY_TONE[priority] || 'info'}">${
          escapeHtml(clLabel(priority))}</span>` : ''}
        ${waiting ? `<span class="cl-tag cl-tag-${waiting.tone} cl-tag-plain">${
          escapeHtml(waiting.text)}</span>` : ''}
        ${t.attachment_count ? `<span class="cl-sc-clip">${clIco('paperclip', { size: 11 })}${
          t.attachment_count}</span>` : ''}
        ${unread ? `<span class="cl-sc-unread">${unread > 9 ? '9+' : unread}</span>` : ''}
      </div>
    </div>
  </div>`;
}

/* The card's one-line preview. The list endpoint carries no message body, so
   this describes the conversation from what it DOES carry rather than showing
   a blank line or fetching fifty threads to fill it in. */
function clScPreview(t) {
  if (String(t.id) === String(clScOpenId) && clScMessages.length) {
    const last = clScMessages[clScMessages.length - 1];
    const text = (last.message || '').replace(/\s+/g, ' ').trim();
    if (text) return `${clScIsMine(last) ? 'You: ' : ''}${text}`;
  }
  const n = t.message_count || 0;
  const parts = [`${n} message${n === 1 ? '' : 's'}`];
  if (t.category_label) parts.push(t.category_label);
  if (t.assigned_admin_name) parts.push(`with ${t.assigned_admin_name}`);
  else if (t.status === 'submitted') parts.push('not yet picked up');
  return parts.join(' · ');
}

/* Sidebar timestamps are relative near the present and absolute past it —
   "14:32" says nothing useful about something from March. */
function clScShortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(iso);
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now - d < 7 * 86400000) return d.toLocaleDateString('en-IN', { weekday: 'short' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/* ========================================================= open a thread */

async function clScOpen(id, { quiet = false } = {}) {
  if (!quiet) {
    clScOpenId = String(id);
    clScFailed = [];
    clScAtBottom = true;
    clScRenderConvs();
    clScRenderChatHead();
    clScRenderFoot();
    $('clScLog').innerHTML = `<div class="cl-sc-loading"><span class="cl-spin cl-spin-lg"></span></div>`;
    /* On a phone the grid shows one column at a time: opening a conversation
       swaps the list out for the chat, and the back control swaps it in. */
    $('clScGrid').classList.add('chatting');
  }

  try {
    const data = await MerchantApi.getSupportThread(id);
    /* A poll that lands after the user has switched threads must not paint the
       old conversation over the new one. */
    if (String(data.thread.id) !== String(clScOpenId)) return;

    const hadMessages = clScMessages.length;
    clScThread = data.thread;
    clScMessages = data.messages || [];
    clScDocs = data.documents || [];

    /* The unread divider needs to know where the merchant had got to BEFORE
       this open marked everything seen, so it is read first. */
    const seenBefore = clScSeen[clScOpenId];
    clScMarkSeen(clScOpenId, clScMessages.length);

    /* Keep the row in the sidebar in step with what the detail just said —
       status, message count and the preview all move without a second list
       call. */
    const row = clScThreads.find(t => String(t.id) === String(clScOpenId));
    if (row) {
      row.status = clScThread.status;
      row.status_label = clScThread.status_label;
      row.can_reopen = clScThread.can_reopen;
      row.message_count = clScMessages.length;
      row.attachment_count = clScDocs.length;
      row.assigned_admin_name = clScThread.assigned_admin_name;
      row.last_message_at = clScThread.last_message_at || row.last_message_at;
    }

    /* A QUIET POLL THAT BROUGHT NOTHING MUST NOT REDRAW THE TRANSCRIPT.
       Re-setting innerHTML every nine seconds throws away the user's text
       selection mid-copy and restarts every bubble's entrance animation, for a
       conversation that has not changed. The signature covers everything the
       transcript renders, so anything that would actually look different still
       redraws. */
    const signature = clScSignature();
    const changed = signature !== clScRendered;
    clScRendered = signature;

    if (!quiet || changed) {
      clScRenderChatHead();
      clScRenderLog({ dividerAfter: seenBefore });
      clScRenderFoot();
      clScRenderConvs();
      clScRenderInfo();
    }
    clScLoadBookingFacts();

    /* A poll that brought something new, on a screen already scrolled to the
       bottom, follows it down. OPENING lands at the bottom instantly — animating
       through a hundred messages to get there is a trip nobody asked for — and
       only the arrival of a message during a poll is worth a smooth scroll. */
    if (!quiet || clScAtBottom || clScMessages.length !== hadMessages) {
      clScScrollToEnd(quiet);
    }
    clScStartPoll();
  } catch (err) {
    $('clScLog').innerHTML = `<div class="cl-msg cl-msg-err" style="margin:auto;">${
      escapeHtml(clError(err, 'Could not open that conversation.'))}</div>`;
  }
}

/* Everything the transcript, its header and the details column draw from, in
   one string. Compared against the last render to decide whether a poll has
   anything to show. The read flags are in it because a receipt turning from
   one tick to two is a visible change with no new message behind it. */
function clScSignature() {
  const t = clScThread;
  if (!t) return '';
  return [
    t.id, t.status, t.assigned_admin, t.priority, t.category, t.can_reopen,
    clScDocs.length,
    clScMessages.length,
    clScMessages.map(m => `${m.id}${m.is_read ? '1' : '0'}`).join(','),
  ].join('|');
}

/* Whose message is this — mine, or the desk's?
   ---------------------------------------------------------------------------
   `direction` is written from the PLATFORM's point of view, not the reader's:
   `chat_service` stores a merchant's message as **inbound** (it came in to us)
   and a staff reply as **outbound** (it went out to them). Read literally in a
   merchant-facing screen that is exactly backwards, and it once was — both of
   the merchant's own messages rendered on the left, under the desk's name.

   So in THIS portal, "mine" is `inbound`. Anything else is the desk. */
function clScIsMine(m) {
  return String(m.direction || '').toLowerCase() === 'inbound';
}

/* ------------------------------------------------------------ chat header */

function clScRenderChatHead() {
  const head = $('clScChatHead');
  if (!head) return;
  const t = clScThread;

  if (!clScOpenId || !t) {
    head.innerHTML = `<div class="cl-sc-chat-id">
      <span class="cl-sc-av desk">${clIco('headset', { size: 17 })}</span>
      <div><b>Partner support desk</b><span>Choose a conversation, or start a new one</span></div>
    </div>`;
    return;
  }

  const status = clScStatus(t);
  const online = clDeskOnline();
  const resolved = t.status === 'completed';

  head.innerHTML = `
    <button type="button" class="cl-sc-back" id="clScBack" aria-label="Back to conversations">
      ${clIco('chevronRight', { size: 17 })}
    </button>
    <div class="cl-sc-chat-id">
      <span class="cl-sc-av desk">${clIco('headset', { size: 17 })}</span>
      <div>
        <b>${escapeHtml(t.title || 'Conversation')}</b>
        <span>
          <span class="cl-ref">${escapeHtml(t.request_number || '')}</span>
          <span class="cl-sc-dot"></span>
          ${escapeHtml(t.assigned_admin_name
            ? `with ${t.assigned_admin_name}`
            : resolved ? 'closed by our desk' : 'partner support desk')}
          <span class="cl-sc-dot"></span>
          <span class="cl-presence ${online && !resolved ? 'online' : ''}">${
            resolved ? 'Closed' : online ? 'Online' : 'Outside hours'}</span>
        </span>
      </div>
    </div>
    <div class="cl-sc-chat-tools">
      <span class="cl-tag cl-tag-${status.tone}">${escapeHtml(status.label)}</span>
      ${resolved && t.can_reopen
        ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" id="clScReopen"
             ${clActionAttrs('chat.create', CL_NO_CHAT)}>
             ${clIco('refresh', { size: 13 })} Reopen</button>` : ''}
      <button type="button" class="cl-btn cl-btn-sm" id="clScExport"
              title="Save this conversation as a PDF" aria-label="Save as PDF">
        ${clIco('download', { size: 14 })}</button>
      <button type="button" class="cl-btn cl-btn-sm" id="clScRefresh"
              aria-label="Refresh this conversation">${clIco('refresh', { size: 14 })}</button>
    </div>`;

  $('clScBack').addEventListener('click', () => {
    $('clScGrid').classList.remove('chatting');
  });
  $('clScRefresh').addEventListener('click', () => {
    clScOpen(clScOpenId);
    clScLoadThreads({ quiet: true });
  });
  $('clScExport').addEventListener('click', clScExportPdf);
  $('clScReopen')?.addEventListener('click', clScReopen);
}

function clScShowInfo(open) {
  $('clScInfo')?.classList.toggle('open', !!open);
}

/* Put a resolved ticket back in the desk's queue. The button only exists when
   the server said `can_reopen`, so this is not expected to 409 — but it still
   surfaces the message if it does, because the window can lapse between the
   render and the click. */
async function clScReopen() {
  const btn = $('clScReopen');
  if (!btn || !clScOpenId) return;
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    await MerchantApi.reopenSupportThread(clScOpenId);
    await clScOpen(clScOpenId);
    await clScLoadThreads({ quiet: true });
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('loading');
    clOpenModal('Could not reopen this ticket',
      `<div class="cl-msg cl-msg-err" style="margin-top:0">${
        escapeHtml(clError(err, 'This ticket could not be reopened.'))}</div>`,
      '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
  }
}

/* ============================================================= the transcript */

/* The line chat_service.attach_document posts for every upload. Matching it is
   what lets an attachment render as a file card inside the conversation rather
   than as the words "Shared a file: invoice.pdf". Kept in step with the server
   string — if that ever changes, the bubbles fall back to plain text rather
   than breaking, which is the right failure. */
const CL_FILE_MSG = /^Shared a file:\s*(.+)$/;

function clScRenderLog({ dividerAfter = null } = {}) {
  const log = $('clScLog');
  if (!log) return;

  /* ---- nothing chosen: the empty state the spec asks for ---- */
  if (!clScOpenId) {
    const none = !clScThreads.length;
    log.innerHTML = `<div class="cl-sc-empty">
      <span class="cl-sc-empty-art" aria-hidden="true">
        ${clIco('headset', { size: 46 })}
        <i></i><i></i>
      </span>
      <b>${none ? 'Need help?' : 'Pick a conversation'}</b>
      <p>${none
        ? 'Our travel team is here to assist you. Start your first conversation.'
        : 'Choose one from the list to read it, or start a new conversation.'}</p>
      <button type="button" class="cl-btn cl-btn-primary cl-btn-lg" id="clScEmptyCta"
        ${clActionAttrs('chat.create', CL_NO_CHAT)}>
        ${clIco('chat', { size: 16 })} Start conversation
      </button>
      <span class="cl-sc-empty-note">Typical first reply ${
        escapeHtml(clScAvgReply || CL_SUPPORT_TARGET)} · ${escapeHtml(clScHoursText())}</span>
    </div>`;
    $('clScEmptyCta').addEventListener('click', () => clScOpenDrawer());
    clScUpdateJump();
    return;
  }

  if (!clScMessages.length && !clScFailed.length) {
    log.innerHTML = '<div class="cl-sc-empty"><b>No messages yet</b></div>';
    return;
  }

  /* Each upload posts its own "Shared a file: NAME" line, and the documents
     arrive as a separate list. Pairing them by name and CONSUMING each match
     means two uploads of the same filename land on their own bubbles in order,
     rather than both pointing at the first document. */
  const unclaimed = [...clScDocs];
  const claimDoc = (text, mine) => {
    const match = CL_FILE_MSG.exec(text || '');
    if (!match) return null;
    const name = match[1].trim();
    /* `is_staff` is the uploader's side; `mine` is the merchant's. They are
       opposites, and matching on both stops a merchant's upload binding to an
       identically named file the desk sent back. */
    let i = unclaimed.findIndex(d => d.filename === name && d.is_staff === !mine);
    if (i < 0) i = unclaimed.findIndex(d => d.filename === name);
    if (i < 0) return null;
    return unclaimed.splice(i, 1)[0];
  };

  const me = clInitials(localStorage.getItem(PARTNER_KEYS.fullName) || 'You');
  /* The index of the last message I sent decides where the receipt goes. */
  let lastMine = -1;
  clScMessages.forEach((m, i) => { if (clScIsMine(m)) lastMine = i; });

  let lastDay = '';
  let lastSide = '';
  let dividerDone = dividerAfter == null;

  const html = clScMessages.map((m, i) => {
    const mine = clScIsMine(m);
    const day = new Date(m.created_at).toDateString();
    let block = '';

    if (day !== lastDay) {
      block += `<div class="cl-sc-day">${escapeHtml(clScDayLabel(m.created_at))}</div>`;
      lastDay = day;
      lastSide = '';
    }
    /* THE UNREAD DIVIDER, placed once, before the first message this merchant
       had not already seen — and never before their own, which they obviously
       have seen. */
    if (!dividerDone && i >= dividerAfter && !mine) {
      block += `<div class="cl-sc-newline"><span>New messages</span></div>`;
      dividerDone = true;
      lastSide = '';
    }

    const grouped = lastSide === (mine ? 'out' : 'in');
    lastSide = mine ? 'out' : 'in';
    const doc = claimDoc(m.message, mine);
    const pending = String(m.id).startsWith('pending-');

    block += `<div class="cl-sc-row ${mine ? 'out' : 'in'}${grouped ? ' grouped' : ''}">
      <span class="cl-sc-av ${mine ? 'me' : 'desk'}" aria-hidden="true">${
        grouped ? '' : mine ? escapeHtml(me) : clIco('headset', { size: 15 })}</span>
      <div class="cl-sc-bub-wrap">
        ${!grouped && !mine
          ? `<div class="cl-sc-who">${escapeHtml(m.sender_name || 'Partner desk')}</div>` : ''}
        <div class="cl-bubble ${mine ? 'out' : 'in'}">
          ${doc ? clScBubbleFile(doc) : escapeHtml(m.message || '')}
          <div class="cl-bubble-meta">
            ${escapeHtml(fmtTime(m.created_at))}
            ${mine ? (pending ? clScReceipt('sending') : i === lastMine
              ? clScReceipt(m.is_read ? 'read' : 'delivered') : '') : ''}
          </div>
        </div>
      </div>
    </div>`;
    return block;
  }).join('');

  /* Anything that failed to send stays in the transcript where it was typed,
     with the words still in it and a retry beside them. Losing a paragraph a
     merchant just wrote because the network blinked is the worst thing a
     support screen can do. */
  const failed = clScFailed.map((f, i) => `
    <div class="cl-sc-row out failed">
      <span class="cl-sc-av me" aria-hidden="true">${escapeHtml(me)}</span>
      <div class="cl-sc-bub-wrap">
        <div class="cl-bubble out">${escapeHtml(f.text)}
          <div class="cl-bubble-meta">Not sent</div>
        </div>
        <div class="cl-sc-retry">
          ${clIco('alert', { size: 13 })}
          <span>${escapeHtml(f.reason)}</span>
          <button type="button" data-cl-sc-retry="${i}">Retry</button>
          <button type="button" data-cl-sc-drop="${i}">Discard</button>
        </div>
      </div>
    </div>`).join('');

  /* "An operator is responding" — real state, not an invented presence ping:
     the thread is claimed, In Progress, and the last thing said was mine. */
  const responding = clScThread
    && clScThread.status === 'in_review'
    && clScThread.assigned_admin
    && lastMine === clScMessages.length - 1;

  log.innerHTML = html + failed + (responding
    ? `<div class="cl-sc-row in"><span class="cl-sc-av desk">${clIco('headset', { size: 15 })}</span>
         <div class="cl-typing" aria-label="An operator is working on your message">
           <i></i><i></i><i></i></div></div>` : '');

  clScBindBubbleFiles(log);
  log.querySelectorAll('[data-cl-sc-retry]').forEach(b =>
    b.addEventListener('click', () => clScRetry(Number(b.dataset.clScRetry))));
  log.querySelectorAll('[data-cl-sc-drop]').forEach(b =>
    b.addEventListener('click', () => {
      clScFailed.splice(Number(b.dataset.clScDrop), 1);
      clScRenderLog();
    }));
  clScUpdateJump();
}

/* A SMOOTH SCROLL FIRES `scroll` AT EVERY INTERMEDIATE POSITION, and the
   handler in clScBindShell reads those as "the reader has scrolled away" — so
   opening a conversation raised the jump-to-latest pill over a log that was on
   its way to the bottom anyway. The flag makes the handler ignore this file's
   own scrolling until it has settled. */
function clScScrollToEnd(smooth = false) {
  const log = $('clScLog');
  if (!log) return;
  clScAtBottom = true;
  clScUpdateJump();
  clScAutoScroll = true;
  clearTimeout(clScAutoScrollTimer);
  clScAutoScrollTimer = setTimeout(() => { clScAutoScroll = false; }, smooth ? 700 : 80);
  log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function clScUpdateJump() {
  const jump = $('clScJump');
  if (!jump) return;
  jump.hidden = clScAtBottom || !clScOpenId || !clScMessages.length;
}

/* Sending, delivered, read. `is_read` is the SERVER's receipt — set when the
   other side actually opens the thread — not a guess drawn from whether the
   ticket has been claimed. */
function clScReceipt(state) {
  if (state === 'sending') {
    return `<span class="cl-seen cl-seen-wait" aria-label="Sending"></span>`;
  }
  const read = state === 'read';
  return `<svg class="cl-seen${read ? ' read' : ''}" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"
       aria-label="${read ? 'Read' : 'Delivered'}">
    ${read
      ? '<polyline points="1 13 5 17 13 8"/><polyline points="10 13 14 17 23 6"/>'
      : '<polyline points="4 13 9 18 20 6"/>'}
  </svg>`;
}

function clScDayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* --------------------------------------------------------- files in a bubble */

/* An attachment is never a plain filename. Images carry a real thumbnail,
   everything else a typed card, and both offer preview and download. */
function clScBubbleFile(doc) {
  const image = (doc.content_type || '').startsWith('image/');
  const ext = (doc.filename.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
  return `<div class="cl-sc-att${image ? ' img' : ''}" data-cl-att="${doc.id}">
    ${image
      ? `<span class="cl-sc-att-thumb" data-cl-thumb="${doc.id}">${clIco('file', { size: 18 })}</span>`
      : `<span class="cl-file-ico">${escapeHtml(ext)}</span>`}
    <span class="cl-file-meta">
      <b>${escapeHtml(doc.filename)}</b>
      <span>${escapeHtml(clFileSize(doc.size_bytes))} · ${escapeHtml(image ? 'Image' : ext)}</span>
    </span>
    <span class="cl-sc-att-do">
      ${image ? `<button type="button" class="cl-btn cl-btn-sm" data-cl-doc-view="${doc.id}"
          aria-label="Preview ${escapeHtml(doc.filename)}">${clIco('eye', { size: 13 })}</button>` : ''}
      <button type="button" class="cl-btn cl-btn-sm" data-cl-doc-get="${doc.id}"
              aria-label="Download ${escapeHtml(doc.filename)}">${clIco('download', { size: 13 })}</button>
    </span>
  </div>`;
}

/* Downloads are authenticated, so an attachment can never be a plain href —
   the bytes are fetched with the bearer token and handed to the browser as an
   object URL, which is revoked once it has been used. Thumbnails go through the
   same path, which is why they are filled in after render rather than being
   `src`ed directly. */
function clScBindBubbleFiles(root) {
  const find = id => clScDocs.find(d => String(d.id) === String(id));

  /* Thumbnails come from the cache when they can, and populate it when they
     cannot. The URL is deliberately NOT revoked: it is held in clScThumbs for
     the life of the screen, which is the whole point — see the note there. */
  root.querySelectorAll('[data-cl-thumb]').forEach(async box => {
    const doc = find(box.dataset.clThumb);
    if (!doc) return;
    const paint = url => {
      if (box.isConnected) box.innerHTML = `<img src="${url}" alt="${escapeHtml(doc.filename)}">`;
    };
    if (clScThumbs.has(doc.id)) return paint(clScThumbs.get(doc.id));
    try {
      const url = await MerchantApi.downloadDocument(doc.id);
      clScThumbs.set(doc.id, url);
      paint(url);
    } catch {
      /* A thumbnail that will not load is not an error worth a dialog — the
         typed icon it already shows is a perfectly good fallback. */
    }
  });

  root.querySelectorAll('[data-cl-doc-get]').forEach(b =>
    b.addEventListener('click', async () => {
      const doc = find(b.dataset.clDocGet);
      if (!doc) return;
      b.disabled = true;
      try {
        const url = await MerchantApi.downloadDocument(doc.id);
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        /* Revoked on a delay — synchronously would cancel the download in some
           browsers before they have read the blob. */
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (err) {
        clOpenModal('Could not download that file',
          `<div class="cl-msg cl-msg-err" style="margin-top:0">${
            escapeHtml(clError(err, 'The file could not be fetched.'))}</div>`,
          '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
      } finally {
        b.disabled = false;
      }
    }));

  root.querySelectorAll('[data-cl-doc-view]').forEach(b =>
    b.addEventListener('click', async () => {
      const doc = find(b.dataset.clDocView);
      if (!doc) return;
      b.disabled = true;
      try {
        const url = await MerchantApi.downloadDocument(doc.id);
        clOpenModal(doc.filename,
          `<img src="${url}" alt="${escapeHtml(doc.filename)}"
                style="width:100%;border-radius:var(--cl-r-md);display:block;">`,
          `<a class="cl-btn" href="${url}" download="${escapeHtml(doc.filename)}">
             ${clIco('download', { size: 14 })} Download</a>
           <button type="button" class="cl-btn cl-btn-primary" onclick="clCloseModal()">Close</button>`);
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      } catch (err) {
        clOpenModal('Could not open that file',
          `<div class="cl-msg cl-msg-err" style="margin-top:0">${
            escapeHtml(clError(err, 'The file could not be fetched.'))}</div>`,
          '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
      } finally {
        b.disabled = false;
      }
    }));
}

/* ============================================================= the composer */

/* Quick-reply chips, the attachment tray and the message box. Re-rendered
   whenever the thread changes because everything in it — whether the box is
   writable, what the placeholder says — depends on the thread's status. */
function clScRenderFoot() {
  const foot = $('clScFoot');
  if (!foot) return;

  if (!clScOpenId || !clScThread) {
    foot.innerHTML = '';
    return;
  }

  const resolved = clScThread.status === 'completed';
  if (resolved) {
    foot.innerHTML = `<div class="cl-sc-closed">
      ${clIco('checkCircle', { size: 17 })}
      <div>
        <b>This conversation is resolved</b>
        <span>${clScThread.can_reopen
          ? 'Reopen it to keep talking, or start a new conversation.'
          : 'It is past the reopening window — start a new conversation to continue.'}</span>
      </div>
      <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" id="clScClosedCta"
        ${clActionAttrs('chat.create', CL_NO_CHAT)}>
        ${clScThread.can_reopen ? 'Reopen' : 'New conversation'}
      </button>
    </div>`;
    $('clScClosedCta').addEventListener('click', () =>
      clScThread.can_reopen ? clScReopen() : clScOpenDrawer());
    return;
  }

  /* THE QUICK-TOPICS ROW IS GONE from above the composer. It sat between the
     transcript and the message box on every open conversation, which is not
     something any messaging app the merchant already uses puts there — and its
     chips only pasted an opening line, which is worth less than the vertical
     space it cost on a laptop. The message box now sits directly under the
     last message, which is what makes this read as a chat. */
  foot.innerHTML = `
    <ul class="cl-files" id="clScFileList"></ul>
    <div class="cl-msg" id="clScFileMsg"></div>

    <div class="cl-sc-compose" id="clScCompose">
      <button type="button" class="cl-sc-cbtn" id="clScClip" aria-label="Attach a file">
        ${clIco('paperclip', { size: 18 })}
      </button>
      <button type="button" class="cl-sc-cbtn" id="clScEmojiBtn" aria-label="Insert an emoji"
              aria-haspopup="true" aria-expanded="false">☺</button>
      <div class="cl-emoji-pop" id="clScEmojiPop" role="menu" aria-label="Emoji"></div>
      <label class="cl-sr" for="clScInput">Your message</label>
      <textarea id="clScInput" rows="1" placeholder="Write a message…"></textarea>
      <button type="button" class="cl-sc-send" id="clScSend" disabled aria-label="Send message">
        ${clIco('send', { size: 18 })}
      </button>
      <input type="file" id="clScFileInput" multiple class="cl-sr"
             accept=".pdf,.jpg,.jpeg,.png,.webp">
    </div>
    <div class="cl-sc-hint">
      <span><b>Enter</b> to send · <b>Shift + Enter</b> for a new line</span>
      <span>PDF, JPG, PNG, WebP · up to ${CL_FILE_MAX_MB} MB each</span>
    </div>`;

  clScBindComposer();
  clScRenderFiles();
  clScUploadState();
}

function clScBindComposer() {
  const box = $('clScInput');
  const send = $('clScSend');
  const compose = $('clScCompose');

  /* A role that may not write to the desk still READS every thread — chat.view
     is in the merchant read floor (rbac.py) — so the conversation, the details
     column and the whole layout are unchanged and only the composer is inert.
     Disabling the textarea is enough for the send button: clScUploadState()
     already derives `send.disabled` from `box.disabled`. */
  if (!clCan('chat.create')) {
    box.disabled = true;
    box.placeholder = CL_NO_CHAT;
    box.title = CL_NO_CHAT;
    [$('clScClip'), $('clScEmojiBtn')].forEach(btn => {
      if (!btn) return;
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      btn.title = CL_NO_CHAT;
    });
  }

  /* Grow to fit, up to the CSS max-height. A one-line box for a paragraph of
     detail is how a support message ends up being three separate messages. */
  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 150)}px`;
    clScUploadState();
  });
  /* Enter sends, Shift+Enter is a newline — the convention every chat uses. */
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); clScSend(); }
  });
  send.addEventListener('click', clScSend);

  /* One file queue, two ways in. */
  const input = $('clScFileInput');
  $('clScClip').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { clScAddFiles([...input.files]); input.value = ''; });

  /* Drop anywhere on the composer, which is a much bigger target than a tray
     and is where a person's hand already is. */
  ['dragenter', 'dragover'].forEach(type => compose.addEventListener(type, e => {
    e.preventDefault(); compose.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(type => compose.addEventListener(type, e => {
    e.preventDefault();
    if (type === 'dragleave' && compose.contains(e.relatedTarget)) return;
    compose.classList.remove('dragging');
  }));
  compose.addEventListener('drop', e => clScAddFiles([...(e.dataTransfer?.files || [])]));

  clScBindEmoji();
}

/* Send: the queued files first, then the typed message.

   THAT ORDER IS DELIBERATE. Each upload posts its own line into the transcript,
   so uploading first puts "Shared a file: proof.jpg" above the message that
   explains it — the order a person would have sent them in. Text last also
   means the merchant's own words are the most recent thing the operator sees
   when the notification arrives.

   Files upload ONE AT A TIME rather than through Promise.all: they share a
   thread whose transcript order is decided by insert order, and four concurrent
   uploads make that order arbitrary.

   A file that fails does not take the message with it, and a message that fails
   does not take its words with it — it drops into clScFailed with a retry. */
async function clScSend() {
  const box = $('clScInput');
  const send = $('clScSend');
  if (!box || !clScOpenId) return;
  const text = box.value.trim();
  const queued = clScFiles.filter(f => f.state !== 'done');
  if (!text && !queued.length) return;

  box.value = '';
  box.style.height = 'auto';
  send.disabled = true;
  box.disabled = true;

  /* Optimistic: the bubble appears immediately with a "sending" tick and the
     server's answer replaces the whole list a moment later. A support chat that
     pauses for a round trip before showing your own words feels broken.
     `inbound` is the merchant side — the optimistic bubble must carry the value
     the server will send back, or it would jump sides when the reply lands. */
  if (text) {
    clScMessages = [...clScMessages, {
      id: `pending-${Date.now()}`, direction: 'inbound',
      message: text, created_at: new Date().toISOString(),
    }];
    clScRenderLog();
    clScScrollToEnd(true);
  }

  const failures = [];
  let latest = null;

  for (const entry of queued) {
    entry.state = 'uploading';
    clScRenderFiles();
    try {
      latest = await MerchantApi.uploadSupportDocument(clScOpenId, entry.file);
      entry.state = 'done';
    } catch (err) {
      entry.state = 'failed';
      failures.push(`${entry.file.name}: ${clError(err, 'could not be sent')}`);
    }
    clScRenderFiles();
  }

  try {
    if (text) latest = await MerchantApi.sendSupportMessage(clScOpenId, text);
    if (latest) clScAdopt(latest);

    /* Only the files that actually landed leave the tray. Anything that failed
       stays, so retrying is one click and not a re-selection. */
    clScFiles.filter(f => f.state === 'done').forEach(f => {
      if (f.url) URL.revokeObjectURL(f.url);
    });
    clScFiles = clScFiles.filter(f => f.state !== 'done');

    clScRenderChatHead();
    clScRenderLog();
    clScRenderInfo();
    clScRenderFiles();
    clMsg($('clScFileMsg'), failures.join('. '), failures.length ? 'err' : '');
    clScScrollToEnd(true);
    clScLoadThreads({ quiet: true });
  } catch (err) {
    /* The words are not lost. The optimistic bubble is swapped for a failed one
       carrying the same text and a retry. */
    clScMessages = clScMessages.filter(m => !String(m.id).startsWith('pending-'));
    clScFailed.push({ text, reason: clError(err, 'Message not sent.') });
    clScRenderLog();
    if (queued.some(f => f.state === 'done')) {
      clMsg($('clScFileMsg'),
        'Your files were attached to the conversation — only the message failed.', 'info');
    }
  } finally {
    box.disabled = false;
    clScUploadState();
    box.focus();
  }
}

/* Retry a message that failed. It goes back through the same path as a fresh
   one, so a second failure lands it back in the list rather than vanishing. */
async function clScRetry(index) {
  const entry = clScFailed[index];
  if (!entry || !clScOpenId) return;
  clScFailed.splice(index, 1);
  clScMessages = [...clScMessages, {
    id: `pending-${Date.now()}`, direction: 'inbound',
    message: entry.text, created_at: new Date().toISOString(),
  }];
  clScRenderLog();
  clScScrollToEnd(true);
  try {
    clScAdopt(await MerchantApi.sendSupportMessage(clScOpenId, entry.text));
    clScRenderChatHead();
    clScRenderLog();
    clScRenderInfo();
    clScScrollToEnd(true);
    clScLoadThreads({ quiet: true });
  } catch (err) {
    clScMessages = clScMessages.filter(m => !String(m.id).startsWith('pending-'));
    clScFailed.push({ text: entry.text, reason: clError(err, 'Message not sent.') });
    clScRenderLog();
  }
}

/* Take a ChatThreadDetailResponse as the new truth for the open thread, and
   mark everything in it seen — the merchant is looking straight at it. */
function clScAdopt(detail) {
  if (!detail?.thread) return;
  clScThread = detail.thread;
  clScMessages = detail.messages || [];
  clScDocs = detail.documents || [];
  clScMarkSeen(clScThread.id, clScMessages.length);
  /* Every caller redraws immediately after this, so record the signature here
     rather than leaving the next poll to discover a change it has already
     drawn. */
  clScRendered = clScSignature();
}

/* ------------------------------------------------------------------ emoji */

const CL_EMOJI = ['👍', '🙏', '✅', '❌', '⚠️', '🙂', '😊', '😅',
  '✈️', '🧳', '🎫', '📄', '📎', '💳', '🕒', '📞',
  '🔴', '🟠', '🟢', '❗', '❓', '💡', '🔁', '🎯'];

function clScBindEmoji() {
  const pop = $('clScEmojiPop');
  const btn = $('clScEmojiBtn');
  if (!pop || !btn) return;
  pop.innerHTML = CL_EMOJI.map(e =>
    `<button type="button" role="menuitem" aria-label="${escapeHtml(e)}">${e}</button>`).join('');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = pop.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  pop.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const box = $('clScInput');
    /* Insert at the caret rather than appending: a person adding an emoji
       mid-sentence should not have it land at the end. */
    const at = box.selectionStart ?? box.value.length;
    box.value = box.value.slice(0, at) + b.textContent + box.value.slice(box.selectionEnd ?? at);
    box.focus();
    box.selectionStart = box.selectionEnd = at + b.textContent.length;
    box.dispatchEvent(new Event('input'));
    pop.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', clScEmojiOutside);
}

function clScEmojiOutside(e) {
  const pop = $('clScEmojiPop');
  const btn = $('clScEmojiBtn');
  if (!pop || !btn) return;
  if (!e.target.closest('#clScEmojiPop') && !e.target.closest('#clScEmojiBtn')) {
    pop.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
}

/* ------------------------------------------------------------- attachments */

function clFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* WHERE THE FILE QUEUE IS CURRENTLY DRAWN.
   The composer owns these ids. The "start a conversation" drawer offers the
   same optional attachment before a thread exists, and borrows the same queue
   rather than growing a second copy of the validation, the thumbnails and the
   remove button. Only one of the two is ever open, so one queue is enough —
   `clScOpenDrawer` points this at its own ids and `clScCloseDrawer` puts it
   back. Without the indirection both would answer to getElementById and the
   composer's list, being first in the document, would win. */
let clScFileIds = { list: 'clScFileList', msg: 'clScFileMsg' };

/* Validation happens here rather than only on `accept`, which is a hint a user
   can walk straight past in the file dialog. The server still checks the BYTES,
   so a .exe renamed to .pdf passes this and is refused there — that is the
   check that matters and it is deliberately not guessed at here. */
function clScAddFiles(files) {
  const rejected = [];
  files.forEach(file => {
    if (file.size > CL_FILE_MAX_MB * 1048576) {
      rejected.push(`${file.name} is ${clFileSize(file.size)} — over the ${CL_FILE_MAX_MB} MB limit`);
      return;
    }
    if (file.type && !CL_FILE_TYPES.includes(file.type)) {
      rejected.push(`${file.name} is not a PDF, JPG, PNG or WebP`);
      return;
    }
    if (clScFiles.some(f => f.file.name === file.name && f.file.size === file.size)) return;
    clScFiles.push({
      file,
      url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      state: 'queued',
    });
  });

  clMsg($(clScFileIds.msg), rejected.join('. '), rejected.length ? 'err' : '');
  clScRenderFiles();
  clScUploadState();
}

function clScRenderFiles() {
  const list = $(clScFileIds.list);
  if (!list) return;
  if (!clScFiles.length) { list.innerHTML = ''; return; }

  const STATE = { queued: 'ready to send', uploading: 'sending…', done: 'sent', failed: 'not sent' };
  list.innerHTML = clScFiles.map(f => {
    const ext = (f.file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
    const busy = f.state === 'uploading';
    return `<li class="cl-file${f.state === 'failed' ? ' failed' : ''}">
      ${f.url
        ? `<img class="cl-file-thumb" src="${f.url}" alt="Preview of ${escapeHtml(f.file.name)}">`
        : `<span class="cl-file-ico">${escapeHtml(ext)}</span>`}
      <span class="cl-file-meta">
        <b>${escapeHtml(f.file.name)}</b>
        <span>${escapeHtml(clFileSize(f.file.size))} · ${escapeHtml(STATE[f.state] || 'ready to send')}</span>
        ${busy ? '<span class="cl-progress cl-progress-idle" style="margin-top:6px;"><i></i></span>' : ''}
      </span>
      ${busy ? '' : `<button type="button" class="cl-btn cl-btn-sm cl-btn-danger"
              data-cl-sc-rm="${escapeHtml(f.file.name)}"
              aria-label="Remove ${escapeHtml(f.file.name)}">${clIco('x', { size: 13 })}</button>`}
    </li>`;
  }).join('');

  list.querySelectorAll('[data-cl-sc-rm]').forEach(b =>
    b.addEventListener('click', () => {
      const i = clScFiles.findIndex(f => f.file.name === b.dataset.clScRm);
      if (i < 0) return;
      if (clScFiles[i].url) URL.revokeObjectURL(clScFiles[i].url);
      clScFiles.splice(i, 1);
      clScRenderFiles();
      clScUploadState();
    }));
}

/* What the composer says about the queue. A queued file is worth sending on its
   own, so an empty box no longer means there is nothing to send. */
function clScUploadState() {
  /* The drawer's own send button, when the queue is being filled before any
     thread exists. A message is still required to OPEN a conversation — an
     attachment with no words gives the desk a file and no question. */
  const drawerGo = $('clScDrawerGo');
  if (drawerGo) {
    const typed = ($('clScNewMsg')?.value || '').trim();
    drawerGo.disabled = !typed;
  }

  const box = $('clScInput');
  const send = $('clScSend');
  const clip = $('clScClip');
  if (clip) {
    clip.classList.toggle('has-files', clScFiles.length > 0);
    clip.setAttribute('aria-label', clScFiles.length
      ? `Attach files — ${clScFiles.length} queued` : 'Attach a file');
  }
  if (box && send) {
    send.disabled = box.disabled || (!box.value.trim() && !clScFiles.length);
  }
}

/* ==================================================== the details column */

function clScRenderInfo() {
  const host = $('clScInfoBody');
  if (!host) return;
  const t = clScThread;

  if (!clScOpenId || !t) {
    host.innerHTML = clScHelpBlocks();
    clScBindHelp();
    return;
  }

  const status = clScStatus(t);
  const waiting = clScWaiting(t);
  const priority = t.priority || 'normal';
  const b = clScBooking;
  const linked = !!t.related_request_number;
  /* The booking facts are a second round trip and land after this renders, so
     each says which of the three states it is in rather than showing a blank. */
  const fact = value => linked
    ? (b ? (value || '<span class="cl-muted">Not recorded</span>')
        : '<span class="cl-muted">Loading…</span>')
    : '<span class="cl-muted">—</span>';

  const passenger = b && (b.passengers || []).length
    ? (() => {
        const p = b.passengers[0];
        const name = [p.title, p.first_name, p.last_name].filter(Boolean).join(' ');
        const more = b.passengers.length - 1;
        return escapeHtml(name) + (more > 0 ? ` <span class="cl-muted">+${more} more</span>` : '');
      })()
    : null;

  const rows = [
    ['Ticket number', `<span class="cl-ref">${escapeHtml(t.request_number || '—')}</span>`],
    ['Status', `<span class="cl-tag cl-tag-${status.tone}">${escapeHtml(status.label)}</span>${
      waiting ? ` <span class="cl-tag cl-tag-${waiting.tone} cl-tag-plain">${
        escapeHtml(waiting.text)}</span>` : ''}`],
    ['Created on', escapeHtml(fmtDateTime(t.created_at))],
    ['Last updated', escapeHtml(fmtDateTime(t.last_message_at || t.created_at))],
    /* "Team" is the partner support desk — the platform has one, and the
       category is the queue inside it. The named operator is shown separately
       because "assigned to a team" and "assigned to a person" are different
       promises and only the second one has a name behind it. */
    ['Assigned team', `Partner support desk${t.category_label
      ? ` <span class="cl-muted">· ${escapeHtml(t.category_label)}</span>` : ''}`],
    ['Handled by', t.assigned_admin_name
      ? escapeHtml(t.assigned_admin_name)
      : t.assigned_admin ? 'An operator'
        : '<span class="cl-muted">Not yet picked up</span>'],
    ['Priority', `<span class="cl-tag cl-tag-${CL_PRIORITY_TONE[priority] || 'info'}">${
      escapeHtml(clLabel(priority))}</span>`],
    ['Category', t.category_label
      ? `<span class="cl-tag cl-tag-plain">${escapeHtml(t.category_label)}</span>`
      : '<span class="cl-muted">Not categorised</span>'],
    ['Booking number', linked
      ? `<span class="cl-ref">${escapeHtml(t.related_request_number)}</span>`
      : '<span class="cl-muted">Not linked to a booking</span>'],
    ['PNR', fact(b?.pnr ? `<span class="cl-ref">${escapeHtml(b.pnr)}</span>` : null)],
    ['Passenger', fact(passenger)],
    ['Travel date', fact(b?.travel_date ? escapeHtml(fmtDate(b.travel_date)) : null)],
    ['Messages', String(t.message_count ?? clScMessages.length)],
    ['Files shared', clScDocs.length ? String(clScDocs.length) : '<span class="cl-muted">None</span>'],
  ];

  host.innerHTML = `
    <section class="cl-sc-card">
      <h3>${clIco('info', { size: 15 })} Ticket information</h3>
      <dl class="cl-dl cl-dl-1">
        ${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join('')}
      </dl>
      ${linked ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-block" id="clScGoBooking">
        ${clIco('external', { size: 13 })} Open booking</button>` : ''}
      <p class="cl-sc-note">Priority is triaged by our desk. What you set when you raise a ticket
        tells us how it looks from your side — anything with a passenger travelling inside 24 hours
        should go to the emergency line rather than wait here.</p>
    </section>

    ${clScDocs.length ? `<section class="cl-sc-card">
      <h3>${clIco('paperclip', { size: 15 })} Shared files</h3>
      <div class="cl-sc-atts" id="clScAtts">
        ${clScDocs.map(d => clScBubbleFile(d)).join('')}
      </div>
    </section>` : ''}

    ${clScHelpBlocks()}`;

  $('clScGoBooking')?.addEventListener('click', () => {
    const ref = t.related_request_number;
    clGo('requests', () => {
      const search = $('clReqSearch');
      if (!search) return;
      search.value = ref;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
  const atts = $('clScAtts');
  if (atts) clScBindBubbleFiles(atts);
  clScBindHelp();
}

/* PNR, passenger and travel date live on the BOOKING, not on the thread — the
   thread only carries the booking's id and number. One fetch per linked ticket,
   cached against the id so switching back and forth does not re-ask, and a
   failure just leaves the three rows saying "Not recorded". */
async function clScLoadBookingFacts() {
  const id = clScThread?.related_request_id;
  if (!id) { clScBooking = null; clScBookingFor = null; return; }
  if (clScBookingFor === id) return;
  clScBookingFor = id;
  clScBooking = null;
  try {
    const data = await MerchantApi.getRequest(id);
    if (clScBookingFor !== id) return;   /* switched threads mid-flight */
    clScBooking = data;
    clScRenderInfo();
  } catch {
    if (clScBookingFor !== id) return;
    clScBooking = {};                    /* asked and answered: stop saying "Loading" */
    clScRenderInfo();
  }
}

/* ---- help & contact, below the ticket facts ---- */

function clScHelpBlocks() {
  return `
    <section class="cl-sc-card">
      <h3>${clIco('help', { size: 15 })} Quick help</h3>
      <label class="cl-sr" for="clFaqSearch">Search the help centre</label>
      <input type="search" id="clFaqSearch" placeholder="Refunds, PNR, wallet, approval…">
      <div class="cl-faq" id="clFaqBody" style="margin-top:12px;"></div>
    </section>

    <section class="cl-sc-card">
      <h3>${clIco('building', { size: 15 })} Other ways to reach us</h3>
      <dl class="cl-dl cl-dl-1">
        <div><dt>Partner desk</dt>
          <dd><a href="tel:${CL_SUPPORT_PHONE.replace(/\s/g, '')}">${escapeHtml(CL_SUPPORT_PHONE)}</a></dd></div>
        <div><dt>WhatsApp</dt>
          <dd><a href="${clScWaLink(clScThread)}" target="_blank" rel="noopener">${
            escapeHtml(clScWaPretty())}</a></dd></div>
        <div><dt>Email</dt>
          <dd><a href="mailto:${CL_SUPPORT_EMAIL}">${escapeHtml(CL_SUPPORT_EMAIL)}</a></dd></div>
        <div><dt>Escalation</dt>
          <dd><a href="mailto:${CL_SUPPORT_ESCALATION}">${escapeHtml(CL_SUPPORT_ESCALATION)}</a></dd></div>
        <div><dt>Emergency — travelling today</dt>
          <dd><a href="tel:${CL_SUPPORT_EMERGENCY.replace(/\s/g, '')}">${escapeHtml(CL_SUPPORT_EMERGENCY)}</a></dd></div>
        <div><dt>Support hours</dt><dd>${escapeHtml(clScHoursText())}</dd></div>
        <div><dt>Office</dt><dd>${escapeHtml(CL_SUPPORT_ADDRESS)}</dd></div>
      </dl>
      <p class="cl-sc-note">Ticketing, date changes, cancellations and ancillaries are raised
        through <a href="#" data-cl-sc-srv>Service Requests</a> so they stay tracked against the
        booking. Use this screen for anything with no request behind it.</p>
    </section>`;
}

function clScBindHelp() {
  $('clFaqSearch')?.addEventListener('input', e => {
    clFaqQuery = e.target.value.trim().toLowerCase();
    clRenderFaq();
  });
  document.querySelector('[data-cl-sc-srv]')?.addEventListener('click', e => {
    e.preventDefault();
    clGo('service-request');
  });
  clRenderFaq();
}

/* ================================================= new conversation drawer */

/* A DRAWER, NOT A FORM. The old modal asked for a subject, a message, a
   category, a priority and a booking before it would open anything. Only the
   message is required here; the subject and the booking are optional, and the
   category and priority are WORKED OUT from what was typed and shown as a
   sentence the merchant can correct. */
/* ===========================================================================
   START A CONVERSATION — a message box, an optional attachment, and Send.
   ===========================================================================
   WHAT WAS TAKEN OUT, AND WHY.
   This drawer used to ask a merchant to file their own ticket before they had
   said what was wrong: quick-topic chips, a category picker seeded by keyword
   detection, a priority picker, a subject line and a booking reference. Every
   one of those is a decision about ROUTING, and routing is the desk's job. A
   merchant with a passenger stuck at a counter should be typing, not choosing
   between "Ticket issue" and "Booking".

   None of it is lost — it MOVED. Category and priority are set by the desk
   through PATCH /api/support/threads/{id}/triage, which the Admin portal now
   exposes; the server already titles a thread from the opening of the first
   message when no subject is sent (merchant-api.js: `subject` is optional).
   So the same fields end up populated, by the people who know the answer.

   The API call is unchanged apart from what it omits — still
   POST /api/support/threads with a `message`. */
function clScOpenDrawer() {
  const drawer = $('clScDrawer');
  const back = $('clScDrawerBack');

  /* A fresh queue, and pointed at this drawer's list rather than the
     composer's — see clScFileIds. */
  clScFiles.forEach(f => f.url && URL.revokeObjectURL(f.url));
  clScFiles = [];
  clScFileIds = { list: 'clScNewFileList', msg: 'clScNewFileMsg' };

  drawer.hidden = false;
  drawer.innerHTML = `
    <div class="cl-sc-drawer-head">
      <div>
        <h2 id="clScDrawerTitle">Start a conversation</h2>
        <p>Tell us what has happened. That alone opens a tracked ticket.</p>
      </div>
      <button type="button" class="cl-sc-x" id="clScDrawerX" aria-label="Close">
        ${clIco('x', { size: 17 })}
      </button>
    </div>

    <div class="cl-sc-drawer-body">
      <div class="cl-field">
        <label for="clScNewMsg">What can we help with?<span class="cl-req">*</span></label>
        <textarea id="clScNewMsg" maxlength="4000" style="min-height:170px;"
          placeholder="What has happened, what you expected, and what you need from us."></textarea>
      </div>

      <!-- The optional attachment. Uploaded AFTER the thread exists, because
           /documents is addressed to a thread id — see clScSubmitDrawer. -->
      <div class="cl-sc-newfiles">
        <button type="button" class="cl-btn cl-btn-sm" id="clScNewClip">
          ${clIco('paperclip', { size: 15 })} Attach a file
        </button>
        <small>PDF, JPG, PNG or WebP · up to ${CL_FILE_MAX_MB} MB — optional</small>
        <input type="file" id="clScNewFile" multiple hidden
               accept="${CL_FILE_TYPES.join(',')}">
        <ul class="cl-files" id="clScNewFileList"></ul>
        <div class="cl-msg" id="clScNewFileMsg"></div>
      </div>

      <div class="cl-msg" id="clScNewMsgErr"></div>
    </div>

    <div class="cl-sc-drawer-foot">
      <button type="button" class="cl-btn" id="clScDrawerCancel">Cancel</button>
      <button type="button" class="cl-btn cl-btn-primary" id="clScDrawerGo" disabled
        ${clActionAttrs('chat.create', CL_NO_CHAT)}>
        ${clIco('send', { size: 15 })} Send
      </button>
    </div>`;

  requestAnimationFrame(() => {
    drawer.classList.add('open');
    back.classList.add('open');
    $('clScNewMsg').focus();
  });
  document.body.style.overflow = 'hidden';

  $('clScNewMsg').addEventListener('input', clScUploadState);
  /* Ctrl/Cmd+Enter sends, the same chord the composer uses. */
  $('clScNewMsg').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') clScSubmitDrawer();
  });

  $('clScNewClip').addEventListener('click', () => $('clScNewFile').click());
  $('clScNewFile').addEventListener('change', e => {
    clScAddFiles([...e.target.files]);
    e.target.value = '';
  });

  $('clScDrawerX').addEventListener('click', clScCloseDrawer);
  $('clScDrawerCancel').addEventListener('click', clScCloseDrawer);
  back.addEventListener('click', clScCloseDrawer);
  document.addEventListener('keydown', clScDrawerEsc);
  $('clScDrawerGo').addEventListener('click', clScSubmitDrawer);
  clScUploadState();
}

function clScDrawerEsc(e) {
  if (e.key === 'Escape') clScCloseDrawer();
}

function clScCloseDrawer() {
  const drawer = $('clScDrawer');
  const back = $('clScDrawerBack');
  if (!drawer) return;
  drawer.classList.remove('open');
  back.classList.remove('open');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', clScDrawerEsc);
  /* Hand the file queue back to the composer. Leaving it pointed at the
     drawer's ids would leave the composer's paperclip drawing into elements
     that were just removed from the document. */
  clScFileIds = { list: 'clScFileList', msg: 'clScFileMsg' };
  setTimeout(() => { drawer.hidden = true; drawer.innerHTML = ''; }, 240);
}

async function clScSubmitDrawer() {
  const message = $('clScNewMsg').value.trim();
  const err = $('clScNewMsgErr');
  if (!message) {
    clMsg(err, 'Write a message — it is the only thing we need to open a ticket.', 'err');
    $('clScNewMsg').focus();
    return;
  }

  const btn = $('clScDrawerGo');
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    /* MESSAGE ONLY. No subject, category, priority or booking link is sent:
       the server titles the thread from this text, and the desk files it
       through /triage. See the note above clScOpenDrawer. */
    let data = await MerchantApi.openSupportThread({ message });

    /* The attachments, now that there is a thread to address them to —
       /documents is addressed to a thread id, so it cannot be part of the same
       call. A file that fails here must NOT lose the conversation that was
       already opened: the thread is real either way, so a failure is carried
       into it and reported there rather than thrown back at a drawer that is
       about to close. Each upload returns the WHOLE thread, so keeping the last
       response is what makes the files appear in the log without a re-fetch. */
    const queued = clScFiles.slice();
    const failed = [];
    if (queued.length) {
      clMsg(err, `Sending ${queued.length} file${queued.length === 1 ? '' : 's'}…`, '');
      for (const f of queued) {
        try {
          data = await MerchantApi.uploadSupportDocument(data.thread.id, f.file);
        } catch {
          failed.push(f.file.name);
        }
      }
    }
    clScFiles.forEach(f => f.url && URL.revokeObjectURL(f.url));
    clScFiles = [];

    clScCloseDrawer();

    clScOpenId = String(data.thread.id);
    clScAdopt(data);
    clScFailed = [];
    clScBookingFor = null;
    $('clScGrid').classList.add('chatting');
    clScRenderChatHead();
    clScRenderLog();
    clScRenderFoot();
    /* Said in the conversation that now exists, not in the drawer that just
       closed. The composer's file line is rendered by clScRenderFoot above, so
       this has to come after it. */
    if (failed.length) {
      clMsg($('clScFileMsg'),
        `Your message was sent, but ${failed.join(', ')} did not upload. `
        + 'Attach it again with the paperclip below.', 'err');
    }
    clScLoadBookingFacts();
    clScRenderInfo();
    clScScrollToEnd();
    await clScLoadThreads({ quiet: true });
    clScStartPoll();
  } catch (e2) {
    clMsg(err, clError(e2, 'Could not start the conversation.'), 'err');
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

/* ================================================================= polling */

/* AUTO-REFRESH. The open conversation is re-read, and so is the list — a reply
   on a thread the merchant is NOT looking at is exactly the case the unread
   badge and the reordered sidebar exist for. `clLoadUnreadCount` is the shell's
   own bell refresh: chat_service writes a real notification when the desk
   replies, so the bell increments from the server rather than from a number
   this file made up. */
function clScStartPoll() {
  clScStopPoll();
  clScTimer = setInterval(async () => {
    if (document.hidden || !$('cl-support')?.classList.contains('active')) return;
    const before = clScTotalUnread();
    if (clScOpenId && clScThread?.status !== 'completed') {
      await clScOpen(clScOpenId, { quiet: true });
    }
    await clScLoadThreads({ quiet: true });
    /* Only disturb the bell when something actually arrived. */
    if (clScTotalUnread() > before) {
      clLoadUnreadCount();
      clLoadSupportBadge();
    }
  }, CL_SC_POLL_MS);
}

function clScTotalUnread() {
  return clScThreads.reduce((n, t) => n + clScUnread(t), 0);
}

function clScStopPoll() {
  if (clScTimer) { clearInterval(clScTimer); clScTimer = null; }
}

function clScPollGuard() {
  if (document.hidden) clScStopPoll();
  else if ($('cl-support')?.classList.contains('active')) clScStartPoll();
}

/* ====================================================== measured response */

/* THE HEADER BADGE IS MEASURED, NOT PUBLISHED. Real elapsed time between the
   merchant's opening message and the desk's first answer, across their most
   recent conversations, whose messages are fetched for the purpose.

   `markRead: false` is load-bearing: this is a measurement, not the merchant
   opening anything. Without it, loading the Support Center would mark the
   desk's messages read on six threads and hand the operator a receipt nobody
   earned. Threads never answered are excluded rather than counted as instant. */
const CL_SC_SAMPLE = 6;

async function clScMeasureReply() {
  let sample = [];
  try {
    const recent = await MerchantApi.listSupportThreads({ pageSize: CL_SC_SAMPLE });
    sample = recent.items || [];
  } catch {
    return;                       /* the badge keeps the published target */
  }
  if (!sample.length) return;

  let gaps = [];
  try {
    const details = await Promise.all(
      sample.map(t => MerchantApi.getSupportThread(t.id, { markRead: false }).catch(() => null)));
    gaps = details.map(d => {
      const messages = d?.messages || [];
      const mine = messages.find(m => clScIsMine(m));
      if (!mine) return null;
      const reply = messages.find(m => !clScIsMine(m)
        && new Date(m.created_at) > new Date(mine.created_at));
      if (!reply) return null;
      return new Date(reply.created_at) - new Date(mine.created_at);
    }).filter(ms => ms != null && ms >= 0);
  } catch {
    return;
  }
  if (!gaps.length) return;

  clScAvgReply = clScDuration(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  const badges = $('clScBadges');
  if (badges) badges.innerHTML = clScBadges();
}

/* Milliseconds as the coarsest unit that still says something useful. */
function clScDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'Under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3600000;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hr`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/* ============================================================ PDF export */

/* The conversation as a document the merchant can file or forward.

   IT PRINTS RATHER THAN BUILDING A PDF BYTE STREAM. Every browser's print
   dialog offers "Save as PDF", and the alternative is a PDF library — a
   dependency to keep patched, for a button, in a portal whose whole icon set is
   inline SVG precisely to avoid one.

   It renders into a hidden same-document iframe, not a popup, because a popup
   is what a blocker eats. The iframe carries its own stylesheet: the portal's
   CSS is themeable, and a transcript printed in dark mode comes out as white
   text on paper. */
function clScExportPdf() {
  const t = clScThread;
  if (!t || !clScMessages.length) return;

  const company = localStorage.getItem(PARTNER_KEYS.companyName) || '';
  const me = localStorage.getItem(PARTNER_KEYS.fullName) || 'You';
  const status = clScStatus(t);
  const facts = [
    ['Ticket number', t.request_number || '—'],
    ['Status', status.label],
    ['Priority', clLabel(t.priority || 'normal')],
    ['Category', t.category_label || 'Not categorised'],
    ['Assigned team', 'Partner support desk'],
    ['Handled by', t.assigned_admin_name || 'Not yet picked up'],
    ['Booking number', t.related_request_number || 'Not linked'],
    ['Created on', fmtDateTime(t.created_at)],
    ['Last updated', fmtDateTime(t.last_message_at || t.created_at)],
    ['Messages', String(clScMessages.length)],
    ['Account', company || '—'],
    ['Exported', fmtDateTime(new Date().toISOString())],
  ];

  let lastDay = '';
  const body = clScMessages.map(m => {
    const mine = clScIsMine(m);
    const day = new Date(m.created_at).toDateString();
    let block = '';
    if (day !== lastDay) {
      lastDay = day;
      block += `<p class="day">${escapeHtml(clScDayLabel(m.created_at))}</p>`;
    }
    block += `<div class="msg ${mine ? 'out' : 'in'}">
      <p class="who">${escapeHtml(mine ? me : (m.sender_name || 'Partner desk'))}
        <span class="when">${escapeHtml(fmtTime(m.created_at))}</span></p>
      <p class="text">${escapeHtml(m.message || '')}</p>
    </div>`;
    return block;
  }).join('');

  const doc = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
    <title>${escapeHtml(`${t.request_number || 'Conversation'} — ${t.title || 'Support'}`)}</title>
    <style>
      @page{margin:16mm;}
      *{box-sizing:border-box;}
      body{font:12px/1.6 'Segoe UI',Arial,sans-serif; color:#0B2545; margin:0;}
      h1{font-size:19px; margin:0 0 2px;}
      .sub{font-size:12px; color:#5B6E88; margin:0 0 18px;}
      .brand{font-size:11px; font-weight:700; letter-spacing:.10em;
             text-transform:uppercase; color:#D2470B; margin:0 0 10px;}
      table.facts{width:100%; border-collapse:collapse; margin:0 0 22px;}
      table.facts td{padding:5px 0; vertical-align:top; border-bottom:1px solid #E3E9F1;}
      table.facts td.k{width:34%; color:#5B6E88; font-weight:600;}
      table.facts td.v{font-weight:600;}
      h2{font-size:13px; margin:0 0 10px; padding-bottom:6px; border-bottom:2px solid #0A2540;}
      .day{text-align:center; font-size:10px; font-weight:700; letter-spacing:.06em;
           text-transform:uppercase; color:#5B6E88; margin:16px 0 10px;}
      /* A transcript has to survive being read in black and white, so each side
         is told apart by its rule and its indent, not only by a tint. */
      .msg{margin:0 0 10px; padding:8px 12px; border-radius:8px;
           page-break-inside:avoid; break-inside:avoid;}
      .msg.in{background:#F4F6FA; border-left:3px solid #0A2540; margin-right:16%;}
      .msg.out{background:#FFF2EB; border-left:3px solid #D2470B; margin-left:16%;}
      .who{margin:0 0 3px; font-size:10.5px; font-weight:700; color:#0A2540;}
      .when{font-weight:600; color:#5B6E88; margin-left:6px;}
      .text{margin:0; white-space:pre-wrap;}
      footer{margin-top:24px; padding-top:10px; border-top:1px solid #E3E9F1;
             font-size:10px; color:#5B6E88;}
    </style></head><body>
    <p class="brand">JackPots World Tours &amp; Travels</p>
    <h1>${escapeHtml(t.title || 'Support conversation')}</h1>
    <p class="sub">Support conversation transcript${company ? ` · ${escapeHtml(company)}` : ''}</p>
    <table class="facts">${facts.map(([k, v]) =>
      `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(v)}</td></tr>`).join('')}</table>
    <h2>Conversation</h2>
    ${body}
    <footer>Exported from the JackPots Merchant Portal. This transcript is a record of the
      messages exchanged on this ticket and is not a tax document.</footer>
  </body></html>`;

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(frame);

  /* srcdoc so nothing is fetched and no object URL has to be revoked. The frame
     is torn down on a delay after print() returns — removing it synchronously
     cancels the dialog in some browsers. */
  frame.srcdoc = doc;
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      clOpenModal('Could not open the print dialog',
        `<p style="margin:0;font-size:14px;line-height:1.65;color:var(--cl-text-2);">
          Your browser would not open its print dialog, which is what saves this conversation as a
          PDF. Printing the page itself (Ctrl&nbsp;+&nbsp;P) produces the same transcript.</p>`,
        '<button type="button" class="cl-btn cl-btn-primary" id="clPrintFallbackOk">Close</button>');
      $('clPrintFallbackOk').addEventListener('click', clCloseModal);
    }
    setTimeout(() => frame.remove(), 1000);
  });
}

/* ================================================================== FAQ */

/* Written against what this product actually does. Every answer is checkable
   against a screen in this portal or a rule in the backend — a help centre that
   describes a generic travel platform is worse than none, because it teaches
   the merchant the wrong model. */
const CL_FAQ = [
  {
    cat: 'Booking',
    q: 'Why can I not book a fare directly?',
    a: 'Every booking starts as a Booking Enquiry. You tell us the sector, our desk confirms availability and quotes a fare, and only then can you turn it into a booking request. That is what guarantees the sector you book is one we have actually confirmed — and the quotation you accept is binding on both sides.',
  },
  {
    cat: 'Booking',
    q: 'My enquiry says "Available". What now?',
    a: 'Open it and press Raise Booking. That copies the whole journey from the enquiry into a draft booking — you only add the passengers. The itinerary cannot drift from what we answered, because you never re-type it.',
  },
  {
    cat: 'Booking',
    q: 'Where did my booking go after it was ticketed?',
    a: 'To Booking History. My Requests is a worklist and only holds what is still moving; anything ticketed, travelled, cancelled or closed lives in the archive, where you can search it by PNR, passenger, route or date and download the invoice and confirmation.',
  },
  {
    cat: 'Approvals',
    q: 'My request is stuck on "Under Manager Approval".',
    a: 'It has not reached us yet. Every service request goes to a manager at your own company first — they approve or reject it, and only then does our desk see it. Ask your manager; the request is on their Approvals screen.',
  },
  {
    cat: 'Approvals',
    q: 'Can I withdraw a request I raised by mistake?',
    a: 'No, and that is deliberate. Withdrawing pulled work out from under an operator who may already be on the phone to the airline, and left no record of who changed their mind. Your manager rejects it instead, with a reason the raiser can read.',
  },
  {
    cat: 'Payments',
    q: 'What is the difference between "Pending payments" and "Awaiting verification"?',
    a: 'Pending payments is money you owe — bookings sitting at a payment stage. Awaiting verification is money you have already sent that we have not yet confirmed. They move in opposite directions, so the dashboard shows them as two separate figures and never adds them together.',
  },
  {
    cat: 'Payments',
    q: 'I paid but the booking still says Payment Pending.',
    a: 'Recording a payment does not move the booking on its own — our finance desk verifies the transfer first, and the booking moves to Paid when they do. Adding your UTR or transaction reference when you record it is what makes that fastest.',
  },
  {
    cat: 'Wallet',
    q: 'My wallet balance is negative. Is that an error?',
    a: 'No. A negative wallet is simply what you owe. Tickets are charged to the wallet when they are issued, and you settle it by adding money. You can keep booking while it is negative, within whatever headroom your account carries.',
  },
  {
    cat: 'Wallet',
    q: 'I added money and the balance has not changed.',
    a: 'Submitting a top-up records a claim, not a credit. An admin verifies the transfer against the bank and the wallet moves then — until it does, the top-up shows as Awaiting verification and is deliberately not counted in your balance.',
  },
  {
    cat: 'Changes & refunds',
    q: 'How do I cancel a ticketed booking?',
    a: 'Service Requests → Cancellation. The airline\'s cancellation charge and the refund due are quoted by our desk when they settle it — they are never estimated in this portal, because the number is the airline\'s and not ours.',
  },
  {
    cat: 'Changes & refunds',
    q: 'Where do I see a refund?',
    a: 'On the cancellation that earned it, and as a credit on your wallet ledger. There is no separate "refunded" state on the booking itself — the booking is Cancelled, and the money is a movement on your account.',
  },
  {
    cat: 'Documents',
    q: 'Do I need to upload passports?',
    a: 'Not in the booking flow. Passport number and expiry are typed into the passenger form on an international sector because the airline needs them, but there is no document upload there. If we ask for a copy, attach it to a support conversation here — the paperclip in the message box takes PDF, JPG, PNG and WebP.',
  },
  {
    cat: 'Documents',
    q: 'Where is my e-ticket?',
    a: 'Booking History → the booking → Ticket. That is the airline\'s own file, attached by our desk once the ticket is issued. Confirmation is our own PDF and is always available; it is not an e-ticket.',
  },
  {
    cat: 'Account',
    q: 'How do I change my company details or GST number?',
    a: 'Those are not self-service — there is no merchant-facing endpoint for them. Write to the partner desk and our team will make the change against your account. Your own name, phone, address and password are all editable on Profile & Settings.',
  },
  {
    cat: 'Account',
    q: 'Someone has left our company. How do I remove their access?',
    a: 'Contact the partner desk. User accounts are created and closed by us so that a departure is recorded against your account rather than being a silent change nobody can audit.',
  },
];

function clRenderFaq() {
  const host = $('clFaqBody');
  if (!host) return;
  const rows = clFaqQuery
    ? CL_FAQ.filter(f => `${f.cat} ${f.q} ${f.a}`.toLowerCase().includes(clFaqQuery))
    : CL_FAQ;

  if (!rows.length) {
    host.innerHTML = `<div class="cl-sc-blank" style="padding:18px 4px;">
      <b>Nothing matches “${escapeHtml(clFaqQuery)}”</b>
      <p>Ask the desk directly — start a conversation and we will answer it, and add it here.</p>
    </div>`;
    return;
  }

  /* Grouped by category, in the order the categories first appear, so the list
     reads as a manual rather than as fifteen unrelated questions. */
  const cats = [...new Set(rows.map(f => f.cat))];
  host.innerHTML = cats.map(cat => `
    <div class="cl-faq-cat">${escapeHtml(cat)}</div>
    ${rows.filter(f => f.cat === cat).map((f, i) => `
      <div class="cl-faq-item${clFaqQuery && i === 0 ? ' open' : ''}">
        <button type="button" class="cl-faq-q" aria-expanded="${clFaqQuery && i === 0 ? 'true' : 'false'}">
          <span>${escapeHtml(f.q)}</span>
          <svg class="cl-faq-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="cl-faq-a"><div><p>${escapeHtml(f.a)}</p></div></div>
      </div>`).join('')}`).join('');

  host.querySelectorAll('.cl-faq-q').forEach(btn =>
    btn.addEventListener('click', () => {
      const item = btn.closest('.cl-faq-item');
      const open = item.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }));
}
