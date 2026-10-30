#!/usr/bin/env bash
# Backup do ./data (sessao + configs) no repo privado de dados.
# Roda no HOST (nao no container). Sucesso = 0; sem mudancas = 0.
set -uo pipefail
export GIT_TERMINAL_PROMPT=0

DATA_DIR="${DATA_DIR:-${GITHUB_WORKSPACE:-$(pwd)}/data}"
cd "$DATA_DIR" || exit 0
[ -d .git ] || { echo "[BACKUP] $DATA_DIR nao e um repo git - pulando"; exit 0; }

git config user.name >/dev/null 2>&1 || git config user.name "zap-bot"
git config user.email >/dev/null 2>&1 || git config user.email "zap-bot@users.noreply.github.com"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
QUICK="${QUICK:-0}"

# QUICK=1 publica so o que o painel precisa em tempo real (status, QR, codigo
# e log). Nao versiona a sessao do Chromium, que muda a cada minuto e fazia o
# repo de dados crescer centenas de MB por dia.
if [ "$QUICK" = "1" ]; then
  git add -A --ignore-errors -- bot-status.json pairing-codes.json 'qr-*.png' server-terminal.jsonl 2>/dev/null || true
  MODE="status"
else
  git add -A --ignore-errors || exit 1
  # Nunca versiona lixeira, temporarios nem cache volatil do Chromium (muda a
  # cada segundo, e inconsistente e faz o repo crescer sem controle). A sessao
  # de verdade (Local Storage/IndexedDB/cookies) continua indo no backup.
  git reset -q -- \
    'trash' '*.tmp' \
    '*/Cache' '*/Code Cache' '*/GPUCache' '*/blob_storage' \
    '*/Service Worker/CacheStorage' 2>/dev/null || true
  MODE="completo"
fi

if git diff --cached --quiet 2>/dev/null; then
  echo "[BACKUP] sem mudancas ($MODE)"
  exit 0
fi

git commit -m "backup $MODE $(date -u +%Y-%m-%dT%H:%M:%SZ) run=${GITHUB_RUN_ID:-local}" >/dev/null || true

run_git_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 40 "$@"
  else
    "$@"
  fi
}

for i in 1 2 3; do
  if run_git_timeout git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 push origin "HEAD:$BRANCH" >/dev/null 2>&1; then
    echo "[BACKUP] push ok (tentativa $i)"
    exit 0
  fi
  echo "[BACKUP] push falhou (tentativa $i) - rebase e nova tentativa"
  run_git_timeout git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 pull --rebase origin "$BRANCH" >/dev/null 2>&1 || { git rebase --abort >/dev/null 2>&1 || true; }
  sleep 3
done

# Ultimo recurso: tenta mais uma vez. NUNCA usa --force: um force-push no
# branch principal pode apagar configs e historico do repositorio de dados.
if run_git_timeout git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 push origin "HEAD:$BRANCH" >/dev/null 2>&1; then
  echo "[BACKUP] push ok na tentativa final"
  exit 0
fi

echo "[BACKUP] FALHOU apos as tentativas (sem force-push, para preservar o historico)"
exit 1
