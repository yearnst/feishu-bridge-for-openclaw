# feishu-bridge (local)

An open-source local Feishu/Lark bridge:

- Receives Feishu Event Subscription callbacks
- Forwards messages to a local **OpenClaw (new name) / Clawdbot (legacy name)** agent
- Sends the model output back to the same Feishu chat (including files/images)

## Compatibility (important)

- **OpenClaw** is the renamed successor of Clawdbot: <https://github.com/openclaw/openclaw>
- By default, this bridge will try `openclaw` first, then `clawdbot` (override via `ASSISTANT_MODE/ASSISTANT_BIN`).

## Features

### Inbound (Feishu → local)
- Feishu Event Subscription URL verification (`challenge`)
- Receives **text / file / image** messages
- Group gating: only respond when @mentioned (`mentions` array)
- **Inbound attachments**: downloads files/images to `FEISHU_DOWNLOAD_DIR` and forwards local paths to the model as `FILE: ...`

### Outbound (local → Feishu)
- Replies back to the same chat (group or p2p)
- **Outbound attachments**: if the model reply includes `FILE:`/`MEDIA:` lines pointing to local paths, the bridge uploads+send them to Feishu
- **Path resolution**: supports relative paths under `cwd`, `outputs/`, `downloads/`, and workspace root
- **Outputs normalization**: if a generated file lands in the workspace root, it is moved into `./outputs/` before sending
- **File type inference**: PDFs are uploaded as `file_type=pdf` (instead of always `stream`)
- **Noise stripping**: strips internal tool traces like `🛠️ Exec: ...` from the text reply before sending

### “No-timeout” UX
- Background queue per session (serializes tasks)
- Delayed processing hint (default 120s): only sends `后台处理… 任务ID：xxxx` if there is no user-visible output within the delay
- Optional periodic progress ping while running

## Encryption (supported)

Feishu can send encrypted callbacks as `{ "encrypt": "..." }`.

- Set `FEISHU_ENCRYPT_KEY` (32-byte string) in `.env`
- Enable **Encrypt Key** in Feishu Event Subscription settings with the same key

The bridge will decrypt the payload (AES-256-CBC; several compatibility variants are attempted) and then process it normally.

## Not implemented yet
- Smart extraction (OCR / PDF text extraction). Currently the model just receives the local file path.

## Run

### Option A: Socket Mode (recommended)

1) In Feishu developer console, switch Event Subscription mode to **persistent connection (Socket Mode)** and subscribe to `im.message.receive_v1`.
2) `.env` minimal:

```env
FEISHU_RECEIVE_MODE=socket
HTTP_SERVER_ENABLED=false
```

3) Run:

```bash
cp .env.example .env
npm install
npm run start:socket
```

### Option B: Webhook Mode

1) Configure Request URL: `https://<your-domain-or-tunnel>/feishu/events`
2) `.env` minimal:

```env
FEISHU_RECEIVE_MODE=webhook
HTTP_SERVER_ENABLED=true
PORT=8787
```

3) Run:

```bash
cp .env.example .env
npm install
npm run start:webhook
```

Health check: `GET http://127.0.0.1:8787/health`

> For a beginner-friendly step-by-step guide (Feishu console, tunnel, verification), see: `DEPLOY.en.md`

## Key environment variables

Basics:
- `PORT` (default: `8787`)
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN` (optional but recommended)
- `FEISHU_ENCRYPT_KEY` (optional; set only if you enabled Encrypt Key in Feishu console; must be 32 bytes)
- `REQUIRE_MENTION_IN_GROUP` (default: `true`)
- `ECHO_MODE` (default: `true` for wiring tests; set to `false` for real forwarding)

Assistant runner (OpenClaw recommended; Clawdbot legacy compatible):
- `ASSISTANT_MODE` (default: `auto`; `auto|cli|entry`)
- `ASSISTANT_BIN` (optional; force `openclaw` or `clawdbot`)
- `CLAWDBOT_ENTRY` (optional; only needed for legacy entry mode, absolute path to Clawdbot `entry.js`)

Files/safety:
- `FEISHU_DOWNLOAD_DIR` (default: `<workspace>/downloads`)
- `FEISHU_MAX_DOWNLOAD_BYTES` (default: 30MB)

Processing/UX:
- `SEND_PROCESSING_HINT` (default: `true`)
- `PROCESSING_HINT_DELAY_MS` (default: `120000`)
- `PROGRESS_PING_MS` (default: `120000`, `0` disables)

File placement:
- `CLAWDBOT_OUTPUTS_DIR` (default: `<workspace>/outputs`)

Optional group caching / media pairing:
- `GROUP_CACHE_ENABLED` (default: `false`)
- `GROUP_CACHE_MAX_ITEMS` (default: `50`)
- `PENDING_INBOUND_TTL_MS` (default: `90000`)
- `MENTION_MEDIA_WAIT_MS` (default: `1500`)
- `IMPLICIT_PAIR_WINDOW_MS` (default: `5000`)

## Debug endpoints

- `GET /health`
- `GET /debug/env`
- `POST /debug/send-file { chat_id, filePath }` (manual outbound attachment test)

## Deploy / Share

- 中文：`DEPLOY.zh-CN.md`
- English: `DEPLOY.en.md`

## License

MIT License. See `LICENSE`.
