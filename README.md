# AI Caller

AI Caller talks to company support lines for you. You dial the support number on your own phone and put it on speaker next to your computer. The web app listens through the computer's microphone, a language model decides what to say, and the computer speaks the reply. It gets through phone menus and voice bots and waits on hold. When a human answers, it either hands the call to you or tries to resolve the issue within limits you set.

It is a web app for people you invite. Each person signs in with an emailed link and uses their own model provider key: OpenRouter, OpenAI, Groq, Anthropic's OpenAI-compatible endpoint, or another public OpenAI-compatible URL.

> The Windows exe (v0.1.0 and v0.1.1) is retired. Its releases stay on GitHub, but its data folder cannot be used by the web app.

## Using it

1. Open the site and enter the email address you were invited with. Click the link in the email, then **Sign in**. The link works once and expires after 15 minutes.
2. Open **Settings**, choose a provider, then enter your API key and a call model. A banner reminds you until this is done.
3. Open **Profile**, enter your name (the AI says it calls on your behalf), and add any stored details a call may need, such as an account number.
4. Open **New call** and describe the problem in plain words. The assistant asks a few short questions, then shows a plan. Check the phone number, choose the mode, autonomy, shared details, disclosure and hold limit, and press **Start call**.
5. Dial the number on your phone, put it on speaker next to the computer, and press **Start listening**. Stay quiet near the computer: the AI hears everything in the room as the other side of the call.
6. When the AI has to press a key, it plays the tone and shows a large "Press 2 on your phone" banner. Press the key on your phone if the tone didn't register.
7. Approval requests appear as cards with **Approve** / **Deny** and an optional note. **Tell the AI** sends it live instructions. **I'll take over** stops the AI so you can talk yourself.

Speech recognition uses the browser's Web Speech API (Chrome or Edge) unless you set up an OpenAI-compatible transcription API in Settings. The voice is the browser's built-in one unless you set up an OpenAI-compatible speech API; if that fails, the browser voice is used.

**Profile → Delete my account** removes everything you stored on the server.

## Running the server (one VPS)

