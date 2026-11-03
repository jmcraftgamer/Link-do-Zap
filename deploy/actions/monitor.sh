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
LAST_QUICK=0
LAST_FULL=$START
LAST_SYNC=0
LAST_STATUS_CHECK=0
LAST_PROCESS_CHECK=0
READY_BACKED=0
FULL_EVERY=21600   # sessao completa a cada 6h (e sempre no fim da execucao)
MONITOR_LOG="$DATA_DIR/monitor.log"
PROCESS_CHECK_INTERVAL=10  # Check process every 10 seconds instead of 30

urgent_pairing_dirty() {
  [ -d "$DATA_DIR/.git" ] || return 1
  git -C "$DATA_DIR" status --porcelain -- pairing-codes.json 'qr-*.png' bot-status.json 2>/dev/null | grep -q .
}

# Valida um JSON vindo de origin/main antes de aplicar.
# kind: array | object. Retorna 0 quando o conteudo e valido.
remote_json_valid() {
  local f="$1" kind="$2" tmp ok=0
  tmp="$(mktemp)"
  if ! timeout -k 5 20 git -C "$DATA_DIR" show "origin/main:$f" >"$tmp" 2>/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const [file, kind] = process.argv.slice(1);
      try {
        const d = JSON.parse(fs.readFileSync(file, "utf8"));
        if (kind === "array" && !Array.isArray(d)) process.exit(2);
        if (kind === "object" && (d === null || Array.isArray(d) || typeof d !== "object")) process.exit(2);
        process.exit(0);
      } catch (e) { process.exit(3); }
    ' "$tmp" "$kind" && ok=1
  else
    python3 - "$tmp" "$kind" <<'PY' && ok=1
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    d = json.load(fh)
kind = sys.argv[2]
if kind == "array" and not isinstance(d, list):
    sys.exit(2)
if kind == "object" and not isinstance(d, dict):
    sys.exit(2)
PY
  fi
  rm -f "$tmp"
  [ "$ok" = "1" ]
}

# Baixa as configs que o painel (PC) enviou e aplica no container ao vivo.
# So toca nos arquivos de configuracao - nunca em sessoes/bot-status.
# Um arquivo invalido NUNCA e aplicado: mantem a versao que ja esta rodando.
sync_down() {
  [ -d "$DATA_DIR/.git" ] || return 0
  # timeout -k: se o git travar no fetch de um repo grande, mata de verdade e
  # nao deixa lock para tras. O fetch roda no maximo 1x por minuto.
  timeout -k 5 20 git -C "$DATA_DIR" fetch --quiet origin main >/dev/null 2>&1 || return 0
  local f kind
  for f in zaps.json providers.json trainings.json zaps.empty-ok.json connect-requests.json; do
    git -C "$DATA_DIR" cat-file -e "origin/main:$f" 2>/dev/null || continue
    case "$f" in
      zaps.json|providers.json) kind="array" ;;
      *) kind="object" ;;
    esac
    if remote_json_valid "$f" "$kind"; then
      timeout -k 5 20 git -C "$DATA_DIR" checkout origin/main -- "$f" >/dev/null 2>&1 || true
    else
      echo "[MON] $f invalido no remoto - mantendo a versao atual"
    fi
  done
  if git -C "$DATA_DIR" cat-file -e "origin/main:trainings" 2>/dev/null; then
    timeout -k 5 20 git -C "$DATA_DIR" checkout origin/main -- trainings >/dev/null 2>&1 || true
  fi
  # STOP criado/removido pelo painel do PC
  if git -C "$DATA_DIR" cat-file -e "origin/main:STOP" 2>/dev/null; then
    timeout -k 5 20 git -C "$DATA_DIR" checkout origin/main -- STOP >/dev/null 2>&1 || true
  else
    rm -f "$DATA_DIR/STOP"
  fi
}

do_backup() {
  QUICK="${1:-0}" DATA_DIR="$DATA_DIR" bash "$BACKUP_SCRIPT" || echo "[MON] aviso: backup falhou"
}

