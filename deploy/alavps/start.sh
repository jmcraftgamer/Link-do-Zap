#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${LINK_APP_DIR:-/opt/link-zap}"
cd "$APP_DIR"

export HEADLESS="${HEADLESS:-1}"
export LINK_HTTP_PORT="${LINK_HTTP_PORT:-8123}"
export LINK_HTTP_HOST="${LINK_HTTP_HOST:-127.0.0.1}"
export LINK_DATA_DIR="${LINK_DATA_DIR:-$APP_DIR/data}"

mkdir -p "$LINK_DATA_DIR"

ELECTRON_BIN="$APP_DIR/node_modules/.bin/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "[start] Electron nao encontrado em $ELECTRON_BIN - rode: npm install" >&2
  exit 1
fi

exec xvfb-run -a "$ELECTRON_BIN" . --no-sandbox --disable-gpu --disable-dev-shm-usage
