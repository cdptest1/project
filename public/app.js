(() => {
  const $ = (sel) => document.querySelector(sel);

  const authView = $('#auth-view');
  const chatView = $('#chat-view');
  const authForm = $('#auth-form');
  const authError = $('#auth-error');
  const authSubmit = $('#auth-submit');
  const messagesEl = $('#messages');
  const loadMoreBtn = $('#load-more');
  const input = $('#input');
  const statusLine = $('#status-line');

  let mode = 'login';
  let me = null;
  let socket = null;
  let oldestId = null;
  let lastRendered = null; // last message appended at the bottom
  let rendered = []; // all messages on screen, oldest first
  let online = [];
  const typingUsers = new Map(); // username -> timeout id

  // ---------- API ----------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
    return data;
  }

  // ---------- Auth ----------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      mode = tab.dataset.mode;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      authSubmit.textContent = mode === 'login' ? 'Log in' : 'Create account';
      authForm.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      authError.textContent = '';
    });
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    authSubmit.disabled = true;
    try {
      const user = await api(`/api/${mode}`, {
        method: 'POST',
        body: JSON.stringify({
          username: authForm.username.value,
          password: authForm.password.value,
        }),
      });
      authForm.reset();
      enterChat(user);
    } catch (err) {
      authError.textContent = err.message;
    } finally {
      authSubmit.disabled = false;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    if (socket) socket.disconnect();
    socket = null;
    me = null;
    showAuth();
  });

  function showAuth() {
    chatView.classList.add('hidden');
    authView.classList.remove('hidden');
    authForm.username.focus();
  }

  // ---------- Chat ----------
  async function enterChat(user) {
    me = user;
    $('#me').textContent = user.username;
    authView.classList.add('hidden');
    chatView.classList.remove('hidden');

    clearMessages();
    oldestId = null;

    const { messages, hasMore } = await api('/api/messages');
    messages.forEach(appendMessage);
    oldestId = messages[0]?.id ?? null;
    loadMoreBtn.classList.toggle('hidden', !hasMore);
    scrollToBottom();

    connectSocket();
    input.focus();
  }

  function connectSocket() {
    socket = io();
    socket.on('connect', updateStatus);
    socket.on('disconnect', () => { statusLine.textContent = 'reconnecting…'; });
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') showAuth();
      else statusLine.textContent = 'offline — retrying…';
    });

    socket.on('message', (msg) => {
      const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
      clearTyping(msg.username);
      appendMessage(msg);
      if (nearBottom || msg.user_id === me.id) scrollToBottom();
    });

    socket.on('presence', (names) => { online = names; updateStatus(); });

    socket.on('typing', (username) => {
      clearTimeout(typingUsers.get(username));
      typingUsers.set(username, setTimeout(() => clearTyping(username), 3000));
      updateStatus();
    });
  }

  function clearTyping(username) {
    clearTimeout(typingUsers.get(username));
    if (typingUsers.delete(username)) updateStatus();
  }

  function updateStatus() {
    if (typingUsers.size) {
      const names = [...typingUsers.keys()];
      statusLine.textContent = names.length === 1
        ? `${names[0]} is typing…`
        : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ' and others' : ''} are typing…`;
      return;
    }
    statusLine.textContent = online.length
      ? `${online.length} online: ${online.join(', ')}`
      : 'connected';
  }

  loadMoreBtn.addEventListener('click', async () => {
    if (!oldestId) return;
    loadMoreBtn.disabled = true;
    try {
      const { messages, hasMore } = await api(`/api/messages?before=${oldestId}`);
      const prevHeight = messagesEl.scrollHeight;
      prependMessages(messages);
      oldestId = messages[0]?.id ?? oldestId;
      loadMoreBtn.classList.toggle('hidden', !hasMore);
      messagesEl.scrollTop += messagesEl.scrollHeight - prevHeight; // keep position
    } finally {
      loadMoreBtn.disabled = false;
    }
  });

  // ---------- Rendering ----------
  const dayKey = (ts) => new Date(ts).toDateString();

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function colorFor(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h}, 60%, 45%)`;
  }

  function buildMessage(msg, prev) {
    const frag = document.createDocumentFragment();
    const newDay = !prev || dayKey(prev.created_at) !== dayKey(msg.created_at);
    if (newDay) {
      const div = document.createElement('div');
      div.className = 'day-divider';
      div.textContent = dayLabel(msg.created_at);
      frag.appendChild(div);
    }

    const mine = msg.user_id === me.id;
    const first = newDay || prev.user_id !== msg.user_id;

    const el = document.createElement('div');
    el.className = `msg${mine ? ' mine' : ''}${first ? ' first' : ''}`;
    el.dataset.id = msg.id;

    if (first && !mine) {
      const author = document.createElement('div');
      author.className = 'author';
      author.textContent = msg.username;
      author.style.color = colorFor(msg.username);
      el.appendChild(author);
    }

    el.appendChild(document.createTextNode(msg.body)); // textContent = no XSS

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.appendChild(time);

    frag.appendChild(el);
    return frag;
  }

  function appendMessage(msg) {
    messagesEl.appendChild(buildMessage(msg, lastRendered));
    lastRendered = msg;
    rendered.push(msg);
  }

  function prependMessages(msgs) {
    if (!msgs.length) return;
    // Re-render everything so day dividers and sender grouping stay correct.
    const all = [...msgs, ...rendered];
    clearMessages();
    all.forEach(appendMessage);
  }

  function clearMessages() {
    messagesEl.querySelectorAll('.msg, .day-divider').forEach((n) => n.remove());
    rendered = [];
    lastRendered = null;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- Composer ----------
  let lastTypingSent = 0;

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  input.addEventListener('input', () => {
    autoGrow();
    if (socket && Date.now() - lastTypingSent > 1500) {
      socket.emit('typing');
      lastTypingSent = Date.now();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !socket) return;
    socket.emit('message', text, (res) => {
      if (res?.error) alert(res.error);
    });
    input.value = '';
    autoGrow();
    input.focus();
  });

  // ---------- Boot ----------
  api('/api/me').then(enterChat).catch(showAuth);
})();