# Enhanced process health check
check_process_health() {
  local now=$(date +%s)
  local elapsed=$(( now - LAST_PROCESS_CHECK ))
  
  if [ "$elapsed" -ge "$PROCESS_CHECK_INTERVAL" ]; then
    LAST_PROCESS_CHECK=$now
    
    # Check if container is actually running
    if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [CRITICAL] Container '$CONTAINER' not running" >> "$MONITOR_LOG"
      return 1
    fi
    
    # Check if process is responsive
    local pid=$(docker inspect --format '{{.State.Pid}}' "$CONTAINER" 2>/dev/null)
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      # Check if process exists
      if ! kill -0 "$pid" 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [CRITICAL] Process $pid for container $CONTAINER not responding" >> "$MONITOR_LOG"
        return 1
      fi
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARNING] Could not get PID for container $CONTAINER" >> "$MONITOR_LOG"
    fi
    
    # Check memory usage
    local mem_usage=$(docker stats "$CONTAINER" --no-stream --format "{{.MemUsage}}" 2>/dev/null || echo "unknown")
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] Container $CONTAINER memory usage: $mem_usage" >> "$MONITOR_LOG"
    
    return 0
  fi
}

# Enhanced health check with detailed logging
enhanced_health_check() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] Running enhanced health check..." >> "$MONITOR_LOG"
  
  # Check HTTP endpoint
  if command -v curl >/dev/null 2>&1; then
    local http_status=$(curl -s -m 5 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8123/status' 2>/dev/null || echo "000")
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] HTTP status check: $http_status" >> "$MONITOR_LOG"
    
    if [ "$http_status" != "200" ]; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] /status endpoint returned $http_status" >> "$MONITOR_LOG"
      return 1
    fi
  fi
  
  # Run our custom health check script
  if command -v node >/dev/null 2>&1 && [ -f "$GITHUB_WORKSPACE/deploy/monitor/health-check.js" ]; then
    if ! node "$GITHUB_WORKSPACE/deploy/monitor/health-check.js" >> "$MONITOR_LOG" 2>&1; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] Enhanced health check failed" >> "$MONITOR_LOG"
      return 1
    fi
  fi
  
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] Enhanced health check passed" >> "$MONITOR_LOG"
  return 0
}

