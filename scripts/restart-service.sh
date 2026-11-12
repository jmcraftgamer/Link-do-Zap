#!/usr/bin/env bash
# Reinicia o backend e confirma que a API respondeu /health.
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/assistente-zap}"
systemctl restart assistente-zap
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-3000}"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "Backend no ar em http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 2
done
echo "Backend nao respondeu. Logs:" >&2
journalctl -u assistente-zap -n 120 --no-pager >&2 || true
exit 1
