'use strict';
/* Merchant Portal — Support Center.
   ===========================================================================
   Live chat with the partner desk, the merchant's own conversation history,
   WhatsApp and phone, an attachment tray, a searchable knowledge base, and the
   contact block — one screen, because a merchant with a problem should not have
   to work out which of five places to raise it in.

   IT IS BACKED BY A REAL BACKEND. `app/routers/support_tickets.py` has existed
   for some time and, until this screen, nothing in the merchant portal called
   it. Threads are chat threads; the merchant opens one with a subject and a
   first message, both sides post messages into it, and an admin claims and
   resolves it. "Support tickets" and "live chat" are the SAME rows with two
   views — which is why this screen has one conversation list and not a ticket
   queue beside a chat window that would disagree with it.

   WHAT IS REAL AND WHAT IS DERIVED — stated because a support screen that
   invents signals is a support screen nobody trusts:

   - REAL, from the API: the threads, every message and its direction and
     sender name, `status` with its chat-specific label (Open / In Progress /
     Resolved), `assigned_admin`, `message_count`, `last_message_at`, and the
     count of threads awaiting a response.
   - DERIVED, and labelled as such: the read receipt (a single tick when the
     server has the message; a double tick once the thread has been claimed or
     an agent has replied after it — both are evidence someone has read it, not
     a `seen_at` column); the "agent is responding" indicator (shown when the
     thread is In Progress, an admin holds it, and the last message is the
     merchant's); and online/offline, which is the published business-hours
     window and nothing more.
   - NOT AVAILABLE, and therefore not faked: a per-thread PRIORITY field (the
     open-chat payload takes a subject and a message only) and FILE UPLOAD on
     this channel — `POST /api/requests/{id}/documents` accepts a merchant's
     upload only while the request is a DRAFT BOOKING (409 otherwise), and a
     chat thread is neither. The attachment tray below is therefore a real,
     working staging area — validation, preview, progress, removal — that hands
     the file list to the desk in the message and points at the two channels
     that genuinely accept a file. It does not pretend to upload.

   THERE IS NO WEBSOCKET, so "live" is a poll: every CL_CHAT_POLL_MS while a
   conversation is open and the tab is visible. Polling stops when the screen is
   left or the tab is hidden — a background tab hammering an endpoint every few
   seconds is how a portal ends up rate-limited. */

const CL_SUPPORT_PHONE = '+91 40 3500 0000';
const CL_SUPPORT_WHATSAPP = '919000035000';           // digits only, for wa.me
const CL_SUPPORT_EMAIL = 'partners@jackpotsworldtours.com';
const CL_SUPPORT_ESCALATION = 'escalations@jackpotsworldtours.com';
const CL_SUPPORT_EMERGENCY = '+91 98490 00000';
const CL_SUPPORT_ADDRESS = 'JackPots World Tours & Travels, Road No. 36, Jubilee Hills, Hyderabad 500033, Telangana, India';
/* Business hours, in local time. `days` is 0=Sunday. Used for the presence dot
   and nothing else — it is a published fact, not a guess at whether a
   particular operator happens to be at their desk. */
const CL_SUPPORT_HOURS = { days: [1, 2, 3, 4, 5, 6], from: 9, to: 19, text: '09:00 – 19:00 IST, Mon–Sat' };

const CL_CHAT_POLL_MS = 9000;
/* Client-side ceiling on a staged attachment. The desk's own limits apply on
   whichever channel actually carries the file; this stops a 200 MB video being
   read into memory for a preview. */
const CL_FILE_MAX_MB = 15;
const CL_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/zip',
  'application/x-zip-compressed', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

let clChatThreads = [];
let clChatOpenId = null;
let clChatMessages = [];
let clChatThread = null;
let clChatTimer = null;
let clChatFilter = '';
let clChatFiles = [];          /* staged attachments; object URLs revoked on clear */
let clFaqQuery = '';

/* ===================================================================== page */