What you need: a small Linux VPS (1 GB RAM is enough), a domain name pointing at it, Node 22.13 or newer, [Caddy](https://caddyserver.com) for HTTPS, and a [Resend](https://resend.com) account for the sign-in emails.

1. **DNS:** add an `A` (and `AAAA`, if the VPS has IPv6) record for your host name, for example `caller.example.com`, pointing at the VPS.
2. **Email:** in Resend, add your domain and create the DNS records it shows (SPF and DKIM). Without them, sign-in emails land in spam or are rejected.
3. **Install:**
   ```sh
   sudo useradd --system --home /opt/ai-caller --shell /usr/sbin/nologin aicaller
   sudo git clone https://github.com/swaftmc/ai-caller /opt/ai-caller
   cd /opt/ai-caller
   sudo npm ci && sudo npm run build
   ```
4. **Settings:** copy `deploy/aicaller.env.example` to `/etc/aicaller.env`, fill it in, and run `sudo chmod 600 /etc/aicaller.env`. Create `ENCRYPTION_KEY` with `openssl rand -base64 32` and keep a copy somewhere safe, separate from the database backups.
5. **Service:** copy `deploy/aicaller.service` to `/etc/systemd/system/`, then run `sudo systemctl enable --now aicaller` and check `journalctl -u aicaller`.
6. **HTTPS:** put `deploy/Caddyfile` (with your host name) in `/etc/caddy/Caddyfile` and run `sudo systemctl reload caddy`. Caddy gets the certificate itself.
7. **First sign-in:** open `https://<your host>/`. Sign in with `ADMIN_EMAIL`, then invite people on the **Admin** page.
8. **Backups:** `deploy/backup.sh` makes a consistent nightly copy of the database (it needs the `sqlite3` package). Add it to cron.

To update: `cd /opt/ai-caller && sudo git pull && sudo npm ci && sudo npm run build && sudo systemctl restart aicaller`. A restart ends any call in progress; those calls are marked failed.

| Variable | Meaning |
| --- | --- |
| `PUBLIC_URL` | **Required.** The site address, e.g. `https://caller.example.com`. Requests for any other host name are refused. |
| `ADMIN_EMAIL` | **Required.** Always allowed to sign in; sees the Admin page. |
| `DATA_DIR` | Database folder (default `./data`). |
| `ENCRYPTION_KEY` | Base64 of 32 random bytes. Without it, a key is generated in `DATA_DIR/secrets.json`. |
| `RESEND_API_KEY`, `MAIL_FROM` | Resend email. Without them, sign-in links are printed to the server log only. |
| `HOST`, `PORT` | Listen address, default `127.0.0.1:4317` (Caddy forwards to it). |
| `AICALLER_LOG_LEVEL` | Default `warn`. |
| `AICALLER_UNSAFE_ALLOW_PRIVATE_URLS` | `1` lets provider URLs point at local or private addresses. Development only. |

## Safety rules

- **Disclosure.** By default the AI opens with "Hi, I'm an AI assistant calling on behalf of <your name>." Whatever the setting, if anyone asks whether it's a bot, an AI or a person, it says truthfully that it is an AI assistant calling for you. It never claims to be you or any human.
- **Autonomy** is set per call:
  - `explain_only`: shares no personal details and agrees to nothing.
  - `approve_decisions`: may read the stored details you ticked, and must get your live approval before agreeing to anything.
  - `act_within_rules`: may agree only to what your numbered rules cover; anything else needs your approval.
- **The server enforces these limits, not the model.** A stored detail can be read only when autonomy allows it and the key is ticked for the call; every read is audited and shown in the transcript. A commitment is accepted only with an approved request from this call or a valid rule number; rejections are audited. Stored details are never put in the model's prompt.
- **Approvals** expire after the approval timeout (default 180 s), and the AI is told not to agree. Pending approvals also expire when the call ends.
- **Playbooks** are per user and keep only menu paths and tactics. The server drops any line containing your name, phone number, a stored detail, a reference number or a run of 5 or more digits.

## Security

- **Access:** invite-only. A sign-in link is sent only to `ADMIN_EMAIL` or an invited address, and the sign-in page gives the same answer either way.
- **Sign-in links:**
  - They are single-use and expire after 15 minutes. Only a hash of each token is stored.
  - The token sits after `#`, so it never reaches server logs or `Referer` headers.
  - Signing in needs a click, so email scanners that open links can't use them up.
- **Sessions:** an `HttpOnly`, `Secure`, `SameSite=Lax` cookie that lasts 30 days. Only a hash is stored. Signing out or deleting the account ends it.
- **Request checks:**
  - The `Host` header must match `PUBLIC_URL`.
  - Requests that change data, and the WebSocket, must come from the site's own `Origin`.
  - Responses send `X-Frame-Options: DENY`, `Strict-Transport-Security`, `nosniff` and `no-referrer`.
- **Isolation:** every query is scoped to the signed-in user. Users never see each other's calls, events, settings, keys, details or playbooks, and the admin can't see them either.
- **Encryption:** API keys and stored details are encrypted at rest (AES-256-GCM) with one server key, and keys are never sent back to the browser. Anyone with both the database and `ENCRYPTION_KEY` can read them, so keep the key out of the backup folder.
- **Provider URLs:** they must be public `https://` addresses. Localhost, private networks and cloud metadata addresses are refused when you save and again before every request, and redirects are refused. A DNS server that changes its answer between the check and the request could still get past this (rebinding); see the `ponytail:` note in `apps/server/src/netguard.ts`.
- **Limits:**
  - Sign-in links: 5 per email and 20 per IP per hour.
  - Intake chat: 30 per minute per user.
  - Live calls: 3 per user and 20 on the server.
  - The limits live in memory, so they reset on restart. This assumes one server process.

**Before inviting other people:** call transcripts are recordings of phone calls. Some US states (and other countries) require every party to consent to recording, and some places regulate AI-voiced calls. You will also need a short privacy note and terms explaining what you store. This app does not settle those questions for you.

## Development

```
npm install
npm run check        # unit check: crypto, store, sign-in tokens and sessions, settings, URL guard, rate limiter
npm run smoke        # scripted call against a fake model server, then sign-in, invites, isolation and guards over HTTP
npm run typecheck    # tsc --noEmit for shared, server and web
npm run build        # static web export + one-file server bundle (apps/server/dist/server.cjs)
PUBLIC_URL=http://localhost:4317 ADMIN_EMAIL=you@example.com npm start
```

With no Resend settings, sign-in links are printed in the server output. Browsers allow the microphone on `http://localhost`, but on any other host name the site needs HTTPS.

## What has been tested, and what has not

Tested on Windows 11 with Node 24.17:

- `npm run check` and `npm run smoke` pass:
  - the full scripted call flow, including human detection, approvals, commitments, the summary, the playbook and the `response_format` fallback;
  - keys encrypted at rest and never returned;
  - invite-only sign-in with single-use, expiring links, session cookies, the admin API, user isolation over HTTP and the WebSocket;
  - the Host, Origin and private-URL guards, rate limits, account deletion and admin removal.
- `next build` produces the static export.
- A headless Chrome run against the built server (`npm start`):
  - sign-in through the emailed link;
  - clicking through every page, including the navigation that crashed in v0.1.0;
  - an admin invite, a refused private URL, signing out and a reused link being refused.

**Not tested:**

- Real email sending through Resend.
- The VPS, Caddy and HTTPS on a real domain; Linux at all (only Windows here).
- A real phone call with a real model provider, real microphone recognition, server STT/TTS, and whether keypad tones register on a phone.
- Load beyond a handful of users.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE): free to use, change and share for non-commercial purposes. For commercial
use, ask first: open an issue at [swaftmc/ai-caller](https://github.com/swaftmc/ai-caller/issues). This is source-available, not OSI open source.
Third-party libraries keep their own licences.
