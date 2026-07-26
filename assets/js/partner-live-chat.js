'use strict';
/* Live Chat Support — frontend component architecture, ready for a future
   backend (WebSocket/SSE). No chat backend exists yet, so ChatAdapter below
   is the seam: swap `localChatAdapter` for a real one once the server side
   is built. Deliberately shows an honest empty state, not fake data. */

const localChatAdapter = {
  async listConversations() { return []; },
  async getMessages(_conversationId) { return []; },
  async sendMessage(_conversationId, _text) { throw new Error('Live chat backend is not connected yet.'); },
  isOnline: () => false,
};
let activeChatAdapter = localChatAdapter;
let chatSelectedConversationId = null;

function chatEmptyConversationList() {
  return `<div class="empty-state" style="padding:40px 16px;">
    <svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/></svg>
    No conversations yet.<br><span style="font-size:11.5px;">Live chat isn't connected to a support backend yet — this is a ready-to-wire UI shell.</span>
  </div>`;
}

function renderChatShell() {
  const panel = document.getElementById('liveChatPanel');
  panel.innerHTML = `
    <div class="chat-shell">
      <aside class="chat-list-pane">
        <div class="chat-list-head">
          <h2 style="font-size:15px;">Messages</h2>
          <span class="chat-status-dot ${activeChatAdapter.isOnline() ? 'online' : 'offline'}"></span>
        </div>
        <div class="chat-search"><input type="text" id="chatSearchInput" placeholder="Search chats…"></div>
        <div class="chat-list" id="chatConversationList"></div>
      </aside>
      <section class="chat-thread-pane">
        <div class="chat-thread-empty" id="chatThreadEmpty">
          <svg viewBox="0 0 24 24" style="width:44px;height:44px;opacity:.3;"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/></svg>
          <p>Select a conversation to start chatting.</p>
        </div>
        <div class="chat-thread" id="chatThread" style="display:none;">
          <div class="chat-thread-head">
            <div><strong id="chatThreadName"></strong><div class="chat-thread-status" id="chatThreadStatus"></div></div>
          </div>
          <div class="chat-messages" id="chatMessages"></div>
          <div class="chat-typing" id="chatTypingIndicator" style="display:none;">Typing…</div>
          <form class="chat-composer" id="chatComposerForm">
            <button type="button" class="chat-tool-btn" id="chatEmojiBtn" title="Emoji" aria-label="Emoji">🙂</button>
            <button type="button" class="chat-tool-btn" id="chatFileBtn" title="Attach file" aria-label="Attach file">📎</button>
            <button type="button" class="chat-tool-btn" id="chatImageBtn" title="Attach image" aria-label="Attach image">🖼️</button>
            <input type="text" id="chatComposerInput" placeholder="Type a message…" autocomplete="off">
            <button type="submit" class="btn btn-coral btn-sm">Send</button>
          </form>
        </div>
      </section>
    </div>`;

  document.getElementById('chatComposerForm').addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('chatComposerInput');
    if (!input.value.trim() || !chatSelectedConversationId) return;
    try {
      await activeChatAdapter.sendMessage(chatSelectedConversationId, input.value.trim());
      input.value = '';
    } catch (err) {
      setMsg?.('chatComposerMsg', err.message, 'error');
    }
  });
  ['chatEmojiBtn', 'chatFileBtn', 'chatImageBtn'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      /* Emoji/file/image affordances are wired and ready — actual picker
         opens once a chat backend exists to receive uploads. */
    });
  });

  document.getElementById('chatSearchInput').addEventListener('input', async e => {
    const q = e.target.value.trim().toLowerCase();
    const all = await activeChatAdapter.listConversations();
    renderConversationList(q ? all.filter(c => c.name.toLowerCase().includes(q)) : all);
  });

  renderConversationList([]);
}

async function renderConversationList(filtered) {
  const list = document.getElementById('chatConversationList');
  const conversations = filtered ?? await activeChatAdapter.listConversations();
  if (!conversations.length) { list.innerHTML = chatEmptyConversationList(); return; }
  list.innerHTML = conversations.map(c => `
    <div class="chat-list-item ${c.id === chatSelectedConversationId ? 'active' : ''}" data-id="${c.id}">
      <span class="chat-avatar">${escapeHtml((c.name || '?')[0])}</span>
      <div class="chat-list-item-body">
        <div class="chat-list-item-top"><strong>${escapeHtml(c.name)}</strong><span class="chat-time">${c.lastTime || ''}</span></div>
        <div class="chat-list-item-preview">${escapeHtml(c.lastMessage || '')}</div>
      </div>
      ${c.unread ? `<span class="chat-unread-badge">${c.unread}</span>` : ''}
    </div>`).join('');
}

function initLiveChat() {
  renderChatShell();
}
