# Feishu bridge for OpenClaw

> Maintainer: **Charles Chern @AIlinker**  
> Repo: <https://github.com/yearnst/feishu-bridge-for-openclaw>

一个本地飞书/Lark 桥接服务（开源版）：接收飞书事件订阅回调 → 转发到本机 **OpenClaw（新名，推荐）/ Clawdbot（旧名，兼容）** → 把模型回复（含附件）发回飞书。

An open-source local Feishu/Lark bridge: receive Event Subscription callbacks → forward to local **OpenClaw (recommended) / Clawdbot (legacy)** → reply back to Feishu (supports files/images).

- 中文详细文档：`README.zh-CN.md`
- English docs: `README.en.md`

---

## Features / 功能

**Inbound（Feishu → Local）**
- Event Subscription URL verification (`challenge`)
- Receive **text / image / file**
- Group gating: only reply when **@mentioned** (configurable)
- Inbound attachments: auto-download to `FEISHU_DOWNLOAD_DIR`, then forward to the agent as `FILE: <local-path>`

**Outbound（Local → Feishu）**
- Reply to the same chat (p2p / group)
- Outbound attachments: if the agent reply contains `FILE:` / `MEDIA:` local paths, auto-upload + send back
- PDF upload uses `file_type=pdf`
- Strip internal tool noise (e.g. `🛠️ Exec: ...`) from messages

**No-timeout UX（不超时体验）**
- Per-session queue (serial processing)
- Delayed “后台处理…任务ID…” hint (default 120s)
- Optional periodic progress ping

**Encryption（已支持）**
- Supports encrypted callbacks `{ "encrypt": "..." }` via `FEISHU_ENCRYPT_KEY`

---

## Prerequisites / 准备工作

- Node.js **22+** recommended (matches OpenClaw guidance)
- OpenClaw installed globally (recommended):

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

- A public HTTPS callback URL
  - local dev: tunnel (cloudflared / ngrok / localtunnel)
  - server: your domain + HTTPS reverse proxy
- A Feishu/Lark app (App ID / Secret) with IM + file/image permissions

---

## Quick start (Local + Tunnel) / 快速开始（本机 + Tunnel）

### 1) Install & run / 安装并运行

```bash
git clone https://github.com/yearnst/feishu-bridge-for-openclaw.git
cd feishu-bridge-for-openclaw
cp .env.example .env
npm install
npm start
```

Health check:
- `GET http://127.0.0.1:8787/health`

### 2) Start a tunnel / 启动一个 tunnel（任选）

```bash
# localtunnel
npx localtunnel --port 8787

# or ngrok
# ngrok http 8787

# or cloudflared
# cloudflared tunnel --url http://127.0.0.1:8787
```

### 3) Configure Feishu Event Subscription / 配置飞书事件订阅

Request URL:
- `https://<your-public-domain>/feishu/events`

Subscribe event:
- `im.message.receive_v1`

Security options:
- Recommended: set `FEISHU_VERIFICATION_TOKEN`
- Optional: enable Encrypt Key and set `FEISHU_ENCRYPT_KEY` (32 bytes)

### 4) First wiring test / 首次联调建议

- Keep `ECHO_MODE=true`
- Send a text message to the bot and confirm it echoes
- Then set `ECHO_MODE=false` to forward to OpenClaw

---

## Deploy (Server / Docker) / 部署（服务器 / Docker）

```bash
cp .env.example .env
# edit .env

docker compose up -d --build

docker compose logs -f
```

Reverse proxy (HTTPS) required:
- `https://your.domain/feishu/events` → `http://127.0.0.1:8787/feishu/events`

---

## Configuration highlights / 常用配置

- `ECHO_MODE=true|false` — wiring test vs real forwarding
- `REQUIRE_MENTION_IN_GROUP=true|false` — only respond on @ in groups
- `FEISHU_ENCRYPT_KEY=<32-bytes>` — enable encrypted callbacks
- `PDF_CJK_FONT_PATH=./fonts/NotoSansCJKsc-Regular.otf` — bundled font (see `./fonts/OFL.txt`)

---

## Docs / 更多文档

- Deploy (CN): `DEPLOY.zh-CN.md`
- Deploy (EN): `DEPLOY.en.md`

---

## License

MIT — see `LICENSE`.
