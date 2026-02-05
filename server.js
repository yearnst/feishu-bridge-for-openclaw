import express from "express";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

function decryptFeishuPayload({ encrypt, encryptKey }) {
  if (!encrypt || typeof encrypt !== "string") throw new Error("missing encrypt string");

  // Be forgiving about how the key is provided in .env (quotes/whitespace).
  let keyStr = String(encryptKey || "").trim();
  if ((keyStr.startsWith("\"") && keyStr.endsWith("\"")) || (keyStr.startsWith("'") && keyStr.endsWith("'"))) {
    keyStr = keyStr.slice(1, -1).trim();
  }

  const keyRaw = Buffer.from(keyStr, "utf8");
  if (keyRaw.length !== 32) {
    throw new Error(`FEISHU_ENCRYPT_KEY must be 32 bytes (got ${keyRaw.length})`);
  }

  const cipherBuf = Buffer.from(encrypt, "base64");
  if (!cipherBuf.length) throw new Error("encrypt is not valid base64 or is empty");

  // Feishu/Lark docs have historically varied across products/versions.
  // In practice we've seen these patterns:
  // 1) IV derived from key (first 16 bytes)
  // 2) IV prefixed to ciphertext (first 16 bytes of decoded buffer)
  // Key may be the raw 32-byte encrypt key, or SHA-256(encrypt_key).
  const candidates = [];

  const keySha = crypto.createHash("sha256").update(keyRaw).digest(); // 32 bytes

  // (key, iv)
  candidates.push({ name: "keyRaw+ivFromKey", key: keyRaw, iv: keyRaw.subarray(0, 16), data: cipherBuf });
  if (cipherBuf.length > 16) candidates.push({ name: "keyRaw+ivPrefixed", key: keyRaw, iv: cipherBuf.subarray(0, 16), data: cipherBuf.subarray(16) });
  candidates.push({ name: "keySha+ivFromKey", key: keySha, iv: keySha.subarray(0, 16), data: cipherBuf });
  if (cipherBuf.length > 16) candidates.push({ name: "keySha+ivPrefixed", key: keySha, iv: cipherBuf.subarray(0, 16), data: cipherBuf.subarray(16) });

  const errs = [];
  for (const c of candidates) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-cbc", c.key, c.iv);
      decipher.setAutoPadding(true);
      const outBuf = Buffer.concat([decipher.update(c.data), decipher.final()]);
      const outStr = outBuf.toString("utf8");
      const json = JSON.parse(outStr);
      return json;
    } catch (e) {
      errs.push(`${c.name}: ${String(e?.message || e)}`);
    }
  }

  throw new Error(`bad decrypt (tried ${candidates.length} variants): ${errs.slice(0, 4).join(" | ")}`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Workspace root is the parent of feishu-bridge/
const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const OUTPUTS_DIR = process.env.CLAWDBOT_OUTPUTS_DIR || path.join(WORKSPACE_ROOT, "outputs");

function envBool(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return String(v).toLowerCase() === "true" || v === "1";
}

const app = express();

// NOTE: do NOT use a global body parser that consumes the stream for all routes.
// We need /feishu/events to accept weird content-types (sometimes text/plain),
// but we also want normal JSON for debug routes.
app.use((req, res, next) => {
  if (req.path === "/feishu/events") {
    return express.text({ type: "*/*", limit: "2mb" })(req, res, next);
  }
  return express.json({ limit: "2mb" })(req, res, next);
});

// For /feishu/events, convert text body → JSON if possible.
app.use((req, _res, next) => {
  if (req.path === "/feishu/events" && typeof req.body === "string" && req.body.length) {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      // keep as string
    }
  }
  next();
});

const PORT = Number(process.env.PORT || 8787);
const VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN || "";
const ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || "";

const REQUIRE_MENTION_IN_GROUP = envBool("REQUIRE_MENTION_IN_GROUP", true);
const ECHO_MODE = envBool("ECHO_MODE", true);

// Assistant runner (Clawdbot legacy / OpenClaw new)
// Prefer CLI mode for portability.
// - auto: try OPENCLAW_BIN/clawdbot in PATH; fallback to CLAWDBOT_ENTRY if provided
// - cli: run `openclaw agent ...` or `clawdbot agent ...`
// - entry: run `node <entry.js> agent ...` (legacy)
const ASSISTANT_MODE = (process.env.ASSISTANT_MODE || "auto").toLowerCase(); // auto|cli|entry
const ASSISTANT_BIN = process.env.ASSISTANT_BIN || ""; // e.g. openclaw | clawdbot
const CLAWDBOT_ENTRY = process.env.CLAWDBOT_ENTRY || ""; // legacy: absolute path to clawdbot entry.js

const DOWNLOAD_DIR = process.env.FEISHU_DOWNLOAD_DIR || path.join(WORKSPACE_ROOT, "downloads");
const MAX_DOWNLOAD_BYTES = Number(process.env.FEISHU_MAX_DOWNLOAD_BYTES || 30 * 1024 * 1024); // 30MB default

// If you want "never timeout" user experience, keep this as 0 and use background jobs.
// This is a hard kill-switch only; users will get a job-id and a later delivery.
const CLAWDBOT_HARD_TIMEOUT_MS = Number(process.env.CLAWDBOT_HARD_TIMEOUT_MS || 0);

// Processing hint (delayed): if the job still hasn't produced any user-visible output
// after PROCESSING_HINT_DELAY_MS, send "后台处理… 任务ID：xxxx".
const SEND_PROCESSING_HINT = envBool("SEND_PROCESSING_HINT", true);
const PROCESSING_HINT_DELAY_MS = Number(process.env.PROCESSING_HINT_DELAY_MS || 120_000);

// Optional: periodic progress ping while running (0 disables).
// NOTE: any progress ping counts as a "reply" for the purpose of suppressing the delayed task-id hint.
const PROGRESS_PING_MS = Number(process.env.PROGRESS_PING_MS || 120_000);

