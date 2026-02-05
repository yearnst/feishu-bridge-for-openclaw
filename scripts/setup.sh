#!/usr/bin/env bash
set -euo pipefail

# Interactive setup for feishu-bridge
# Writes feishu-bridge/.env and prints next steps.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_FILE="$ROOT_DIR/.env.example"

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "Missing $EXAMPLE_FILE" >&2
  exit 1
fi

read -r -p "FEISHU_APP_ID (e.g. cli_xxx): " FEISHU_APP_ID
read -r -p "FEISHU_APP_SECRET: " FEISHU_APP_SECRET

read -r -p "FEISHU_VERIFICATION_TOKEN (optional, press Enter to skip): " FEISHU_VERIFICATION_TOKEN

read -r -p "Require @mention in group? (true/false, default true): " REQUIRE_MENTION_IN_GROUP
REQUIRE_MENTION_IN_GROUP=${REQUIRE_MENTION_IN_GROUP:-true}

read -r -p "ECHO_MODE for first test? (true/false, default true): " ECHO_MODE
ECHO_MODE=${ECHO_MODE:-true}

read -r -p "PORT (default 8787): " PORT
PORT=${PORT:-8787}

read -r -p "Download dir (default ./downloads): " FEISHU_DOWNLOAD_DIR
FEISHU_DOWNLOAD_DIR=${FEISHU_DOWNLOAD_DIR:-./downloads}

read -r -p "Max download bytes (default 31457280): " FEISHU_MAX_DOWNLOAD_BYTES
FEISHU_MAX_DOWNLOAD_BYTES=${FEISHU_MAX_DOWNLOAD_BYTES:-31457280}

# PDF font
DEFAULT_FONT="./fonts/NotoSansCJKsc-Regular.otf"
read -r -p "PDF_CJK_FONT_PATH (default $DEFAULT_FONT): " PDF_CJK_FONT_PATH
PDF_CJK_FONT_PATH=${PDF_CJK_FONT_PATH:-$DEFAULT_FONT}

# Encryption (optional)
read -r -p "FEISHU_ENCRYPT_KEY (optional, 32 bytes; Enter to skip): " FEISHU_ENCRYPT_KEY
FEISHU_ENCRYPT_KEY=${FEISHU_ENCRYPT_KEY:-}

# Assistant runner (optional)
read -r -p "ASSISTANT_MODE (auto/cli/entry, default auto): " ASSISTANT_MODE
ASSISTANT_MODE=${ASSISTANT_MODE:-auto}
read -r -p "ASSISTANT_BIN (optional, openclaw/clawdbot; Enter to auto-detect): " ASSISTANT_BIN
ASSISTANT_BIN=${ASSISTANT_BIN:-}

cat > "$ENV_FILE" <<EOF
# Feishu / Lark
FEISHU_APP_ID=$FEISHU_APP_ID
FEISHU_APP_SECRET=$FEISHU_APP_SECRET

# Event Subscription
FEISHU_VERIFICATION_TOKEN=$FEISHU_VERIFICATION_TOKEN

# Encrypt Key (optional)
FEISHU_ENCRYPT_KEY=$FEISHU_ENCRYPT_KEY

# Assistant runner (Clawdbot legacy / OpenClaw new)
ASSISTANT_MODE=$ASSISTANT_MODE
ASSISTANT_BIN=$ASSISTANT_BIN
# For legacy entry mode only:
CLAWDBOT_ENTRY=

# Behavior
REQUIRE_MENTION_IN_GROUP=$REQUIRE_MENTION_IN_GROUP

# Testing
ECHO_MODE=$ECHO_MODE

# Storage
FEISHU_DOWNLOAD_DIR=$FEISHU_DOWNLOAD_DIR
FEISHU_MAX_DOWNLOAD_BYTES=$FEISHU_MAX_DOWNLOAD_BYTES

# PDF CJK font (avoid garbled Chinese)
PDF_CJK_FONT_PATH=$PDF_CJK_FONT_PATH

PORT=$PORT
EOF

echo
echo "Wrote: $ENV_FILE"
echo

echo "Next steps (local + tunnel):"
echo "  cd $ROOT_DIR"
echo "  npm install"
echo "  npm start"
echo

echo "Tunnel options (pick one):"
echo "  cloudflared tunnel --url http://127.0.0.1:$PORT"
echo "  ngrok http $PORT"
echo "  npx localtunnel --port $PORT"
echo

echo "Feishu callback URL:" 
echo "  https://<your-public-domain>/feishu/events"
