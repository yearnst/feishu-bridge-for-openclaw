#!/usr/bin/env bash
set -euo pipefail

# One-shot helper for Docker users.
# Assumes you already created feishu-bridge/.env.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Building + starting feishu-bridge via docker compose..."
docker compose -f docker-compose.yml up -d --build

echo
echo "Running containers:"
docker compose -f docker-compose.yml ps

echo
echo "Logs (follow):"
echo "  docker compose -f docker-compose.yml logs -f"
