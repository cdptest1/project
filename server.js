const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { stmts } = require('./db');
const { summarise, SUMMARY_SIZE } = require('./summary');

const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'sid';
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
const MAX_PASSWORD_BYTES = 256;
const AUTH_RATE_LIMIT = Number(process.env.AUTH_RATE_LIMIT) || 10; // attempts per window
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Refuse cross-origin handshakes. Same-origin polling requests may omit Origin.
  allowRequest: (req, cb) => cb(null, !req.headers.origin || originMatchesHost(req)),
});

function originMatchesHost(req) {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Profile photos arrive as base64 JSON, so that one route gets a larger body limit
app.use('/api/profile/avatar', express.json({ limit: '600kb' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- session helpers ----

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  stmts.createSession.run(token, userId, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
  });
}

function tokenFromCookieHeader(header) {
  for (const part of (header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function userFromCookieHeader(header) {
  const token = tokenFromCookieHeader(header);
  if (!token) return null;
  return stmts.sessionUser.get(token, Date.now()) || null;
}

// Each socket joins a room named after its session, so a session's sockets can be closed together
const sessionRoom = (token) => `sid:${token}`;

function disconnectSession(token) {
  io.in(sessionRoom(token)).disconnectSockets(true);
}

function requireAuth(req, res, next) {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

// ---- passwords ----

// scrypt runs in the libuv threadpool, so hashing doesn't block chat traffic
const scrypt = promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Returns { ok, rehash }. Accounts created before the switch to scrypt still have bcrypt hashes.
async function verifyPassword(password, stored) {
  if (stored.startsWith('scrypt$')) {
    const [, salt, key] = stored.split('$');
    const expected = Buffer.from(key, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
    return { ok: crypto.timingSafeEqual(actual, expected), rehash: false };
  }
  const ok = await bcrypt.compare(password, stored);
  // bcrypt ignores bytes past 72, so only upgrade when the whole password was checked
  return { ok, rehash: ok && Buffer.byteLength(password) <= 72 };
}

// ---- rate limiting ----

const rateBuckets = new Map(); // key -> { count, resetAt }

function overLimit(key) {
  const b = rateBuckets.get(key);
  return !!b && b.resetAt > Date.now() && b.count >= AUTH_RATE_LIMIT;
}

function hit(key) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) rateBuckets.set(key, { count: 1, resetAt: now + AUTH_RATE_WINDOW_MS });
  else b.count++;
}

const tooMany = (res) => res.status(429).json({ error: 'Too many attempts, try again later' });

// ---- auth routes ----

function validateCredentials(body) {
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) {
    return { error: 'Username must be 3-20 letters, numbers or underscores' };
  }
  if (password.length < 6) return { error: 'Password must be at least 6 characters' };
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    return { error: `Password must be ${MAX_PASSWORD_BYTES} bytes or fewer` };
  }
  return { username, password };
}

app.post('/api/register', async (req, res) => {
  const ipKey = `register:${req.ip}`;
  if (overLimit(ipKey)) return tooMany(res);
  const creds = validateCredentials(req.body);
  if (creds.error) return res.status(400).json({ error: creds.error });

  if (stmts.userByName.get(creds.username)) {
    return res.status(409).json({ error: 'Username is already taken' });
  }
  hit(ipKey);
  const hash = await hashPassword(creds.password);
  // Another request may have taken the name while this one was hashing
  if (stmts.userByName.get(creds.username)) {
    return res.status(409).json({ error: 'Username is already taken' });
  }
  const { lastInsertRowid } = stmts.createUser.run(creds.username, hash, Date.now());
  createSession(res, Number(lastInsertRowid));
  res.json({ id: Number(lastInsertRowid), username: creds.username, text_color: 'default' });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const ipKey = `login:${req.ip}`;
  const userKey = `login-user:${username.toLowerCase()}`;
  if (overLimit(ipKey) || overLimit(userKey)) return tooMany(res);

  const user = Buffer.byteLength(password) <= MAX_PASSWORD_BYTES && stmts.userByName.get(username);
  const check = user ? await verifyPassword(password, user.password_hash) : { ok: false };
  if (!check.ok) {
    hit(ipKey);
    hit(userKey);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  rateBuckets.delete(userKey);
  if (check.rehash) stmts.setPasswordHash.run(await hashPassword(password), user.id);
  createSession(res, user.id);
  res.json({ id: user.id, username: user.username, text_color: user.text_color });
});

app.post('/api/logout', (req, res) => {
  const token = tokenFromCookieHeader(req.headers.cookie);
  if (token) {
    stmts.deleteSession.run(token);
    disconnectSession(token); // other tabs on this session stop receiving chat too
  }
  res.clearCookie(SESSION_COOKIE);
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
app.get('/api/summary', requireAuth, async (req, res) => {
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

// A missing field gives null, which updateProfile treats as "leave unchanged"
function cleanField(value, max, { multiline = false } = {}) {
  if (value === undefined) return { value: null };
  if (typeof value !== 'string') return { error: 'Invalid value' };
  let v = value.replace(/\r\n?/g, '\n');
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

function broadcastPresence() {
  io.emit('presence', {
    online: [...onlineCounts.keys()].sort(),
    members: stmts.listMembers.all(), // everyone registered: { username, status, avatar_v }
  });
}

io.use((socket, next) => {
  const token = tokenFromCookieHeader(socket.handshake.headers.cookie);
  const user = token && stmts.sessionUser.get(token, Date.now());
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  socket.data.token = token;
  next();
});

io.on('connection', (socket) => {
  const { user, token } = socket.data;
  socket.join(sessionRoom(token));

  // Drop the socket if its session has expired or been deleted since the handshake
  socket.use((packet, next) => {
    if (stmts.sessionUser.get(token, Date.now())) return next();
    socket.disconnect(true);
  });
  onlineCounts.set(user.username, (onlineCounts.get(user.username) || 0) + 1);
  broadcastPresence();

  const reply = (ack, payload) => typeof ack === 'function' && ack(payload);

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
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body || body.length > MAX_MESSAGE_LENGTH) {
      return typeof ack === 'function' && ack({ error: 'Invalid message' });
    }
    const color = typeof payload === 'string' ? undefined : payload?.color;
    if (color !== undefined && !TEXT_COLORS.has(color)) return reply(ack, { error: 'Unknown colour' });
    post('text', body, ack, color);
  });

  socket.on('sticker', (id, ack) => {
    if (!STICKER_IDS.has(id)) {
      return typeof ack === 'function' && ack({ error: 'Unknown sticker' });
    }
    post('sticker', id, ack);
  });

  socket.on('set-color', (color, ack) => {
    if (!TEXT_COLORS.has(color)) return reply(ack, { error: 'Unknown colour' });
    stmts.setTextColor.run(color, user.id);
    reply(ack, { ok: true });
  });

  socket.on('pin', (id, ack) => {
    if (!Number.isInteger(id) || !stmts.messageExists.get(id)) {
      return reply(ack, { error: 'Message not found' });
    }
    // Strictly increasing so pin order is exact even for pins in the same millisecond
    lastPinAt = Math.max(Date.now(), lastPinAt + 1);
    stmts.insertPin.run(id, user.id, lastPinAt);
    stmts.trimPins.run(MAX_PINS); // pinning past the limit drops the oldest pin
    io.emit('pins', stmts.listPins.all());
    reply(ack, { ok: true });
  });

  socket.on('unpin', (id, ack) => {
    if (!Number.isInteger(id)) return reply(ack, { error: 'Message not found' });
    stmts.deletePin.run(id);
    io.emit('pins', stmts.listPins.all());
    reply(ack, { ok: true });
  });

  socket.on('typing', () => {
    socket.broadcast.emit('typing', user.username);
  });

  socket.on('disconnect', () => {
    const n = (onlineCounts.get(user.username) || 1) - 1;
    if (n <= 0) onlineCounts.delete(user.username);
    else onlineCounts.set(user.username, n);
    broadcastPresence();
  });
});

// Body-parser and other errors get JSON, not Express's default HTML page with a stack trace
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message = status === 413 ? 'Request is too large'
    : err.type === 'entity.parse.failed' ? 'Invalid JSON'
    : err.expose ? err.message : 'Server error';
  res.status(status).json({ error: message });
});

// Hourly: close sockets on expired sessions, delete those sessions and drop stale rate-limit buckets
setInterval(() => {
  const now = Date.now();
  for (const { token } of stmts.expiredSessions.all(now)) disconnectSession(token);
  stmts.purgeSessions.run(now);
  for (const [key, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(key);
}, 60 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Chat server running at http://localhost:${PORT}`);
  });
}

module.exports = { app, server, io };
