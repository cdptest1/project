const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { stmts } = require('./db');
const { summarise, SUMMARY_SIZE } = require('./summary');
const { RateLimiter, limitRequests } = require('./ratelimit');

const PORT = process.env.PORT || 3000;
// Production is expected to be served over HTTPS: cookies get the Secure flag and HSTS is sent
const SECURE = process.env.NODE_ENV === 'production';
// __Host- cookies must be Secure, so plain-HTTP development keeps the short name
const SESSION_COOKIE = SECURE ? '__Host-sid' : 'sid';
const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'lax', secure: SECURE, path: '/' };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PAGE_SIZE = 50;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_PINS = 3;
const STICKERS = require('./public/stickers/stickers.json');
const STICKER_IDS = new Set(STICKERS.map((s) => s.id));
const STICKER_LABELS = new Map(STICKERS.map((s) => [s.id, s.label]));
const TEXT_COLORS = new Set(require('./public/text-colors.json').map((c) => c.id));
const PROFILE_LIMITS = { status: 80, bio: 500, location: 60 };
const MAX_AVATAR_BYTES = 300 * 1024;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt ignores anything past 72 bytes
const BCRYPT_COST = 12;
const MAX_SOCKETS_PER_USER = 10;
// Control characters (except newline) and bidi overrides, which can spoof how text reads
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARS_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
// Optional comma-separated origins allowed to open sockets, for use behind a proxy that rewrites Host
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);

const limits = {
  loginPerIp: new RateLimiter(30, 15 * 60 * 1000), // every login attempt
  loginFailuresPerUser: new RateLimiter(10, 15 * 60 * 1000), // failed logins per username
  registerPerIp: new RateLimiter(10, 60 * 60 * 1000),
  summaryPerUser: new RateLimiter(5, 60 * 1000),
  postsPerUser: new RateLimiter(10, 10 * 1000), // messages and stickers
  pinsPerUser: new RateLimiter(5, 30 * 1000), // pins and unpins
  colorPerUser: new RateLimiter(10, 10 * 1000),
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { allowRequest: (req, cb) => cb(null, originAllowed(req)) });

// Blocks cross-site WebSocket hijacking. Browsers always send Origin on cross-origin and WebSocket
// requests; a missing Origin means a same-origin GET or a non-browser client, neither of which is a CSWSH risk.
function originAllowed(req) {
  const { origin } = req.headers;
  if (!origin) return true;
  if (ALLOWED_ORIGINS) return ALLOWED_ORIGINS.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Set TRUST_PROXY (e.g. 1 = one proxy hop) when behind a reverse proxy, so req.ip is the real client
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'], // data:/blob: for the avatar crop preview
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      // Upgrading requests would break plain-HTTP use (e.g. sharing http://<your-ip>:3000)
      upgradeInsecureRequests: SECURE ? [] : null,
    },
  },
  strictTransportSecurity: SECURE,
}));

