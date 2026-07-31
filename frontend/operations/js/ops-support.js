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

let opsChatTimer = null;
let opsChatThreadId = null;

function opsStopChatPolling() {
  if (opsChatTimer) clearInterval(opsChatTimer);
  opsChatTimer = null;
  opsChatThreadId = null;
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
    ${opsCan('chat.create') ? '' : `<div class="ops-panel"><div class="ops-panel-note" style="border-top:none">
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
    searchable: false,   /* the endpoint takes status/page only */
    filters: [
      { key: 'status', label: 'Status', type: 'select', anyLabel: 'All',
        options: [
          { value: 'submitted', label: 'Open — unclaimed' },
          { value: 'in_review', label: 'Claimed' },
          { value: 'completed', label: 'Resolved' },
        ] },
    ],
    columns: [
      OpsCol.ref('request_number', 'Ref.'),
      { key: 'title', label: 'Subject', value: r => r.title },
      ...(opsIsStaff() ? [{ key: 'merchant_name', label: 'Merchant', value: r => r.merchant_name }] : []),
      { key: 'opened_by', label: 'Opened by', value: r => r.opened_by },
      { key: 'message_count', label: 'Msgs', align: 'right' },
      { key: 'status', label: 'Status', nowrap: true,
        render: r => opsTag(r.status, r.status_label), text: r => r.status_label },
      { key: 'assigned_admin', label: 'Claimed by', align: 'right', hidden: true },
      OpsCol.dateTime('last_message_at', 'Last message'),
      OpsCol.dateTime('created_at', 'Opened'),
      OpsCol.actions([{ act: 'open', label: 'Open', primary: true }]),
    ],
    note: `A thread only ever moves through three statuses: <b>Open</b> (server label for
      "submitted" — nobody has claimed it), <b>Under Review</b> (claimed), <b>Resolved</b>
      (closed). Resolving is terminal — a merchant continues by opening a new conversation.`,
    emptyText: 'No conversations.',
    fetch: async ({ page, pageSize, filters: f }) => {
      const params = { page, page_size: pageSize };
      if (f.status) params.status = f.status;
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

  /* Preserve the scroll position across a silent poll, otherwise reading a long
     thread becomes impossible while it refreshes every twenty seconds. */
  const oldLog = $('opsChatLog');
  const wasAtBottom = !oldLog || (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40);
  const oldScroll = oldLog ? oldLog.scrollTop : 0;

  host.innerHTML = `
    <div class="ops-panel">
      <div class="ops-panel-head">
        <h2>${escapeHtml(t.title || t.request_number)}</h2>
        <div class="ops-panel-tools">
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
          <div><dt>Opened</dt><dd>${escapeHtml(fmtDateTime(t.created_at))}</dd></div>
        </dl>
      </div>
      <div class="ops-chat">
        <div class="ops-chat-log" id="opsChatLog">
          ${msgs.length ? msgs.map(m => `
            <div class="ops-bubble ${mine(m) ? 'out' : ''}">
              ${escapeHtml(m.message || '')}
              <small>${escapeHtml(m.sender_name || (m.direction === 'inbound' ? 'Merchant' : 'Support'))}
                · ${escapeHtml(fmtDateTime(m.created_at))}</small>
            </div>`).join('') : '<div class="ops-empty">No messages yet.</div>'}
        </div>
        ${canReply && !closed ? `
          <div class="ops-chat-in">
            <textarea id="opsChatMsg" rows="1" placeholder="Type a reply — Enter sends, Shift+Enter for a new line"></textarea>
            <button type="button" class="ops-btn ops-btn-primary" id="opsChatSend">Send</button>
          </div>` : `
          <div class="ops-panel-note" style="border-top:1px solid var(--ops-line)">
            ${closed ? 'This conversation is closed.'
              : 'Your role can read this conversation but not reply to it.'}
          </div>`}
      </div>
      <div class="ops-msg" id="opsChMsg" style="margin:8px 10px"></div>
    </div>`;

  const log = $('opsChatLog');
  log.scrollTop = wasAtBottom ? log.scrollHeight : oldScroll;

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