function clInitSupport() {
  $('cl-support').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Support Center</h1>
        <p>Talk to the partner desk, track everything you have raised, and find the answer
           yourself if it is faster.</p>
      </div>
      <div class="cl-page-actions">
        <span class="cl-presence ${clDeskOnline() ? 'online' : ''}" id="clDeskPresence">
          ${clDeskOnline() ? 'Desk online' : 'Desk closed'}
        </span>
        <button type="button" class="cl-btn cl-btn-primary" id="clChatNew">
          ${clIco('chat', { size: 15 })} Start a conversation
        </button>
      </div>
    </div>

    <!-- ---- how your tickets stand ---- -->
    <div id="clSupportStats"></div>

    <!-- ---- the three channels ---- -->
    <div class="cl-grid-3" id="clSupportChannels">${clChannelCards()}</div>

    <!-- ---- conversations ---- -->
    <div class="cl-split">
      <div class="cl-panel" style="overflow:visible;">
        <div class="cl-chat" id="clChatPanel">
          <div class="cl-chat-head" id="clChatHead">
            <div>
              <b>Live chat</b>
              <span>Choose a conversation, or start a new one</span>
            </div>
            <div class="cl-panel-tools">
              <button type="button" class="cl-btn cl-btn-sm" id="clChatRefresh"
                      aria-label="Refresh this conversation">${clIco('refresh', { size: 14 })}</button>
            </div>
          </div>
          <div class="cl-chat-log" id="clChatLog" role="log" aria-live="polite" aria-label="Conversation"></div>
          <div class="cl-chat-compose" id="clChatCompose" style="position:relative;">
            <button type="button" class="cl-emoji-btn" id="clEmojiBtn" aria-label="Insert an emoji"
                    aria-haspopup="true" aria-expanded="false">☺</button>
            <div class="cl-emoji-pop" id="clEmojiPop" role="menu" aria-label="Emoji"></div>
            <label class="cl-sr" for="clChatInput">Your message</label>
            <textarea id="clChatInput" rows="1" placeholder="Write a message…" disabled></textarea>
            <button type="button" class="cl-chat-send" id="clChatSend" disabled aria-label="Send message">
              ${clIco('send', { size: 19 })}
            </button>
          </div>
        </div>
      </div>

      <div>
        <div class="cl-panel">
          <div class="cl-panel-head">
            <h2>${clIco('inbox')}Your tickets</h2>
            <div class="cl-panel-tools">
              <span class="cl-kpi-sub" id="clChatCount"></span>
            </div>
          </div>
          <div class="cl-panel-body" style="padding-bottom:12px;">
            <div class="cl-seg" id="clChatTabs" role="tablist">
              <button type="button" class="active" data-cl-chat-tab="" role="tab" aria-selected="true">All</button>
              <button type="button" data-cl-chat-tab="submitted" role="tab" aria-selected="false">Open</button>
              <button type="button" data-cl-chat-tab="in_review" role="tab" aria-selected="false">In progress</button>
              <button type="button" data-cl-chat-tab="completed" role="tab" aria-selected="false">Resolved</button>
            </div>
          </div>
          <div class="cl-panel-body cl-flush" style="padding:0 12px 12px;">
            <div id="clChatList"></div>
          </div>
        </div>

        <!-- Everything the payload knows about the open ticket, in one block.
             Filled in by clRenderTicketInfo when a conversation is opened. -->
        <div id="clTicketInfo"></div>

        ${clAttachmentPanel()}
      </div>
    </div>

    <!-- ---- knowledge base ---- -->
    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>${clIco('help')}Help centre</h2>
        <div class="cl-panel-tools" style="flex:1 1 240px; max-width:340px;">
          <label class="cl-sr" for="clFaqSearch">Search the help centre</label>
          <input type="search" id="clFaqSearch" placeholder="Search — refunds, PNR, wallet, approval…">
        </div>
      </div>
      <div class="cl-panel-body" id="clFaqBody"></div>
    </div>

    <!-- ---- contact ---- -->
    <div class="cl-panel">
      <div class="cl-panel-head"><h2>${clIco('building')}Contact</h2></div>
      <div class="cl-panel-body">
        <dl class="cl-dl">
          <div><dt>Partner desk</dt><dd><a href="tel:${CL_SUPPORT_PHONE.replace(/\s/g, '')}">${escapeHtml(CL_SUPPORT_PHONE)}</a></dd></div>
          <div><dt>Email</dt><dd><a href="mailto:${CL_SUPPORT_EMAIL}">${escapeHtml(CL_SUPPORT_EMAIL)}</a></dd></div>
          <div><dt>Escalation</dt><dd><a href="mailto:${CL_SUPPORT_ESCALATION}">${escapeHtml(CL_SUPPORT_ESCALATION)}</a></dd></div>
          <div><dt>Emergency — travelling today</dt><dd><a href="tel:${CL_SUPPORT_EMERGENCY.replace(/\s/g, '')}">${escapeHtml(CL_SUPPORT_EMERGENCY)}</a></dd></div>
          <div><dt>Support hours</dt><dd>${escapeHtml(CL_SUPPORT_HOURS.text)}</dd></div>
          <div><dt>Office</dt><dd>${escapeHtml(CL_SUPPORT_ADDRESS)}</dd></div>
          <div><dt>Your account</dt><dd>${escapeHtml(localStorage.getItem(PARTNER_KEYS.companyName) || '—')}</dd></div>
        </dl>
      </div>
      <div class="cl-panel-note">
        Ticketing, date changes, cancellations and ancillaries are raised through
        <a href="#" data-cl-nav-inline="service-request">Service Requests</a> so they are tracked
        against the booking. Use this screen for anything with no request behind it — and for
        anything urgent, the emergency line is answered outside business hours for passengers
        travelling within 24 hours.
      </div>
    </div>`;

  /* ---- wiring ---- */
  $('cl-support').querySelector('[data-cl-nav-inline]').addEventListener('click', e => {
    e.preventDefault(); clGo('service-request');
  });
  $('clChatNew').addEventListener('click', clOpenNewChat);
  $('clChatRefresh').addEventListener('click', () => {
    if (clChatOpenId) clLoadChatThread(clChatOpenId, { quiet: false });
    clLoadChatThreads();
  });
  $('clChatTabs').querySelectorAll('[data-cl-chat-tab]').forEach(b =>
    b.addEventListener('click', () => {
      clChatFilter = b.dataset.clChatTab;
      $('clChatTabs').querySelectorAll('button').forEach(x => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      clLoadChatThreads();
    }));

  clBindComposer();
  clBindEmoji();
  clBindDropzone();
  clBindFaq();
  clRenderFaq();
  clRenderChatLog();

  /* Polling must not outlive the screen or the tab's visibility. */
  document.addEventListener('visibilitychange', clChatPollGuard);

  /* Stats are loaded ONCE per visit, alongside the list rather than from it.
     They describe the account, not the current tab, so re-running them every
     time somebody switches between All and Resolved would be three wasted
     round trips for an unchanged answer. */
  return Promise.all([clLoadChatThreads(), clLoadSupportStats()]);
}

/* Business hours. `getDay()` is 0=Sunday, matching CL_SUPPORT_HOURS.days. */
function clDeskOnline(now = new Date()) {
  return CL_SUPPORT_HOURS.days.includes(now.getDay())
    && now.getHours() >= CL_SUPPORT_HOURS.from
    && now.getHours() < CL_SUPPORT_HOURS.to;
}

/* ============================================================== channels */

function clChannelCards() {
  const online = clDeskOnline();
  const waText = encodeURIComponent(
    `Hello JackPots partner desk — this is ${localStorage.getItem(PARTNER_KEYS.companyName) || 'a merchant'}. `);

  return `
    <div class="cl-channel">
      <div class="cl-channel-head">
        <span class="cl-channel-ico wa">${clIco('whatsapp', { size: 23 })}</span>
        <div><b>WhatsApp</b><span>Fastest for anything with a file</span></div>
      </div>
      <div class="cl-channel-facts">
        <div class="cl-channel-fact"><span>Number</span><b>+${escapeHtml(CL_SUPPORT_WHATSAPP.replace(/^(\d{2})(\d{5})(\d+)$/, '$1 $2 $3'))}</b></div>
        <div class="cl-channel-fact"><span>Hours</span><b>${escapeHtml(CL_SUPPORT_HOURS.text)}</b></div>
        <div class="cl-channel-fact"><span>Typical reply</span><b>Under 15 minutes</b></div>
        <div class="cl-channel-fact"><span>Status</span>
          <span class="cl-presence ${online ? 'online' : ''}">${online ? 'Online now' : 'Outside hours'}</span></div>
      </div>
      <a class="cl-btn cl-btn-wa cl-btn-block" target="_blank" rel="noopener"
         href="https://wa.me/${CL_SUPPORT_WHATSAPP}?text=${waText}">
        ${clIco('whatsapp', { size: 16 })} Open WhatsApp
      </a>
    </div>

    <div class="cl-channel">
      <div class="cl-channel-head">
        <span class="cl-channel-ico phone">${clIco('phone', { size: 22 })}</span>
        <div><b>Partner desk</b><span>Speak to an operator</span></div>
      </div>
      <div class="cl-channel-facts">
        <div class="cl-channel-fact"><span>Number</span><b>${escapeHtml(CL_SUPPORT_PHONE)}</b></div>
        <div class="cl-channel-fact"><span>Emergency</span><b>${escapeHtml(CL_SUPPORT_EMERGENCY)}</b></div>
        <div class="cl-channel-fact"><span>Hours</span><b>${escapeHtml(CL_SUPPORT_HOURS.text)}</b></div>
        <div class="cl-channel-fact"><span>Out of hours</span><b>Travel within 24h only</b></div>
      </div>
      <a class="cl-btn cl-btn-block" href="tel:${CL_SUPPORT_PHONE.replace(/\s/g, '')}">
        ${clIco('phone', { size: 16 })} Call the desk
      </a>
    </div>

    <div class="cl-channel">
      <div class="cl-channel-head">
        <span class="cl-channel-ico mail">${clIco('mail', { size: 22 })}</span>
        <div><b>Email</b><span>For anything that needs a paper trail</span></div>
      </div>
      <div class="cl-channel-facts">
        <div class="cl-channel-fact"><span>Partner desk</span><b>${escapeHtml(CL_SUPPORT_EMAIL)}</b></div>
        <div class="cl-channel-fact"><span>Escalation</span><b>${escapeHtml(CL_SUPPORT_ESCALATION)}</b></div>
        <div class="cl-channel-fact"><span>Typical reply</span><b>Same business day</b></div>
        <div class="cl-channel-fact"><span>Attachments</span><b>Accepted</b></div>
      </div>
      <a class="cl-btn cl-btn-block" href="mailto:${CL_SUPPORT_EMAIL}">
        ${clIco('mail', { size: 16 })} Write to the desk
      </a>
    </div>`;
}

/* ========================================================== conversations */

async function clLoadChatThreads() {
  const host = $('clChatList');
  host.innerHTML = `<div class="cl-note" style="cursor:default">
    <span class="cl-skel cl-skel-line w60"></span>
    <span class="cl-skel cl-skel-line w80"></span></div>`.repeat(3);

  try {
    const data = await MerchantApi.listSupportThreads({
      status: clChatFilter || undefined, pageSize: 50,
    });
    clChatThreads = data.items || [];
    $('clChatCount').textContent = `${data.total ?? clChatThreads.length} total`;

    host.innerHTML = clChatThreads.length
      ? clChatThreads.map(clThreadCard).join('')
      : `<div class="cl-blank" style="padding:34px 12px;">
          <span class="cl-blank-ico">${clIco('chat', { size: 24 })}</span>
          <b>${clChatFilter ? 'Nothing here' : 'No conversations yet'}</b>
          <p>${clChatFilter
            ? 'Try another tab — your other tickets are still there.'
            : 'Start one and it becomes a tracked ticket you can come back to.'}</p></div>`;

    host.querySelectorAll('[data-cl-thread]').forEach(el =>
      el.addEventListener('click', () => clLoadChatThread(el.dataset.clThread)));

    /* Land on the most recent conversation, so the panel is never an empty
       box on a screen the merchant opened because they need help. */
    if (!clChatOpenId && clChatThreads.length) clLoadChatThread(clChatThreads[0].id);
    clLoadSupportBadge();
  } catch (err) {
    host.innerHTML = `<div class="cl-msg cl-msg-err">${escapeHtml(clError(err, 'Could not load your conversations.'))}</div>`;
  }
}

/* ================================================================= stats */

/* How your tickets stand: raised today, open, in progress, resolved, and how
   quickly we answer.

   THE THREE STATUS COUNTS ARE THE DATABASE'S, NOT THIS FILE'S. One call per
   status with `page_size: 1`, reading `total` off the standard Page envelope —
   a COUNT(*) under that filter. Bucketing one page of threads in the browser
   would undercount the moment a merchant has more tickets than a page holds,
   which is the mistake this portal has already made four times.

   TODAY and AVERAGE FIRST REPLY have no server aggregate and are measured
   here, so both say what they were measured over. THEY FETCH THEIR OWN
   UNFILTERED LIST rather than reading `clChatThreads`, which holds whatever the
   status tab is currently showing — reading that would have made "Raised today"
   fall to zero the moment somebody clicked Resolved, and the tiles describe the
   account, not the tab.

     * "Raised today" counts the threads in the list it loaded. The endpoint has
       no created_at filter, so beyond 50 threads this is a floor and the
       caption says so.

     * "Average first reply" is real elapsed time — the gap between the
       merchant's opening message and the desk's first answer — measured across
       the most recent few conversations, whose messages are fetched for the
       purpose. It is not a service-level promise and is not labelled as one.
       Threads never answered are excluded rather than counted as instant. */
const CL_STATS_SAMPLE = 6;
const CL_STATS_WINDOW = 50;

/* The unfiltered thread list these tiles are measured over. Held separately
   from `clChatThreads`, which follows the status tabs. */
let clStatsThreads = [];

async function clLoadSupportStats() {
  const host = $('clSupportStats');
  if (!host) return;

  let counts = null;
  try {
    const [open, progress, resolved, recent] = await Promise.all([
      MerchantApi.listSupportThreads({ status: 'submitted', pageSize: 1 }),
      MerchantApi.listSupportThreads({ status: 'in_review', pageSize: 1 }),
      MerchantApi.listSupportThreads({ status: 'completed', pageSize: 1 }),
      MerchantApi.listSupportThreads({ pageSize: CL_STATS_WINDOW }),
    ]);
    counts = {
      open: open.total ?? 0,
      progress: progress.total ?? 0,
      resolved: resolved.total ?? 0,
    };
    clStatsThreads = recent.items || [];
  } catch {
    host.innerHTML = '';        /* the conversation list is the real surface */
    return;
  }

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = clStatsThreads.filter(t => new Date(t.created_at) >= midnight).length;
  /* True when the list this counted over is itself a window on something
     bigger, in which case "today" is a floor and has to say so. */
  const windowed = clStatsThreads.length >= CL_STATS_WINDOW;

  const tiles = [
    ['Raised today', String(today), windowed
      ? `Among your ${clStatsThreads.length} most recent`
      : today === 1 ? 'One conversation started today' : 'Conversations you started today', 'chat', ''],
    ['Open', String(counts.open), counts.open ? 'Waiting for the desk to pick up' : 'Nothing waiting to be picked up',
      'inbox', counts.open ? 'warn' : ''],
    ['In progress', String(counts.progress), counts.progress ? 'An operator is on these' : 'None being worked on',
      'headset', counts.progress ? 'info' : ''],
    ['Resolved', String(counts.resolved), 'Closed by our desk', 'checkCircle', 'ok'],
  ];

  host.innerHTML = `<div class="cl-kpis">${tiles.map(([label, value, sub, icon, tone]) => `
    <div class="cl-kpi">
      <div class="cl-kpi-head"><span class="cl-kpi-ico ${tone}">${clIco(icon)}</span></div>
      <div class="cl-kpi-label">${escapeHtml(label)}</div>
      <div class="cl-kpi-value">${escapeHtml(value)}</div>
      <div class="cl-kpi-sub">${escapeHtml(sub)}</div>
    </div>`).join('')}
    <div class="cl-kpi" id="clStatReply">
      <div class="cl-kpi-head"><span class="cl-kpi-ico">${clIco('clock')}</span></div>
      <div class="cl-kpi-label">Average first reply</div>
      <div class="cl-kpi-value"><span class="cl-spin"></span></div>
      <div class="cl-kpi-sub">Measuring your recent conversations…</div>
    </div>
  </div>`;

  clMeasureFirstReply();
}

/* Elapsed time from the merchant's opening message to the desk's first answer,
   over the most recent CL_STATS_SAMPLE conversations. Their messages are not in
   the thread list, so each is fetched — deliberately few, deliberately after
   the page has already rendered, and a failure just leaves the tile blank. */
async function clMeasureFirstReply() {
  const tile = $('clStatReply');
  if (!tile) return;
  const sample = clStatsThreads.slice(0, CL_STATS_SAMPLE);
  const say = (value, sub) => {
    if (!$('clStatReply')) return;      /* the screen re-rendered underneath us */
    tile.querySelector('.cl-kpi-value').textContent = value;
    tile.querySelector('.cl-kpi-sub').textContent = sub;
  };

  if (!sample.length) return say('—', 'No conversations to measure yet');

  let gaps = [];
  try {
    const details = await Promise.all(
      sample.map(t => MerchantApi.getSupportThread(t.id).catch(() => null)));
    gaps = details.map(d => {
      const messages = d?.messages || [];
      const mine = messages.find(m => clIsOutgoing(m));
      if (!mine) return null;
      const reply = messages.find(m => !clIsOutgoing(m)
        && new Date(m.created_at) > new Date(mine.created_at));
      if (!reply) return null;
      return new Date(reply.created_at) - new Date(mine.created_at);
    }).filter(ms => ms != null && ms >= 0);
  } catch {
    return say('—', 'Could not be measured just now');
  }

  if (!gaps.length) {
    return say('—', sample.length === 1
      ? 'Your conversation has not been answered yet'
      : 'None of your recent conversations has been answered yet');
  }

  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  say(clDuration(mean),
    `Across ${gaps.length} answered conversation${gaps.length === 1 ? '' : 's'} of your last ${sample.length}`);
}

/* Milliseconds as the coarsest unit that still says something useful. */
function clDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'Under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3600000;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hr`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/* How long a thread has gone without an answer. This is the closest honest
   thing to a priority: the payload has no priority field, and a made-up
   High/Medium/Low that the desk never set would be worse than nothing. */
function clThreadWaiting(t) {
  const since = t.last_message_at || t.created_at;
  if (t.status === 'completed') return { text: 'Resolved', tone: 'ok' };
  const hours = (Date.now() - new Date(since).getTime()) / 3600000;
  if (hours >= 48) return { text: `Waiting ${Math.floor(hours / 24)} days`, tone: 'err' };
  if (hours >= 8) return { text: `Waiting ${Math.floor(hours)} hours`, tone: 'warn' };
  return { text: 'Recently active', tone: 'info' };
}

const CL_CHAT_TONE = { submitted: 'warn', in_review: 'info', completed: 'ok' };

function clThreadCard(t) {
  const waiting = clThreadWaiting(t);
  const active = String(t.id) === String(clChatOpenId);
  return `<div class="cl-note${active ? ' unread' : ''}" data-cl-thread="${t.id}" role="button" tabindex="0"
               aria-label="${escapeHtml(`${t.title || 'Conversation'}, ${t.status_label}`)}">
    <b>${escapeHtml(t.title || 'Conversation')}</b>
    <div class="cl-chip-row" style="margin:6px 0 4px;">
      <span class="cl-tag cl-tag-${CL_CHAT_TONE[t.status] || 'info'}">${escapeHtml(t.status_label || clLabel(t.status))}</span>
      <span class="cl-tag cl-tag-${waiting.tone} cl-tag-plain">${escapeHtml(waiting.text)}</span>
    </div>
    <span class="cl-ref">${escapeHtml(t.request_number || '')}</span>
    · ${t.message_count} message${t.message_count === 1 ? '' : 's'}
    ${t.assigned_admin ? ' · assigned' : ''}
    <time>${escapeHtml(fmtDateTime(t.last_message_at || t.created_at))}</time>
  </div>`;
}

async function clLoadChatThread(id, { quiet = false } = {}) {
  if (!quiet) {
    clChatOpenId = id;
    $('clChatLog').innerHTML = `<div style="margin:auto;text-align:center;">
      <span class="cl-spin cl-spin-lg"></span></div>`;
  }
  try {
    const data = await MerchantApi.getSupportThread(id);
    /* A poll that lands after the user has switched threads must not paint the
       old conversation over the new one. */
    if (String(data.thread.id) !== String(clChatOpenId)) return;

    clChatThread = data.thread;
    clChatMessages = data.messages || [];
    clRenderChatHead();
    clRenderChatLog();
    clRenderTicketInfo();
    /* Reflect the selection and any status change in the list without a
       second round trip for the whole page. */
    $('clChatList').querySelectorAll('[data-cl-thread]').forEach(el =>
      el.classList.toggle('unread', el.dataset.clThread === String(clChatOpenId)));
    clStartChatPoll();
  } catch (err) {
    $('clChatLog').innerHTML = `<div class="cl-msg cl-msg-err" style="margin:auto;">${
      escapeHtml(clError(err, 'Could not open that conversation.'))}</div>`;
  }
}

function clRenderChatHead() {
  const t = clChatThread;
  if (!t) return;
  const online = clDeskOnline();
  const resolved = t.status === 'completed';
  $('clChatHead').innerHTML = `
    <span class="cl-avatar" aria-hidden="true">${escapeHtml(clInitials(t.assigned_admin ? 'Partner Desk' : 'JackPots Desk'))}</span>
    <div style="min-width:0;">
      <b>${escapeHtml(t.title || 'Conversation')}</b>
      <span><span class="cl-ref">${escapeHtml(t.request_number || '')}</span> ·
        ${escapeHtml(t.status_label || clLabel(t.status))}
        ${t.assigned_admin ? ' · an operator is on it' : ''}</span>
    </div>
    <div class="cl-panel-tools">
      <span class="cl-presence ${online && !resolved ? 'online' : ''}">
        ${resolved ? 'Closed' : online ? 'Desk online' : 'Outside hours'}</span>
      <button type="button" class="cl-btn cl-btn-sm" id="clChatExport"
              title="Save this conversation as a PDF">${clIco('download', { size: 14 })} PDF</button>
      <button type="button" class="cl-btn cl-btn-sm" id="clChatRefresh"
              aria-label="Refresh this conversation">${clIco('refresh', { size: 14 })}</button>
    </div>`;
  $('clChatRefresh').addEventListener('click', () => clLoadChatThread(clChatOpenId));
  $('clChatExport').addEventListener('click', clExportChatPdf);

  const box = $('clChatInput');
  const send = $('clChatSend');
  box.disabled = resolved;
  send.disabled = resolved || !box.value.trim();
  box.placeholder = resolved
    ? 'This ticket is resolved — start a new conversation to continue.'
    : 'Write a message…';
}

/* The conversation. Consecutive messages from one side are grouped, day
   separators are inserted where the date changes, and the receipt on an
   outgoing message is derived — see the header of this file. */
function clRenderChatLog() {
  const log = $('clChatLog');

  if (!clChatOpenId) {
    log.innerHTML = `<div class="cl-blank" style="margin:auto;">
      <span class="cl-blank-ico">${clIco('headset', { size: 26 })}</span>
      <b>How can we help?</b>
      <p>Start a conversation and it becomes a tracked ticket. Everything you send here is
         recorded against your account, so whoever picks it up has the whole story.</p>
      <button type="button" class="cl-btn cl-btn-primary" id="clChatBlankCta">
        ${clIco('chat', { size: 15 })} Start a conversation</button>
    </div>`;
    $('clChatBlankCta')?.addEventListener('click', clOpenNewChat);
    return;
  }

  if (!clChatMessages.length) {
    log.innerHTML = '<div class="cl-blank" style="margin:auto;"><b>No messages yet</b></div>';
    return;
  }

  /* The index of the last OUTGOING message decides where the receipt goes. */
  let lastOutIndex = -1;
  clChatMessages.forEach((m, i) => { if (clIsOutgoing(m)) lastOutIndex = i; });
  /* Evidence the desk has read it: an operator holds the thread, or a reply
     landed after the merchant's last message. */
  const repliedAfter = clChatMessages.slice(lastOutIndex + 1).some(m => !clIsOutgoing(m));
  const seen = repliedAfter || !!clChatThread?.assigned_admin;

  let lastDay = '';
  let lastSide = '';
  const html = clChatMessages.map((m, i) => {
    const out = clIsOutgoing(m);
    const day = new Date(m.created_at).toDateString();
    let block = '';
    if (day !== lastDay) {
      block += `<div class="cl-chat-day">${escapeHtml(clDayLabel(m.created_at))}</div>`;
      lastDay = day;
      lastSide = '';
    }
    const grouped = lastSide === (out ? 'out' : 'in');
    lastSide = out ? 'out' : 'in';

    block += `<div class="cl-bubble ${out ? 'out' : 'in'}${grouped ? ' grouped' : ''}">
      ${!grouped && !out ? `<div class="cl-bubble-who">${escapeHtml(m.sender_name || 'Partner desk')}</div>` : ''}
      ${escapeHtml(m.message || '')}
      <div class="cl-bubble-meta">
        ${escapeHtml(fmtTime(m.created_at))}
        ${out && i === lastOutIndex ? clReceipt(seen) : ''}
      </div>
    </div>`;
    return block;
  }).join('');

  /* "An operator is responding" — real state, not an invented presence ping:
     the thread has been claimed, it is In Progress, and the last thing said was
     the merchant's. */
  const awaitingReply = clChatThread
    && clChatThread.status === 'in_review'
    && clChatThread.assigned_admin
    && lastOutIndex === clChatMessages.length - 1;

  log.innerHTML = html + (awaitingReply
    ? `<div class="cl-typing" aria-label="An operator is working on your message"><i></i><i></i><i></i></div>` : '');
  log.scrollTop = log.scrollHeight;
}

/* Whose message is this — mine, or the desk's?
   ---------------------------------------------------------------------------
   `direction` is written from the PLATFORM's point of view, not the reader's:
   `chat_service` stores a merchant's message as **inbound** (it came in to us)
   and a staff reply as **outbound** (it went out to them). Read literally in a
   merchant-facing screen that is exactly backwards, and it was — the first
   drive of this screen put both of the merchant's own messages on the left,
   attributed to the partner desk, under its own name.

   So in THIS portal, "mine" is `inbound`. Anything else is the desk. */
function clIsOutgoing(m) {
  return String(m.direction || '').toLowerCase() === 'inbound';
}

function clReceipt(seen) {
  return seen
    ? `<svg class="cl-seen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"
         stroke-linecap="round" stroke-linejoin="round" aria-label="Read"><polyline points="1 13 5 17 13 8"/><polyline points="10 13 14 17 23 6"/></svg>`
    : `<svg class="cl-seen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"
         stroke-linecap="round" stroke-linejoin="round" aria-label="Sent"><polyline points="4 13 9 18 20 6"/></svg>`;
}

/* ========================================================== ticket information */

/* Everything the thread payload actually carries, in one block beside the
   conversation, so a merchant chasing a ticket can quote it without scrolling
   the chat for the reference.

   WHAT IS NOT HERE, AND WHY IT IS NOT INVENTED. `ChatThreadResponse` has no
   priority and no category column — `OpenChatRequest` takes a subject and a
   message and nothing else — so neither is shown. A High/Medium/Low the desk
   never set, or a category nobody filed it under, would be a field that reads
   like a fact and is a guess. What IS real is how long the thread has waited
   for an answer, which is the row below, and it is labelled as elapsed time
   rather than dressed up as a priority.

   `request_number` is the thread's own reference. When our desk raised the
   thread against a booking it is that booking's number, which is why the row is
   a jump to it rather than plain text — but only when it looks like one, since
   for a merchant-opened thread it is the thread's own reference. */
function clRenderTicketInfo() {
  const host = $('clTicketInfo');
  if (!host) return;
  const t = clChatThread;
  if (!t) { host.innerHTML = ''; return; }

  const waiting = clThreadWaiting(t);
  const lastAt = t.last_message_at || t.created_at;
  const booking = /^REQ-/i.test(t.request_number || '') ? t.request_number : '';

  const rows = [
    ['Reference', `<span class="cl-ref">${escapeHtml(t.request_number || '—')}</span>`],
    ['Subject', escapeHtml(t.title || 'Conversation')],
    ['Status', `<span class="cl-tag cl-tag-${CL_CHAT_TONE[t.status] || 'info'}">${
      escapeHtml(t.status_label || clLabel(t.status))}</span>`],
    ['Assigned to', t.assigned_admin
      ? escapeHtml(t.assigned_admin)
      : '<span class="cl-muted">Not yet picked up</span>'],
    ['Waiting', `<span class="cl-tag cl-tag-${waiting.tone} cl-tag-plain">${escapeHtml(waiting.text)}</span>`],
    ['Messages', String(t.message_count ?? clChatMessages.length)],
    ['Opened', escapeHtml(fmtDateTime(t.created_at))],
    ['Last activity', escapeHtml(fmtDateTime(lastAt))],
    ['Account', escapeHtml(localStorage.getItem(PARTNER_KEYS.companyName) || '—')],
  ];

  host.innerHTML = `
    <div class="cl-panel">
      <div class="cl-panel-head"><h2>${clIco('info')}Ticket information</h2></div>
      <div class="cl-panel-body">
        <dl class="cl-dl cl-dl-1">
          ${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join('')}
        </dl>
        ${booking ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-block"
          style="margin-top:14px;" id="clTicketBooking">
          ${clIco('external', { size: 14 })} Open booking ${escapeHtml(booking)}</button>` : ''}
      </div>
    </div>`;

  $('clTicketBooking')?.addEventListener('click', () => {
    /* The list carries the id the detail screen needs; without it there is
       nothing to open, so the button sends them to the searchable list. */
    clGo('requests', () => {
      const search = $('clReqSearch');
      if (!search) return;
      search.value = booking;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

/* ============================================================ PDF export */

/* The conversation as a document the merchant can file or forward.

   IT PRINTS RATHER THAN BUILDING A PDF BYTE STREAM. Every browser's print
   dialog offers "Save as PDF", and the alternative is a PDF library — a second
   network request in a portal whose whole icon set is inline SVG precisely to
   avoid one, and a dependency to keep patched for a button.

   It renders into a hidden same-document iframe, not a popup, because a popup
   is what a blocker eats. The iframe carries its own stylesheet: the portal's
   own CSS is themeable and screen-shaped, and a transcript printed in dark mode
   would come out as white text on paper. */
function clExportChatPdf() {
  const t = clChatThread;
  if (!t || !clChatMessages.length) return;

  const company = localStorage.getItem(PARTNER_KEYS.companyName) || '';
  const me = localStorage.getItem(PARTNER_KEYS.fullName) || 'You';
  const facts = [
    ['Reference', t.request_number || '—'],
    ['Status', t.status_label || clLabel(t.status)],
    ['Assigned to', t.assigned_admin || 'Not yet picked up'],
    ['Opened', fmtDateTime(t.created_at)],
    ['Last activity', fmtDateTime(t.last_message_at || t.created_at)],
    ['Messages', String(clChatMessages.length)],
    ['Account', company || '—'],
    ['Exported', fmtDateTime(new Date().toISOString())],
  ];

  let lastDay = '';
  const body = clChatMessages.map(m => {
    const out = clIsOutgoing(m);
    const day = new Date(m.created_at).toDateString();
    let block = '';
    if (day !== lastDay) {
      lastDay = day;
      block += `<p class="day">${escapeHtml(clDayLabel(m.created_at))}</p>`;
    }
    block += `<div class="msg ${out ? 'out' : 'in'}">
      <p class="who">${escapeHtml(out ? me : (m.sender_name || 'Partner desk'))}
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

  /* srcdoc so nothing is fetched and no object URL has to be revoked. The
     iframe is torn down on the next tick after print() returns — removing it
     synchronously cancels the dialog in some browsers. */
  frame.srcdoc = doc;
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      /* Printing blocked (an embedded viewer, a locked-down browser). The
         transcript is not lost — say where it went instead of failing mute. */
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

function clDayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ------------------------------------------------------------- composing */

function clBindComposer() {
  const box = $('clChatInput');
  const send = $('clChatSend');

  /* Grow to fit, up to the CSS max-height. A one-line box for a paragraph of
     detail is how a support message ends up being three separate messages. */
  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 132)}px`;
    send.disabled = !box.value.trim() || box.disabled;
  });
  /* Enter sends, Shift+Enter is a newline — the convention every chat uses. */
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); clSendChat(); }
  });
  send.addEventListener('click', clSendChat);
}

async function clSendChat() {
  const box = $('clChatInput');
  const send = $('clChatSend');
  let text = box.value.trim();
  if (!text || !clChatOpenId) return;

  /* Staged attachments travel as a list in the message. The tray says plainly
     that the file itself goes by WhatsApp or email — see the header. */
  if (clChatFiles.length) {
    text += `\n\nAttachments I have ready (${clChatFiles.length}):\n`
      + clChatFiles.map(f => `• ${f.file.name} (${clFileSize(f.file.size)})`).join('\n');
  }

  const original = box.value;
  box.value = '';
  box.style.height = 'auto';
  send.disabled = true;
  box.disabled = true;

  /* Optimistic: the bubble appears immediately with a single tick, and the
     server's answer replaces the whole list a moment later. A support chat that
     pauses for a round trip before showing your own words feels broken. */
  clChatMessages = [...clChatMessages, {
    /* `inbound` is the merchant side — see clIsOutgoing. The optimistic bubble
       must carry the same value the server will send back, or it would jump
       from one side of the conversation to the other when the reply lands. */
    id: `pending-${Date.now()}`, direction: 'inbound',
    message: text, created_at: new Date().toISOString(),
  }];
  clRenderChatLog();

  try {
    const data = await MerchantApi.sendSupportMessage(clChatOpenId, text);
    clChatThread = data.thread;
    clChatMessages = data.messages || [];
    clClearFiles();
    clRenderChatHead();
    clRenderChatLog();
    clLoadChatThreads();
  } catch (err) {
    box.value = original;
    clChatMessages = clChatMessages.filter(m => !String(m.id).startsWith('pending-'));
    clRenderChatLog();
    clOpenModal('Message not sent',
      `<div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Your message could not be sent.'))}</div>`,
      '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
  } finally {
    box.disabled = clChatThread?.status === 'completed';
    send.disabled = !box.value.trim() || box.disabled;
    box.focus();
  }
}

