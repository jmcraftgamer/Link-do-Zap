#!/usr/bin/env bash
set -uo pipefail

export HEADLESS="${HEADLESS:-1}"
export LINK_HTTP_PORT="${LINK_HTTP_PORT:-8123}"
export LINK_HTTP_HOST="${LINK_HTTP_HOST:-127.0.0.1}"
export LINK_DATA_DIR="${LINK_DATA_DIR:-/data}"

mkdir -p "$LINK_DATA_DIR"

# Xvfb (display virtual) em background
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99
sleep 1

ELECTRON_BIN="/app/node_modules/.bin/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "[entry] Electron nao encontrado em $ELECTRON_BIN" >&2
  exit 1
fi

# Desliga o Xvfb junto com o processo
shutdown() {
  kill "$XVFB_PID" 2>/dev/null || true
}
trap shutdown EXIT

echo "[entry] Iniciando Electron headless (HEADLESS=$HEADLESS LINK_DATA_DIR=$LINK_DATA_DIR)"
"$ELECTRON_BIN" /app --no-sandbox --disable-gpu --disable-dev-shm-usage &
ELECTRON_PID=$!

# docker stop manda SIGTERM no PID1 (este script) - repassa ao Electron
term() {
  echo "[entry] SIGTERM recebido - encerrando Electron graceful..."
  kill -TERM "$ELECTRON_PID" 2>/dev/null || true
}
trap term TERM INT

wait "$ELECTRON_PID"
EXIT_CODE=$?
echo "[entry] Electron saiu com codigo $EXIT_CODE"
exit "$EXIT_CODE"