// Only JSON bodies are parsed. With SameSite=Lax cookies this is the CSRF protection, since a
// cross-site form can't send application/json. Add an Origin check before adding other parsers.
// Profile photos arrive as base64 JSON, so that one route gets a larger body limit
app.use('/api/profile/avatar', express.json({ limit: '600kb' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- session helpers ----

// Only a hash of each token is stored, so a copy of the database doesn't hand out live sessions
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const sessionRoom = (tokenHash) => `session:${tokenHash}`;

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  stmts.createSession.run(hashToken(token), userId, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_TTL_MS });
}

function tokenFromCookieHeader(header) {
  for (const part of (header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return null; // malformed percent-encoding, e.g. "sid=%E0"
    }
  }
  return null;
}

function sessionUser(tokenHash) {
  return stmts.sessionUser.get(tokenHash, Date.now()) || null;
}

function userFromCookieHeader(header) {
  const token = tokenFromCookieHeader(header);
  if (!token) return null;
  return sessionUser(hashToken(token));
}

const stripUnsafeChars = (s) => s.replace(UNSAFE_CHARS_RE, '');

function requireAuth(req, res, next) {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

// ---- auth routes ----

function validateCredentials(body) {
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) {
    return { error: 'Username must be 3-20 letters, numbers or underscores' };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` };
  }
  if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) {
    return { error: `Password must be at most ${PASSWORD_MAX_BYTES} bytes` };
  }
  return { username, password };
}

// Compared against when the username doesn't exist, so response time doesn't reveal which names exist
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

app.post('/api/register', limitRequests(limits.registerPerIp, (req) => req.ip), async (req, res) => {
  const creds = validateCredentials(req.body);
  if (creds.error) return res.status(400).json({ error: creds.error });

  if (stmts.userByName.get(creds.username)) {
    return res.status(409).json({ error: 'Username is already taken' });
  }
  const hash = await bcrypt.hash(creds.password, BCRYPT_COST);
  let lastInsertRowid;
  try {
    ({ lastInsertRowid } = stmts.createUser.run(creds.username, hash, Date.now()));
  } catch (err) {
    // Someone else took the name while the password was hashing
    if (err.errcode === 2067 /* SQLITE_CONSTRAINT_UNIQUE */) {
      return res.status(409).json({ error: 'Username is already taken' });
    }
    throw err;
  }
  createSession(res, Number(lastInsertRowid));
  res.json({ id: Number(lastInsertRowid), username: creds.username, text_color: 'default' });
});

const TOO_MANY_LOGINS = 'Too many login attempts. Try again later.';

app.post('/api/login', limitRequests(limits.loginPerIp, (req) => req.ip, TOO_MANY_LOGINS), async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const userKey = username.toLowerCase(); // usernames are case-insensitive
  if (!limits.loginFailuresPerUser.allowed(userKey)) return res.status(429).json({ error: TOO_MANY_LOGINS });

  const user = stmts.userByName.get(username);
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    limits.loginFailuresPerUser.take(userKey);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  createSession(res, user.id);
  res.json({ id: user.id, username: user.username, text_color: user.text_color });
});

app.post('/api/logout', (req, res) => {
  const token = tokenFromCookieHeader(req.headers.cookie);
  if (token) {
    const tokenHash = hashToken(token);
    stmts.deleteSession.run(tokenHash);
    io.in(sessionRoom(tokenHash)).disconnectSockets(true); // end this session's open sockets too
  }
  res.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

// ---- chat history ----

app.get('/api/messages', requireAuth, (req, res) => {
  const before = Number(req.query.before);
  const rows = Number.isInteger(before) && before > 0
    ? stmts.messagesBefore.all(before, PAGE_SIZE)
    : stmts.recentMessages.all(PAGE_SIZE);
  res.json({ messages: rows, hasMore: rows.length === PAGE_SIZE });
});

// Catch-up summary of the latest messages, shown when someone logs in
app.get('/api/summary', requireAuth, limitRequests(limits.summaryPerUser, (req) => req.user.id), async (req, res) => {
  res.json(await summarise(stmts.recentMessages.all(SUMMARY_SIZE), STICKER_LABELS));
});

// ---- profiles ----

// Checks the file's leading bytes so only real JPEG/PNG/WebP images are stored
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function cleanField(value, max, { multiline = false } = {}) {
  if (value === undefined) return { value: '' };
  if (typeof value !== 'string') return { error: 'Invalid value' };
  let v = stripUnsafeChars(value.replace(/\r\n?/g, '\n'));
  v = multiline ? v.replace(/\n{3,}/g, '\n\n') : v.replace(/\s+/g, ' ');
  v = v.trim();
  if (v.length > max) return { error: `Must be ${max} characters or fewer` };
  return { value: v };
}

app.get('/api/users/:username', requireAuth, (req, res) => {
  if (!USERNAME_RE.test(req.params.username)) return res.status(404).json({ error: 'No such user' });
  const p = stmts.profileByName.get(req.params.username);
  if (!p) return res.status(404).json({ error: 'No such user' });
  const { id, ...profile } = p;
  res.json({ ...profile, online: onlineCounts.has(p.username), is_me: id === req.user.id });
});

app.put('/api/profile', requireAuth, (req, res) => {
  const fields = {
    status: cleanField(req.body?.status, PROFILE_LIMITS.status),
    bio: cleanField(req.body?.bio, PROFILE_LIMITS.bio, { multiline: true }),
    location: cleanField(req.body?.location, PROFILE_LIMITS.location),
  };
  for (const [name, f] of Object.entries(fields)) {
    if (f.error) return res.status(400).json({ error: `${name}: ${f.error}` });
  }
  stmts.updateProfile.run(fields.status.value, fields.bio.value, fields.location.value, req.user.id);
  profileChanged(req.user.username);
  res.json({ ok: true });
});

app.put('/api/profile/avatar', requireAuth, (req, res) => {
  const match = /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.data ?? '');
  if (!match) return res.status(400).json({ error: 'Send the photo as a base64 data URL' });
  const buf = Buffer.from(match[1], 'base64');
  if (buf.length > MAX_AVATAR_BYTES) return res.status(413).json({ error: 'Photo is too large (max 300 KB)' });
  const type = imageType(buf);
  if (!type) return res.status(400).json({ error: 'Photo must be a JPEG, PNG or WebP image' });
  stmts.upsertAvatar.run(req.user.id, type, buf);
  const version = Date.now();
  stmts.setAvatarVersion.run(version, req.user.id);
  profileChanged(req.user.username);
  res.json({ ok: true, avatar_v: version });
});

app.delete('/api/profile/avatar', requireAuth, (req, res) => {
  stmts.deleteAvatar.run(req.user.id);
  stmts.setAvatarVersion.run(0, req.user.id);
  profileChanged(req.user.username);
  res.json({ ok: true });
});

app.get('/avatars/:username', requireAuth, (req, res) => {
  const avatar = USERNAME_RE.test(req.params.username) && stmts.avatarByName.get(req.params.username);
  if (!avatar) return res.status(404).end();
  res.set({
    'Content-Type': avatar.type,
    'X-Content-Type-Options': 'nosniff',
    // URLs carry ?v=<version>, so a changed photo gets a new URL
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  res.send(Buffer.from(avatar.data));
});

// Tell everyone a profile changed (member list avatars/status, open profile pages)
function profileChanged(username) {
  broadcastPresence();
  io.emit('profile', username);
}

// ---- realtime ----

const onlineCounts = new Map(); // username -> number of open sockets
let lastPinAt = 0;
let presenceTimer = null;

// Batched, so a burst of connects/disconnects sends one member list instead of one each
function broadcastPresence() {
  presenceTimer ??= setTimeout(() => {
    presenceTimer = null;
    io.emit('presence', {
      online: [...onlineCounts.keys()].sort(),
      members: stmts.listMembers.all(), // everyone registered: { username, status, avatar_v }
    });
  }, 250);
}

io.use((socket, next) => {
  try {
    const token = tokenFromCookieHeader(socket.handshake.headers.cookie);
    const tokenHash = token && hashToken(token);
    const user = tokenHash && sessionUser(tokenHash);
    if (!user) return next(new Error('unauthorized'));
    if ((onlineCounts.get(user.username) || 0) >= MAX_SOCKETS_PER_USER) {
      return next(new Error('too many connections'));
    }
    socket.data.user = user;
    socket.data.tokenHash = tokenHash;
    next();
  } catch (err) {
    console.error('Socket auth failed:', err);
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const { user, tokenHash } = socket.data;
  socket.join(sessionRoom(tokenHash)); // so logout can disconnect it
  onlineCounts.set(user.username, (onlineCounts.get(user.username) || 0) + 1);
  broadcastPresence();

  const reply = (ack, payload) => typeof ack === 'function' && ack(payload);
  const slowDown = (ack) => reply(ack, { error: 'You are doing that too often. Slow down a little.' });
  let lastTypingAt = 0;

  // Drop events from a socket whose session has expired or been logged out
  socket.use((packet, next) => {
    if (sessionUser(tokenHash)) return next();
    socket.disconnect(true);
  });

  // Send current pins to this client (also re-sent on every reconnect)
  socket.emit('pins', stmts.listPins.all());

  function post(kind, body, ack, requestedColor) {
    const createdAt = Date.now();
    let color = null;
    if (kind === 'text') {
      // The client sends the colour it is showing, so what you see is what gets sent.
      // Fall back to the saved preference for clients that don't send one.
      const textColor = requestedColor ?? stmts.userTextColor.get(user.id)?.text_color;
      if (requestedColor) stmts.setTextColor.run(requestedColor, user.id); // keep saved preference in sync
      color = textColor && textColor !== 'default' ? textColor : null;
    }
    const { lastInsertRowid } = stmts.insertMessage.run(user.id, kind, body, color, createdAt);
    io.emit('message', {
      id: Number(lastInsertRowid),
      kind,
      body,
      color,
      created_at: createdAt,
      user_id: user.id,
      username: user.username,
    });
    if (typeof ack === 'function') ack({ ok: true });
  }

  // Payload is { text, color } (or a plain string from older clients)
  socket.on('message', (payload, ack) => {
    const text = typeof payload === 'string' ? payload : payload?.text;
    const body = typeof text === 'string' ? stripUnsafeChars(text).trim() : '';
    if (!body || body.length > MAX_MESSAGE_LENGTH) {
      return typeof ack === 'function' && ack({ error: 'Invalid message' });
    }
    if (!limits.postsPerUser.take(user.id)) return slowDown(ack);
    const color = TEXT_COLORS.has(payload?.color) ? payload.color : undefined;
    post('text', body, ack, color);
  });

  socket.on('sticker', (id, ack) => {
    if (!STICKER_IDS.has(id)) {
      return typeof ack === 'function' && ack({ error: 'Unknown sticker' });
    }
    if (!limits.postsPerUser.take(user.id)) return slowDown(ack);
    post('sticker', id, ack);
  });

  socket.on('set-color', (color, ack) => {
    if (!TEXT_COLORS.has(color)) return reply(ack, { error: 'Unknown colour' });
    if (!limits.colorPerUser.take(user.id)) return slowDown(ack);
    stmts.setTextColor.run(color, user.id);
    reply(ack, { ok: true });
  });

  // Pins are a shared board by design (anyone can pin or unpin), so both are rate limited and unpins are logged
  socket.on('pin', (id, ack) => {
    if (!Number.isInteger(id) || !stmts.messageExists.get(id)) {
      return reply(ack, { error: 'Message not found' });
    }
    if (!limits.pinsPerUser.take(user.id)) return slowDown(ack);
    // Strictly increasing so pin order is exact even for pins in the same millisecond
    lastPinAt = Math.max(Date.now(), lastPinAt + 1);
    stmts.insertPin.run(id, user.id, lastPinAt);
    stmts.trimPins.run(MAX_PINS); // pinning past the limit drops the oldest pin
    io.emit('pins', stmts.listPins.all());
    reply(ack, { ok: true });
  });

  socket.on('unpin', (id, ack) => {
    if (!Number.isInteger(id)) return reply(ack, { error: 'Message not found' });
    if (!limits.pinsPerUser.take(user.id)) return slowDown(ack);
    if (stmts.deletePin.run(id).changes) {
      console.log(`${user.username} unpinned message ${id}`);
      io.emit('pins', stmts.listPins.all());
    }
    reply(ack, { ok: true });
  });

  socket.on('typing', () => {
    const now = Date.now();
    if (now - lastTypingAt < 1000) return; // clients send at most one every 1.5 s
    lastTypingAt = now;
    socket.broadcast.emit('typing', user.username);
  });

  socket.on('disconnect', () => {
    const n = (onlineCounts.get(user.username) || 1) - 1;
    if (n <= 0) onlineCounts.delete(user.username);
    else onlineCounts.set(user.username, n);
    broadcastPresence();
  });
});

// Last in the chain: errors (bad JSON, unexpected failures) get a JSON reply with no stack trace
// eslint-disable-next-line no-unused-vars -- Express needs all four arguments to treat this as an error handler
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : 'Bad request' });
});

// Clean up expired sessions hourly
setInterval(() => stmts.purgeSessions.run(Date.now()), 60 * 60 * 1000).unref();

// Disconnect sockets whose session expired while they sat idle
setInterval(() => {
  for (const socket of io.of('/').sockets.values()) {
    if (!sessionUser(socket.data.tokenHash)) socket.disconnect(true);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Chat server running at http://localhost:${PORT}`);
});
