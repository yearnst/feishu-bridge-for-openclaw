# feishu-bridge — Quick Deploy / Share Guide (English)

Goal: let anyone deploy a Feishu/Lark bot bridge with minimal steps: receive messages, reply text, and send/receive files & images.

> Current features
> - Inbound: text / image / file
> - Outbound: text; plus auto-upload+send attachments when model output contains local `FILE:` / `MEDIA:` paths
> - Inbound attachments: auto-download to `FEISHU_DOWNLOAD_DIR`, and forward `FILE: <path>` to the model
>
> Encrypted callbacks (Encrypt Key / `encrypt` payload)
> - Supported (payload shape: `{ "encrypt": "..." }`).
> - Set `FEISHU_ENCRYPT_KEY` (32-byte string) in `.env`, and enable Encrypt Key in Feishu console with the same key.
> - If you don’t want encryption, keep Encrypt Key OFF.

---

## 0) Prerequisites

- Node.js 22+ (recommended; matches OpenClaw's guidance)
  - If you insist on Node 18/20: this bridge may still run, but OpenClaw may require a higher version
- A local assistant installed:
  - New (recommended): OpenClaw: <https://github.com/openclaw/openclaw>
    - Global install: `npm install -g openclaw@latest` (or `pnpm add -g openclaw@latest`)
    - Onboarding wizard: `openclaw onboard --install-daemon`
  - Legacy (optional): Clawdbot (if you still run the old environment)
  - By default this bridge auto-detects `openclaw` → `clawdbot`
- A publicly reachable HTTPS callback URL:
  - For local dev: tunnel (cloudflared / ngrok / localtunnel)
  - Or deploy on a server with your own domain + HTTPS reverse proxy
- A Feishu/Lark app:
  - `FEISHU_APP_ID`
  - `FEISHU_APP_SECRET`

---

## 1) Option A: Local + Tunnel (fastest for individuals)

### 1.1 Generate `.env` interactively (recommended)

```bash
cd feishu-bridge
./scripts/setup.sh
```

### 1.2 Install & start

```bash
cd feishu-bridge
npm install
npm start
```

### 1.3 Start a tunnel (pick one)

#### A) cloudflared (recommended)

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

#### B) ngrok

```bash
ngrok http 8787
```

#### C) localtunnel

```bash
npx localtunnel --port 8787
```

---

## 2) Option B: Server (Docker Compose, long-running)

### 2.1 Configure

```bash
cd feishu-bridge
cp .env.example .env
# Fill FEISHU_APP_ID / FEISHU_APP_SECRET etc.
```

### 2.2 Start

```bash
cd feishu-bridge
docker compose up -d --build
docker compose logs -f
```

### 2.3 Reverse proxy (required)

You need an HTTPS domain and reverse-proxy:

- `https://your.domain/feishu/events`

→

- `http://127.0.0.1:8787/feishu/events`

(Nginx / Traefik / Caddy)

---

## 3) Feishu/Lark Console Setup (Event Subscription + Permissions)

### 3.1 Event Subscription URL

Set Request URL to:

- `https://<your-public-domain>/feishu/events`

Example:
- `https://xxxx.trycloudflare.com/feishu/events`

> Note: if you enable Encrypt Key, this bridge will decrypt `{ "encrypt": "..." }` callbacks automatically; if you keep it OFF, it processes plaintext callbacks.

### 3.2 Permissions checklist

Exact permission names vary across tenants/console versions, but you need these capabilities:

- IM basics
  - send messages (reply)
  - receive message events (`im.message.receive_v1`)
- Files/Images
  - upload files (`/im/v1/files`)
  - upload images (`/im/v1/images`)
  - download message resources (`/messages/{message_id}/resources/{key}`)

Troubleshooting:
- If upload/download fails, you’ll usually see HTTP 403 or `code != 0`.
- Enable/apply the missing permissions, then publish a new app version.

### 3.3 Typical console navigation (best-effort)

1. Feishu Open Platform → open your app
2. Left menu (one of these):
   - Event Subscriptions
   - Bot
   - Permissions
3. Configure:
   - Event subscription request URL: `.../feishu/events`
   - Subscribe to event: `im.message.receive_v1`
   - Permissions: IM + file/image + resource download
4. Save and publish a new version

---

## 4) Verification steps (recommended order)

### 4.1 Health check

- `GET http://127.0.0.1:8787/health`
- `GET http://127.0.0.1:8787/debug/env`

### 4.2 Text callback test

- Set `ECHO_MODE=true`
- Send a message to the bot
- You should get an echo reply

### 4.3 File/Image inbound test

- Keep `ECHO_MODE=true`
- Send an image/file
- You should see receipt logs; with `ECHO_MODE=false` the file is downloaded and forwarded as `FILE: ...`

### 4.4 Local file → Feishu send test

```bash
curl -X POST http://127.0.0.1:8787/debug/send-file \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"oc_xxx","filePath":"/abs/path/to/a.png"}'
```

Get `chat_id` from event logs: `event.message.chat_id`.

---

## 5) FAQ

### Q: Chinese text in generated PDFs is garbled.
A: Ensure the PDF generator embeds a CJK-capable font. Set:

- `PDF_CJK_FONT_PATH=./fonts/NotoSansCJKsc-Regular.otf`

This repo bundles Noto Sans CJK SC (SIL OFL 1.1; see `./fonts/OFL.txt`) so it works out of the box.

### Q: Should I enable Encrypt Key?
A: Either is fine.
- If OFF: Feishu sends plaintext callbacks; this bridge processes them directly.
- If ON: Feishu sends `{ encrypt: "..." }`; this bridge decrypts it using `FEISHU_ENCRYPT_KEY` from `.env`.
