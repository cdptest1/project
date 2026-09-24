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
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`);

const stmts = {
  createUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  createSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare(`
    SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  insertMessage: db.prepare('INSERT INTO messages (user_id, body, created_at) VALUES (?, ?, ?)'),
  recentMessages: db.prepare(`
    SELECT * FROM (
      SELECT m.id, m.body, m.created_at, u.id AS user_id, u.username
      FROM messages m JOIN users u ON u.id = m.user_id
      ORDER BY m.id DESC LIMIT ?
    ) ORDER BY id ASC`),
  messagesBefore: db.prepare(`
    SELECT * FROM (
      SELECT m.id, m.body, m.created_at, u.id AS user_id, u.username
      FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.id < ?
      ORDER BY m.id DESC LIMIT ?
    ) ORDER BY id ASC`),
};

module.exports = { db, stmts };
