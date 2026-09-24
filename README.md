# Group Chat

A WhatsApp-style group chat: everyone who signs up chats in one shared room.

- **Auth**: username + password sign-up and login. New passwords must be 8 characters to 72 bytes long. Passwords are hashed with bcrypt (cost 12), and sessions are random tokens sent as an httpOnly cookie (valid for 7 days). The DB stores only a SHA-256 hash of each token. Logging out also disconnects that session's open chat connections.
- **Database**: SQLite (`chat.db`) via Node's built-in `node:sqlite`, so there is nothing native to compile. It stores users, sessions and all chat messages.
- **Realtime**: Socket.IO pushes new messages and shows "typing…" indicators.
- **People online**: a side panel lists everyone currently online and who's typing. It is open by default on desktop, and on phones the "N online" button in the header opens it.
- **Stickers**: the sticker button next to the message box opens a tray of 13 stickers. They are SVGs in `public/stickers/`, listed in `stickers.json`, and the server only accepts IDs from that list.
- **Profiles**: everyone has a profile page with a photo, a short status, "About me", location, joined date and message stats. Open one by clicking someone in the Members list or a sender's name on a message; your own opens from your avatar in the header. Each profile has its own link (`#profile/<username>`), and the browser Back button or Esc closes it. Only the owner can edit a profile. Photos are cropped to a square and shrunk to 256 px in the browser before upload. The server only accepts real JPEG, PNG or WebP files (checked by their contents, max 300 KB) and serves them only to logged-in users.
- **Pinned messages**: hover a message (or tap it on a phone) and click the pin button. Anyone can pin or unpin (it's a shared board; pins are rate limited and unpins are logged on the server), and up to 3 messages stay pinned, with the oldest dropped when a 4th is pinned. Pins show in a bar at the top of the chat. Clicking the bar jumps to that message and moves on to the next pin, and ✕ unpins it.
- **Font colour**: the **A** button next to the message box picks one of 8 text colours. The choice is saved to your account, and each message keeps the colour it was sent in. The colours have light and dark variants so they stay readable in both themes. They are listed in `public/text-colors.json`, and the server only accepts those IDs.
- **Catch-up summary**: when you log in, a card at the top of the chat summarises the last 10 messages. Claude (`claude-opus-5`) writes it through the Anthropic API. The summary is cached until a new message arrives, so many logins in a row cost one API call, and a new summary is made at most once a minute however busy the chat is. The chat text is passed as data with `<`, `>` and `&` escaped, so a message can't break out of the transcript, and the model is told not to follow instructions inside it. If a request is declined by the safety classifiers, it falls back server-side (`fallbacks: "default"`). Without an API key the card just says summaries aren't set up, and the rest of the app works normally.
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

## Deploying

Serve the app over HTTPS and start it with `NODE_ENV=production`. In production the session cookie is `Secure` and named `__Host-sid`, and HSTS is sent, so plain HTTP logins will not work in that mode.

- `TRUST_PROXY`: set this behind a reverse proxy (for example `1` for one hop) so rate limits see the real client IP.
- `ALLOWED_ORIGINS`: a comma-separated list of origins allowed to open chat sockets. By default the `Origin` must match the `Host` header. Set this if your proxy rewrites `Host`.

## Security

- Rate limits (in memory, per server process): logins (per IP and failed attempts per username), sign-ups per IP, summaries per user, and messages, stickers, pins and colour changes per user. Typing events are throttled per connection, and each user can have at most 10 open connections.
- Helmet sets a strict Content-Security-Policy (`script-src 'self'`, `frame-ancestors 'none'`) and other security headers. Errors return JSON with no stack trace.
- Control characters and bidi overrides are stripped from messages and profile fields.
- `npm run lint:security` runs ESLint with `eslint-plugin-security` and `eslint-plugin-no-unsanitized`. `npm test` runs the security regression tests. CI runs both, plus `npm audit --omit=dev`.

## Files

- `server.js` – Express routes (register/login/logout/me/messages) and the Socket.IO chat server
- `db.js` – SQLite schema and prepared statements
- `summary.js` – catch-up summaries via the Anthropic API
- `ratelimit.js` – in-memory token-bucket rate limiter
- `test/` – security regression tests (`npm test`)
- `public/` – frontend (`index.html`, `style.css`, `app.js`)