# Quando o zap fica pronto, salva a sessao imediatamente. Sem isso um crash
# antes do backup de 6h faria o usuario parear de novo.
backup_if_ready() {
  [ "$READY_BACKED" = "1" ] && return 0
  [ -f "$DATA_DIR/bot-status.json" ] || return 0
  if grep -q '"status": *"ready"' "$DATA_DIR/bot-status.json" 2>/dev/null; then
    echo "[MON] Zap pronto - salvando sessao completa agora"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] Zap ready - triggering full backup" >> "$MONITOR_LOG"
    do_backup 0
    READY_BACKED=1
  fi
}

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - START ))

  # Enhanced process health check every 10 seconds
  if ! check_process_health; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [CRITICAL] Process health check failed - attempting recovery" >> "$MONITOR_LOG"
    # Attempt immediate recovery
    echo "[MON] Container health check failed - attempting recovery"
    
    # Take final backup before restart
    do_backup 0
    
    # Try to restart container
    echo "[MON] Attempting to restart container..."
    docker start "$CONTAINER" 2>/dev/null || docker run -d --name "$CONTAINER" --shm-size=1g --user "$(id -u):$(id -g)" -e HEADLESS=1 -e LINK_DATA_DIR=/data -e LINK_HTTP_PORT=8123 -e LINK_HTTP_HOST=127.0.0.1 -e LINK_AUTO_PAIR="$LINK_AUTO_PAIR" -e LINK_HIDE_CODES="$LINK_HIDE_CODES" -e LINK_CODE_FILE=/data/pairing-codes.json -v "$DATA_DIR:/data" linkzap-bot:latest 2>/dev/null || true
    
    # Wait and check if restart was successful
    sleep 5
    if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      echo "[MON] Container successfully restarted"
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] Container successfully restarted" >> "$MONITOR_LOG"
      LAST_QUICK=$NOW
    else
      echo "[MON] Failed to restart container - exiting for new workflow"
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] Failed to restart container - exiting for new workflow" >> "$MONITOR_LOG"
      docker logs "$CONTAINER" --tail 50 2>/dev/null || true
      exit 1
    fi
  fi

  # Enhanced health check every 30 seconds
  if [ $(( NOW - LAST_STATUS_CHECK )) -ge 30 ]; then
    LAST_STATUS_CHECK=$NOW
    
    if ! enhanced_health_check; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] Enhanced health check failed" >> "$MONITOR_LOG"
      # Log recent critical events for diagnostics
      if [ -f "$DATA_DIR/bot-status.json" ]; then
        echo "[MON] Recent bot status:"
        cat "$DATA_DIR/bot-status.json" | jq '.' 2>/dev/null || cat "$DATA_DIR/bot-status.json"
      fi
    fi
  fi

  # Check if container is still running (additional check)
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "[MON] Container '$CONTAINER' stopped unexpectedly at ${ELAPSED}s"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [CRITICAL] Container stopped unexpectedly" >> "$MONITOR_LOG"
    
    # Take final backup
    do_backup 0
    
    # Try to restart
    echo "[MON] Attempting to restart container..."
    docker start "$CONTAINER" 2>/dev/null || docker run -d --name "$CONTAINER" --shm-size=1g --user "$(id -u):$(id -g)" -e HEADLESS=1 -e LINK_DATA_DIR=/data -e LINK_HTTP_PORT=8123 -e LINK_HTTP_HOST=127.0.0.1 -e LINK_AUTO_PAIR="$LINK_AUTO_PAIR" -e LINK_HIDE_CODES="$LINK_HIDE_CODES" -e LINK_CODE_FILE=/data/pairing-codes.json -v "$DATA_DIR:/data" linkzap-bot:latest 2>/dev/null || true
    
    sleep 5
    if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      echo "[MON] Container successfully restarted"
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] Container successfully restarted after unexpected stop" >> "$MONITOR_LOG"
      LAST_QUICK=$NOW
    else
      echo "[MON] Failed to restart container after unexpected stop - exiting for new workflow"
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] Failed to restart container after unexpected stop - exiting for new workflow" >> "$MONITOR_LOG"
      docker logs "$CONTAINER" --tail 50 2>/dev/null || true
      exit 1
    fi
  fi

  # Aplica configs enviadas pelo painel (no maximo 1x por minuto).
  if [ $(( NOW - LAST_SYNC )) -ge 60 ]; then
    sync_down
    LAST_SYNC=$NOW
  fi

  # Bot desligado pelo painel do PC (arquivo STOP no repo de dados)
  if [ -f "$DATA_DIR/STOP" ]; then
    echo "[MON] STOP encontrado - desligando o bot a pedido do painel"
    docker stop -t 90 "$CONTAINER" >/dev/null 2>&1 || true
    do_backup 0
    echo "STOPPED=true" >> "$GITHUB_ENV"
    echo "[MON] Bot desligado. Para religar, use o painel no PC."
    exit 0
  fi

  backup_if_ready

  # Status/QR/log a cada 30s (ou imediatamente se o pareamento mudou).
  if urgent_pairing_dirty || [ $(( NOW - LAST_QUICK )) -ge 30 ]; then
    do_backup 1
    LAST_QUICK=$NOW
  fi

  # Sessao completa so a cada 6h (e no fim da execucao).
  if [ $(( NOW - LAST_FULL )) -ge "$FULL_EVERY" ]; then
    do_backup 0
    LAST_FULL=$NOW
  fi

  if [ "$ELAPSED" -ge "$GRACE" ]; then
    echo "[MON] Tempo maximo (${MAX_MINUTES}min) atingido em ${ELAPSED}s - parando graceful"
    docker stop -t 90 "$CONTAINER" >/dev/null 2>&1 || true
    do_backup 0
    echo "[MON] Parada normal concluida"
    exit 0
  fi

  sleep 10
done
