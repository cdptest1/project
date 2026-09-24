const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { stmts } = require('./db');

const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PAGE_SIZE = 50;
const MAX_MESSAGE_LENGTH = 2000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return { error: 'Username must be 3-20 letters, numbers or underscores' };
  }
  if (password.length < 6) return { error: 'Password must be at least 6 characters' };
  return { username, password };
}

app.post('/api/register', (req, res) => {
  const creds = validateCredentials(req.body);
  if (creds.error) return res.status(400).json({ error: creds.error });

  if (stmts.userByName.get(creds.username)) {
    return res.status(409).json({ error: 'Username is already taken' });
  }
  const hash = bcrypt.hashSync(creds.password, 10);
  const { lastInsertRowid } = stmts.createUser.run(creds.username, hash, Date.now());
  createSession(res, Number(lastInsertRowid));
  res.json({ id: Number(lastInsertRowid), username: creds.username });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = stmts.userByName.get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  createSession(res, user.id);
  res.json({ id: user.id, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const token = tokenFromCookieHeader(req.headers.cookie);
  if (token) stmts.deleteSession.run(token);
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

// ---- realtime ----

const onlineCounts = new Map(); // username -> number of open sockets

function broadcastPresence() {
  io.emit('presence', [...onlineCounts.keys()].sort());
}

io.use((socket, next) => {
  const user = userFromCookieHeader(socket.handshake.headers.cookie);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const { user } = socket.data;
  onlineCounts.set(user.username, (onlineCounts.get(user.username) || 0) + 1);
  broadcastPresence();

  socket.on('message', (text, ack) => {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body || body.length > MAX_MESSAGE_LENGTH) {
      return typeof ack === 'function' && ack({ error: 'Invalid message' });
    }
    const createdAt = Date.now();
    const { lastInsertRowid } = stmts.insertMessage.run(user.id, body, createdAt);
    const msg = {
      id: Number(lastInsertRowid),
      body,
      created_at: createdAt,
      user_id: user.id,
      username: user.username,
    };
    io.emit('message', msg);
    if (typeof ack === 'function') ack({ ok: true });
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

// Clean up expired sessions hourly
setInterval(() => stmts.purgeSessions.run(Date.now()), 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Chat server running at http://localhost:${PORT}`);
});
