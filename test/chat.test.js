const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbPath = path.join(os.tmpdir(), `chat-test-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.AUTH_RATE_LIMIT = '25';
const { server, io } = require('../server');
const { db } = require('../db');
const bcrypt = require('bcryptjs');
const { io: connect } = require('socket.io-client');

let base;
before(() => new Promise((r) => server.listen(0, () => {
  base = `http://localhost:${server.address().port}`;
  r();
})));
after(() => {
  io.close();
  server.close();
  db.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
});

const post = (route, body, headers = {}) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];

async function register(username, password = 'secret1') {
  const res = await post('/api/register', { username, password });
  return { res, cookie: cookieOf(res) };
}

async function login(username, password = 'secret1') {
  const res = await post('/api/login', { username, password });
  return { res, cookie: cookieOf(res) };
}

const sock = (cookie, extraHeaders = {}) => new Promise((resolve, reject) => {
  const s = connect(base, {
    transports: ['websocket'],
    extraHeaders: { Cookie: cookie, ...extraHeaders },
    forceNew: true,
    reconnection: false,
  });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});

const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)),
]);

test('logout disconnects every socket on that session (Bug 1)', async () => {
  const { cookie } = await register('leaver');
  const [tab1, tab2] = await Promise.all([sock(cookie), sock(cookie)]);
  const closed = [tab1, tab2].map((s) => new Promise((r) => s.on('disconnect', r)));
  await post('/api/logout', {}, { Cookie: cookie });
  assert.deepEqual(await within(Promise.all(closed), 2000, 'sockets closing'), ['io server disconnect', 'io server disconnect']);
});

test('logout leaves other sessions of the same user connected (Bug 1)', async () => {
  const { cookie: a } = await register('twodevices');
  const { cookie: b } = await login('twodevices');
  const [sa, sb] = await Promise.all([sock(a), sock(b)]);
  const closed = new Promise((r) => sa.on('disconnect', r));
  await post('/api/logout', {}, { Cookie: a });
  await within(closed, 2000, 'logged-out socket closing');
  assert.deepEqual(await sb.emitWithAck('message', 'still here'), { ok: true });
  sb.close();
});

test('a socket whose session expired is dropped on its next event (Bug 1)', async () => {
  const { cookie } = await register('expirer');
  const s = await sock(cookie);
  db.prepare('UPDATE sessions SET expires_at = 0 WHERE token = ?').run(cookie.split('=')[1]);
  const closed = new Promise((r) => s.on('disconnect', r));
  s.emit('message', 'too late');
  assert.equal(await within(closed, 2000, 'expired socket closing'), 'io server disconnect');
});

test('password hashing does not block other requests (Bug 2)', async () => {
  const signups = Array.from({ length: 8 }, (_, i) => register(`load${i}`));
  const t0 = performance.now();
  await fetch(`${base}/style.css`);
  const elapsed = performance.now() - t0;
  await Promise.all(signups);
  assert.ok(elapsed < 250, `static file took ${elapsed.toFixed(0)} ms during signups`);
});

test('partial profile update keeps the other fields (Bug 3)', async () => {
  const { cookie } = await register('profiler');
  const put = (body) => fetch(`${base}/api/profile`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await put({ status: 's', bio: 'b', location: 'L' });
  assert.equal((await put({ status: 'new' })).status, 200);
  const p = await (await fetch(`${base}/api/users/profiler`, { headers: { Cookie: cookie } })).json();
  assert.equal(p.status, 'new');
  assert.equal(p.bio, 'b');
  assert.equal(p.location, 'L');
  await put({ bio: '' }); // an empty string still clears a field
  const p2 = await (await fetch(`${base}/api/users/profiler`, { headers: { Cookie: cookie } })).json();
  assert.equal(p2.bio, '');
  assert.equal(p2.location, 'L');
});

test('passwords longer than 72 bytes are checked in full (Bug 4)', async () => {
  const pw = `${'p'.repeat(72)}AAAA`;
  assert.equal((await register('longpw', pw)).res.status, 200);
  assert.equal((await login('longpw', `${'p'.repeat(72)}ZZZZ`)).res.status, 401);
  assert.equal((await login('longpw', pw)).res.status, 200);
  assert.equal((await register('hugepw', 'x'.repeat(257))).res.status, 400);
});

test('bcrypt accounts still log in and are upgraded to scrypt (Bug 2/4)', async () => {
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run('legacy', bcrypt.hashSync('oldpass1', 4), Date.now());
  assert.equal((await login('legacy', 'wrong')).res.status, 401);
  assert.equal((await login('legacy', 'oldpass1')).res.status, 200);
  const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('legacy');
  assert.match(password_hash, /^scrypt\$/);
  assert.equal((await login('legacy', 'oldpass1')).res.status, 200);
});

test('bad bodies get JSON errors, not an HTML stack trace (Bug 5)', async () => {
  const bad = await post('/api/login', '{bad');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'Invalid JSON' });

  const { cookie } = await register('bigphoto');
  const big = await fetch(`${base}/api/profile/avatar`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: `data:image/png;base64,${'A'.repeat(700 * 1024)}` }),
  });
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'Request is too large' });
});

test('cross-origin socket handshakes are refused (Bug 6)', async () => {
  const { cookie } = await register('origin');
  await assert.rejects(sock(cookie, { Origin: 'http://evil.example' }));
  const ok = await sock(cookie, { Origin: base });
  ok.close();
});

test('messages are validated, and unknown colours are rejected', async () => {
  const { cookie: ca } = await register('msg_a');
  const { cookie: cb } = await register('msg_b');
  const [a, b] = await Promise.all([sock(ca), sock(cb)]);
  const received = new Promise((r) => b.on('message', r));
  assert.deepEqual(await a.emitWithAck('message', '   '), { error: 'Invalid message' });
  assert.deepEqual(await a.emitWithAck('message', { text: 'x', color: 'nope' }), { error: 'Unknown colour' });
  assert.deepEqual(await a.emitWithAck('message', { text: ' hi ', color: 'red' }), { ok: true });
  const msg = await received;
  assert.equal(msg.body, 'hi');
  assert.equal(msg.color, 'red');
  a.close();
  b.close();
});

// Runs last: it uses up this IP's login allowance
test('repeated failed logins are rate limited (Bug 2)', async () => {
  await register('target');
  let last;
  for (let i = 0; i < 26; i++) last = await login('target', `wrong${i}`);
  assert.equal(last.res.status, 429);
  assert.equal((await login('target')).res.status, 429);
});
