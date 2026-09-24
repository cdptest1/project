const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'chat.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    text_color    TEXT NOT NULL DEFAULT 'default', -- id from public/text-colors.json
    status        TEXT NOT NULL DEFAULT '', -- short profile tagline
    bio           TEXT NOT NULL DEFAULT '', -- "About me"
    location      TEXT NOT NULL DEFAULT '',
    avatar_v      INTEGER NOT NULL DEFAULT 0, -- photo version (updated_at), 0 = no photo
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS avatars (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL, -- image/jpeg | image/png | image/webp
    data       BLOB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'text', -- 'text' | 'sticker' (body = sticker id)
    body       TEXT NOT NULL,
    color      TEXT, -- text colour id, NULL = default
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pins (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pinned_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`);

// Migrate databases created before these columns existed
function addColumn(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");
addColumn('messages', 'color', 'TEXT');
addColumn('users', 'text_color', "TEXT NOT NULL DEFAULT 'default'");
addColumn('users', 'status', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'bio', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'location', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'avatar_v', 'INTEGER NOT NULL DEFAULT 0');

const MESSAGE_COLS = 'm.id, m.kind, m.body, m.color, m.created_at, u.id AS user_id, u.username';

const stmts = {
  createUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  listMembers: db.prepare('SELECT username, status, avatar_v FROM users ORDER BY username COLLATE NOCASE'),

  // Profiles
  profileByName: db.prepare(`
    SELECT u.id, u.username, u.status, u.bio, u.location, u.avatar_v, u.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS message_count,
      (SELECT MAX(created_at) FROM messages m WHERE m.user_id = u.id) AS last_message_at
    FROM users u WHERE u.username = ?`),
  updateProfile: db.prepare('UPDATE users SET status = ?, bio = ?, location = ? WHERE id = ?'),
  setAvatarVersion: db.prepare('UPDATE users SET avatar_v = ? WHERE id = ?'),
  upsertAvatar: db.prepare(`
    INSERT INTO avatars (user_id, type, data) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET type = excluded.type, data = excluded.data`),
  deleteAvatar: db.prepare('DELETE FROM avatars WHERE user_id = ?'),
  avatarByName: db.prepare('SELECT a.type, a.data, u.avatar_v FROM avatars a JOIN users u ON u.id = a.user_id WHERE u.username = ?'),
  createSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare(`
    SELECT u.id, u.username, u.text_color, u.avatar_v FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  setTextColor: db.prepare('UPDATE users SET text_color = ? WHERE id = ?'),
  userTextColor: db.prepare('SELECT text_color FROM users WHERE id = ?'),
  insertMessage: db.prepare('INSERT INTO messages (user_id, kind, body, color, created_at) VALUES (?, ?, ?, ?, ?)'),
  messageExists: db.prepare('SELECT 1 FROM messages WHERE id = ?'),
  recentMessages: db.prepare(`
    SELECT * FROM (
      SELECT ${MESSAGE_COLS}
      FROM messages m JOIN users u ON u.id = m.user_id
      ORDER BY m.id DESC LIMIT ?
    ) ORDER BY id ASC`),
  messagesBefore: db.prepare(`
    SELECT * FROM (
      SELECT ${MESSAGE_COLS}
      FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.id < ?
      ORDER BY m.id DESC LIMIT ?
    ) ORDER BY id ASC`),

  // Pins, newest first
  listPins: db.prepare(`
    SELECT ${MESSAGE_COLS}, pu.username AS pinned_by, p.pinned_at
    FROM pins p
    JOIN messages m ON m.id = p.message_id
    JOIN users u ON u.id = m.user_id
    JOIN users pu ON pu.id = p.pinned_by
    ORDER BY p.pinned_at DESC, p.message_id DESC`),
  insertPin: db.prepare('INSERT OR IGNORE INTO pins (message_id, pinned_by, pinned_at) VALUES (?, ?, ?)'),
  deletePin: db.prepare('DELETE FROM pins WHERE message_id = ?'),
  trimPins: db.prepare(`
    DELETE FROM pins WHERE message_id NOT IN (
      SELECT message_id FROM pins ORDER BY pinned_at DESC, message_id DESC LIMIT ?
    )`),
};

module.exports = { db, stmts };