function clOpenNewChat() {
  clOpenModal('Start a conversation', `
    <p style="margin:0 0 20px;font-size:13.5px;line-height:1.6;color:var(--cl-text-2);">
      This opens a tracked ticket. Give it a subject our desk can triage from, and say as much as
      you can in the first message — it is what whoever picks it up will read first.
    </p>
    <div class="cl-form cl-form-2">
      <div class="cl-field cl-field-full">
        <label for="clNewChatSubject">Subject<span class="cl-req">*</span></label>
        <input type="text" id="clNewChatSubject" maxlength="200"
               placeholder="e.g. PNR not received on REQ-2026-000042">
        <small>Include a reference number if the question is about one — it saves a round trip.</small>
      </div>
      <div class="cl-field cl-field-full">
        <label for="clNewChatMessage">Message<span class="cl-req">*</span></label>
        <textarea id="clNewChatMessage" maxlength="4000" style="min-height:130px;"
                  placeholder="What has happened, what you expected, and what you need from us."></textarea>
      </div>
    </div>
    <div class="cl-msg" id="clNewChatMsg"></div>`,
    `<button type="button" class="cl-btn" data-cl-newchat-cancel>Cancel</button>
     <button type="button" class="cl-btn cl-btn-primary" data-cl-newchat-go>Start conversation</button>`);

  $('clModalFoot').querySelector('[data-cl-newchat-cancel]').addEventListener('click', clCloseModal);
  $('clModalFoot').querySelector('[data-cl-newchat-go]').addEventListener('click', async () => {
    const subject = $('clNewChatSubject').value.trim();
    const message = $('clNewChatMessage').value.trim();
    const msg = $('clNewChatMsg');
    if (!subject) return clMsg(msg, 'Give the conversation a subject.', 'err');
    if (!message) return clMsg(msg, 'Write your first message.', 'err');

    const btn = $('clModalFoot').querySelector('[data-cl-newchat-go]');
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      const data = await MerchantApi.openSupportThread({ subject, message });
      clCloseModal();
      clChatOpenId = data.thread.id;
      clChatThread = data.thread;
      clChatMessages = data.messages || [];
      clRenderChatHead();
      clRenderChatLog();
      clRenderTicketInfo();
      /* A new ticket changes both "Raised today" and "Open", so the tiles are
         recomputed here — the one place other than opening the screen where
         they can go stale. */
      await Promise.all([clLoadChatThreads(), clLoadSupportStats()]);
      clStartChatPoll();
    } catch (err) {
      clMsg(msg, clError(err, 'Could not start the conversation.'), 'err');
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  });
}

