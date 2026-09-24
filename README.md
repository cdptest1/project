# Group Chat

A WhatsApp-style group chat: everyone who signs up chats in one shared room.

- **Auth**: username + password sign-up and login. Passwords are hashed with bcrypt, and sessions are random tokens stored in the DB and sent as an httpOnly cookie (valid for 7 days).
- **Database**: SQLite (`chat.db`) via Node's built-in `node:sqlite`, so there is nothing native to compile. It stores users, sessions and all chat messages.
- **Realtime**: Socket.IO pushes new messages and shows "typing…" indicators.
- **People online**: a side panel lists everyone currently online and who's typing. It is open by default on desktop, and on phones the "N online" button in the header opens it.
- **Stickers**: the sticker button next to the message box opens a tray of 13 stickers. They are SVGs in `public/stickers/`, listed in `stickers.json`, and the server only accepts IDs from that list.
- **Pinned messages**: hover a message (or tap it on a phone) and click the pin button. Anyone can pin or unpin, and up to 3 messages stay pinned, with the oldest dropped when a 4th is pinned. Pins show in a bar at the top of the chat. Clicking the bar jumps to that message and moves on to the next pin, and ✕ unpins it.
- **Font colour**: the **A** button next to the message box picks one of 8 text colours. The choice is saved to your account, and each message keeps the colour it was sent in. The colours have light and dark variants so they stay readable in both themes. They are listed in `public/text-colors.json`, and the server only accepts those IDs.
- **Catch-up summary**: when you log in, a card at the top of the chat summarises the last 10 messages. Claude (`claude-opus-5`) writes it through the Anthropic API. The summary is cached until a new message arrives, so many logins in a row cost one API call. The chat text is passed as data, and the model is told not to follow instructions inside it. If a request is declined by the safety classifiers, it falls back server-side (`fallbacks: "default"`). Without an API key the card just says summaries aren't set up, and the rest of the app works normally.
- **History**: the latest 50 messages load on open, and "Load earlier messages" pages further back.

## Run

Requires Node.js 22.5+ (built with Node 26).

```
npm install
npm start
```

Open http://localhost:3000, create an account, then open another browser (or an incognito window) and sign up as a second user to chat.

To turn on catch-up summaries, set an Anthropic API key before starting the server:

```
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; npm start
# bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

To let others on your network join, share `http://<your-ip>:3000`. Set `PORT` to change the port and `DB_PATH` to change the database location.

## Files

- `server.js` – Express routes (register/login/logout/me/messages) and the Socket.IO chat server
- `db.js` – SQLite schema and prepared statements
- `public/` – frontend (`index.html`, `style.css`, `app.js`)
