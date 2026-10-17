#!/usr/bin/env bash
# Ciclo de vida do bot dentro de uma execucao do Actions:
#  - backup do ./data a cada 60s (15s quando pairing/QR mudou)
#  - pare graceful quando o tempo acabar (docker stop -> SIGTERM -> app flush)
#  - detecta queda do container e faz backup final
# Saida 0 = parada normal (pros passos de dispatch/heartbeat rodarem).
set -uo pipefail

MAX_MINUTES="${MAX_MINUTES:-310}"
DATA_DIR="${DATA_DIR:-${GITHUB_WORKSPACE:-$(pwd)}/data}"
CONTAINER="${CONTAINER:-bot}"
BACKUP_SCRIPT="$(cd "$(dirname "$0")" && pwd)/backup.sh"
START=$(date +%s)
GRACE=$(( MAX_MINUTES * 60 - 120 ))
[ "$GRACE" -lt 60 ] && GRACE=60
LAST_BACKUP=0

urgent_pairing_dirty() {
  [ -d "$DATA_DIR/.git" ] || return 1
  git -C "$DATA_DIR" status --porcelain -- pairing-codes.json 'qr-*.png' bot-status.json 2>/dev/null | grep -q .
}

do_backup() {
  DATA_DIR="$DATA_DIR" bash "$BACKUP_SCRIPT" || echo "[MON] aviso: backup falhou"
}

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - START ))

  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "[MON] Container '$CONTAINER' parou inesperadamente em ${ELAPSED}s"
    do_backup
    docker logs "$CONTAINER" --tail 50 2>/dev/null || true
    exit 1
  fi

  if urgent_pairing_dirty || [ $(( NOW - LAST_BACKUP )) -ge 60 ]; then
    do_backup
    LAST_BACKUP=$NOW
  fi

  if [ "$ELAPSED" -ge "$GRACE" ]; then
    echo "[MON] Tempo maximo (${MAX_MINUTES}min) atingido em ${ELAPSED}s - parando graceful"
    docker stop -t 90 "$CONTAINER" >/dev/null 2>&1 || true
    do_backup
    echo "[MON] Parada normal concluida"
    exit 0
  fi

  sleep 15
done