function mustHave(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

// --- Feishu token + send message (for echo replies)
let cachedTenantToken = null;
let cachedTenantTokenExp = 0;

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedTenantToken && now < cachedTenantTokenExp - 30_000) return cachedTenantToken;

  const app_id = mustHave("FEISHU_APP_ID");
  const app_secret = mustHave("FEISHU_APP_SECRET");

  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id, app_secret }),
  });
  const json = await res.json();
  if (!res.ok || json.code !== 0) {
    throw new Error(`tenant_access_token error: http=${res.status} body=${JSON.stringify(json)}`);
  }

  cachedTenantToken = json.tenant_access_token;
  // expires_in is seconds
  cachedTenantTokenExp = now + Number(json.expire || json.expires_in || 7200) * 1000;
  return cachedTenantToken;
}

async function sendTextMessage({ receive_id_type, receive_id, text }) {
  const token = await getTenantAccessToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receive_id_type)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 0) {
    throw new Error(`send text message error: http=${res.status} body=${JSON.stringify(json)}`);
  }
  return json;
}

function guessIsImage(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext);
}

function resolveLocalMediaPath(p) {
  const s = String(p || "").trim();
  if (!s) return null;

  // Ignore URLs
  if (/^https?:\/\//i.test(s)) return null;

  // Absolute path
  if (path.isAbsolute(s)) return fs.existsSync(s) ? s : null;

  // Relative path: try a few common bases
  const bases = [
    process.cwd(),
    OUTPUTS_DIR,
    DOWNLOAD_DIR,
    WORKSPACE_ROOT,
  ];

  for (const base of bases) {
    const cand = path.resolve(base, s);
    if (fs.existsSync(cand)) return cand;
  }

  return null;
}

function extractMediaPathsFromText(text) {
  // Support common conventions:
  // - "MEDIA: /abs/or/rel/path"
  // - "FILE: /abs/or/rel/path"
  // Multiple lines allowed.
  if (!text) return [];
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^(MEDIA|FILE)\s*:\s*(.+)$/i);
    if (!m) continue;
    const p = m[2].trim();
    if (p) out.push(p);
  }
  return out;
}

function stripMediaLines(text) {
  if (!text) return text;
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !/^(MEDIA|FILE)\s*:/i.test(line.trim()))
    .join("\n")
    .trim();
}

function stripToolTraces(text) {
  // Hide internal tool traces that may leak into model output, e.g.:
  // - "🛠️ Exec: ..."
  // - "📖 Read: ..."
  // This is user-visible noise and can reveal local paths/commands.
  if (!text) return text;

  const lines = String(text).split(/\r?\n/);
  const out = [];

  let skipHeredoc = null; // marker string if we are inside a heredoc block

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // If we're skipping a heredoc body, stop when we hit the marker on its own line.
    if (skipHeredoc) {
      if (line.trim() === skipHeredoc) {
        skipHeredoc = null;
      }
      continue;
    }

    const trimmed = line.trim();

    // Detect common tool-trace prefixes.
    const isExecTrace = /^🛠️\s*Exec\s*:/i.test(trimmed) || /^Exec\s*:/i.test(trimmed);
    const isReadTrace = /^📖\s*Read\s*:/i.test(trimmed) || /^Read\s*:/i.test(trimmed);

    if (isExecTrace) {
      // If this exec trace starts a heredoc, skip until the marker.
      const m = trimmed.match(/<<\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))\s*$/);
      const marker = (m && (m[1] || m[2] || m[3])) || null;
      if (marker) skipHeredoc = marker;
      continue;
    }

    if (isReadTrace) {
      // Drop the read trace line (contains local path).
      continue;
    }

    out.push(line);
  }

  return out.join("\n").trim();
}

function inferFeishuFileType(fileNameOrPath) {
  const ext = path.extname(String(fileNameOrPath || "")).toLowerCase();
  // Feishu IM file upload supports specific file_type values; fall back to "stream".
  // Common: "pdf" | "doc" | "xls" | "ppt" | "mp4" | "opus" | "txt" | "stream"
  if (ext === ".pdf") return "pdf";
  if (ext === ".doc" || ext === ".docx") return "doc";
  if (ext === ".xls" || ext === ".xlsx" || ext === ".csv") return "xls";
  if (ext === ".ppt" || ext === ".pptx") return "ppt";
  if (ext === ".mp4") return "mp4";
  if (ext === ".opus") return "opus";
  if (ext === ".txt" || ext === ".md") return "txt";
  return "stream";
}

async function uploadFileFromPath(filePath) {
  const token = await getTenantAccessToken();
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const buf = fs.readFileSync(abs);
  const fileName = path.basename(abs);
  const fileType = inferFeishuFileType(fileName);

  const form = new FormData();
  form.append("file_type", fileType);
  form.append("file_name", fileName);
  form.append("file", new Blob([buf]), fileName);

  const res = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}` },
    body: form,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 0) {
    throw new Error(`upload file error: http=${res.status} body=${JSON.stringify(json)}`);
  }

  const file_key = json?.data?.file_key;
  if (!file_key) throw new Error(`upload file: missing file_key in response: ${JSON.stringify(json)}`);
  return { file_key, fileName };
}

async function uploadImageFromPath(filePath) {
  const token = await getTenantAccessToken();
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const buf = fs.readFileSync(abs);
  const fileName = path.basename(abs);

  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", new Blob([buf]), fileName);

  const res = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}` },
    body: form,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 0) {
    throw new Error(`upload image error: http=${res.status} body=${JSON.stringify(json)}`);
  }

  const image_key = json?.data?.image_key;
  if (!image_key) throw new Error(`upload image: missing image_key in response: ${JSON.stringify(json)}`);
  return { image_key, fileName };
}

async function sendFileMessage({ receive_id_type, receive_id, file_key }) {
  const token = await getTenantAccessToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receive_id_type)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id,
      msg_type: "file",
      content: JSON.stringify({ file_key }),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 0) {
    throw new Error(`send file message error: http=${res.status} body=${JSON.stringify(json)}`);
  }
  return json;
}

async function sendImageMessage({ receive_id_type, receive_id, image_key }) {
  const token = await getTenantAccessToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receive_id_type)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id,
      msg_type: "image",
      content: JSON.stringify({ image_key }),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 0) {
    throw new Error(`send image message error: http=${res.status} body=${JSON.stringify(json)}`);
  }
  return json;
}

