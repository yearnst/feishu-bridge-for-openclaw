# feishu-bridge（本地）

一个本地飞书/Lark 桥接服务（开源版）：

- 接收飞书事件订阅回调
- 将消息转发给本机的 **OpenClaw（新名）/ Clawdbot（旧名）** agent
- 把模型输出再发回同一个飞书会话（支持图片/文件附件）

## 兼容性（重要）

- **OpenClaw** 是 Clawdbot 的新名称：<https://github.com/openclaw/openclaw>
- 本项目默认会自动优先调用 `openclaw`，找不到再调用 `clawdbot`（可用 `ASSISTANT_MODE/ASSISTANT_BIN` 覆盖）。

## 功能

### 入站（飞书 → 本机）
- 支持飞书事件订阅 URL 校验（`challenge`）
- 接收 **文本 / 文件 / 图片**
- 群聊只在 **@提及** 时响应（基于 `mentions`）
- **入站附件**：用户发来的文件/图片会下载到 `FEISHU_DOWNLOAD_DIR`，并以 `FILE: <本地路径>` 形式追加转发给模型

### 出站（本机 → 飞书）
- 回复回同一会话（群聊或私聊）
- **出站附件**：模型回复中出现 `FILE:`/`MEDIA:` 行（指向本地路径）时，会自动 upload + 发送到飞书
- **路径解析增强**：相对路径会在 `cwd`、`outputs/`、`downloads/`、workspace 根目录下尝试寻找
- **统一输出目录**：如果生成文件落在 workspace 根目录，会在发送前自动移动到 `./outputs/`，保证文件都归档在 outputs
- **文件类型推断**：PDF 按 `file_type=pdf` 上传（不再一律 `stream`）
- **隐藏内部执行噪音**：会过滤掉模型输出里类似 `🛠️ Exec: ...` 的工具/命令痕迹，避免污染群消息与泄露路径

### “不超时”交互体验
- 每个会话串行后台队列（避免并发打乱）
- **延迟提示**（默认 120s）：只有在 120s 内没有任何用户可见输出时，才发送 `后台处理… 任务ID：xxxx`
- 可选 **周期进度 ping**（运行中定期提示）

## 事件加密（已支持）

飞书事件订阅可用 `{ "encrypt": "..." }` 方式发送加密回调。

- 在 `.env` 配置 `FEISHU_ENCRYPT_KEY`（32 字节字符串）
- 在飞书后台事件订阅中开启 Encrypt Key（填同一把 key）

本桥会先解密（AES-256-CBC，多种兼容尝试），再按普通事件流程处理。

## 仍未实现
- OCR / PDF 文本抽取暂未做（当前仅把本地路径交给模型）

## 运行（本机）

```bash
cd feishu-bridge
cp .env.example .env
npm install
npm start
```

> 想要完整“小白部署”步骤（含飞书控制台配置、tunnel、验证），看：`DEPLOY.zh-CN.md`

## 关键环境变量

基础：
- `PORT`（默认 `8787`）
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`（建议配置）
- `FEISHU_ENCRYPT_KEY`（可选；如果你在飞书控制台启用了 Encrypt Key，就在这里填同一把 32 字节 key）
- `REQUIRE_MENTION_IN_GROUP`（默认 `true`）
- `ECHO_MODE`（默认 `true`，联调用；真实转发请设 `false`）

Assistant（推荐 OpenClaw；兼容 Clawdbot）：
- `ASSISTANT_MODE`（默认 `auto`；`auto|cli|entry`）
- `ASSISTANT_BIN`（可选；指定 `openclaw` 或 `clawdbot`）
- `CLAWDBOT_ENTRY`（可选；仅 legacy entry 模式需要，指向 Clawdbot 的 `entry.js` 绝对路径）

附件/安全：
- `FEISHU_DOWNLOAD_DIR`（默认 `<workspace>/downloads`）
- `FEISHU_MAX_DOWNLOAD_BYTES`（默认 30MB）

交互/进度：
- `SEND_PROCESSING_HINT`（默认 `true`）
- `PROCESSING_HINT_DELAY_MS`（默认 `120000`）
- `PROGRESS_PING_MS`（默认 `120000`，设 `0` 关闭）

输出目录：
- `CLAWDBOT_OUTPUTS_DIR`（默认 `<workspace>/outputs`）

群聊缓存/媒体配对（可选）：
- `GROUP_CACHE_ENABLED`（默认 `false`；开启后会缓存群聊近况供后续 @ 对话参考）
- `GROUP_CACHE_MAX_ITEMS`（默认 `50`）
- `PENDING_INBOUND_TTL_MS`（默认 `90000`；图片/文件缓存的有效期）
- `MENTION_MEDIA_WAIT_MS`（默认 `1500`；@消息到来时等待图片/文件到达的短窗口）
- `IMPLICIT_PAIR_WINDOW_MS`（默认 `5000`；“刚发媒体 + 只@不说话”的隐式配对窗口）

## 调试接口

- `GET /health`
- `GET /debug/env`
- `POST /debug/send-file { chat_id, filePath }`（手动测试往某个群/会话发附件）

## 部署/分享

- 中文：`DEPLOY.zh-CN.md`
- English: `DEPLOY.en.md`

## License

MIT License. See `LICENSE`.
