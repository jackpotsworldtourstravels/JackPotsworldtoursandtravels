/* Admin — B2C Communication (Phase 7 of the B2C Admin Portal build-out)
   ==================================================================
   A READ-ONLY RECORD of what customers have been sent and have said. There is
   no compose box, no ticket reply and no chat handling here, on purpose (see
   services/customer_communication_admin_service.py):

     Notifications   written by the event they describe (a booking, a
                     cancellation, a payment) and never composed ahead of it —
                     an admin compose box would break that guarantee.
     Support tickets the customer site's Support Center is now live chat, so
                     tickets are no longer created; existing ones are history.
     Live chat       answered on the Live Support desk; this tab only shows the
                     queue's totals and links there.

   ENDPOINTS (all GET, under /api/admin/communication):
     /notifications   /tickets   /tickets/{id}   /chat-overview

   Loaded after admin.js and admin-b2c-catalogue-common.js, whose shared modal
   and error formatter it reuses. */

const COM_TABS = [['notifications', 'Notifications'], ['tickets', 'Support Tickets'], ['chat', 'Live Chat']];
const COM_TYPE_LABEL = {
  booking_created: 'Booking created', booking_confirmed: 'Booking confirmed',
  booking_cancelled: 'Booking cancelled', booking_payment: 'Payment', general: 'General',
};
const COM_TICKET_TONE = { open: 'pending', in_progress: 'refunded', resolved: 'confirmed', closed: 'inactive' };

const comState = { tab: 'notifications', nPage: 1, nType: '', nRead: '', nSearch: '', tPage: 1, tStatus: '', tPriority: '', tSearch: '' };
let comWired = false;

async function comApi(path, params) {
  const res = await axios.get(`${API_BASE}/api/admin/communication${path}`, { headers: authHeaders(), params });
  return res.data;
}
const comWho = c => `${escapeHtml(c.name)}<div class="cell-sub">${escapeHtml(c.email)}</div>`;

async function initB2CCommunication() {
  if (!comWired) {
    comWired = true;
    document.getElementById('comTabs').innerHTML = COM_TABS.map(([k, l]) =>
      `<button type="button" role="tab" class="ops-tab" data-com-tab="${k}">${escapeHtml(l)}</button>`).join('');
    document.getElementById('comTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-com-tab]');
      if (b) comShow(b.dataset.comTab);
    });
    document.getElementById('comNType').innerHTML = '<option value="">All types</option>' +
      Object.entries(COM_TYPE_LABEL).map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
    const bind = (id, key, page) => document.getElementById(id).addEventListener('change', e => {
      comState[key] = e.target.value; comState[page] = 1; comLoad();
    });
    bind('comNType', 'nType', 'nPage'); bind('comNRead', 'nRead', 'nPage');
    bind('comTStatus', 'tStatus', 'tPage'); bind('comTPriority', 'tPriority', 'tPage');
    const searchBind = (id, key, page) => {
      const el = document.getElementById(id);
      el.addEventListener('input', catDebounce(() => { comState[key] = el.value.trim(); comState[page] = 1; comLoad(); }));
    };
    searchBind('comNSearch', 'nSearch', 'nPage'); searchBind('comTSearch', 'tSearch', 'tPage');
    document.getElementById('comTicketTable').addEventListener('click', e => {
      const b = e.target.closest('[data-com-ticket]');
      if (b) comOpenTicket(b.dataset.comTicket);
    });
  }
  comShow(comState.tab);
}

function comShow(tab) {
  comState.tab = tab;
  document.querySelectorAll('#comTabs .ops-tab').forEach(b => b.classList.toggle('active', b.dataset.comTab === tab));
  ['notifications', 'tickets', 'chat'].forEach(k => { document.getElementById(`comPane-${k}`).hidden = k !== tab; });
  comLoad();
}

function comLoad() {
  return ({ notifications: comLoadNotifications, tickets: comLoadTickets, chat: comLoadChat }[comState.tab])();
}

/* ---------- notifications ---------- */

