# Feishu bridge for OpenClaw

> Maintainer: **Charles Chern @AIlinker**

一个本地飞书/Lark 桥接服务（开源版）：接收飞书事件订阅回调 → 转发到本机 **OpenClaw（新名，推荐）/ Clawdbot（旧名，兼容）** → 把模型回复（含附件）发回飞书。

An open-source local Feishu/Lark bridge: receive Event Subscription callbacks → forward to local **OpenClaw (recommended) / Clawdbot (legacy)** → reply back to Feishu (supports files/images).

- 中文详细文档：**README.zh-CN.md**
- English docs: **README.en.md**

## Quick start / 快速开始

```bash
cd feishu-bridge
cp .env.example .env
npm install
npm start
```

> 推荐先设置 `ECHO_MODE=true` 做链路联调；确认回调没问题后再改为 `false` 真实转发给 OpenClaw。

## Deploy / 部署

- 中文：`DEPLOY.zh-CN.md`
- English: `DEPLOY.en.md`

## Notes / 备注

- Default listen: `127.0.0.1:8787`
- Feishu Event Subscription Request URL: `https://<your-public-domain>/feishu/events`
  - Local dev tunnel example: `npx localtunnel --port 8787`

## License

MIT — see `LICENSE`.