// --- Background job queue ("never timeout" UX)
const jobChainsBySession = new Map();

function enqueueSessionJob(sessionId, fn) {
  const prev = jobChainsBySession.get(sessionId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const startedAt = Date.now();
      console.log("job start", { sessionId, startedAt });
      try {
        await fn();
      } finally {
        console.log("job end", { sessionId, tookMs: Date.now() - startedAt });
      }
    })
    .finally(() => {
      if (jobChainsBySession.get(sessionId) === next) jobChainsBySession.delete(sessionId);
    });
  jobChainsBySession.set(sessionId, next);
  return next;
}

async function downloadMessageResource({ message_id, file_key, type }) {
  // Feishu resource download endpoint (commonly):
  // GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=file|image
  const token = await getTenantAccessToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(message_id)}/resources/${encodeURIComponent(file_key)}?type=${encodeURIComponent(type)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`download resource error: http=${res.status} body=${txt.slice(0, 800)}`);
  }

  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > MAX_DOWNLOAD_BYTES) {
    throw new Error(`download too large: ${len} > ${MAX_DOWNLOAD_BYTES}`);
  }

  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`download too large: ${ab.byteLength} > ${MAX_DOWNLOAD_BYTES}`);
  }
  return Buffer.from(ab);
}

function safeFileName(name, fallback = "file") {
  const base = (name || fallback).toString();
  // Remove path separators and weird control chars
  return base.replace(/[\\/\0\r\n\t]/g, "_").slice(0, 160) || fallback;
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeToOutputs(absPath) {
  try {
    if (!absPath) return absPath;
    const abs = path.resolve(absPath);
    ensureDirSync(OUTPUTS_DIR);

    // If file already in outputs/ (or downloads/), do nothing.
    const inOutputs = abs.startsWith(path.resolve(OUTPUTS_DIR) + path.sep);
    const inDownloads = abs.startsWith(path.resolve(DOWNLOAD_DIR) + path.sep);
    if (inOutputs || inDownloads) return abs;

    // Only normalize files that live directly under workspace root.
    const parent = path.dirname(abs);
    if (path.resolve(parent) !== path.resolve(WORKSPACE_ROOT)) return abs;

    const dest = path.join(OUTPUTS_DIR, path.basename(abs));
    if (dest === abs) return abs;

    // If destination exists, add a short suffix to avoid clobbering.
    let finalDest = dest;
    if (fs.existsSync(finalDest)) {
      const ext = path.extname(dest);
      const base = path.basename(dest, ext);
      finalDest = path.join(OUTPUTS_DIR, `${base}__${Date.now()}${ext}`);
    }

    fs.renameSync(abs, finalDest);
    return finalDest;
  } catch (e) {
    console.error("normalizeToOutputs failed", { absPath, err: String(e?.message || e) });
    return absPath;
  }
}

function saveDownloadedResource({ buffer, fileName }) {
  ensureDirSync(DOWNLOAD_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = safeFileName(fileName);
  const outPath = path.join(DOWNLOAD_DIR, `${ts}__${name}`);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

function commandExists(cmd) {
  if (!cmd) return false;
  try {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    // Some CLIs return nonzero for --version; presence is enough if it's not ENOENT.
    if (r?.error && String(r.error?.code) === "ENOENT") return false;
    return true;
  } catch {
    return false;
  }
}

function resolveAssistantRunner() {
  // Explicit mode
  if (ASSISTANT_MODE === "entry") {
    if (!CLAWDBOT_ENTRY) throw new Error("ASSISTANT_MODE=entry requires CLAWDBOT_ENTRY");
    return { mode: "entry", name: "clawdbot(entry)", command: process.execPath, baseArgs: [CLAWDBOT_ENTRY] };
  }

  if (ASSISTANT_MODE === "cli") {
    const bin = ASSISTANT_BIN || (commandExists("openclaw") ? "openclaw" : "clawdbot");
    if (!commandExists(bin)) throw new Error(`ASSISTANT_MODE=cli but command not found: ${bin}`);
    return { mode: "cli", name: bin, command: bin, baseArgs: [] };
  }

  // auto
  if (ASSISTANT_BIN) {
    if (!commandExists(ASSISTANT_BIN)) throw new Error(`ASSISTANT_BIN not found in PATH: ${ASSISTANT_BIN}`);
    return { mode: "cli", name: ASSISTANT_BIN, command: ASSISTANT_BIN, baseArgs: [] };
  }

  if (commandExists("openclaw")) return { mode: "cli", name: "openclaw", command: "openclaw", baseArgs: [] };
  if (commandExists("clawdbot")) return { mode: "cli", name: "clawdbot", command: "clawdbot", baseArgs: [] };

  if (CLAWDBOT_ENTRY) return { mode: "entry", name: "clawdbot(entry)", command: process.execPath, baseArgs: [CLAWDBOT_ENTRY] };

  throw new Error("No assistant runner found. Install openclaw/clawdbot in PATH, or set ASSISTANT_BIN, or set CLAWDBOT_ENTRY.");
}

function runClawdbotAgent({ sessionId, message, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const runner = resolveAssistantRunner();

    // Both Clawdbot and OpenClaw support: agent --session-id ... --message ... --json
    const args = [...runner.baseArgs, "agent", "--session-id", sessionId, "--message", message, "--json"];

    const child = spawn(runner.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let out = "";
    let err = "";

    let timer = null;
    if (timeoutMs && Number(timeoutMs) > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${runner.name} agent timeout after ${timeoutMs}ms`));
      }, Number(timeoutMs));
    }

    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`${runner.name} agent failed code=${code} stderr=${err.trim()}`));
      }
      try {
        const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
        const cleaned = stripAnsi(out).trim();

        // Some CLIs may print banners/logs; extract the last JSON object from output.
        const first = cleaned.indexOf("{");
        const last = cleaned.lastIndexOf("}");
        if (first < 0 || last < 0 || last <= first) {
          return reject(new Error(`${runner.name} agent produced no JSON. raw=${cleaned.slice(0, 800)}`));
        }
        const jsonStr = cleaned.slice(first, last + 1);
        const json = JSON.parse(jsonStr);

        // Normalize output: { text, mediaPaths[] }
        let text = json?.reply?.text || json?.text || json?.result?.text;
        const mediaPaths = [];

        // Newer CLI shape: { result: { payloads: [ { text, mediaUrl? }, ...] } }
        if (Array.isArray(json?.result?.payloads)) {
          if (!text) {
            text = json.result.payloads
              .map((p) => (p && typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n");
          }

          for (const p of json.result.payloads) {
            if (!p) continue;
            const cand = p.mediaPath || p.media_path || p.path || p.filePath || p.file_path;
            if (typeof cand === "string" && cand.trim()) mediaPaths.push(cand.trim());
            if (typeof p.mediaUrl === "string" && p.mediaUrl.trim()) mediaPaths.push(p.mediaUrl.trim());
          }
        }

        if (!text && typeof json?.result?.payload?.text === "string") {
          text = json.result.payload.text;
        }

        if (typeof text === "string") {
          for (const p of extractMediaPathsFromText(text)) mediaPaths.push(p);
        }

        if (!text) return reject(new Error(`${runner.name} agent returned no text. raw=${jsonStr.slice(0, 800)}`));
        resolve({ text, mediaPaths });
      } catch (e) {
        reject(new Error(`failed to parse agent JSON. err=${e.message} raw=${out.slice(0, 800)}`));
      }
    });
  });
}

// --- Helpers
function isChallenge(body) {
  return body && typeof body.challenge === "string";
}

function getPlainEvent(body) {
  // Feishu event payload (non-encrypted)
  // { schema, header:{event_type, token}, event:{...} }
  return body?.event;
}

function getHeader(body) {
  return body?.header;
}

function extractTextMessage(event) {
  // event.message.content is a JSON string for text messages
  try {
    const msg = event?.message;
    if (!msg) return null;
    if (msg.message_type !== "text") return null;
    const content = JSON.parse(msg.content || "{}");
    return content.text || "";
  } catch {
    return null;
  }
}

function extractPostMessageText(event) {
  // Feishu "post" message is rich text. content is a JSON string with nested arrays.
  // We extract visible text nodes so users can @mention + ask questions in a post.
  try {
    const msg = event?.message;
    if (!msg) return null;
    if (msg.message_type !== "post") return null;
    const content = JSON.parse(msg.content || "{}");
    const post = content?.post;
    const blocks = post?.content;
    if (!Array.isArray(blocks)) return "";

    const texts = [];
    for (const block of blocks) {
      if (!Array.isArray(block)) continue;
      for (const node of block) {
        if (!node) continue;
        if (typeof node.text === "string") texts.push(node.text);
        // Some nodes nest text differently; ignore non-text nodes for now.
      }
    }
    return texts.join("").trim();
  } catch {
    return null;
  }
}

function extractFileMessage(event) {
  try {
    const msg = event?.message;
    if (!msg) return null;
    if (msg.message_type !== "file") return null;
    const content = JSON.parse(msg.content || "{}");
    return {
      message_id: msg.message_id,
      file_key: content.file_key,
      file_name: content.file_name,
    };
  } catch {
    return null;
  }
}

function extractPostImageKeys(event) {
  // Extract embedded images from a Feishu "post" message.
  // In practice, post node shapes vary. We'll do:
  // 1) A fast path for common node.image_key / node.image.image_key
  // 2) A bounded recursive scan for any field named image_key/img_key
  try {
    const msg = event?.message;
    if (!msg) return [];
    if (msg.message_type !== "post") return [];
    const content = JSON.parse(msg.content || "{}");

    const keys = new Set();

    const blocks = content?.post?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (!Array.isArray(block)) continue;
        for (const node of block) {
          if (!node || typeof node !== "object") continue;
          const k1 = node.image_key || node.imageKey || node.img_key || node.imgKey;
          const k2 = node?.image?.image_key || node?.image?.imageKey || node?.image?.img_key || node?.image?.imgKey;
          for (const k of [k1, k2]) {
            if (typeof k === "string" && k.trim()) keys.add(k.trim());
          }
        }
      }
    }

    // Bounded recursive scan (depth + node count) to catch other shapes.
    let seen = 0;
    const maxNodes = 2000;
    const maxDepth = 12;

    const walk = (obj, depth) => {
      if (!obj || depth > maxDepth) return;
      if (seen++ > maxNodes) return;

      if (Array.isArray(obj)) {
        for (const v of obj) walk(v, depth + 1);
        return;
      }
      if (typeof obj !== "object") return;

      for (const [k, v] of Object.entries(obj)) {
        if ((k === "image_key" || k === "img_key" || k === "imageKey" || k === "imgKey") && typeof v === "string" && v.trim()) {
          keys.add(v.trim());
        } else {
          walk(v, depth + 1);
        }
      }
    };

    walk(content, 0);

    return Array.from(keys);
  } catch {
    return [];
  }
}

function extractImageMessage(event) {
  try {
    const msg = event?.message;
    if (!msg) return null;

    if (msg.message_type === "image") {
      const content = JSON.parse(msg.content || "{}");
      return {
        message_id: msg.message_id,
        image_key: content.image_key,
      };
    }

    if (msg.message_type === "post") {
      const keys = extractPostImageKeys(event);
      if (!keys.length) return null;
      return { message_id: msg.message_id, image_key: keys[0] };
    }

    return null;
  } catch {
    return null;
  }
}

function isGroupChat(event) {
  // chat_type: "group" | "p2p" (common)
  return event?.message?.chat_type === "group";
}

function botWasMentioned(event) {
  // mentions: [{ key, id, name, tenant_key }]
  const mentions = event?.message?.mentions;
  if (!Array.isArray(mentions) || mentions.length === 0) return false;
  // Any mention counts; Feishu only includes mentions that exist.
  return true;
}

function getReplyTarget(event) {
  // We reply back to the same chat.
  // For both p2p and group, the chat_id is usually available.
  const chat_id = event?.message?.chat_id;
  if (!chat_id) return null;
  return { receive_id_type: "chat_id", receive_id: chat_id };
}

// --- Pending attachment pairing (group chats)
// Some Feishu clients send an image as a standalone message (no mentions),
// then the user sends a separate @mention rich-text "post" to ask about it.
// We keep a short-lived cache of the latest inbound attachments per chat and
// attach them when the next mentioned message arrives.
const pendingInboundByChat = new Map();
const PENDING_INBOUND_TTL_MS = Number(process.env.PENDING_INBOUND_TTL_MS || 90_000);
const MENTION_MEDIA_WAIT_MS = Number(process.env.MENTION_MEDIA_WAIT_MS || 1500);

// Optional: cache recent group messages (text/post/file/image) so later @mentions can reference context.
const GROUP_CACHE_ENABLED = envBool("GROUP_CACHE_ENABLED", false);
const GROUP_CACHE_MAX_ITEMS = Number(process.env.GROUP_CACHE_MAX_ITEMS || 50);
const IMPLICIT_PAIR_WINDOW_MS = Number(process.env.IMPLICIT_PAIR_WINDOW_MS || 5_000);
const groupCacheByChat = new Map();

function cacheGroupItem(chatId, item) {
  if (!GROUP_CACHE_ENABLED) return;
  if (!chatId || !item) return;
  const now = Date.now();
  const prev = groupCacheByChat.get(chatId);
  const items = Array.isArray(prev?.items) ? prev.items : [];
  items.push({ ...item, at: now });
  groupCacheByChat.set(chatId, { items: items.slice(-GROUP_CACHE_MAX_ITEMS), at: now });
}

function getGroupCacheText(chatId) {
  if (!GROUP_CACHE_ENABLED) return "";
  const entry = groupCacheByChat.get(chatId);
  const items = Array.isArray(entry?.items) ? entry.items : [];
  if (!items.length) return "";

  // Keep it compact; do not include local paths unless they are referenced as FILE: lines.
  const lines = [];
  for (const it of items.slice(-20)) {
    if (it.kind === "text") lines.push(`- [text] ${it.text}`);
    else if (it.kind === "file") lines.push(`- [file] ${it.name || "(unknown)"}`);
    else if (it.kind === "image") lines.push(`- [image] ${it.name || "(image)"}`);
    else lines.push(`- [${it.kind || "item"}]`);
  }
  return ["[group_cache:last_messages]", ...lines, "[/group_cache]"].join("\n");
}

function rememberPendingInbound(chatId, filePath) {
  if (!chatId || !filePath) return;
  const now = Date.now();
  const prev = pendingInboundByChat.get(chatId);
  const items = Array.isArray(prev?.items) ? prev.items : [];
  items.push({ path: filePath, at: now });
  // Keep it small: last 5
  const trimmed = items.slice(-5);
  pendingInboundByChat.set(chatId, { items: trimmed, at: now });
}

function takePendingInbound(chatId) {
  if (!chatId) return [];
  const now = Date.now();
  const entry = pendingInboundByChat.get(chatId);
  if (!entry?.items?.length) return [];
  const fresh = entry.items.filter((it) => now - (it.at || 0) <= PENDING_INBOUND_TTL_MS).map((it) => it.path);
  pendingInboundByChat.delete(chatId);
  return fresh;
}

function peekPendingInboundItems(chatId) {
  if (!chatId) return [];
  const now = Date.now();
  const entry = pendingInboundByChat.get(chatId);
  if (!entry?.items?.length) return [];
  return entry.items
    .filter((it) => now - (it.at || 0) <= PENDING_INBOUND_TTL_MS)
    .map((it) => ({ path: it.path, at: it.at || 0, ageMs: now - (it.at || 0) }));
}

function peekPendingInbound(chatId) {
  return peekPendingInboundItems(chatId).map((it) => it.path);
}

function shouldAttachPendingMediaByKeywords(userText) {
  const t = String(userText || "").trim().toLowerCase();
  if (!t) return false;

  // Attach pending media only when the user clearly references an image/file.
  // Chinese keywords
  const zh = /(这张|这幅|这图|图片|图里|图中|看图|识图|读图|看一下|帮我看|截图|相片|照片|上面的图|刚才的图|刚刚的图|附件|文件|pdf|文档)/;
  // English keywords
  const en = /(this image|the image|picture|photo|screenshot|see attached|attachment|file|pdf|document|read the image|analyze the image|ocr)/;

  return zh.test(userText) || en.test(t);
}

// --- Routes
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/debug/env", (_req, res) => {
  res.json({
    ok: true,
    hasAppId: Boolean(process.env.FEISHU_APP_ID),
    hasAppSecret: Boolean(process.env.FEISHU_APP_SECRET),
    hasVerificationToken: Boolean(process.env.FEISHU_VERIFICATION_TOKEN),
    requireMentionInGroup: REQUIRE_MENTION_IN_GROUP,
    echoMode: ECHO_MODE,
    port: PORT,
    clawdbotEntry: CLAWDBOT_ENTRY,
    downloadDir: DOWNLOAD_DIR,
    maxDownloadBytes: MAX_DOWNLOAD_BYTES,
  });
});

// Local manual test: send a local file to a chat.
// POST /debug/send-file { chat_id, filePath }
app.post("/debug/send-file", async (req, res) => {
  try {
    const { chat_id, filePath } = req.body || {};
    if (!chat_id) return res.status(400).json({ ok: false, error: "missing chat_id" });
    if (!filePath) return res.status(400).json({ ok: false, error: "missing filePath" });

    const target = { receive_id_type: "chat_id", receive_id: chat_id };
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: `file not found: ${abs}` });

    if (guessIsImage(abs)) {
      const { image_key } = await uploadImageFromPath(abs);
      await sendImageMessage({ ...target, image_key });
    } else {
      const { file_key } = await uploadFileFromPath(abs);
      await sendFileMessage({ ...target, file_key });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/debug/build", async (_req, res) => {
  const fs = await import("node:fs/promises");
  const st = await fs.stat(new URL(import.meta.url));
  res.json({ ok: true, startedAt: new Date().toISOString(), fileMtimeMs: st.mtimeMs });
});

// Some Feishu consoles probe with GET; return JSON so it doesn't complain.
app.get("/feishu/events", (_req, res) => res.json({ ok: true }));

app.post("/feishu/events", async (req, res) => {
  let body = req.body;
  try {
    const hdr = getHeader(body);
    console.log("/feishu/events", {
      hasChallenge: typeof body?.challenge === "string",
      hasEncrypt: typeof body?.encrypt === "string",
      eventType: hdr?.event_type,
      tokenPresent: Boolean(hdr?.token),
    });
  } catch {}

  // If encryption is enabled, Feishu sends { encrypt: "..." } and we need to decrypt.
  if (body && typeof body.encrypt === "string") {
    if (!ENCRYPT_KEY) {
      // Fail fast: we cannot process encrypted callbacks without the key.
      return res.status(400).json({ ok: false, error: "received encrypted payload but FEISHU_ENCRYPT_KEY is not set" });
    }
    try {
      body = decryptFeishuPayload({ encrypt: body.encrypt, encryptKey: ENCRYPT_KEY });
      // Avoid logging full decrypted body (privacy). Just log minimal shape.
      try {
        const hdr = getHeader(body);
        console.log("decrypted payload", {
          hasChallenge: typeof body?.challenge === "string",
          eventType: hdr?.event_type,
        });
      } catch {}
    } catch (err) {
      console.error("decrypt failed", err);
      return res.status(400).json({ ok: false, error: `decrypt failed: ${String(err?.message || err)}` });
    }
  }

  // URL verification
  if (isChallenge(body)) {
    return res.json({ challenge: body.challenge });
  }

  // Token verification (best-effort; Feishu may omit token in some contexts)
  const header = getHeader(body);
  if (VERIFICATION_TOKEN && header?.token && header.token !== VERIFICATION_TOKEN) {
    return res.status(401).json({ ok: false, error: "verification token mismatch" });
  }

  const event = getPlainEvent(body);
  if (!event) {
    // Always 200 to stop retries when payload is irrelevant.
    return res.json({ ok: true, ignored: true, note: "no event field" });
  }

  try {
    console.log("event.message", {
      chat_type: event?.message?.chat_type,
      message_type: event?.message?.message_type,
      hasMentions: Array.isArray(event?.message?.mentions) ? event.message.mentions.length : 0,
    });
  } catch {}

  let text = extractTextMessage(event);
  if (text == null) text = extractPostMessageText(event);

  const fileMsg = extractFileMessage(event);
  const imageMsg = extractImageMessage(event);
  const group = isGroupChat(event);
  const chatId = event?.message?.chat_id;

  if (event?.message?.message_type === "post") {
    const ks = extractPostImageKeys(event);
    if (ks.length) console.log("post embedded images", { chatId, count: ks.length, sample: ks.slice(0, 2) });
    // Cache embedded images in post messages when enabled.
    if (group && chatId && ks.length) cacheGroupItem(chatId, { kind: "image", name: "(embedded image)", image_key: ks[0] });
  }

  // Cache raw text/post content (even if not mentioned) when enabled.
  if (group && chatId && text && String(text).trim()) {
    cacheGroupItem(chatId, { kind: "text", text: String(text).trim().slice(0, 800) });
  }

  // Feishu group @mentions can arrive as a text OR post message with empty content.
  // If the bot was mentioned, treat it as a valid trigger even when text is empty.
  if ((event?.message?.message_type === "text" || event?.message?.message_type === "post") && (!text || !String(text).trim()) && botWasMentioned(event)) {
    text = "[feishu:mention]";
  }

  const wasMentioned = botWasMentioned(event);

  // Group gating: ignore unless @mentioned.
  // Exception: allow inbound media (image/file) to pass so we can cache it, because some clients
  // send the @mention as a separate "post" message.
  if (group && REQUIRE_MENTION_IN_GROUP && !wasMentioned && !fileMsg && !imageMsg) {
    return res.json({ ok: true, ignored: true, reason: "not mentioned" });
  }

  // Always ack quickly
  res.json({ ok: true });

  if (!text && !fileMsg && !imageMsg) return;

  const target = getReplyTarget(event);
  if (!target) return;

  if (ECHO_MODE) {
    // In echo mode, keep group gating strict: only respond when mentioned.
    if (group && REQUIRE_MENTION_IN_GROUP && !wasMentioned) return;

    const prefix = group ? "[群聊]" : "[私聊]";
    let reply = "";
    if (text) reply = `${prefix} 收到：${text}`;
    else if (fileMsg) reply = `${prefix} 收到文件：${fileMsg.file_name || "(unknown)"} file_key=${fileMsg.file_key || "(none)"}`;
    else if (imageMsg) reply = `${prefix} 收到图片：image_key=${imageMsg.image_key || "(none)"}`;

    try {
      await sendTextMessage({ ...target, text: reply });
    } catch (err) {
      console.error("sendTextMessage failed", err);
    }
    return;
  }

  // Real mode: forward into Clawdbot and reply with the model output.
  const sessionId = group ? `feishu:group:${event?.message?.chat_id}` : `feishu:p2p:${event?.message?.chat_id}`;

  let forwardText = text;

  // Provide channel context so the agent doesn't hallucinate other channels (e.g., WhatsApp)
  // and knows that Feishu supports sending attachments via FILE:/MEDIA: lines.
  const channelPreamble = [
    "[channel:feishu]",
    "You are replying inside a Feishu (Lark) chat.",
    "This chat supports sending images/files. To send an attachment, include lines like:",
    "FILE: <local path>",
    "MEDIA: <local path>",
    `When generating files (e.g., PDFs), always save them under: ${OUTPUTS_DIR} and reference them as FILE: outputs/<name>.`,
    "Do NOT mention WhatsApp/Telegram or other channels unless the user explicitly asks.",
    "[/channel]",
    "",
  ].join("\n");

  // If user sent a file/image, download it locally and pass a FILE: line to the model.
  const inboundAttachments = [];
  if (fileMsg?.message_id && fileMsg?.file_key) {
    console.log("inbound file msg", fileMsg);
    try {
      const buf = await downloadMessageResource({ message_id: fileMsg.message_id, file_key: fileMsg.file_key, type: "file" });
      const saved = saveDownloadedResource({ buffer: buf, fileName: fileMsg.file_name || `feishu_file_${fileMsg.file_key}` });
      inboundAttachments.push(saved);
      console.log("saved inbound file", saved);
      if (chatId) {
        rememberPendingInbound(chatId, saved);
        cacheGroupItem(chatId, { kind: "file", name: fileMsg.file_name || path.basename(saved), path: saved });
      }
    } catch (err) {
      console.error("download inbound file failed", err);
    }
  }
  if (imageMsg?.message_id && imageMsg?.image_key) {
    console.log("inbound image msg", imageMsg);
    try {
      const buf = await downloadMessageResource({ message_id: imageMsg.message_id, file_key: imageMsg.image_key, type: "image" });
      const saved = saveDownloadedResource({ buffer: buf, fileName: `feishu_image_${imageMsg.image_key}.jpg` });
      inboundAttachments.push(saved);
      console.log("saved inbound image", saved);
      if (chatId) {
        rememberPendingInbound(chatId, saved);
        cacheGroupItem(chatId, { kind: "image", name: path.basename(saved), path: saved });
      }
    } catch (err) {
      console.error("download inbound image failed", err);
      // If user mentioned the bot and we couldn't fetch the image, tell them explicitly.
      if (wasMentioned) {
        try {
          await sendTextMessage({
            ...target,
            text: `我收到了图片引用，但从飞书下载图片失败（可能是权限/资源过期/接口限制）。\nimage_key=${imageMsg.image_key}\n错误：${String(err?.message || err)}`,
          });
        } catch {}
      }
    }
  }

  if (!forwardText && fileMsg) {
    forwardText = `[feishu:file] name=${fileMsg.file_name || ""} file_key=${fileMsg.file_key || ""}`.trim();
  }
  if (!forwardText && imageMsg) {
    forwardText = `[feishu:image] image_key=${imageMsg.image_key || ""}`.trim();
  }

  // If this message mentions the bot but doesn't include the image/file in the same message,
  // attach any recently uploaded inbound media cached for this chat.
  if (wasMentioned && chatId && inboundAttachments.length === 0) {
    // Attach pending media only when it is clearly intended.
    // 1) Keyword-based (explicit: "看图/图片/附件/pdf" etc.)
    // 2) Mention-only ping shortly after a media upload (implicit: user sent media + @ as a paired action)

    const pendingItems0 = peekPendingInboundItems(chatId);
    const hasPending = pendingItems0.length > 0;
    const newestAgeMs = hasPending ? Math.min(...pendingItems0.map((x) => x.ageMs)) : Infinity;

    const trimmed = String(forwardText || "").trim();
    const isMentionOnly = trimmed === "[feishu:mention]" || trimmed.length <= 2;

    const wantsByKeywords = shouldAttachPendingMediaByKeywords(forwardText);
    const wantsByImplicitPair = isMentionOnly && hasPending && newestAgeMs <= IMPLICIT_PAIR_WINDOW_MS;

    if (wantsByKeywords || wantsByImplicitPair) {
      // First try immediate take.
      let pending = takePendingInbound(chatId);

      // If nothing yet, wait briefly: Feishu clients sometimes send image and @mention as separate messages
      // in unpredictable order.
      if (!pending.length && MENTION_MEDIA_WAIT_MS > 0) {
        const deadline = Date.now() + MENTION_MEDIA_WAIT_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          pending = takePendingInbound(chatId);
          if (pending.length) break;
        }
      }

      for (const p of pending) inboundAttachments.push(p);
      if (pending.length) console.log("attached pending inbound", { chatId, count: pending.length, wantsByKeywords, wantsByImplicitPair, newestAgeMs });

      // If user didn't provide any actual instruction besides @, ask the model to describe the image.
      if ((isMentionOnly || !trimmed) && inboundAttachments.length) {
        forwardText = "用户发来图片/附件并@你，但没有给出具体问题。请先描述图片内容（含识别到的文字/关键信息），并给出你观察到的要点，然后问我希望你进一步怎么处理。";
      }
    } else {
      const pending = pendingItems0.map((x) => x.path);
      if (pending.length) console.log("pending inbound retained (not referenced)", { chatId, count: pending.length, newestAgeMs });
    }
  }

  // If this is an unmentioned group media message, cache it and stop here (no reply).
  // Note: we *still* download and remember the media so a subsequent @mention can reference it.
  if (group && REQUIRE_MENTION_IN_GROUP && !wasMentioned && inboundAttachments.length) {
    console.log("cached group media without mention", { chatId, count: inboundAttachments.length });
    return;
  }

  // Build the final message sent to the agent.
  // - Always include the channel preamble.
  // - Then include user text.
  // - Then include any inbound attachments as FILE: lines.
  const parts = [];
  parts.push(channelPreamble);

  // Optional group context cache (compact)
  if (group && chatId) {
    const ctx = getGroupCacheText(chatId);
    if (ctx) parts.push(ctx);
  }

  if (forwardText) parts.push(forwardText);

  if (inboundAttachments.length) {
    // Add FILE: lines for the agent.
    parts.push(inboundAttachments.map((p) => `FILE: ${p}`).join("\n"));
  }

  forwardText = parts.join("\n\n").trim();

  // "Never timeout" UX: run in background and deliver later.
  // If the job doesn't produce any user-visible output within PROCESSING_HINT_DELAY_MS,
  // we send a delayed "后台处理… 任务ID" hint.
  const jobId = crypto.randomUUID();

  console.log("enqueueSessionJob", { sessionId, jobId, group, hasText: Boolean(text && String(text).trim()), hasFile: Boolean(fileMsg), hasImage: Boolean(imageMsg) });

  // NOTE: start the delayed processing hint timer immediately on receipt.
  // This ensures the user still gets feedback even if this job is queued behind a stuck/slow prior job.
  let outputSent = false;
  let hintSent = false;

  const sendText = async (text) => {
    if (!text) return;
    // Mark as "output sent" as soon as we begin sending to avoid races with the delayed hint timer.
    outputSent = true;
    try {
      await sendTextMessage({ ...target, text });
    } catch (err) {
      console.error("sendTextMessage failed", { err, target, textPreview: String(text).slice(0, 200) });
      throw err;
    }
  };
  const sendImage = async (image_key) => {
    if (!image_key) return;
    outputSent = true;
    try {
      await sendImageMessage({ ...target, image_key });
    } catch (err) {
      console.error("sendImageMessage failed", { err, target });
      throw err;
    }
  };
  const sendFile = async (file_key) => {
    if (!file_key) return;
    outputSent = true;
    try {
      await sendFileMessage({ ...target, file_key });
    } catch (err) {
      console.error("sendFileMessage failed", { err, target });
      throw err;
    }
  };

  const processingHintTimer =
    SEND_PROCESSING_HINT && PROCESSING_HINT_DELAY_MS > 0
      ? setTimeout(() => {
          // Only hint if nothing has been sent yet (including progress pings).
          if (hintSent || outputSent) return;
          hintSent = true;
          sendText(`后台处理… 任务ID：${jobId}`).catch(() => {});
        }, PROCESSING_HINT_DELAY_MS)
      : null;

  enqueueSessionJob(sessionId, async () => {
    let progressTimer = null;

    if (PROGRESS_PING_MS && PROGRESS_PING_MS > 0) {
      progressTimer = setInterval(() => {
        // Progress ping counts as a reply, so it suppresses the delayed hint.
        sendText(`任务 ${jobId} 仍在处理中…`).catch(() => {});
      }, PROGRESS_PING_MS);
    }

    try {
      const { text: replyTextRaw, mediaPaths: mediaPaths0 } = await runClawdbotAgent({
        sessionId,
        message: forwardText,
        timeoutMs: CLAWDBOT_HARD_TIMEOUT_MS || undefined,
      });

      // Heuristic fallback: sometimes the model mentions a generated PDF by filename but forgets to emit FILE:/MEDIA: lines.
      // If that happens, try to locate the mentioned file in common output dirs and send it.
      const mediaPaths = Array.isArray(mediaPaths0) ? [...mediaPaths0] : [];
      if (mediaPaths.length === 0 && typeof replyTextRaw === "string") {
        const pdfNames = Array.from(replyTextRaw.matchAll(/`([^`\n]+\.pdf)`|\b([A-Za-z0-9_\-\.]+\.pdf)\b/g))
          .map((m) => (m[1] || m[2] || "").trim())
          .filter(Boolean);

        const searchDirs = [
          process.cwd(),
          path.resolve(process.cwd(), "outputs"),
          path.resolve(process.cwd(), "downloads"),
        ];

        for (const name of pdfNames) {
          // Absolute path mentioned
          if (path.isAbsolute(name) && fs.existsSync(name)) {
            mediaPaths.push(name);
            break;
          }
          for (const dir of searchDirs) {
            const cand = path.resolve(dir, name);
            if (fs.existsSync(cand)) {
              mediaPaths.push(cand);
              break;
            }
          }
          if (mediaPaths.length) break;
        }
      }

      console.log("agent result", {
        jobId,
        sessionId,
        group,
        mediaCount: mediaPaths.length,
        mediaPaths: mediaPaths.slice(0, 5),
        replyPreview: typeof replyTextRaw === "string" ? replyTextRaw.slice(0, 200) : "(non-string)",
      });

      // 1) Send attachments (local paths) if any.
      let attachmentWanted = 0;
      let attachmentSent = 0;
      const attachmentErrors = [];

      for (const p of mediaPaths || []) {
        const raw = String(p || "").trim();
        if (!raw) continue;

        // Resolve local path (supports relative paths under several common bases)
        let abs = resolveLocalMediaPath(raw);
        if (!abs) {
          // Count it as "wanted" so we can surface a helpful error if nothing was sent.
          attachmentWanted++;
          attachmentErrors.push({ path: raw, error: "file not found under workspace roots" });
          console.error("attachment missing", { raw, cwd: process.cwd(), outputsDir: OUTPUTS_DIR, downloadsDir: DOWNLOAD_DIR, workspaceRoot: WORKSPACE_ROOT });
          continue;
        }

        // Normalize: if the agent wrote into workspace root, move to ./outputs to keep things consistent.
        abs = normalizeToOutputs(abs);

        attachmentWanted++;
        try {
          if (guessIsImage(abs)) {
            const { image_key } = await uploadImageFromPath(abs);
            await sendImage(image_key);
          } else {
            const { file_key } = await uploadFileFromPath(abs);
            await sendFile(file_key);
          }
          attachmentSent++;
        } catch (err) {
          console.error("send attachment failed", { path: abs, err });
          attachmentErrors.push({ path: abs, error: String(err?.message || err) });
        }
      }

      // If the agent asked to send attachments but none could be delivered, say so explicitly
      // (and in Feishu terms, not WhatsApp/Telegram).
      if (attachmentWanted > 0 && attachmentSent === 0) {
        const first = attachmentErrors[0];
        const fileName = first?.path ? path.basename(first.path) : "(unknown)";
        const reason = first?.error ? `\n错误：${first.error}` : "";
        await sendText(
          `我这边生成了附件，但发送到飞书${group ? "群聊" : "会话"}失败（可能是权限/文件类型限制）。\n文件名：${fileName}${reason}`
        );
      }

      // 2) Send text (strip internal traces + MEDIA:/FILE: lines to avoid leaking paths/commands)
      let replyText0 = stripToolTraces(replyTextRaw);
      replyText0 = stripMediaLines(replyText0);
      const replyText = hintSent && replyText0 ? `已完成（任务ID：${jobId}）：\n${replyText0}` : replyText0;
      if (replyText) await sendText(replyText);
    } catch (err) {
      console.error("clawdbot forward failed", err);
      try {
        const msg = String(err.message || err);
        await sendText(`任务 ${jobId} 失败：${msg}`);
      } catch {}
    } finally {
      if (processingHintTimer) clearTimeout(processingHintTimer);
      if (progressTimer) clearInterval(progressTimer);
    }
  });
});

app.listen(PORT, () => {
  console.log(`feishu-bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`Feishu event endpoint: /feishu/events`);
});
