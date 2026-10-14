#!/usr/bin/env bash
# Backup do ./data (sessao + configs) no repo privado de dados.
# Roda no HOST (nao no container). Sucesso = 0; sem mudancas = 0.
set -uo pipefail

DATA_DIR="${DATA_DIR:-${GITHUB_WORKSPACE:-$(pwd)}/data}"
cd "$DATA_DIR" || exit 0
[ -d .git ] || { echo "[BACKUP] $DATA_DIR nao e um repo git - pulando"; exit 0; }

git config user.name >/dev/null 2>&1 || git config user.name "zap-bot"
git config user.email >/dev/null 2>&1 || git config user.email "zap-bot@users.noreply.github.com"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  echo "[BACKUP] sem mudancas"
  exit 0
fi

git add -A --ignore-errors || exit 1
git commit -m "backup $(date -u +%Y-%m-%dT%H:%M:%SZ) run=${GITHUB_RUN_ID:-local}" >/dev/null || true

for i in 1 2 3; do
  if git push origin "HEAD:$BRANCH" >/dev/null 2>&1; then
    echo "[BACKUP] push ok (tentativa $i)"
    exit 0
  fi
  echo "[BACKUP] push falhou (tentativa $i) - rebase e nova tentativa"
  git pull --rebase origin "$BRANCH" >/dev/null 2>&1 || { git rebase --abort >/dev/null 2>&1 || true; }
  sleep 3
done

# Ultimo recurso: nosso estado local e o mais completo (sessoes do servidor)
if git push --force-with-lease origin "HEAD:$BRANCH" >/dev/null 2>&1; then
  echo "[BACKUP] push ok via force-with-lease (histrico do repo remoto sobrescrito)"
  exit 0
fi

echo "[BACKUP] FALHOU apos 3 tentativas"
exit 1
