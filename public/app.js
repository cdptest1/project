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
  const chatEl = $('#chat-view');
  const peopleToggle = $('#people-toggle');
  const peopleList = $('#people-list');
  const stickerTray = $('#sticker-tray');
  const stickerToggle = $('#sticker-toggle');
  const colorMenu = $('#color-menu');
  const colorToggle = $('#color-toggle');
  const pinnedBar = $('#pinned-bar');

  let mode = 'login';
  let me = null;
  let socket = null;
  let oldestId = null;
  let lastRendered = null; // last message appended at the bottom
  let rendered = []; // all messages on screen, oldest first
  let online = [];
  const typingUsers = new Map(); // username -> timeout id
  let stickers = new Map(); // id -> { id, label }
  let textColors = [{ id: 'default', label: 'Default' }];
  let pins = []; // pinned messages, newest first
  let pinnedIds = new Set();
  let pinIndex = 0; // which pin the bar is showing

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
    summaryRequest++;
    summaryCard.classList.add('hidden');
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
    applyMyColor(user.text_color);
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
    showSummary();
  }

  // ---------- Catch-up summary ----------
  const summaryCard = $('#summary-card');
  let summaryRequest = 0; // ignore responses for a previous login

  async function showSummary() {
    const req = ++summaryRequest;
    summaryCard.className = 'summary-card loading';
    $('#summary-meta').textContent = '';
    $('#summary-text').textContent = 'Summarising the latest messages';
    let data;
    try {
      data = await api('/api/summary');
    } catch {
      data = { unavailable: true, reason: 'Could not load the summary.' };
    }
    if (req !== summaryRequest || !me) return;
    if (!data.unavailable && !data.summary) {
      summaryCard.classList.add('hidden'); // nothing to summarise yet
      return;
    }
    summaryCard.className = `summary-card${data.unavailable ? ' unavailable' : ''}`;
    if (data.count) {
      const t = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      $('#summary-meta').textContent = `Last ${data.count} message${data.count === 1 ? '' : 's'} · ${t(data.from)} – ${t(data.to)}`;
    }
    $('#summary-text').textContent = data.unavailable ? data.reason : data.summary;
  }

  $('#summary-close').addEventListener('click', () => {
    summaryRequest++;
    summaryCard.classList.add('hidden');
  });

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

    socket.on('pins', updatePins);

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
    renderPeople();
    if (typingUsers.size) {
      const names = [...typingUsers.keys()];
      statusLine.textContent = names.length === 1
        ? `${names[0]} is typing…`
        : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ' and others' : ''} are typing…`;
      return;
    }
    statusLine.textContent = online.length
      ? sortedOnline().map((n) => (n === me.username ? 'You' : n)).join(', ')
      : 'connected';
  }

  // ---------- People online ----------
  // You first, then everyone else alphabetically
  const sortedOnline = () => [
    ...online.filter((n) => n === me?.username),
    ...online.filter((n) => n !== me?.username),
  ];

  function renderPeople() {
    $('#online-count').textContent = online.length;
    $('#online-count-panel').textContent = online.length;
    peopleList.replaceChildren(...sortedOnline().map((name) => {
      const li = document.createElement('li');
      li.className = 'person';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.style.background = colorFor(name);
      avatar.textContent = name[0];

      const info = document.createElement('div');
      const nameEl = document.createElement('div');
      nameEl.className = 'person-name';
      nameEl.textContent = name;
      if (name === me.username) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = ' (you)';
        nameEl.appendChild(you);
      }
      const sub = document.createElement('div');
      const typing = typingUsers.has(name);
      sub.className = `person-sub${typing ? ' typing' : ''}`;
      sub.textContent = typing ? 'typing…' : 'online';
      info.append(nameEl, sub);

      li.append(avatar, info);
      return li;
    }));
  }

  function setPeopleOpen(open) {
    chatEl.classList.toggle('people-open', open);
    peopleToggle.setAttribute('aria-expanded', String(open));
  }

  // Panel starts open on wide screens, closed on phones
  setPeopleOpen(window.matchMedia('(min-width: 901px)').matches);
  peopleToggle.addEventListener('click', () => setPeopleOpen(!chatEl.classList.contains('people-open')));
  $('#people-close').addEventListener('click', () => setPeopleOpen(false));

  // Loads the previous page of history; returns whether even older messages exist
  async function loadOlder() {
    if (!oldestId) return false;
    loadMoreBtn.disabled = true;
    try {
      const { messages, hasMore } = await api(`/api/messages?before=${oldestId}`);
      const prevHeight = messagesEl.scrollHeight;
      prependMessages(messages);
      oldestId = messages[0]?.id ?? oldestId;
      loadMoreBtn.classList.toggle('hidden', !hasMore);
      messagesEl.scrollTop += messagesEl.scrollHeight - prevHeight; // keep position
      return hasMore;
    } finally {
      loadMoreBtn.disabled = false;
    }
  }

  loadMoreBtn.addEventListener('click', loadOlder);

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
    const isSticker = msg.kind === 'sticker';
    el.className = `msg${mine ? ' mine' : ''}${first ? ' first' : ''}${isSticker ? ' sticker' : ''}`;
    el.classList.toggle('pinned', pinnedIds.has(msg.id));
    el.dataset.id = msg.id;

    if (first && !mine) {
      const author = document.createElement('div');
      author.className = 'author';
      author.textContent = msg.username;
      author.style.color = colorFor(msg.username);
      el.appendChild(author);
    }

    if (isSticker) {
      el.appendChild(stickerImg(msg.body));
    } else {
      const body = document.createElement('span');
      body.className = `body ${colorClass(msg.color)}`;
      body.textContent = msg.body; // textContent = no XSS
      el.appendChild(body);
    }

    const time = document.createElement('span');
    time.className = 'time';
    const mark = document.createElement('span');
    mark.className = 'pin-mark';
    mark.appendChild(pinIcon());
    time.append(mark, new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    el.appendChild(time);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'msg-action';
    action.appendChild(pinIcon());
    setActionLabel(action, pinnedIds.has(msg.id));
    el.appendChild(action);

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

  // ---------- Pinned messages ----------
  const pinIconTpl = $('#pin-icon');
  const pinIcon = () => pinIconTpl.content.firstElementChild.cloneNode(true);

  function setActionLabel(btn, pinned) {
    btn.title = pinned ? 'Unpin message' : 'Pin message';
    btn.setAttribute('aria-label', btn.title);
  }

  function preview(msg) {
    if (msg.kind === 'sticker') return `Sticker: ${stickers.get(msg.body)?.label ?? msg.body}`;
    return msg.body.replace(/\s+/g, ' ');
  }

  function updatePins(list) {
    pins = list;
    pinnedIds = new Set(list.map((p) => p.id));
    if (pinIndex >= pins.length) pinIndex = 0;
    messagesEl.querySelectorAll('.msg').forEach((el) => {
      const pinned = pinnedIds.has(Number(el.dataset.id));
      el.classList.toggle('pinned', pinned);
      setActionLabel(el.querySelector('.msg-action'), pinned);
    });
    renderPinnedBar();
  }

  function renderPinnedBar() {
    pinnedBar.classList.toggle('hidden', pins.length === 0);
    if (!pins.length) return;
    const pin = pins[pinIndex];

    $('#pin-indicator').replaceChildren(...pins.map((_, i) => {
      const seg = document.createElement('span');
      if (i === pinIndex) seg.className = 'active';
      return seg;
    }));
    $('#pinned-heading').textContent = pins.length > 1
      ? `Pinned message ${pinIndex + 1} of ${pins.length}`
      : 'Pinned message';

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${pin.user_id === me.id ? 'You' : pin.username}: `;
    const text = document.createElement('span');
    text.className = colorClass(pin.color);
    text.textContent = preview(pin);
    $('#pinned-text').replaceChildren(who, text);
    $('#pinned-open').title = `Pinned by ${pin.pinned_by === me.username ? 'you' : pin.pinned_by} — click to view`;
  }

  // Click the bar: jump to the pin it shows, then advance to the next one
  $('#pinned-open').addEventListener('click', async () => {
    const pin = pins[pinIndex];
    if (!pin) return;
    if (pins.length > 1) {
      pinIndex = (pinIndex + 1) % pins.length;
      renderPinnedBar();
    }
    await scrollToMessage(pin.id);
  });

  $('#pinned-unpin').addEventListener('click', () => {
    const pin = pins[pinIndex];
    if (pin) togglePin(pin.id);
  });

  async function scrollToMessage(id) {
    const find = () => messagesEl.querySelector(`.msg[data-id="${id}"]`);
    // Older pins may not be loaded yet — page back through history until found
    while (!find() && oldestId && oldestId > id) {
      if (!(await loadOlder())) break;
    }
    const el = find();
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }

  function togglePin(id) {
    if (!socket) return;
    socket.emit(pinnedIds.has(id) ? 'unpin' : 'pin', id, (res) => {
      if (res?.error) alert(res.error);
    });
  }

  messagesEl.addEventListener('click', (e) => {
    const action = e.target.closest('.msg-action');
    const msgEl = e.target.closest('.msg');
    if (action) {
      togglePin(Number(msgEl.dataset.id));
      msgEl.classList.remove('show-actions');
      return;
    }
    // Tap a message to reveal its pin button (touch screens have no hover)
    messagesEl.querySelectorAll('.msg.show-actions').forEach((el) => el !== msgEl && el.classList.remove('show-actions'));
    if (msgEl) msgEl.classList.toggle('show-actions');
  });

  // ---------- Font colour ----------
  const knownColor = (id) => textColors.some((c) => c.id === id);
  const colorClass = (id) => (id && id !== 'default' && knownColor(id) ? `tc-${id}` : '');

  function applyMyColor(id) {
    const color = knownColor(id) ? id : 'default';
    if (me) me.text_color = color;
    input.className = colorClass(color);
    $('#color-bar').className = `color-bar tc-${color}`;
    document.querySelectorAll('.swatch').forEach((sw) => {
      sw.setAttribute('aria-checked', String(sw.dataset.id === color));
    });
  }

  async function loadTextColors() {
    textColors = await fetch('/text-colors.json').then((r) => r.json());
    $('#color-grid').replaceChildren(...textColors.map((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `swatch tc-${c.id}`;
      btn.dataset.id = c.id;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      const dot = document.createElement('span');
      dot.className = 'dot';
      btn.append(dot, c.label);
      return btn;
    }));
  }

  $('#color-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (!btn || !socket) return;
    const previous = me.text_color;
    applyMyColor(btn.dataset.id); // optimistic
    socket.emit('set-color', btn.dataset.id, (res) => {
      if (res?.error) { applyMyColor(previous); alert(res.error); }
    });
    setPopover(null);
    input.focus();
  });

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
    // Send the colour shown in the input so the message always matches it
    socket.emit('message', { text, color: me.text_color }, (res) => {
      if (res?.error) alert(res.error);
    });
    input.value = '';
    autoGrow();
    input.focus();
  });

  // ---------- Stickers ----------
  function stickerImg(id) {
    const img = document.createElement('img');
    img.src = `/stickers/${encodeURIComponent(id)}.svg`;
    img.alt = stickers.get(id)?.label ?? 'Sticker';
    img.title = img.alt;
    img.draggable = false;
    return img;
  }

  async function loadStickers() {
    const list = await fetch('/stickers/stickers.json').then((r) => r.json());
    stickers = new Map(list.map((s) => [s.id, s]));
    $('#sticker-grid').replaceChildren(...list.map((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.id = s.id;
      btn.setAttribute('aria-label', `Send ${s.label} sticker`);
      btn.appendChild(stickerImg(s.id));
      return btn;
    }));
  }

  // ---------- Popovers (sticker tray, colour menu) ----------
  const popovers = [
    { panel: stickerTray, toggle: stickerToggle },
    { panel: colorMenu, toggle: colorToggle },
  ];

  // Opens the given panel (or none) and closes the rest
  function setPopover(panel) {
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    for (const p of popovers) {
      const open = p.panel === panel;
      p.panel.classList.toggle('hidden', !open);
      p.toggle.setAttribute('aria-expanded', String(open));
    }
    if (panel && nearBottom) scrollToBottom();
  }

  for (const p of popovers) {
    p.toggle.addEventListener('click', () => setPopover(p.panel.classList.contains('hidden') ? p.panel : null));
  }

  $('#sticker-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn || !socket) return;
    socket.emit('sticker', btn.dataset.id, (res) => {
      if (res?.error) alert(res.error);
    });
    setPopover(null);
    input.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (popovers.some((p) => !p.panel.classList.contains('hidden'))) setPopover(null);
    else if (window.matchMedia('(max-width: 900px)').matches) setPeopleOpen(false);
  });

  document.addEventListener('click', (e) => {
    const inside = popovers.some((p) => p.panel.contains(e.target) || p.toggle.contains(e.target));
    if (!inside) setPopover(null);
  });

  // ---------- Boot ----------
  // Stickers and colours must be known before history renders
  Promise.all([loadStickers(), loadTextColors()])
    .catch(() => {})
    .then(() => api('/api/me'))
    .then(enterChat, showAuth);
})();
