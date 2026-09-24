# Group Chat

A WhatsApp-style group chat: everyone who signs up chats in one shared room.

- **Auth**: username + password sign-up and login. Passwords are hashed with bcrypt, and sessions are random tokens stored in the DB and sent as an httpOnly cookie (valid for 7 days).
- **Database**: SQLite (`chat.db`) via Node's built-in `node:sqlite`, so there is nothing native to compile. It stores users, sessions and all chat messages.
- **Realtime**: Socket.IO pushes new messages, shows who is online, and shows "typing…" indicators.
- **History**: the latest 50 messages load on open, and "Load earlier messages" pages further back.

## Run

Requires Node.js 22.5+ (built with Node 26).

```
npm install
npm start
```

Open http://localhost:3000, create an account, then open another browser (or an incognito window) and sign up as a second user to chat.

To let others on your network join, share `http://<your-ip>:3000`. Set `PORT` to change the port and `DB_PATH` to change the database location.

## Files

- `server.js` – Express routes (register/login/logout/me/messages) and the Socket.IO chat server
- `db.js` – SQLite schema and prepared statements
- `public/` – frontend (`index.html`, `style.css`, `app.js`)
