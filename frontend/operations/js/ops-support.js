'use strict';
/* Operations Portal — Support.
   ===========================================================================
   Chat threads are service_requests rows with request_type = live_chat, and
   chat_service.py walks them through only THREE of the request statuses —
   confirmed by reading open_thread/claim_thread/resolve_thread directly
   rather than assumed from the general lifecycle:

     submitted    open_thread's initial status. Server label is "Open", not
                  "Submitted" — ChatThreadResponse carries its own status_label,
                  which this screen renders instead of the general one.
     in_review    claim_thread's target; also reached as a side effect of an
                  admin's first reply while still submitted (send_message
                  auto-claims — see the note on the composer below).
     completed    resolve_thread's target. Terminal: resolve_thread 400s if
                  already completed, and there is no route back.
   draft/pending_approval/rejected/cancelled never occur on a chat thread —
   they belong to the booking/service-request lifecycle, not this one.

   THREE DIFFERENT SEATS AT THE SAME TABLE, enforced server-side:
     merchant     chat.create + chat.view — opens threads, replies to its own
     admin        chat.manage + chat.view — claims, replies, resolves
     super admin  chat.view only          — reads the queue, cannot reply
   The last one is deliberate (the spec gives Super Admin visibility, not
   participation), so the composer is hidden rather than shown and then 403ing.

   TRANSPORT: short polling, per the signed-off contract (§ Live Chat: "Phase 1
   ships short-polling; the message schema must stay WebSocket-ready"). The open
   thread refreshes on a timer while its panel is visible, and the timer is
   cleared whenever the panel is replaced — an orphaned interval polling a
   closed thread forever is the classic version of this bug.
   =========================================================================== */

/* The server's own vocabularies. CATEGORIES mirrors chat_service.CATEGORIES —
   anything outside it is a 400, so these drive every picker rather than being
   retyped per screen. Priorities are priority_enum, which OPS_TONE already
   tones. */
const OPS_CHAT_CATEGORIES = [
  ['booking', 'Booking'],
  ['payment', 'Payment'],
  ['wallet', 'Wallet'],
  ['refund', 'Refund'],
  ['ticket_issue', 'Ticket Issue'],
  ['account', 'Account'],
  ['technical', 'Technical'],
  ['other', 'Other'],
];
const OPS_CHAT_PRIORITIES = [
  ['low', 'Low'],
  ['normal', 'Normal'],
  ['high', 'High'],
  ['urgent', 'Urgent'],
];

/* Canned openers (spec §11). Deliberately a CLIENT-SIDE list and not a stored
   template table: these are typing shortcuts that land in the composer where
   the operator can edit them before sending, not messages the platform sends on
   anyone's behalf. Nothing is sent by picking one. */
const OPS_QUICK_REPLIES = [
  'Hello — thanks for getting in touch. I am looking at this now.',
  'Could you share the booking reference this is about?',
  'Please give me a moment while I verify this with the airline.',
  'I have checked with our ticketing desk and am waiting on their reply.',
  'Your ticket has been uploaded to the booking — you can download it from Booking History.',
  'We have received your payment and the booking has been updated.',
  'This is now resolved. I will close the ticket, but you can reopen it if anything is still wrong.',
];

let opsChatTimer = null;
let opsChatThreadId = null;
let opsChatDocs = [];

function opsStopChatPolling() {
  if (opsChatTimer) clearInterval(opsChatTimer);
  opsChatTimer = null;
  opsChatThreadId = null;
  /* Cleared with the thread, so a download button left in a stale DOM cannot
     resolve against the previous conversation's files. */
  opsChatDocs = [];
}