/* ---------------------------------------------------------------- polling */

function clStartChatPoll() {
  clStopChatPoll();
  if (!clChatOpenId || clChatThread?.status === 'completed') return;
  clChatTimer = setInterval(() => {
    /* Never poll a hidden tab, and never poll a screen the user has left. */
    if (document.hidden || !$('cl-support').classList.contains('active')) return;
    clLoadChatThread(clChatOpenId, { quiet: true });
  }, CL_CHAT_POLL_MS);
}

function clStopChatPoll() {
  if (clChatTimer) { clearInterval(clChatTimer); clChatTimer = null; }
}

function clChatPollGuard() {
  if (document.hidden) clStopChatPoll();
  else if (clChatOpenId && $('cl-support').classList.contains('active')) clStartChatPoll();
}

/* ------------------------------------------------------------------ emoji */

const CL_EMOJI = ['👍', '🙏', '✅', '❌', '⚠️', '🙂', '😊', '😅',
  '✈️', '🧳', '🎫', '📄', '📎', '💳', '🕒', '📞',
  '🔴', '🟠', '🟢', '❗', '❓', '💡', '🔁', '🎯'];

function clBindEmoji() {
  const pop = $('clEmojiPop');
  const btn = $('clEmojiBtn');
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
    const box = $('clChatInput');
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
  document.addEventListener('click', e => {
    if (!e.target.closest('#clEmojiPop') && !e.target.closest('#clEmojiBtn')) {
      pop.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}

/* ------------------------------------------------------------ attachments */

function clAttachmentPanel() {
  return `
    <div class="cl-panel">
      <div class="cl-panel-head"><h2>${clIco('paperclip')}Attachments</h2></div>
      <div class="cl-panel-body">
        <div class="cl-drop" id="clDrop" role="button" tabindex="0"
             aria-label="Choose files, or drop them here">
          ${clIco('upload', { size: 30 })}
          <b>Drop files here</b>
          <small>or click to choose · PDF, JPG, PNG, WebP, DOCX, ZIP · up to ${CL_FILE_MAX_MB} MB each</small>
        </div>
        <input type="file" id="clDropInput" multiple class="cl-sr"
               accept=".pdf,.jpg,.jpeg,.png,.webp,.zip,.doc,.docx">
        <ul class="cl-files" id="clFileList"></ul>
        <div class="cl-msg" id="clFileMsg"></div>
      </div>
      <div class="cl-panel-note">
        Files you stage here are <b>listed to the desk with your message</b> so the operator knows
        exactly what you have. This channel cannot carry the file itself — send it on
        <b>WhatsApp</b> or by <b>email</b>, both of which accept attachments and are one tap away
        above. Passport and visa copies for a booking are not needed here at all.
      </div>
    </div>`;
}

function clBindDropzone() {
  const drop = $('clDrop');
  const input = $('clDropInput');

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => { clAddFiles([...input.files]); input.value = ''; });

  ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, e => {
    e.preventDefault(); drop.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, e => {
    e.preventDefault();
    if (type === 'dragleave' && drop.contains(e.relatedTarget)) return;
    drop.classList.remove('dragging');
  }));
  drop.addEventListener('drop', e => clAddFiles([...(e.dataTransfer?.files || [])]));
}

function clFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* Validation happens here rather than only on `accept`, which is a hint a user
   can walk straight past in the file dialog. */
function clAddFiles(files) {
  const rejected = [];
  files.forEach(file => {
    if (file.size > CL_FILE_MAX_MB * 1048576) {
      rejected.push(`${file.name} is ${clFileSize(file.size)} — over the ${CL_FILE_MAX_MB} MB limit`);
      return;
    }
    if (file.type && !CL_FILE_TYPES.includes(file.type)) {
      rejected.push(`${file.name} is not a supported type`);
      return;
    }
    if (clChatFiles.some(f => f.file.name === file.name && f.file.size === file.size)) return;
    /* An object URL only for an image, and only so the thumbnail can render —
       revoked in clClearFiles / clRemoveFile so a long session does not hold
       every preview it has ever made. */
    clChatFiles.push({
      file,
      url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      progress: 0,
    });
  });

  clMsg($('clFileMsg'), rejected.join('. '), rejected.length ? 'err' : 'info');
  clRenderFiles();
  /* A short progress animation on each newly staged file: the read IS
     instantaneous for a local file, and a bar that never appears makes the
     staging look like it did not happen. */
  clChatFiles.filter(f => f.progress < 100).forEach(f => clAnimateFile(f));
}

function clAnimateFile(entry) {
  const step = () => {
    entry.progress = Math.min(100, entry.progress + 20 + Math.random() * 25);
    const bar = document.querySelector(`[data-cl-file-bar="${CSS.escape(entry.file.name)}"] i`);
    if (bar) bar.style.width = `${entry.progress}%`;
    if (entry.progress < 100) setTimeout(step, 90);
    else clRenderFiles();
  };
  setTimeout(step, 60);
}

function clRenderFiles() {
  const list = $('clFileList');
  if (!clChatFiles.length) { list.innerHTML = ''; return; }

  list.innerHTML = clChatFiles.map(f => {
    const ext = (f.file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
    return `<li class="cl-file">
      ${f.url
        ? `<img class="cl-file-thumb" src="${f.url}" alt="Preview of ${escapeHtml(f.file.name)}">`
        : `<span class="cl-file-ico">${escapeHtml(ext)}</span>`}
      <span class="cl-file-meta">
        <b>${escapeHtml(f.file.name)}</b>
        <span>${escapeHtml(clFileSize(f.file.size))}${f.progress >= 100 ? ' · ready' : ' · staging…'}</span>
        ${f.progress < 100
          ? `<span class="cl-progress" data-cl-file-bar="${escapeHtml(f.file.name)}" style="margin-top:6px;">
               <i style="width:${f.progress}%"></i></span>` : ''}
      </span>
      ${f.url ? `<button type="button" class="cl-btn cl-btn-sm" data-cl-file-view="${escapeHtml(f.file.name)}"
            aria-label="Preview ${escapeHtml(f.file.name)}">${clIco('eye', { size: 14 })}</button>` : ''}
      <a class="cl-btn cl-btn-sm" download="${escapeHtml(f.file.name)}"
         href="${f.url || URL.createObjectURL(f.file)}"
         aria-label="Download ${escapeHtml(f.file.name)}">${clIco('download', { size: 14 })}</a>
      <button type="button" class="cl-btn cl-btn-sm cl-btn-danger" data-cl-file-remove="${escapeHtml(f.file.name)}"
              aria-label="Remove ${escapeHtml(f.file.name)}">${clIco('x', { size: 14 })}</button>
    </li>`;
  }).join('');

  list.querySelectorAll('[data-cl-file-remove]').forEach(b =>
    b.addEventListener('click', () => clRemoveFile(b.dataset.clFileRemove)));
  list.querySelectorAll('[data-cl-file-view]').forEach(b =>
    b.addEventListener('click', () => {
      const f = clChatFiles.find(x => x.file.name === b.dataset.clFileView);
      if (!f) return;
      clOpenModal(f.file.name,
        `<img src="${f.url}" alt="${escapeHtml(f.file.name)}"
              style="width:100%;border-radius:var(--cl-r-md);display:block;">`,
        '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
    }));
}

function clRemoveFile(name) {
  const i = clChatFiles.findIndex(f => f.file.name === name);
  if (i < 0) return;
  if (clChatFiles[i].url) URL.revokeObjectURL(clChatFiles[i].url);
  clChatFiles.splice(i, 1);
  clRenderFiles();
}

function clClearFiles() {
  clChatFiles.forEach(f => { if (f.url) URL.revokeObjectURL(f.url); });
  clChatFiles = [];
  clRenderFiles();
  clMsg($('clFileMsg'), '');
}

/* ================================================================== FAQ */

/* Written against what this product actually does. Every answer here is
   checkable against a screen in this portal or a rule in the backend — a help
   centre that describes a generic travel platform is worse than no help
   centre, because it teaches the merchant the wrong model. */
const CL_FAQ = [
  {
    cat: 'Booking',
    q: 'Why can I not book a fare directly?',
    a: 'Every booking starts as a Booking Enquiry. You tell us the sector, our desk confirms availability and quotes a fare, and only then can you turn it into a booking request. That is what guarantees the sector you book is one we have actually confirmed — and the quotation you accept is binding on both sides.',
  },
  {
    cat: 'Booking',
    q: 'My enquiry says "Available". What now?',
    a: 'Open it and press Request Ticket. That copies the whole journey from the enquiry into a draft booking — you only add the passengers. The itinerary cannot drift from what we answered, because you never re-type it.',
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
    a: 'No. Passport number and expiry are typed into the passenger form on an international sector, because the airline needs them — but there is no document upload in the booking flow. If we ever need a copy, the desk will ask for it on WhatsApp or by email.',
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

function clBindFaq() {
  $('clFaqSearch').addEventListener('input', e => {
    clFaqQuery = e.target.value.trim().toLowerCase();
    clRenderFaq();
  });
}

function clRenderFaq() {
  const host = $('clFaqBody');
  const rows = clFaqQuery
    ? CL_FAQ.filter(f => `${f.cat} ${f.q} ${f.a}`.toLowerCase().includes(clFaqQuery))
    : CL_FAQ;

  if (!rows.length) {
    host.innerHTML = `<div class="cl-blank">
      <span class="cl-blank-ico">${clIco('search', { size: 26 })}</span>
      <b>Nothing matches “${escapeHtml(clFaqQuery)}”</b>
      <p>Ask the desk directly — start a conversation above and we will answer it, and add it here.</p>
    </div>`;
    return;
  }

  /* Grouped by category, in the order the categories first appear, so the list
     reads as a manual rather than as fifteen unrelated questions. */
  const cats = [...new Set(rows.map(f => f.cat))];
  host.innerHTML = cats.map(cat => `
    <div class="cl-faq-cat">${escapeHtml(cat)}</div>
    <div class="cl-faq" style="margin-bottom:18px;">
      ${rows.filter(f => f.cat === cat).map((f, i) => `
        <div class="cl-faq-item${clFaqQuery && i === 0 ? ' open' : ''}">
          <button type="button" class="cl-faq-q" aria-expanded="${clFaqQuery && i === 0 ? 'true' : 'false'}">
            <span>${escapeHtml(f.q)}</span>
            <svg class="cl-faq-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="cl-faq-a"><div><p>${escapeHtml(f.a)}</p></div></div>
        </div>`).join('')}
    </div>`).join('');

  host.querySelectorAll('.cl-faq-q').forEach(btn =>
    btn.addEventListener('click', () => {
      const item = btn.closest('.cl-faq-item');
      const open = item.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }));
}