async function comLoadNotifications(page = comState.nPage) {
  comState.nPage = page;
  const tbody = document.querySelector('#comNotifTable tbody');
  tbody.innerHTML = `<tr><td colspan="6">${rowsSkeleton(5)}</td></tr>`;
  try {
    const d = await comApi('/notifications', {
      page, page_size: PAGE_SIZE, type: comState.nType || undefined,
      read: comState.nRead === '' ? undefined : comState.nRead === 'read', search: comState.nSearch || undefined,
    });
    const s = d.summary;
    const readPct = s.total ? Math.round((s.total - s.unread) / s.total * 100) : 0;
    document.getElementById('comNotifSummary').innerHTML = `
      <div class="detail-item"><span class="detail-label">Sent</span><span class="detail-value">${s.total}</span></div>
      <div class="detail-item"><span class="detail-label">Read</span><span class="detail-value">${readPct}% <span class="cell-sub">(${s.total - s.unread} of ${s.total})</span></span></div>
      ${Object.entries(s.by_type).map(([t, n]) => `<div class="detail-item"><span class="detail-label">${escapeHtml(COM_TYPE_LABEL[t] || catCap(t))}</span><span class="detail-value">${n}</span></div>`).join('')}`;
    tbody.innerHTML = d.items.length ? d.items.map(n => `
      <tr>
        <td>${catWhen(n.created_at)}</td>
        <td>${comWho(n.customer)}</td>
        <td>${escapeHtml(COM_TYPE_LABEL[n.notification_type] || catCap(n.notification_type))}</td>
        <td><strong>${escapeHtml(n.title)}</strong><div class="cell-sub">${escapeHtml(n.message)}</div></td>
        <td>${n.related_ref ? `<span class="mono">${escapeHtml(n.related_ref)}</span>` : '—'}</td>
        <td>${n.is_read ? `<span class="badge confirmed">Read</span><div class="cell-sub">${catWhen(n.read_at)}</div>` : '<span class="badge pending">Unread</span>'}</td>
      </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No notifications match this filter.</td></tr>`;
    renderPagination('comNotifPagination', d.page, d.total_pages, d.total, comLoadNotifications);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(catErr(err, 'Failed to load notifications.'))}</td></tr>`;
  }
}

/* ---------- tickets ---------- */

async function comLoadTickets(page = comState.tPage) {
  comState.tPage = page;
  const tbody = document.querySelector('#comTicketTable tbody');
  tbody.innerHTML = `<tr><td colspan="7">${rowsSkeleton(4)}</td></tr>`;
  try {
    const d = await comApi('/tickets', {
      page, page_size: PAGE_SIZE, status: comState.tStatus || undefined,
      priority: comState.tPriority || undefined, search: comState.tSearch || undefined,
    });
    tbody.innerHTML = d.items.length ? d.items.map(t => `
      <tr>
        <td class="mono">#${t.ticket_id}</td>
        <td>${comWho(t.customer)}</td>
        <td>${escapeHtml(t.subject)}</td>
        <td>${escapeHtml(catCap(t.priority))}</td>
        <td><span class="badge ${COM_TICKET_TONE[t.status] || 'pending'}">${escapeHtml(catCap(t.status))}</span></td>
        <td class="num">${t.message_count}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-com-ticket="${t.ticket_id}">View</button></td>
      </tr>`).join('') : `<tr><td colspan="7" class="empty-state">No tickets match this filter.</td></tr>`;
    renderPagination('comTicketPagination', d.page, d.total_pages, d.total, comLoadTickets);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(catErr(err, 'Failed to load tickets.'))}</td></tr>`;
  }
}

async function comOpenTicket(id) {
  catOpenModal(catModalShell('Support ticket', rowsSkeleton(4)));
  try {
    const t = await comApi(`/tickets/${encodeURIComponent(id)}`);
    catOpenModal(`
      <div class="ops-modal-head"><h2>#${t.ticket_id} ${escapeHtml(t.subject)}
        <span class="badge ${COM_TICKET_TONE[t.status] || 'pending'}">${escapeHtml(catCap(t.status))}</span></h2>
        <button type="button" class="ops-modal-close" data-cat-close aria-label="Close">&times;</button></div>
      <div class="ops-modal-body">
        <div class="detail-grid">
          <div class="detail-item"><span class="detail-label">Customer</span><span class="detail-value">${comWho(t.customer)}</span></div>
          <div class="detail-item"><span class="detail-label">Priority</span><span class="detail-value">${escapeHtml(catCap(t.priority))}</span></div>
          <div class="detail-item"><span class="detail-label">Opened</span><span class="detail-value">${catWhen(t.created_at)}</span></div>
        </div>
        <p class="cp-readonly-note">History only. The customer site now uses live chat, so this ticket can no longer be answered from here — continue the conversation on Live Support.</p>
        <div>${t.messages.map(m => `
          <div style="padding:10px 0; border-bottom:1px solid var(--border-color);">
            <div class="cell-sub"><strong>${escapeHtml(m.author_name || 'Customer')}</strong>${m.is_staff ? ' · staff' : ''} · ${catWhen(m.created_at)}</div>
            <div style="white-space:pre-wrap; margin-top:3px;">${escapeHtml(m.message)}</div></div>`).join('')}</div>
      </div>`);
  } catch (err) {
    catOpenModal(catModalShell('Support ticket', `<p class="msg error">${escapeHtml(catErr(err, 'Could not load this ticket.'))}</p>`));
  }
}

/* ---------- live chat summary ---------- */

async function comLoadChat() {
  const host = document.getElementById('comChatBody');
  host.innerHTML = rowsSkeleton(4);
  try {
    const c = await comApi('/chat-overview');
    const st = k => c.by_status[k] || 0;
    const card = (l, v, sub) => `<div class="detail-item"><span class="detail-label">${escapeHtml(l)}</span><span class="detail-value">${v}</span>${sub ? `<span class="cell-sub">${escapeHtml(sub)}</span>` : ''}</div>`;
    host.innerHTML = `
      <div class="detail-grid">
        ${card('Conversations', c.conversations_total, `${st('waiting')} waiting · ${st('active')} active · ${st('closed')} closed`)}
        ${card('Unassigned & open', c.unassigned_open, 'No agent has picked these up')}
        ${card('Unread by agents', c.admin_unread, 'Customer messages not yet read')}
        ${card('Messages', c.messages_total)}
        ${card('Voice calls', c.calls_total, Object.entries(c.calls_by_status).map(([k, n]) => `${n} ${k}`).join(' · '))}
        ${card('Longest wait since', c.oldest_waiting_at ? catWhen(c.oldest_waiting_at) : '—', 'Oldest conversation still waiting')}
      </div>
      <p class="cp-readonly-note" style="margin-top:14px;">Chats and calls are answered on the Live Support desk — this is only a summary.</p>
      <div class="cat-actions" style="justify-content:flex-start;">
        <button type="button" class="btn btn-navy" id="comOpenLive">Open Live Support</button></div>`;
    document.getElementById('comOpenLive').addEventListener('click', () => navigateToSection('live-support'));
  } catch (err) {
    host.innerHTML = `<p class="empty-state">${escapeHtml(catErr(err, 'Could not load the chat overview.'))}</p>`;
  }
}
