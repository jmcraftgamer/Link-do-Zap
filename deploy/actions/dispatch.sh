#!/usr/bin/env bash
# Dispara a PROXIMA execucao do zap-bot (cadeia 24h).
# Precisa de BOT_PAT: o GITHUB_TOKEN nao dispara workflows (anti-recursao).
set -uo pipefail

BOT_PAT="${BOT_PAT:-}"
REPO="${GITHUB_REPOSITORY:-}"
REF="${GITHUB_REF_NAME:-main}"
MAX_MINUTES="${MAX_MINUTES:-310}"
CURRENT_RUN="${GITHUB_RUN_ID:-0}"

if [ -z "$BOT_PAT" ]; then
  echo "[DISPATCH] BOT_PAT ausente" >&2
  exit 1
fi
if [ -z "$REPO" ]; then
  echo "[DISPATCH] GITHUB_REPOSITORY ausente" >&2
  exit 1
fi

# Evita empilhar execucoes: se ja existe uma run ativa/na fila (que nao seja
# esta), nao dispara outra. Sem isso, o dispatch do inicio + o do fim + o cron
# criavam dezenas de runs enfileiradas e o bot vivia reiniciando.
ACTIVE=$(curl -sS --connect-timeout 10 --max-time 30 \
  -H "Authorization: Bearer $BOT_PAT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/actions/workflows/zap-bot.yml/runs?per_page=50" \
  | jq -r --arg current "$CURRENT_RUN" '.workflow_runs[]? | select((.id|tostring) != $current) | select(.status == "queued" or .status == "in_progress" or .status == "waiting" or .status == "requested" or .status == "pending") | .id' \
  | head -n 1)

if [ -n "$ACTIVE" ]; then
  echo "[DISPATCH] ja existe execucao ativa/fila ($ACTIVE) - nao vou duplicar"
  exit 0
fi

HTTP=$(curl -sS --connect-timeout 10 --max-time 30 -o /tmp/dispatch-body.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $BOT_PAT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/actions/workflows/zap-bot.yml/dispatches" \
  -d "{\"ref\":\"$REF\",\"inputs\":{\"max_minutes\":\"$MAX_MINUTES\"}}")

if [ "$HTTP" = "204" ]; then
  echo "[DISPATCH] proxima execucao agendada (max_minutes=$MAX_MINUTES)"
  exit 0
fi

echo "[DISPATCH] HTTP $HTTP - veja /tmp/dispatch-body.json" >&2
cat /tmp/dispatch-body.json >&2 || true
exit 1
