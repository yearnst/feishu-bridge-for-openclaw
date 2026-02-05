# feishu-bridge — 快速部署/迁移指南（给别人用）

目标：让任何人用最少步骤把飞书机器人「接收消息 + 回文本 + 收发文件/图片」跑起来。

> 目前该 bridge 依赖：
> - Node.js 22+（推荐；与 OpenClaw 官方建议一致）
> - 本机已安装 OpenClaw（Clawdbot 新名称，推荐）或旧版 Clawdbot（兼容）
> - 一条公网可访问的 HTTPS 回调地址（本地开发用 tunnel：cloudflared / ngrok / localtunnel）
> - 飞书开放平台应用的 App ID/Secret（并开通对应权限）

---

## 0. 你要准备什么

- 在飞书开放平台创建一个应用（机器人/自建应用均可）
- 拿到：
  - `FEISHU_APP_ID`
  - `FEISHU_APP_SECRET`
- 事件订阅（Event Subscription）里要能配置：回调 URL
- Encrypt Key：可开可不开。
  - 不开：明文回调
  - 开：回调为 `{ "encrypt": "..." }`，本项目支持用 `FEISHU_ENCRYPT_KEY` 解密

---

## 1. 一键本地启动（最推荐：本机 + tunnel）

> 新增了交互式脚本：`scripts/setup.sh`，可以自动生成 `.env`。

一条命令：

```bash
cd feishu-bridge
./scripts/setup.sh
```

然后按它输出的步骤启动。

（你也可以继续用手工方式：复制 `.env.example` 再改。）



### 1.1 拉代码 + 安装依赖

```bash
git clone <你的仓库>
cd <你的仓库>
cp .env.example .env
npm install
```

> OpenClaw 安装（推荐）：
>
> ```bash
> npm install -g openclaw@latest
> openclaw onboard --install-daemon
> ```

### 1.2 配置 .env（最少项）

编辑 `feishu-bridge/.env`：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
ECHO_MODE=true
PORT=8787
```

可选但推荐：

```env
FEISHU_DOWNLOAD_DIR=./downloads
FEISHU_MAX_DOWNLOAD_BYTES=31457280
PDF_CJK_FONT_PATH=./fonts/NotoSansCJKsc-Regular.otf
```

> `PDF_CJK_FONT_PATH` 用于确保模型生成 PDF 时中文不乱码（字体已随仓库内置，SIL OFL 1.1，见 `./fonts/OFL.txt`）。

### 1.3 启动 bridge

```bash
npm start
```

终端应该看到类似：
- `feishu-bridge listening on http://127.0.0.1:8787`

---

## 2. 让飞书能回调到你电脑（选一种 tunnel）

你需要一个公网 HTTPS 地址把请求转到本机 8787。

### 方案 A：cloudflared（推荐，稳定且不用注册也能跑）

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

它会打印一个类似 `https://xxxx.trycloudflare.com` 的地址。

### 方案 B：ngrok（更常见，但需要账号/Token）

```bash
ngrok http 8787
```

### 方案 C：localtunnel（最简单，但域名偶尔不稳定）

```bash
npx localtunnel --port 8787
```

---

## 3. 飞书控制台设置（必须）

### 3.1 事件订阅 URL

把 Request URL 设置为：

```
https://<你的公网域名>/feishu/events
```

例如：
```
https://xxxx.trycloudflare.com/feishu/events
```

### 3.2 权限（不然收发文件会失败）

至少需要 IM 相关：
- 接收消息事件
- 发送消息
- 上传文件/图片
- 下载消息资源（用于收文件/图片）

不同租户/应用类型权限名略有差异：如果看到 403 或返回 `code != 0`，先去权限页补齐。

---

## 4. 验证流程（照着做就能知道哪一步坏）

### 4.1 健康检查

浏览器打开：
- `http://127.0.0.1:8787/health`
- `http://127.0.0.1:8787/debug/env`

### 4.2 验证事件订阅（文本）

- `.env` 里设置 `ECHO_MODE=true`
- 在飞书里给机器人发一句话
- 应该回：`收到：...`

### 4.3 验证接收图片/文件

- 继续 `ECHO_MODE=true`
- 在飞书里发图片/文件
- 应该回执收到 image_key/file_key

### 4.4 验证“本地文件 → 飞书发送”

用 debug API（不依赖模型）：

```bash
curl -X POST http://127.0.0.1:8787/debug/send-file \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"oc_xxx","filePath":"/abs/path/to/a.png"}'
```

`chat_id` 可从事件日志里拿到（`event.message.chat_id`）。

---

## 5. 服务器部署（Docker Compose，长期运行）

适合：放到一台有公网域名/HTTPS 的服务器上，稳定对外提供回调。

### 5.1 准备
- 服务器安装 Docker + Docker Compose
- DNS + 证书（推荐用 Nginx/Traefik/Caddy 做 HTTPS 反代到 8787）

### 5.2 配置
```bash
cd feishu-bridge
cp .env.example .env
# 填好 FEISHU_APP_ID / FEISHU_APP_SECRET 等
```

### 5.3 启动
```bash
cd feishu-bridge
docker compose up -d --build
# 看日志
docker compose logs -f
```

### 5.4 反代（示例：Nginx）
把 `https://your.domain/feishu/events` 代理到 `http://127.0.0.1:8787/feishu/events`。

---

## 6. 迁移/分享给别人时的最小交付清单

你只需要给对方：
- 代码仓库（含 `feishu-bridge/`、`fonts/`）
- 这份 `DEPLOY.md`
- 对方自己在飞书开放平台创建自己的应用并填 `.env`

对方不需要你的任何密钥。


你只需要给对方：
- 代码仓库（含 `feishu-bridge/` 和 `fonts/NotoSansCJKsc-Regular.otf`）
- 这份 `DEPLOY.md`
- 让对方在飞书开放平台创建自己的应用并填 `.env`

对方不需要你的任何密钥。

---

## 6. 常见问题

### Q1：Encrypt Key 要不要开？
A：可开可不开。
- **不开**：飞书发送明文回调，本项目直接处理。
- **开**：飞书发送 `{ "encrypt": "..." }`，本项目会用 `.env` 中的 `FEISHU_ENCRYPT_KEY` 自动解密后再处理。

### Q2：PDF 中文乱码怎么办？
A：确保生成 PDF 的进程环境里设置：
`PDF_CJK_FONT_PATH=./fonts/NotoSansCJKsc-Regular.otf`
并且生成器会把字体 embed 进 PDF（否则 PDF 里仍可能缺字/乱码）。

### Q3：对方想部署到服务器，而不是本机 tunnel？
A：把 `feishu-bridge` 放到一台有公网 HTTPS 的机器上（Nginx/Traefik 反代到 8787），回调 URL 直接指向服务器域名即可。
