# AI Caller

AI Caller talks to company support lines for you. You dial the support number on your own phone and put it on speaker next to your laptop. The app listens through the laptop microphone, a language model decides what to say, and the laptop speaks the reply. It gets through phone menus and voice bots and waits on hold. When a human answers, it either hands the call to you or tries to resolve the issue within limits you set.

It works with any OpenAI-compatible model provider: OpenRouter, OpenAI, Groq, Ollama, Anthropic's OpenAI-compatible endpoint, or a custom URL.

## Download

Get `AICaller.exe` (Windows x64) from the [latest release](https://github.com/swaftmc/ai-caller/releases/latest) and check it against `SHA256SUMS.txt`:

```powershell
(Get-FileHash .\AICaller.exe -Algorithm SHA256).Hash
```

This is a pre-release: it has not made a real phone call yet (see the end of this file).

## Using the exe

1. Put `AICaller.exe` in any folder and double-click it. There is no installer and no database server.
   Windows SmartScreen may warn that the app is unrecognised (it is not signed). Click **More info**, then **Run anyway**.
2. A console window opens with the dashboard address and data folder, and your browser opens the dashboard. **Keep the console window open**; closing it stops AI Caller.
3. Open **Settings**, choose a provider, then enter an API key and a call model. A banner reminds you until this is done.
4. Open **Profile**, enter your name (the AI says it calls on your behalf), and add any stored details a call may need, such as an account number.
5. Open **New call** and describe the problem in plain words. The assistant asks a few short questions, then shows a plan. Check the phone number, choose the mode, autonomy, shared details, disclosure and hold limit, and press **Start call**.
6. Dial the number on your phone, put it on speaker next to the laptop, and press **Start listening**.
   Stay quiet near the laptop: the AI hears everything in the room as the other side of the call.
7. When the AI has to press a key, it plays the tone and shows a large "Press 2 on your phone" banner. Press the key on your phone if the tone didn't register.
8. Approval requests appear as cards with **Approve** / **Deny** and an optional note. **Tell the AI** sends it live instructions. **I'll take over** stops the AI so you can talk yourself.

If the browser didn't open, or you open the dashboard on another browser, it asks for the dashboard token. The token is `dashboardToken` in `secrets.json` in the data folder.

Speech recognition uses the browser's Web Speech API (Chrome or Edge only) unless you set up an OpenAI-compatible transcription API in Settings. The voice is the browser's built-in one unless you set up an OpenAI-compatible speech API. If the speech API fails, the browser voice is used instead.

## Where data lives

- `AICaller-data\` next to the exe. If that folder isn't writable, `%LOCALAPPDATA%\AICaller\` is used instead. The `DATA_DIR` environment variable overrides both.
- `aicaller.db` (plus `-wal` and `-shm`) is the SQLite database. It holds calls, transcripts, approvals, the audit log, playbooks, settings and stored details.
- `secrets.json` holds the dashboard token and the encryption key for stored details and API keys. **Back it up together with the database.** Without it, stored details and saved API keys cannot be decrypted.
- Calls that were still live when AI Caller stopped are marked `failed` on the next start.

## Safety rules

- **Disclosure.** By default the AI opens with "Hi, I'm an AI assistant calling on behalf of <your name>." Whatever the setting, if anyone asks whether it's a bot, an AI or a person, it says truthfully that it is an AI assistant calling for you. It never claims to be you or any human.
- **Autonomy** is set per call:
  - `explain_only`: shares no personal details and agrees to nothing.
  - `approve_decisions`: may read the stored details you ticked, and must get your live approval before agreeing to anything.
  - `act_within_rules`: may agree only to what your numbered rules cover; anything else needs your approval.
- **The server enforces these limits, not the model:**
  - A stored detail can be read only when autonomy allows it and the key is ticked for the call. Every read is written to the audit table and shown in the transcript.
  - A commitment is accepted only with an approved request from this call, or, in `act_within_rules`, a valid rule number. Rejections are audited.
  - Stored details are never put in the model's prompt.
- **Approvals** expire after the approval timeout (default 180 s). The AI is then told you didn't respond and must not agree. Pending approvals also expire when the call ends.
- **Playbooks** save only menu paths and tactics. The model is told never to include personal data, and the server also drops any line that contains your name, callback phone, a stored detail, a reference number or a run of 5 or more digits.
- **Local only.** The server listens on 127.0.0.1 and rejects requests with any other Host header (DNS-rebinding guard). Every API call needs the dashboard token, and the WebSocket takes the token as its first message. API keys are encrypted at rest (AES-256-GCM) and never sent back to the browser.

## Settings and environment variables

Precedence: a value saved in the dashboard wins, then the environment or a `.env` file (next to the exe or in the working folder), then the default. Clearing a field in the dashboard removes the saved value.

| Variable | Meaning |
| --- | --- |
| `LLM_PROVIDER` | `openrouter` (default), `openai`, `groq`, `ollama`, `anthropic`, `custom` |
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_PLANNING_MODEL`, `LLM_CLASSIFIER_MODEL`, `LLM_BASE_URL` | key, call model, optional planning/summary model, optional hold-classifier model, base URL override |
| `LLM_WEB_SEARCH` | `true`/`false`; OpenRouter only (appends `:online` to the planning model) |
| `APPROVAL_TIMEOUT_SECONDS` | default 180 |
| `STT_PROVIDER`, `STT_URL`, `STT_API_KEY`, `STT_MODEL` | `browser` or `openai_compatible`; model default `whisper-1` |
| `TTS_PROVIDER`, `TTS_URL`, `TTS_API_KEY`, `TTS_MODEL`, `TTS_VOICE` | `browser` or `openai_compatible`; defaults `tts-1`, `alloy` |
| `HOST`, `PORT` | default `127.0.0.1`, `4317` (the next 9 ports are tried if busy) |
| `OPEN_BROWSER` | `0` to skip opening the browser |
| `AICALLER_LOG_LEVEL` | Fastify log level; default `warn` in the exe, `info` in dev |
| `DATA_DIR` | data folder override |

## Optional Twilio mode

Twilio mode is off unless all of `PUBLIC_URL` (an https tunnel to this server), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `OPENAI_API_KEY` and `DEEPGRAM_API_KEY` are set. When it is on, the plan editor offers a Twilio channel:

- The server places the call and streams its audio to the OpenAI Realtime API. It uses `gpt-realtime` with G.711 mu-law audio; `OPENAI_REALTIME_MODEL` changes the model.
- While on hold, the audio goes to Deepgram nova-3 and the same human detector instead.
- Keys are pressed by updating the call with `<Play digits>`.
- **Join** rings your Profile callback phone (answering machines are not connected) and puts you in a conference with the support line.
- Only US/Canada numbers are dialable by default (`DIAL_ALLOWED_COUNTRY_CODES=1`). 900/976, N11 and emergency numbers are always blocked.
- Webhooks must carry a valid `X-Twilio-Signature`. The media WebSocket needs a random per-call token. The public host can reach only `/twilio/` paths.

## Development

Requires Node 22.13 or newer (built and tested with Node 24.17).

```
npm install
npm run check        # unit check: crypto, store, settings precedence, Twilio guards
npm run smoke        # whole speakerphone call offline against a fake model server
npm run typecheck    # tsc --noEmit for shared, server and web
npm run dev:server   # API + built dashboard on http://127.0.0.1:4317 (run npm run build:web first)
npm run dev:web      # next dev; set NEXT_PUBLIC_API_URL=http://127.0.0.1:4317
npm run build:exe    # build/win-x64/AICaller.exe
npm run build:exe -- --target=linux-x64   # also win-arm64, linux-arm64, darwin-x64, darwin-arm64, host
```

`build:exe` builds the static dashboard and bundles the server into one CommonJS file with esbuild. It then embeds both in a Node single-executable application. For a target other than the host, it downloads the matching Node runtime from npm (`node-<target>@<running version>`), because a SEA blob only runs on the Node version that built it. macOS binaries must be re-signed on a Mac (`codesign --sign - AICaller`).

## What has been tested, and what has not

Tested on Windows 11 x64 with Node 24.17.0:

- `npm run check` and `npm run smoke` pass. The smoke test runs a full scripted call against a real temporary SQLite database and a fake model server:
  - menu, hold, a recorded message, the human detector, AI disclosure
  - approval, then a recorded commitment, then the reference number and end of call
  - the summary and playbook are written
  - the `response_format` fallback works
  - keys are encrypted at rest and never returned
  - commitments without approval are rejected
- HTTP checks with curl:
  - 401 without a token, 403 for a foreign Host header, `..` paths rejected
  - `/call?id=` redirects to `/call/?id=`
  - cache headers are correct
  - the WebSocket closes with 4401 on a bad token or after 5 s without auth
- `next build` produces the static export.
- `AICaller.exe` was run from empty folders. It created `AICaller-data`, and the dashboard loaded in headless Edge (token gate, settings save, stored details masked, draft call page). Data survived a restart.
- The `linux-x64` binary was built with a runtime fetched from npm.
- With fake Twilio settings, the routes register, unsigned webhooks are rejected, and 900 numbers are refused.

**Not tested:**

- A real phone call on speaker, with a real model provider.
- Microphone recognition in a real room: the Web Speech API, the voice-activity detection, and server STT/TTS against a real provider.
- Whether the acoustic DTMF tones register on a phone (mobile phones often miss them; use the on-screen banner).
- Twilio mode end to end: placing calls, the Realtime audio bridge, Deepgram on hold, key presses, Join/conference, answering-machine detection.
- Running the exe on a clean PC, on Windows Sandbox, or with Microsoft Defender on (only this laptop, which runs CrowdStrike).
- The linux, arm64 and macOS executables: they build, but none of them were run.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE): free to use, change and share for non-commercial purposes. For commercial
use, ask first: open an issue at [swaftmc/ai-caller](https://github.com/swaftmc/ai-caller/issues). This is source-available, not OSI open source.
Third-party libraries bundled into the exe, and the Node.js runtime it embeds, keep their own licences.