function opsInitSupport() {
  opsStopChatPolling();
  const host = $('ops-support');
  const canReply = opsCan('chat.create', 'chat.manage');

  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Support</h1>
        <p>${escapeHtml(opsIsStaff()
          ? (opsCan('chat.manage')
            ? 'The support queue. Claim a thread to take ownership, then reply and resolve.'
            : 'The support queue, read-only — your role has visibility without participation.')
          : 'Conversations with the partner desk.')}</p>
      </div>
      <div class="ops-page-actions">
        ${opsCan('chat.create') ? '<button type="button" class="ops-btn ops-btn-primary" id="opsSuNew">+ New conversation</button>' : ''}
      </div>
    </div>
    <div class="ops-cols-2" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)">
      <div id="opsSuList"></div>
      <div id="opsSuThread">
        <div class="ops-panel"><div class="ops-panel-body">
          <div class="ops-empty">Select a conversation to read it${canReply ? ' and reply' : ''}.</div>
        </div></div>
      </div>
    </div>
    ${canReply ? '' : `<div class="ops-panel"><div class="ops-panel-note" style="border-top:none">
      Your role holds <code>chat.view</code> but not <code>chat.create</code> or
      <code>chat.manage</code>, so conversations are readable but not answerable from this account.
    </div></div>`}`;

  $('opsSuNew')?.addEventListener('click', opsNewThreadDialog);

  const grid = OpsGrid({
    id: 'support-threads',
    mount: $('opsSuList'),
    title: 'Conversations',
    exportName: 'support-threads',
    mode: 'server',
    /* The endpoint's `q` searches subjects, references AND message bodies, so
       this is a server search rather than a filter over the loaded page —
       which is also why it was switched on: an operator looking for the thread
       where a PNR was mentioned cannot find it by subject. */
    searchable: true,
    searchPlaceholder: 'Reference, subject, or anything said in a thread…',
    filters: [
      { key: 'status', label: 'Status', type: 'select', anyLabel: 'All',
        options: [
          { value: 'submitted', label: 'Open — unclaimed' },
          { value: 'in_review', label: 'Claimed' },
          { value: 'completed', label: 'Resolved' },
        ] },
      { key: 'priority', label: 'Priority', type: 'select', anyLabel: 'Any',
        options: OPS_CHAT_PRIORITIES.map(([value, label]) => ({ value, label })) },
      { key: 'category', label: 'Category', type: 'select', anyLabel: 'All',
        options: OPS_CHAT_CATEGORIES.map(([value, label]) => ({ value, label })) },
    ],
    columns: [
      OpsCol.ref('request_number', 'Ref.'),
      { key: 'title', label: 'Subject', value: r => r.title },
      ...(opsIsStaff() ? [{ key: 'merchant_name', label: 'Merchant', value: r => r.merchant_name }] : []),
      { key: 'opened_by', label: 'Opened by', value: r => r.opened_by },
      /* OPS_TONE already carries priority_enum (low/normal blank, high warn,
         urgent err), so opsTag tones this correctly from the value itself. */
      { key: 'priority', label: 'Priority', nowrap: true,
        render: r => opsTag(r.priority || 'normal', opsLabel(r.priority || 'normal')),
        text: r => r.priority || 'normal' },
      { key: 'category', label: 'Category', value: r => r.category_label || '—' },
      { key: 'message_count', label: 'Msgs', align: 'right' },
      { key: 'attachment_count', label: 'Files', align: 'right' },
      { key: 'status', label: 'Status', nowrap: true,
        render: r => opsTag(r.status, r.status_label), text: r => r.status_label },
      { key: 'assigned_admin_name', label: 'Claimed by', value: r => r.assigned_admin_name || '—' },
      OpsCol.dateTime('last_message_at', 'Last message'),
      OpsCol.dateTime('created_at', 'Opened'),
      OpsCol.actions([{ act: 'open', label: 'Open', primary: true }]),
    ],
    note: `A thread moves through three statuses: <b>Open</b> (server label for "submitted" —
      nobody has claimed it), <b>Under Review</b> (claimed), <b>Resolved</b> (closed). Resolving
      is no longer terminal: the merchant may reopen it within the server's window, which puts it
      back in this queue as unclaimed. Search covers what was <i>said</i> in a thread, not just
      its subject.`,
    emptyText: 'No conversations.',
    fetch: async ({ page, pageSize, filters: f, search }) => {
      const params = { page, page_size: pageSize };
      if (f.status) params.status = f.status;
      if (f.priority) params.priority = f.priority;
      if (f.category) params.category = f.category;
      if (search) params.q = search;
      const d = await OpsApi.listThreads(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    onRow: r => opsOpenThread(r.id, grid),
    actions: { open: row => opsOpenThread(row.id, grid) },
  });

  return grid;
}

async function opsOpenThread(id, grid) {
  opsStopChatPolling();
  opsChatThreadId = id;
  const host = $('opsSuThread');
  host.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">${opsSpinner('Loading conversation…')}</div></div>`;

  const paint = async (silent) => {
    /* Self-cancelling poll. There is no unmount hook on a section, so instead of
       trying to catch every way of leaving (nav click, hash change, deep link,
       sign-out) the timer checks whether Support is still the visible section
       and stops itself. An interval left polling a screen nobody is looking at
       is the classic version of this bug. */
    if (!$('ops-support').classList.contains('active')) return opsStopChatPolling();
    /* Only the thread that is still on screen may repaint — a stale response
       arriving after the operator moved on must not overwrite the new panel. */
    if (opsChatThreadId !== id) return;
    try {
      const d = await OpsApi.getThread(id);
      if (opsChatThreadId !== id) return;
      opsRenderThread(d, grid);
    } catch (err) {
      if (silent) return;         /* a failed poll is not worth a visible error */
      host.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">
        <div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Could not load the conversation.'))}</div>
      </div></div>`;
    }
  };

  await paint(false);
  /* 20s, in the 15-30s band the contract specifies. */
  opsChatTimer = setInterval(() => paint(true), 20000);
}

function opsRenderThread(d, grid) {
  const t = d.thread;
  const msgs = d.messages || [];
  const host = $('opsSuThread');
  const canReply = opsCan('chat.create', 'chat.manage');
  const canManage = opsCan('chat.manage');
  /* completed is the only terminal status chat_service ever sets — see the
     module header. Checking a broader set here would just be dead code, but
     leaving it narrow is also what makes it obvious if that ever changes. */
  const closed = t.status === 'completed';

  /* `direction` is the server's word for which side sent a message. Rendering
     it relative to the reader ("out" = written by my side) is what makes a
     transcript legible to both a merchant and an admin without two templates. */
  const mine = m => (opsIsStaff() ? m.direction === 'outbound' : m.direction === 'inbound');

  opsChatDocs = d.documents || [];

  /* Preserve the scroll position across a silent poll, otherwise reading a long
     thread becomes impossible while it refreshes every twenty seconds. */
  const oldLog = $('opsChatLog');
  const wasAtBottom = !oldLog || (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40);
  const oldScroll = oldLog ? oldLog.scrollTop : 0;
  /* And preserve anything half-typed. This whole panel is rebuilt every twenty
     seconds, so without carrying the drafts across, an operator writing a
     considered reply watched it vanish mid-sentence. */
  const draftReply = $('opsChatMsg')?.value || '';
  const draftNote = $('opsChNoteBody')?.value || '';

  host.innerHTML = `
    <div class="ops-panel">
      <div class="ops-panel-head">
        <h2>${escapeHtml(t.title || t.request_number)}</h2>
        <div class="ops-panel-tools">
          ${opsTag(t.priority || 'normal', opsLabel(t.priority || 'normal'))}
          ${opsTag(t.status, t.status_label)}
          ${canManage && t.status === 'submitted'
            ? '<button type="button" class="ops-btn ops-btn-sm" id="opsChClaim">Claim</button>' : ''}
          ${canManage && !closed
            ? '<button type="button" class="ops-btn ops-btn-sm" id="opsChResolve">Resolve</button>' : ''}
        </div>
      </div>
      <div class="ops-panel-body" style="padding:8px 10px">
        <dl class="ops-dl">
          <div><dt>Reference</dt><dd class="ops-ref">${escapeHtml(t.request_number)}</dd></div>
          ${opsIsStaff() ? `<div><dt>Merchant</dt><dd>${escapeHtml(t.merchant_name || '—')}</dd></div>` : ''}
          <div><dt>Opened by</dt><dd>${escapeHtml(t.opened_by || '—')}</dd></div>
          <div><dt>Category</dt><dd>${escapeHtml(t.category_label || '—')}</dd></div>
          <div><dt>Claimed by</dt><dd>${escapeHtml(t.assigned_admin_name || '—')}</dd></div>
          <div><dt>About booking</dt><dd>${t.related_request_number
            ? `<span class="ops-ref">${escapeHtml(t.related_request_number)}</span>`
            : '—'}</dd></div>
          <div><dt>Files</dt><dd>${opsChatDocs.length || '—'}</dd></div>
          <div><dt>Opened</dt><dd>${escapeHtml(fmtDateTime(t.created_at))}</dd></div>
        </dl>
        ${canManage ? `
          <!-- Triage. The merchant sets a starting priority when it raises the
               ticket; this is where the desk decides what it actually is. -->
          <div class="ops-form ops-form-3" style="margin-top:10px">
            <div class="ops-field">
              <label for="opsChPriority">Priority</label>
              <select id="opsChPriority">
                ${OPS_CHAT_PRIORITIES.map(([v, l]) =>
                  `<option value="${v}"${v === (t.priority || 'normal') ? ' selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="ops-field">
              <label for="opsChCategory">Category</label>
              <select id="opsChCategory">
                <option value="">Uncategorised</option>
                ${OPS_CHAT_CATEGORIES.map(([v, l]) =>
                  `<option value="${v}"${v === t.category ? ' selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="ops-field" style="display:flex;align-items:flex-end">
              <button type="button" class="ops-btn ops-btn-sm" id="opsChTriage">Update triage</button>
            </div>
          </div>` : ''}
      </div>
      <div class="ops-chat">
        <div class="ops-chat-log" id="opsChatLog">
          ${msgs.length ? opsRenderBubbles(msgs, mine) : '<div class="ops-empty">No messages yet.</div>'}
        </div>
        ${canReply && !closed ? `
          <div class="ops-chat-tools">
            <select id="opsChQuick" aria-label="Insert a quick reply">
              <option value="">Quick reply…</option>
              ${OPS_QUICK_REPLIES.map((r, i) => `<option value="${i}">${escapeHtml(r.slice(0, 58))}${r.length > 58 ? '…' : ''}</option>`).join('')}
            </select>
            <button type="button" class="ops-btn ops-btn-sm" id="opsChAttach">Attach a file</button>
            <input type="file" id="opsChFile" class="ops-sr" accept=".pdf,.jpg,.jpeg,.png,.webp">
          </div>
          <div class="ops-chat-in">
            <textarea id="opsChatMsg" rows="1" placeholder="Type a reply — Enter sends, Shift+Enter for a new line"></textarea>
            <button type="button" class="ops-btn ops-btn-primary" id="opsChatSend">Send</button>
          </div>` : `
          <div class="ops-panel-note" style="border-top:1px solid var(--ops-line)">
            ${closed ? 'This conversation is closed. The merchant can reopen it within the '
              + 'reopening window, which returns it to this queue as unclaimed.'
              : 'Your role can read this conversation but not reply to it.'}
          </div>`}
      </div>
      <div class="ops-msg" id="opsChMsg" style="margin:8px 10px"></div>
    </div>
    ${canManage ? opsNotesPanel() : ''}`;

  const log = $('opsChatLog');
  log.scrollTop = wasAtBottom ? log.scrollHeight : oldScroll;
  if ($('opsChatMsg')) $('opsChatMsg').value = draftReply;
  if ($('opsChNoteBody')) $('opsChNoteBody').value = draftNote;
  opsBindChatDocs(log);
  if (canManage) opsBindNotes(t.id);

  $('opsChTriage')?.addEventListener('click', async () => {
    const btn = $('opsChTriage');
    btn.disabled = true;
    try {
      await OpsApi.triageThread(t.id, {
        priority: $('opsChPriority').value,
        /* '' means uncategorised. The server leaves an omitted field alone, so
           clearing a category is deliberately not expressible here — an
           operator re-files it as something else instead of blanking it. */
        category: $('opsChCategory').value || undefined,
      });
      opsToast(`${t.request_number} re-filed.`, 'ok');
      grid?.reload();
      opsOpenThread(t.id, grid);
    } catch (err) {
      opsMsg($('opsChMsg'), opsError(err, 'Triage could not be updated.'), 'err');
      btn.disabled = false;
    }
  });

  /* Quick replies land in the composer rather than sending: they are typing
     shortcuts an operator edits before sending, not canned messages the
     platform fires on their behalf. */
  $('opsChQuick')?.addEventListener('change', e => {
    const reply = OPS_QUICK_REPLIES[Number(e.target.value)];
    e.target.value = '';
    if (!reply) return;
    const box = $('opsChatMsg');
    box.value = box.value.trim() ? `${box.value.trim()} ${reply}` : reply;
    box.focus();
  });

  $('opsChAttach')?.addEventListener('click', () => $('opsChFile').click());
  $('opsChFile')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const btn = $('opsChAttach');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await OpsApi.uploadThreadDocument(t.id, file);
      opsToast(`${file.name} shared.`, 'ok');
      grid?.reload();
      opsOpenThread(t.id, grid);
    } catch (err) {
      opsMsg($('opsChMsg'), opsError(err, 'The file could not be shared.'), 'err');
      btn.disabled = false;
      btn.textContent = 'Attach a file';
    }
  });

  $('opsChClaim')?.addEventListener('click', async () => {
    try {
      await OpsApi.claimThread(t.id);
      opsToast(`${t.request_number} claimed.`, 'ok');
      grid?.reload();
      opsOpenThread(t.id, grid);
      opsLoadBadges();
    } catch (err) { opsMsg($('opsChMsg'), opsError(err, 'Could not claim the thread.'), 'err'); }
  });

  $('opsChResolve')?.addEventListener('click', async () => {
    if (!await opsConfirm(
      `Resolve ${t.request_number}? This is terminal — the merchant would have to open a new `
      + `conversation to continue.`, 'Resolve')) return;
    try {
      await OpsApi.resolveThread(t.id);
      opsToast(`${t.request_number} resolved.`, 'ok');
      grid?.reload();
      opsOpenThread(t.id, grid);
      opsLoadBadges();
    } catch (err) { opsMsg($('opsChMsg'), opsError(err, 'Could not resolve the thread.'), 'err'); }
  });

  const send = async () => {
    const box = $('opsChatMsg');
    const text = box.value.trim();
    if (!text) return;
    $('opsChatSend').disabled = true;
    try {
      await OpsApi.sendThreadMessage(t.id, text);
      box.value = '';
      grid?.reload();
      await opsOpenThread(t.id, grid);
      opsLoadBadges();
    } catch (err) {
      opsMsg($('opsChMsg'), opsError(err, 'The message was not sent.'), 'err');
    } finally {
      const b = $('opsChatSend');
      if (b) b.disabled = false;
    }
  };
  $('opsChatSend')?.addEventListener('click', send);
  $('opsChatMsg')?.addEventListener('keydown', e => {
    /* Enter sends; Shift+Enter is a newline. This is a reply box in an
       operations tool, not a document editor. */
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}

/* ---------------------------------------------------------------- bubbles */

/* The line chat_service.attach_document posts for every upload. Matching it is
   what turns an attachment into a downloadable card instead of the literal
   words "Shared a file: invoice.pdf". If the server string ever changes, the
   bubbles fall back to plain text rather than breaking. */
const OPS_FILE_MSG = /^Shared a file:\s*(.+)$/;

function opsRenderBubbles(msgs, mine) {
  /* Each match is consumed, so two uploads of the same filename land on their
     own bubbles in order rather than both pointing at the first document. */
  const unclaimed = [...opsChatDocs];
  const claim = (text, isStaffSide) => {
    const m = OPS_FILE_MSG.exec(text || '');
    if (!m) return null;
    const name = m[1].trim();
    let i = unclaimed.findIndex(doc => doc.filename === name && doc.is_staff === isStaffSide);
    if (i < 0) i = unclaimed.findIndex(doc => doc.filename === name);
    return i < 0 ? null : unclaimed.splice(i, 1)[0];
  };

  return msgs.map(m => {
    const doc = claim(m.message, m.direction === 'outbound');
    return `<div class="ops-bubble ${mine(m) ? 'out' : ''}">
      ${doc ? opsBubbleFile(doc) : escapeHtml(m.message || '')}
      <small>${escapeHtml(m.sender_name || (m.direction === 'inbound' ? 'Merchant' : 'Support'))}
        · ${escapeHtml(fmtDateTime(m.created_at))}
        ${m.direction === 'outbound' && m.is_read ? ' · read' : ''}</small>
    </div>`;
  }).join('');
}

function opsBubbleFile(doc) {
  const ext = (doc.filename.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
  return `<span class="ops-chat-file">
    <b>${escapeHtml(ext)}</b>
    <span>${escapeHtml(doc.filename)} · ${escapeHtml(opsFileSize(doc.size_bytes))}</span>
    <button type="button" class="ops-btn ops-btn-sm" data-ops-doc="${doc.id}">Download</button>
  </span>`;
}

function opsFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* Downloads are authenticated, so an attachment can never be a plain href —
   the blob is pulled with the bearer token and handed over as an object URL,
   which is revoked once the browser has had it. */
function opsBindChatDocs(root) {
  root.querySelectorAll('[data-ops-doc]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const doc = opsChatDocs.find(x => String(x.id) === String(btn.dataset.opsDoc));
      if (!doc) return;
      btn.disabled = true;
      try {
        const url = await OpsApi.downloadDocument(doc.id);
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (err) {
        opsMsg($('opsChMsg'), opsError(err, 'The file could not be downloaded.'), 'err');
      } finally {
        btn.disabled = false;
      }
    }));
}

/* --------------------------------------------------------- internal notes */

/* THE MERCHANT NEVER SEES THIS PANEL, and not because it is hidden here.
   Notes are `request_notes` rows and the server refuses both endpoints for a
   non-staff account, so a merchant calling them directly gets a 403 rather
   than a payload this screen happens not to render. Migration 0032 chose a
   staff-only table over a visibility flag for exactly that reason: a boolean
   is one forgotten filter away from a leak. */
function opsNotesPanel() {
  return `
    <div class="ops-panel" style="margin-top:12px">
      <div class="ops-panel-head">
        <h2>Internal notes</h2>
        <div class="ops-panel-tools"><span class="ops-muted">Not visible to the merchant</span></div>
      </div>
      <div class="ops-panel-body" style="padding:10px">
        <div class="ops-field">
          <label class="ops-sr" for="opsChNoteBody">Add an internal note</label>
          <textarea id="opsChNoteBody" rows="2"
                    placeholder="What you found, what you are waiting on, what the next operator needs to know."></textarea>
        </div>
        <button type="button" class="ops-btn ops-btn-sm" id="opsChNoteAdd" style="margin-top:8px">Add note</button>
        <div class="ops-msg" id="opsChNoteMsg"></div>
        <div id="opsChNotes" style="margin-top:12px"></div>
      </div>
    </div>`;
}

function opsBindNotes(threadId) {
  const add = $('opsChNoteAdd');
  add?.addEventListener('click', async () => {
    const box = $('opsChNoteBody');
    const body = box.value.trim();
    if (!body) return opsMsg($('opsChNoteMsg'), 'A note cannot be empty.', 'err');
    add.disabled = true;
    try {
      await OpsApi.addThreadNote(threadId, body);
      box.value = '';
      opsMsg($('opsChNoteMsg'), '');
      opsLoadNotes(threadId);
    } catch (err) {
      opsMsg($('opsChNoteMsg'), opsError(err, 'The note could not be saved.'), 'err');
    } finally {
      add.disabled = false;
    }
  });
  opsLoadNotes(threadId);
}

async function opsLoadNotes(threadId) {
  const host = $('opsChNotes');
  if (!host) return;
  try {
    const notes = await OpsApi.listThreadNotes(threadId);
    /* The panel may have been rebuilt by a poll while this was in flight. */
    if (!$('opsChNotes')) return;
    $('opsChNotes').innerHTML = notes.length
      /* NOT .ops-note — that class is the portal's clickable list row and
         carries cursor:pointer and a hover state. A note is read, not opened. */
      ? notes.map(n => `
        <div class="ops-inote">
          <p>${escapeHtml(n.body)}</p>
          <small>${escapeHtml(n.author || 'Support')} · ${escapeHtml(fmtDateTime(n.created_at))}${
            n.edited_at ? ' · edited' : ''}</small>
        </div>`).join('')
      : '<div class="ops-empty">No internal notes on this conversation.</div>';
  } catch (err) {
    if (!$('opsChNotes')) return;
    $('opsChNotes').innerHTML =
      `<div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Notes could not be loaded.'))}</div>`;
  }
}

function opsNewThreadDialog() {
  opsOpenModal('New conversation', `
    <div class="ops-form ops-form-2">
      <div class="ops-field ops-field-full">
        <label for="opsNtSubject">Subject<span class="ops-req">*</span></label>
        <input type="text" id="opsNtSubject" placeholder="e.g. Reissue on REQ-2026-000004">
      </div>
      <div class="ops-field ops-field-full">
        <label for="opsNtMsg">First message<span class="ops-req">*</span></label>
        <textarea id="opsNtMsg" rows="4" placeholder="Include the request number if this is about a specific booking."></textarea>
      </div>
    </div>
    <p class="ops-field-hint" style="margin-top:6px">
      For a change to a confirmed booking — a date change, cancellation or refund — raise a
      <b>service request</b> from the booking instead. It is tracked against the booking and moves
      through approval; a conversation is not.
    </p>
    <div class="ops-msg" id="opsNtMsgBox"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsNtCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-primary" id="opsNtSave">Open conversation</button>`);

  $('opsNtCancel').addEventListener('click', opsCloseModal);
  $('opsNtSave').addEventListener('click', async () => {
    const subject = $('opsNtSubject').value.trim();
    const message = $('opsNtMsg').value.trim();
    const msg = $('opsNtMsgBox');
    if (!subject) return opsMsg(msg, 'A subject is required.', 'err');
    if (!message) return opsMsg(msg, 'Write the first message.', 'err');
    $('opsNtSave').disabled = true;
    try {
      const d = await OpsApi.openThread({ subject, message });
      opsCloseModal();
      opsToast(`Conversation ${d?.thread?.request_number || ''} opened.`, 'ok');
      opsInvalidate('support');
      opsRefreshIfVisible('support');
      opsLoadBadges();
    } catch (err) {
      opsMsg(msg, opsError(err, 'The conversation could not be opened.'), 'err');
      $('opsNtSave').disabled = false;
    }
  });
}
