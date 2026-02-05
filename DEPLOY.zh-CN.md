# feishu-bridge — 快速部署/迁移指南（中文）

目标：让任何人用最少步骤把飞书机器人「接收消息 + 回复文本 + 收发文件/图片」跑起来。

> 当前 bridge 特性
> - 接收：text / image / file
> - 发送：text；以及模型回复中包含 `FILE:`/`MEDIA:` 本地路径时自动上传并发送（image/file）
> - 入站附件：自动下载到本地目录 `FEISHU_DOWNLOAD_DIR`，并把 `FILE: <path>` 传给模型
>
> 事件加密（Encrypt Key / encrypt payload）
> - 已支持加密回调（payload 形如 `{ "encrypt": "..." }`）。
> - 在 `.env` 中设置 `FEISHU_ENCRYPT_KEY`（32 字节字符串），并在飞书控制台事件订阅里开启 Encrypt Key（填同一把 key）。
> - 如果你不想用加密，保持 Encrypt Key 关闭即可。

---

## 0) 你需要准备什么

- Node.js 22+（推荐；与 OpenClaw 官方建议一致）
  - 如果你坚持 Node 18/20：本 bridge 通常也能跑，但 OpenClaw 可能要求更高版本
- 已安装本地 Assistant：
  - 新版（推荐）：OpenClaw <https://github.com/openclaw/openclaw>
    - 全局安装：`npm install -g openclaw@latest`（或 `pnpm add -g openclaw@latest`）
    - 初始化向导：`openclaw onboard --install-daemon`
  - 旧版（可选兼容）：Clawdbot（如果你还在用旧环境）
  - 本项目默认 `openclaw` → `clawdbot` 自动探测
- 一个公网 HTTPS 回调地址：
  - 本机开发用 tunnel（cloudflared / ngrok / localtunnel）
  - 或者部署在服务器上，自己有域名/HTTPS 反代
- 飞书开放平台应用（自建应用/机器人）
  - `FEISHU_APP_ID`
  - `FEISHU_APP_SECRET`

---

## 1) 方案 A：本机快速接入（tunnel）

### 1.1 一键生成 .env（推荐）

```bash
cd feishu-bridge
./scripts/setup.sh
```

它会交互式询问并写出 `feishu-bridge/.env`。

### 1.2 安装依赖并启动

```bash
cd feishu-bridge
npm install
npm start
```

### 1.3 开一个 tunnel（3 选 1）

#### A) cloudflared（推荐）

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

它会输出类似 `https://xxxx.trycloudflare.com`。

#### B) ngrok

```bash
ngrok http 8787
```

#### C) localtunnel

```bash
npx localtunnel --port 8787
```

---

## 2) 方案 B：服务器长期运行（Docker Compose）

### 2.1 配置

```bash
cd feishu-bridge
cp .env.example .env
# 填 FEISHU_APP_ID / FEISHU_APP_SECRET 等
```

### 2.2 启动

```bash
cd feishu-bridge
docker compose up -d --build
docker compose logs -f
```

### 2.3 反代（必需）

你需要 HTTPS 域名，将：

- `https://your.domain/feishu/events`

反代到：

- `http://127.0.0.1:8787/feishu/events`

（可以用 Nginx / Traefik / Caddy）

---

## 3) 飞书开放平台配置（事件订阅 + 权限）

### 3.1 事件订阅 URL

把 Request URL 设置为：

- `https://<你的公网域名>/feishu/events`

例如：
- `https://xxxx.trycloudflare.com/feishu/events`

> 注意：如果你开启了 Encrypt Key，本项目会自动解密 `{ "encrypt": "..." }` 回调；如果未开启则按明文回调处理。

### 3.2 权限（Checklist）

不同租户/控制台版本权限名称可能略有差异，但你需要保证这几类能力：

- IM 基础
  - 发送消息（reply）
  - 接收消息事件（im.message.receive_v1）
- 文件/图片
  - 上传文件（im/v1/files）
  - 上传图片（im/v1/images）
  - 下载消息资源（messages/{message_id}/resources/{key}）

> 排障标准：
> - 如果上传/下载失败，通常是 403 或返回 `code != 0`。
> - 先去权限管理里「申请/开通」对应能力，再发布版本。

### 3.3 控制台操作路径（尽量通用）

1. 飞书开放平台 → 进入你的应用
2. 左侧菜单（大概率是以下之一）：
   - “事件订阅 / Event Subscriptions”
   - “机器人 / Bot”
   - “权限管理 / Permissions”
3. 配置：
   - **事件订阅**：填写 `.../feishu/events`
   - **订阅事件**：选择 `im.message.receive_v1`
   - **权限**：开通消息/文件/图片相关权限
4. 保存并发布应用版本（否则权限/订阅可能不生效）

---

## 4) 验证流程（建议按顺序）

### 4.1 健康检查

- `GET http://127.0.0.1:8787/health`
- `GET http://127.0.0.1:8787/debug/env`

### 4.2 验证文本回调

- `.env` 里设置 `ECHO_MODE=true`
- 在飞书里发一句话给机器人
- 应该收到回声回复

### 4.3 验证接收图片/文件

- 继续 `ECHO_MODE=true`
- 在飞书里发图片/文件
- 应该看到回执，且本地 `downloads/` 里出现文件（若 `ECHO_MODE=false` 会下载+转发给模型）

### 4.4 验证“本地文件 → 飞书”

```bash
curl -X POST http://127.0.0.1:8787/debug/send-file \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"oc_xxx","filePath":"/abs/path/to/a.png"}'
```

`chat_id` 可从事件日志 `event.message.chat_id` 获取。

---

## 5) 常见问题

### Q1：PDF 中文乱码怎么办？
A：确保生成 PDF 的进程环境里设置：

- `PDF_CJK_FONT_PATH=./fonts/NotoSansCJKsc-Regular.otf`

本仓库已内置 Noto Sans CJK SC（SIL OFL 1.1，见 `./fonts/OFL.txt`），开箱即用。

### Q2：Encrypt Key 要不要开？
A：可开可不开。
- **不开**：飞书发送明文回调，本项目直接处理。
- **开**：飞书发送 `{ encrypt: "..." }`，本项目会用 `.env` 中的 `FEISHU_ENCRYPT_KEY` 自动解密后再处理。
